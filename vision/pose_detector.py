"""姿态（Pose）检测模块。

本模块基于 MediaPipe 1.0+ 的 **Tasks API**：``mp.tasks.vision.PoseLandmarker``。

⚠️ 重要：旧版 ``mp.solutions.pose``（以及配套的 ``mp.solutions.drawing_utils``）
在 MediaPipe 1.0 中已被**移除**。网上绝大多数教程仍在用旧 API，直接照抄会报
``AttributeError: module 'mediapipe' has no attribute 'solutions'``。
本文件使用的是当前真正可用的新 API，请勿改回旧写法。

本模块只做一件事：输入一帧 OpenCV BGR 图像，输出人体关键点。
不做动作识别、不调用任何 LLM / VLM、不访问后端。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Union

import cv2
import mediapipe as mp
import numpy as np

# ---------------------------------------------------------------------------
# MediaPipe 新版 Tasks API 的别名（写短一点，方便阅读）
# ---------------------------------------------------------------------------
BaseOptions = mp.tasks.BaseOptions
PoseLandmarker = mp.tasks.vision.PoseLandmarker
PoseLandmarkerOptions = mp.tasks.vision.PoseLandmarkerOptions
RunningMode = mp.tasks.vision.RunningMode
PoseLandmark = mp.tasks.vision.PoseLandmark

# 项目根目录（vision/ 的上一级）下的 models/ 目录
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL_PATH = _PROJECT_ROOT / "models" / "pose_landmarker_lite.task"

#: 骨架连线，元素为 ``(起点索引, 终点索引)``。
#: 这里直接从 MediaPipe 自带的定义转换而来，避免手写 35 条连线出错。
POSE_CONNECTIONS: tuple[tuple[int, int], ...] = tuple(
    (int(conn.start), int(conn.end))
    for conn in mp.tasks.vision.PoseLandmarksConnections.POSE_LANDMARKS
)

#: 索引 -> 名字，例如 11 -> "left_shoulder"，16 -> "right_wrist"
LANDMARK_NAMES: dict[int, str] = {int(m): m.name.lower() for m in PoseLandmark}

#: 名字 -> 索引，例如 "left_shoulder" -> 11
INDEX_BY_NAME: dict[str, int] = {name: idx for idx, name in LANDMARK_NAMES.items()}

#: 关键点总数（MediaPipe Pose 固定输出 33 个点）
NUM_LANDMARKS = len(LANDMARK_NAMES)

# 允许用「名字字符串 / 整数索引 / PoseLandmark 枚举」三种方式定位关键点
LandmarkKey = Union[str, int, "PoseLandmark"]


@dataclass(frozen=True)
class Landmark:
    """单个关键点（NormalizedLandmark 的纯数据版本）。

    坐标含义——这是理解 MediaPipe Pose 输出的核心，请重点看这段：

    ``x``：归一化横坐标，范围 **0.0 ~ 1.0**，相对**画面宽度**的比例。
          0.0 = 画面最左边，1.0 = 画面最右边。
          它**不是像素值**。想转成像素：``px = int(x * frame_width)``。

    ``y``：归一化纵坐标，范围 **0.0 ~ 1.0**，相对**画面高度**的比例。
          0.0 = 画面最上边，1.0 = 画面最下边。
          注意图像坐标系 **y 轴朝下**，这点和数学坐标系相反。

    ``z``：深度，**量纲与 x 大致相同**（不是米）。原点大致在两侧髋部中点，
          数值越小表示离摄像头越近。因为 x/y 是相对画面宽高归一化的，
          所以 z 也不是真实距离；单目摄像头估出来的 z 精度较低，
          做「前后远近」判断时要留出容错。

    ``visibility``：0.0 ~ 1.0，该点**在画面中可见**（没被身体遮挡、没出画）的置信度。

    ``presence``：0.0 ~ 1.0，该点**存在于画面中**的置信度。
          实际使用中，判断「这个点能不能用」一般看 ``visibility``。

    如何取到 shoulder / wrist 等具体点？三种写法等价：

    >>> pose.get("left_shoulder")          # 按名字（推荐，可读性最好）
    >>> pose.get(11)                       # 按官方索引
    >>> pose.get(PoseLandmark.RIGHT_WRIST) # 按枚举

    官方索引速查（完整 33 点见 LANDMARK_NAMES）：
        0  nose            11 left_shoulder   12 right_shoulder
        13 left_elbow      14 right_elbow     15 left_wrist     16 right_wrist
        23 left_hip        24 right_hip       27 left_ankle     28 right_ankle
    """

    index: int
    name: str
    x: float
    y: float
    z: float
    visibility: float
    presence: float

    def to_pixel(self, frame_width: int, frame_height: int) -> tuple[int, int]:
        """把归一化坐标转成该帧上的像素坐标 ``(px, py)``。

        注意：x 乘**宽度**、y 乘**高度**，不要乘反。
        坐标可能超出画面范围（人体出画时），调用方自行决定是否裁剪。
        """
        return int(self.x * frame_width), int(self.y * frame_height)

    @property
    def is_visible(self) -> bool:
        """该点是否可用（经验阈值：可见度 > 0.5）。"""
        return self.visibility > 0.5


@dataclass(frozen=True)
class Pose:
    """一个人的完整姿态：33 个归一化关键点 + 33 个世界坐标关键点。"""

    landmarks: tuple[Landmark, ...]
    world_landmarks: tuple[Landmark, ...]

    def get(self, key: LandmarkKey) -> Optional[Landmark]:
        """按名字 / 索引 / 枚举取关键点，取不到返回 ``None``。"""
        index = _resolve_index(key)
        if index is None or index < 0 or index >= len(self.landmarks):
            return None
        return self.landmarks[index]

    def to_pixels(self, frame_width: int, frame_height: int) -> dict[str, tuple[int, int]]:
        """一次性把所有关键点转成像素坐标，便于调试打印。"""
        return {
            lm.name: lm.to_pixel(frame_width, frame_height) for lm in self.landmarks
        }


@dataclass(frozen=True)
class PoseResult:
    """``PoseDetector.detect()`` 的返回值。

    这是 vision 模块对外的主要数据契约：

    * ``person_detected``：画面里是否有人（bool）
    * ``poses``：检测到的每个人（默认配置下最多 1 个）
    * ``landmarks`` / ``get()``：快捷访问第一个人的关键点
    """

    poses: tuple[Pose, ...] = ()
    timestamp_ms: int = 0
    inference_ms: float = 0.0

    @property
    def person_detected(self) -> bool:
        """是否检测到人体。"""
        return len(self.poses) > 0

    @property
    def landmarks(self) -> tuple[Landmark, ...]:
        """第一个人的 33 个关键点；没人时返回空元组。"""
        return self.poses[0].landmarks if self.poses else ()

    def get(self, key: LandmarkKey) -> Optional[Landmark]:
        """取第一个人的某个关键点，例如 ``result.get("left_wrist")``。"""
        return self.poses[0].get(key) if self.poses else None


def _resolve_index(key: LandmarkKey) -> Optional[int]:
    """把名字 / 整数 / 枚举统一转成整数索引。"""
    if isinstance(key, str):
        return INDEX_BY_NAME.get(key.lower())
    if isinstance(key, PoseLandmark):
        return int(key)
    if isinstance(key, int):
        return key
    return None


def _to_landmark(index: int, raw) -> Landmark:
    """把 MediaPipe 的 NormalizedLandmark 转成本模块的 Landmark。"""
    return Landmark(
        index=index,
        name=LANDMARK_NAMES.get(index, f"landmark_{index}"),
        x=float(raw.x),
        y=float(raw.y),
        z=float(raw.z),
        visibility=float(raw.visibility),
        presence=float(raw.presence),
    )


class PoseDetector:
    """MediaPipe Pose 的薄封装：输入 BGR 帧，输出关键点。

    典型用法::

        with PoseDetector() as detector:
            result = detector.detect(bgr_frame)
            if result.person_detected:
                wrist = result.get("left_wrist")
                px, py = wrist.to_pixel(frame.shape[1], frame.shape[0])

    内部使用 ``RunningMode.VIDEO`` 模式（同步、逐帧调用 ``detect_for_video``），
    它比 ``LIVE_STREAM`` 更容易调试，比 ``IMAGE`` 模式更快也更稳（会做时序跟踪）。
    VIDEO 模式要求时间戳**严格递增**，本类已自动处理，调用方不用操心。
    """

    def __init__(
        self,
        model_path: str | Path = DEFAULT_MODEL_PATH,
        *,
        num_poses: int = 1,
        min_detection_confidence: float = 0.5,
        min_presence_confidence: float = 0.5,
        min_tracking_confidence: float = 0.5,
        use_gpu: bool = False,
    ) -> None:
        """
        Args:
            model_path: ``.task`` 模型文件路径。默认用 models/pose_landmarker_lite.task。
            num_poses: 最多检测几个人。桌宠场景 1 个就够了，调大会明显变慢。
            min_detection_confidence: 首次「有没有人」的检测阈值，越大越严格。
            min_presence_confidence: 关键点存在的置信度阈值。
            min_tracking_confidence: 帧间跟踪阈值，越大越不容易抖动/丢失。
            use_gpu: 是否尝试 GPU 推理。Windows 上 GPU delegate 容易失败，
                     失败会自动回退 CPU，所以默认关掉。
        """
        self.model_path = Path(model_path)
        if not self.model_path.exists():
            raise FileNotFoundError(
                f"找不到 Pose 模型文件：{self.model_path}\n"
                "请先下载 pose_landmarker_lite.task 到项目的 models/ 目录，"
                "命令见 README 或运行说明。"
            )

        self.num_poses = num_poses
        self._last_timestamp_ms = -1  # 用于保证时间戳严格递增

        delegate = (
            BaseOptions.Delegate.GPU if use_gpu else BaseOptions.Delegate.CPU
        )

        # 【重要坑】不要把路径直接交给 MediaPipe（model_asset_path）。
        # MediaPipe 的 C++ 层在 Windows 上用窄字符打开文件，路径里一旦有中文
        # （例如本项目位于 "C:\3G实验室\..."）就会报
        #   FileNotFoundError: Unable to open file at ...
        # 明明文件存在却读不到。解决办法：用 Python 把模型读成 bytes 传进去。
        model_bytes = self.model_path.read_bytes()

        # 新版 API：BaseOptions 指定模型，PoseLandmarkerOptions 指定行为
        options = PoseLandmarkerOptions(
            base_options=BaseOptions(
                model_asset_buffer=model_bytes,
                delegate=delegate,
            ),
            running_mode=RunningMode.VIDEO,
            num_poses=num_poses,
            min_pose_detection_confidence=min_detection_confidence,
            min_pose_presence_confidence=min_presence_confidence,
            min_tracking_confidence=min_tracking_confidence,
            output_segmentation_masks=False,  # 第一阶段用不到人像分割
        )
        self._landmarker = PoseLandmarker.create_from_options(options)

    # -- 生命周期 ---------------------------------------------------------
    def close(self) -> None:
        """释放底层模型资源。"""
        if getattr(self, "_landmarker", None) is not None:
            self._landmarker.close()
            self._landmarker = None

    def __enter__(self) -> "PoseDetector":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def __del__(self) -> None:  # 兜底，防止忘记 close()
        self.close()

    # -- 核心接口 ---------------------------------------------------------
    def detect(
        self,
        bgr_frame: np.ndarray,
        timestamp_ms: Optional[int] = None,
    ) -> PoseResult:
        """对一帧图像做姿态检测。

        Args:
            bgr_frame: OpenCV 读出的帧，``np.ndarray``，形状 ``(H, W, 3)``，**BGR** 通道序。
            timestamp_ms: 时间戳（毫秒，可自定义）。不传则内部用单调时钟生成，
                          保证严格递增。传自定义值时也必须是递增的。

        Returns:
            PoseResult：是否有人 + 关键点 + 耗时。
        """
        if bgr_frame is None or bgr_frame.size == 0:
            raise ValueError("detect() 收到的帧为空，请检查摄像头读取是否成功。")
        if bgr_frame.ndim != 3 or bgr_frame.shape[2] != 3:
            raise ValueError(
                f"detect() 需要 (H, W, 3) 的 BGR 帧，实际形状为 {bgr_frame.shape}。"
            )

        ts = self._next_timestamp_ms() if timestamp_ms is None else int(timestamp_ms)
        self._last_timestamp_ms = max(self._last_timestamp_ms, ts)

        # MediaPipe 只吃 RGB，OpenCV 给的是 BGR，必须转换。
        # ascontiguousarray 是为了满足 mp.Image 对连续内存的要求。
        rgb_frame = np.ascontiguousarray(cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB))
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)

        start = time.perf_counter()
        raw_result = self._landmarker.detect_for_video(mp_image, ts)
        inference_ms = (time.perf_counter() - start) * 1000.0

        return PoseResult(
            poses=self._parse_result(raw_result),
            timestamp_ms=ts,
            inference_ms=inference_ms,
        )

    def detect_and_render(
        self,
        bgr_frame: np.ndarray,
        timestamp_ms: Optional[int] = None,
    ) -> tuple[PoseResult, np.ndarray]:
        """检测并直接返回可显示的 debug 画面。

        这是给「只想快速看效果」的调用方准备的便捷方法，
        真正的绘制逻辑在 :mod:`vision.visualizer` 里，这里只是转调，不重复实现。
        """
        from .visualizer import draw_pose_debug  # 延迟导入，避免循环依赖

        result = self.detect(bgr_frame, timestamp_ms)
        return result, draw_pose_debug(bgr_frame, result)

    # -- 内部实现 ---------------------------------------------------------
    def _next_timestamp_ms(self) -> int:
        """生成严格递增的时间戳（毫秒）。

        MediaPipe 的 VIDEO 模式要求时间戳单调递增，重复或倒退会直接抛错，
        所以这里做一次「至少 +1」的修正。
        """
        ts = int(time.monotonic() * 1000)
        if ts <= self._last_timestamp_ms:
            ts = self._last_timestamp_ms + 1
        return ts

    @staticmethod
    def _parse_result(raw_result) -> tuple[Pose, ...]:
        """把 MediaPipe 原始结果转成本模块的 Pose 元组。

        ``raw_result.pose_landmarks`` 是「每个人一个列表」的嵌套结构：
        ``[[NormalizedLandmark, ...], ...]``；没人时是空列表。
        世界坐标在 ``raw_result.pose_world_landmarks``，结构相同，
        单位是**米**（相对髋部中点，y 轴朝上，与归一化坐标相反）。
        """
        poses: list[Pose] = []
        normalized_all = raw_result.pose_landmarks or []
        world_all = raw_result.pose_world_landmarks or []

        for person_idx, raw_landmarks in enumerate(normalized_all):
            landmarks = tuple(
                _to_landmark(i, raw) for i, raw in enumerate(raw_landmarks)
            )
            world = ()
            if person_idx < len(world_all):
                world = tuple(
                    _to_landmark(i, raw) for i, raw in enumerate(world_all[person_idx])
                )
            poses.append(Pose(landmarks=landmarks, world_landmarks=world))

        return tuple(poses)
