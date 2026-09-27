"""模糊动作检测：DRINKING（喝水）—— Pose 触发 + VLM 裁决。

为什么要有这个模块
--------------------------------------------------------------------------
旧版 ``drinking_detector.py`` 用纯 Pose 规则（手腕靠近嘴、手腕高于手肘、
肘低于肩）直接判断喝水，真实摄像头测试**误报严重**（托腮、扶脸、打电话、
挠脸都会命中），阈值怎么调都按不住。结论是：**「手在脸附近」这件事本身
信息量太低，规则无解**，必须看图才知道手里是不是真拿着杯子。

因此 DRINKING 改成「模糊动作」处理，架构是：

    Camera → MediaPipe Pose
        ↓
    Pose 只做「高召回」的疑似判断（可疑就放行，不追求准）
        ↓ 连续满足若干帧
    截取 1~3 张关键帧（JPEG）
        ↓
    VLM 看图最终裁决（这是准的那一步）
        ↓
    ActionResult → Event Manager

本模块的三个关键设计
--------------------------------------------------------------------------
1. **Pose 只负责「疑似」，故意放宽**
   :func:`is_drinking_candidate` 只要求「手腕高于同侧肩」+「手腕离嘴比较近」，
   不判断肘部、不要求端着杯子。宁可多放行，交给 VLM 去否决。

2. **VLM 绝不逐帧调用**（否则 API 会被打爆、也会卡住主循环）
   * 连续 ``trigger_frames`` 帧疑似 → 才截关键帧、才调一次 VLM；
   * 调用放在**后台线程**（daemon），主循环 ``update()`` 永不阻塞；
   * 结果回来后才产生``ActionResult``；
   * 之后进入 ``cooldown_seconds`` 冷却，且必须「把手放下」重新武装。

3. **任何 VLM 失败都不许让摄像头主循环崩**
   ``_judge()`` 会把 ``VlmError``（超时 / HTTP 错误 / JSON 非法 / 没配 key）
   全部吞掉，转成一个 ``action="NONE"`` 且 ``error`` 非空的 ActionResult，
   主循环继续跑。

本模块**不**产生对外事件 JSON、**不**访问后端，只产出 :class:`ActionResult`。
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Callable, Optional, Sequence

import cv2
import numpy as np

from .action_result import ACTION_DRINKING, ACTION_NONE, ActionResult
from .pose_detector import Pose, PoseResult
from .vlm_client import VlmClient, VlmError

# ---------------------------------------------------------------------------
# VLM prompt
# ---------------------------------------------------------------------------

#: 给 VLM 的系统角色设定：强调「只输出 JSON、不做解释」。
VLM_SYSTEM_PROMPT = (
    "You are a strict, concise action-recognition classifier. "
    "You always answer with a single JSON object and nothing else. "
    "You never explain, never use markdown, never add commentary."
)

#: 喝水判断的完整 prompt。刻意把「像喝水但不算」的动作逐条列出，
#: 因为实测里误报几乎全部来自这些孪生动作。
DRINKING_PROMPT = """You are a strict action-recognition classifier for a desk-pet camera.
Look at the person in the image(s) and decide ONE thing only:
is the person **actually drinking** from a cup, bottle, mug, glass, or can?

Return DRINKING (is_drinking=true) ONLY when you can see a real drinking action:
the person's hand is holding a drink container (cup / bottle / mug / glass / can)
AND the container is at or very near the person's mouth (touching the lips or
tilted toward the mouth), as if they are taking a sip.

Do NOT return DRINKING for any of these look-alike actions:
- hand resting near or on the face
- touching / rubbing / scratching the face or cheek
- chin resting on the hand (托腮)
- propping up the head with the hand
- talking on the phone (hand or phone at the ear)
- holding the phone in front of the face
- eating food or putting food in the mouth
- wiping the mouth or nose
- adjusting a mask or glasses
- hand merely raised in front of the body
If you cannot clearly see a drink container, or you are unsure, answer NONE.

Answer with JSON only, no markdown, no explanation:
{"action": "DRINKING", "confidence": 0.0, "is_drinking": true}
or
{"action": "NONE", "confidence": 0.0, "is_drinking": false}
"confidence" is a number between 0 and 1 describing how sure you are.
"""

# ---------------------------------------------------------------------------
# 疑似触发（纯函数）
# ---------------------------------------------------------------------------

_NOSE = "nose"
_MOUTH_LEFT = "mouth_left"
_MOUTH_RIGHT = "mouth_right"
_SHOULDERS = ("left_shoulder", "right_shoulder")
_WRISTS = ("left_wrist", "right_wrist")

_DEFAULT_ASPECT_RATIO = 4.0 / 3.0


def is_drinking_candidate(
    pose: Optional[Pose],
    *,
    trigger_distance: float = 0.30,
    min_visibility: float = 0.4,
    aspect_ratio: float = _DEFAULT_ASPECT_RATIO,
) -> bool:
    """「疑似喝水」的**宽松**判定（只看单帧，无状态，方便测试）。

    与旧的严格规则相反，这里的目标是 **高召回**——宁可把托腮、打电话也放进来，
    也不能漏掉真正的喝水，因为最终由 VLM 裁决。

    条件（左右任一手臂满足即可）：

        1) 手腕高于同侧肩：``wrist.y < shoulder.y``（y 轴朝下，越小越高）
           —— 说明手抬起来了，不是垂在身侧。
        2) 手腕到嘴部参考点距离 <= ``trigger_distance``
           —— 嘴部参考点取左右嘴角中点，不可信时退回鼻子。
           默认 0.30，比旧规则的 0.18 宽松得多。

    刻意**不**包含：肘部高度、肘部夹角、是否握着杯子——这些交给 VLM。

    Args:
        pose: 一个人的姿态；``None`` 或关键点不全时返回 ``False``。
        trigger_distance: 手腕到嘴部的最大归一化距离（以画面高度为 1）。
        min_visibility: 关键点可见度阈值，低于此值的点视为不可信。
        aspect_ratio: 画面宽高比，用于把 x 方向归一化距离换算到同一尺度。

    Returns:
        是否属于「疑似喝水」。
    """
    if pose is None:
        return False

    # -- 嘴部参考点：优先左右嘴角中点，取不到退回鼻子 ----------------------
    mouth_left = pose.get(_MOUTH_LEFT)
    mouth_right = pose.get(_MOUTH_RIGHT)
    if (
        mouth_left is not None
        and mouth_right is not None
        and mouth_left.visibility >= min_visibility
        and mouth_right.visibility >= min_visibility
    ):
        mouth_x = (mouth_left.x + mouth_right.x) / 2.0
        mouth_y = (mouth_left.y + mouth_right.y) / 2.0
    else:
        nose = pose.get(_NOSE)
        if nose is None or nose.visibility < min_visibility:
            return False
        mouth_x, mouth_y = nose.x, nose.y

    # -- 逐条手臂检查（只要有一条像就放行）--------------------------------
    for shoulder_name, wrist_name in zip(_SHOULDERS, _WRISTS):
        shoulder = pose.get(shoulder_name)
        wrist = pose.get(wrist_name)
        if (
            shoulder is None
            or wrist is None
            or shoulder.visibility < min_visibility
            or wrist.visibility < min_visibility
        ):
            continue

        # 条件 1：手抬到肩以上
        if wrist.y >= shoulder.y:
            continue

        # 条件 2：手离嘴够近（宽松阈值）
        dx = (wrist.x - mouth_x) * aspect_ratio
        dy = wrist.y - mouth_y
        if (dx * dx + dy * dy) ** 0.5 > trigger_distance:
            continue

        return True

    return False


def encode_frame_jpeg(
    frame: Optional[np.ndarray],
    *,
    max_width: int = 640,
    quality: int = 80,
) -> Optional[bytes]:
    """把一帧 BGR 图像编码成 JPEG 字节（用于喂给 VLM）。

    太宽的帧先等比缩小：关键帧只用来「看清手里有没有杯子」，
    没必要传 1080p，缩到 640 宽既省流量也省 token。

    Returns:
        JPEG 字节；输入为空或编码失败时返回 ``None``。
    """
    if frame is None or getattr(frame, "size", 0) == 0:
        return None

    image = frame
    height, width = image.shape[:2]
    if width > max_width > 0:
        scale = max_width / float(width)
        new_size = (max_width, max(1, int(round(height * scale))))
        image = cv2.resize(image, new_size, interpolation=cv2.INTER_AREA)

    ok, buffer = cv2.imencode(
        ".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)]
    )
    if not ok:
        return None
    return buffer.tobytes()


def _parse_verdict(data: dict, *, timestamp: float) -> ActionResult:
    """把 VLM 返回的 JSON dict 收敛成 :class:`ActionResult`。

    健壮性优先：字段缺失、类型不对、action 与 is_drinking 自相矛盾，
    一律按「不是喝水」（NONE）处理，绝不抛异常。

    规则：
        * ``action`` 转大写去空白，只认 ``"DRINKING"``，其它一律 ``"NONE"``；
        * ``confidence`` 尽力转 float 并夹到 [0, 1]，转不了取 0；
        * ``is_drinking`` 必须与 action 一致才算数（两者任一不满足即 NONE），
          避免模型给出 ``{"action":"DRINKING","is_drinking":false}`` 这种矛盾输出。
    """
    action = str(data.get("action", ACTION_NONE)).strip().upper()
    if action != ACTION_DRINKING:
        action = ACTION_NONE

    try:
        confidence = float(data.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    is_drinking = bool(data.get("is_drinking", False)) and action == ACTION_DRINKING
    if not is_drinking:
        action = ACTION_NONE

    return ActionResult(
        action=action,
        confidence=confidence,
        timestamp=timestamp,
        is_drinking=is_drinking,
        source="vlm",
    )


class DrinkingVlmDetector:
    """「Pose 疑似 → 关键帧 → VLM 裁决」的喝水检测状态机。

    典型用法（摄像头主循环里逐帧调用）::

        drinking = DrinkingVlmDetector()

        while True:
            ok, frame = camera.read()
            result = pose_detector.detect(frame)
            verdict = drinking.update(frame, result)   # 注意要传原始帧
            if verdict is not None and verdict.is_drinking:
                print(verdict)                          # ActionResult

    状态流转::

        未疑似
          ↓ 连续 trigger_frames 帧 is_drinking_candidate
        截关键帧 → 后台线程调 VLM（此时不阻塞主循环）
          ↓ VLM 返回
        ActionResult（DRINKING / NONE，或 error 非空的 NONE）
          ↓ 进入 cooldown，且必须「手放下」后重新武装
        冷却结束 + 手放下 → 允许再次触发

    Args:
        vlm: VLM 客户端。传 ``None`` 时按环境变量自动创建。
            测试时可注入假客户端（只要实现 ``ask_json(prompt, images)``）。
        trigger_frames: 连续疑似多少帧才触发。默认 5（约 0.17s@30fps），
            用来滤掉单帧抖动，但比旧的 hold 短得多——因为「准不准」交给 VLM。
        cooldown_seconds: 两次 VLM 调用之间的最小间隔。默认 15.0 秒。
            对 DRINKING 和 NONE 都生效，避免「一直举着手」把 API 打爆。
        trigger_distance: 疑似判定的手腕-嘴部距离阈值，透传给
            :func:`is_drinking_candidate`。默认 0.30（宽松）。
        min_visibility: 关键点可见度阈值。
        aspect_ratio: 画面宽高比，用于距离校正。
        keyframes: 一次调用送给 VLM 的图片张数（1~3）。默认 3。
        buffer_size: 关键帧环形缓冲的长度（帧）。默认 15。
            只有「疑似」帧才会进缓冲，手一放下就清空。
        jpeg_quality: 关键帧 JPEG 质量，默认 80。
        max_width: 关键帧最大宽度（超过则等比缩小），默认 640。
        verbose: 是否打印触发/错误等低频日志。事件行由调用方（main）打印。
        clock: 内部计时用的时钟，默认 ``time.monotonic``。
        wall_clock: 生成 ActionResult.timestamp 用的时钟，默认 ``time.time``。
    """

    def __init__(
        self,
        *,
        vlm: Optional[VlmClient] = None,
        trigger_frames: int = 5,
        cooldown_seconds: float = 15.0,
        trigger_distance: float = 0.30,
        min_visibility: float = 0.4,
        aspect_ratio: float = _DEFAULT_ASPECT_RATIO,
        keyframes: int = 3,
        buffer_size: int = 15,
        jpeg_quality: int = 80,
        max_width: int = 640,
        verbose: bool = True,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        if trigger_frames < 1:
            raise ValueError("trigger_frames 至少为 1")
        if cooldown_seconds < 0:
            raise ValueError("cooldown_seconds 不能为负数")
        if keyframes < 1:
            raise ValueError("keyframes 至少为 1")

        self.vlm = vlm if vlm is not None else VlmClient()
        self.trigger_frames = int(trigger_frames)
        self.cooldown_seconds = float(cooldown_seconds)
        self.trigger_distance = float(trigger_distance)
        self.min_visibility = float(min_visibility)
        self.aspect_ratio = float(aspect_ratio)
        self.keyframes = int(keyframes)
        self.jpeg_quality = int(jpeg_quality)
        self.max_width = int(max_width)
        self.verbose = verbose
        self._clock = clock
        self._wall_clock = wall_clock

        # -- 关键帧环形缓冲（只存「疑似」帧的 JPEG 字节）--------------------
        self._buffer: deque[bytes] = deque(maxlen=int(buffer_size))

        # -- 状态 -----------------------------------------------------------
        #: 连续疑似帧计数
        self._streak: int = 0
        #: 是否处于「已武装」状态：必须手放下（候选转 False）才会重新武装
        self._armed: bool = True
        #: 上次发起 VLM 调用的时刻（cooldown 从此刻计时）
        self._last_trigger_time: Optional[float] = None
        #: 是否有后台 VLM 调用在跑（True 时不再发起新的）
        self._pending: bool = False
        #: 后台线程写回的结果槽
        self._verdict: Optional[ActionResult] = None
        #: 最近一次结论（含 NONE / 错误）
        self.last_result: Optional[ActionResult] = None
        #: 统计用：累计确认了多少次 DRINKING
        self.event_count: int = 0

    # -- 只读属性 ---------------------------------------------------------
    @property
    def is_pending(self) -> bool:
        """是否有一次 VLM 调用正在进行中。"""
        return self._pending

    @property
    def candidate_streak(self) -> int:
        """当前连续疑似帧数。"""
        return self._streak

    # -- 核心接口 ---------------------------------------------------------
    def update(
        self,
        frame: Optional[np.ndarray],
        pose_result: Optional[PoseResult],
        timestamp: Optional[float] = None,
    ) -> Optional[ActionResult]:
        """推进一帧。

        Args:
            frame: 当前帧（BGR），用于截关键帧。允许为 ``None``（则无法截帧）。
            pose_result: ``PoseDetector.detect()`` 的返回值。
            timestamp: 内部计时用（秒），默认取 ``clock()``。测试时可显式传。

        Returns:
            本次新产生的 :class:`ActionResult`；没有则 ``None``。
            注意：返回的**不一定是 DRINKING**——VLM 判为 NONE 或调用失败时，
            同样会返回一个 NONE 的 ActionResult（``error`` 可能非空），
            调用方自行决定怎么用（main 只对 ``is_drinking`` 的打印事件）。
        """
        now = self._clock() if timestamp is None else float(timestamp)

        # 1) 先尝试取回后台线程的结论（非阻塞）
        ready = self._take_verdict()
        if ready is not None:
            return ready

        # 2) 这一帧是否疑似
        pose = pose_result.poses[0] if pose_result and pose_result.poses else None
        candidate = is_drinking_candidate(
            pose,
            trigger_distance=self.trigger_distance,
            min_visibility=self.min_visibility,
            aspect_ratio=self.aspect_ratio,
        )

        if not candidate:
            # 手放下 / 没人：清计数、清缓冲，并**重新武装**
            self._streak = 0
            self._buffer.clear()
            self._armed = True
            return None

        # 3) 疑似帧进缓冲
        encoded = encode_frame_jpeg(
            frame, max_width=self.max_width, quality=self.jpeg_quality
        )
        if encoded is not None:
            self._buffer.append(encoded)
        self._streak += 1

        # 4) 触发闸门：没有正在跑的调用 + 已武装 + 连续帧够 + 冷却已过
        if self._pending or not self._armed:
            return None
        if self._streak < self.trigger_frames:
            return None
        if (
            self._last_trigger_time is not None
            and now - self._last_trigger_time < self.cooldown_seconds
        ):
            return None

        # 5) 触发：截关键帧 → 后台线程调 VLM
        keyframes = self._pick_keyframes()
        self._armed = False           # 必须手放下才会重新武装
        self._last_trigger_time = now
        if keyframes:
            self._start_vlm(keyframes, now)
        elif self.verbose:
            print("[Drinking] 疑似触发但没截到关键帧，跳过本次 VLM 调用")
        return None

    def reset(self) -> None:
        """恢复到刚创建时的状态。"""
        self._buffer.clear()
        self._streak = 0
        self._armed = True
        self._last_trigger_time = None
        self._pending = False
        self._verdict = None
        self.last_result = None
        self.event_count = 0

    # -- 内部实现 ---------------------------------------------------------
    def _take_verdict(self) -> Optional[ActionResult]:
        """若有后台结论就取走并返回（只取一次）。"""
        if self._pending or self._verdict is None:
            return None
        verdict = self._verdict
        self._verdict = None
        self.last_result = verdict
        if verdict.is_drinking:
            self.event_count += 1
        if self.verbose:
            if verdict.error:
                print(f"[Drinking] VLM 判断失败，按 NONE 处理：{verdict.error}")
            else:
                print(
                    f"[Drinking] VLM 结论：{verdict.action} "
                    f"(confidence={verdict.confidence:.2f})"
                )
        return verdict

    def _pick_keyframes(self) -> list[bytes]:
        """从环形缓冲里均匀取最多 ``keyframes`` 张，尽量覆盖整个疑似过程。"""
        frames = list(self._buffer)
        if not frames:
            return []
        count = min(self.keyframes, len(frames))
        if count <= 1:
            return [frames[-1]]
        step = (len(frames) - 1) / (count - 1)
        indices = [int(round(i * step)) for i in range(count)]
        return [frames[i] for i in indices]

    def _start_vlm(self, keyframes: Sequence[bytes], triggered_at: float) -> None:
        """起一个 daemon 线程去调 VLM，主循环立刻返回。"""
        self._pending = True
        wall_ts = self._wall_clock()
        thread = threading.Thread(
            target=self._worker,
            args=(list(keyframes), wall_ts),
            name="drinking-vlm",
            daemon=True,
        )
        thread.start()
        if self.verbose:
            print(
                f"[Drinking] 疑似喝水已达 {self._streak} 帧，"
                f"截取 {len(keyframes)} 张关键帧调用 VLM"
            )

    def _worker(self, keyframes: list[bytes], wall_ts: float) -> None:
        """后台线程体：调用 VLM 并把结论放回结果槽。

        顺序很重要：**先写 ``_verdict`` 再清 ``_pending``**，
        这样 ``update()`` 只有在结论就绪后才会读到 ``_pending=False``。
        """
        verdict = self._judge(keyframes, wall_ts)
        self._verdict = verdict
        self._pending = False

    def _judge(self, keyframes: list[bytes], wall_ts: float) -> ActionResult:
        """真正调用 VLM 并解析；**任何异常都在这里被吞掉**，绝不外泄。"""
        try:
            data = self.vlm.ask_json(
                DRINKING_PROMPT, keyframes, system=VLM_SYSTEM_PROMPT
            )
            return _parse_verdict(data, timestamp=wall_ts)
        except VlmError as exc:
            # 超时 / HTTP 错误 / JSON 非法 / 没配 key 都在这一类里
            return ActionResult(
                action=ACTION_NONE,
                confidence=0.0,
                timestamp=wall_ts,
                is_drinking=False,
                source="vlm",
                error=str(exc),
            )
        except Exception as exc:  # noqa: BLE001 - 兜底，主循环绝不能因 VLM 崩
            return ActionResult(
                action=ACTION_NONE,
                confidence=0.0,
                timestamp=wall_ts,
                is_drinking=False,
                source="vlm",
                error=f"未预期的 VLM 错误: {exc!r}",
            )
