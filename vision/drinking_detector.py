"""喝水（DRINKING）检测模块 —— ⚠️ 已停用，仅作历史参考，请勿在主流程使用。

--------------------------------------------------------------------------
弃用说明（DEPRECATED）
--------------------------------------------------------------------------
本模块用纯 Pose 规则直接判断喝水，经**真实摄像头测试误报严重**
（托腮、扶脸、打电话、挠脸、擦嘴都会命中），调阈值无法根治。

现已被 :mod:`vision.drinking_vlm_detector` 取代：
    Pose 只做「疑似」高召回判断 → 截关键帧 → VLM 看图裁决。

``vision/main.py`` 已不再引用本模块。保留此文件仅为记录旧思路，
**运行主流程请勿使用** ``DrinkingDetector`` / ``is_drinking_pose``。
--------------------------------------------------------------------------

职责非常单一：
    根据当前帧的人体关键点，判断「这个人是不是正在端杯喝水」，
    并在满足条件且稳定保持了一小段时间后，产生一次 DRINKING 事件。

本模块：
    * 不做人物进出判断（那是 presence_detector.py 的事）
    * 不做伸展判断（那是 stretching_detector.py 的事）
    * 不调用任何 LLM / VLM，不访问后端，不产生 Event JSON
    * 不引入任何新模型，只复用上游 PoseDetector 的 33 个关键点

--------------------------------------------------------------------------
⚠️ 判定规则说明（重要）
--------------------------------------------------------------------------
本阶段**不检测「水杯」这个物体本身**，只做基于人体关键点的喝水**动作**判断。
这是刻意的取舍：为了一个杯子去引入目标检测模型（YOLO 之类）会带来新依赖、
新权重文件和新性能开销，不符合「第一阶段先跑通动作识别」的目标。

采用的判定规则是「三条件同时满足」（全部基于归一化坐标与关键点）：

    1) 手腕靠近嘴部
       记 mouth = 左右嘴角（landmark 9 / 10）的中点；若嘴角不可信则退回鼻子(0)。
       手腕到嘴部的距离（x 先按画面宽高比缩放，抵消归一化的各向异性）
       要小于阈值 max_mouth_distance。

    2) 手腕高于肘部（手抬起来了）
       wrist.y < elbow.y。y 轴朝下，y 更小 = 更高。端杯送到嘴边时手在肘的上方。

    3) 肘部低于肩部（手臂是「从下往上端起来」的姿态）
       elbow.y > shoulder.y。这一条把「端杯喝水」和「把手高举过头」
       （典型是伸展动作）区分开：后者肘部会抬到肩以上。

    左右两条手臂**任意一条**满足上述三条件即可。三者都要求用到的关键点
    可见度足够（visibility >= min_visibility），否则视为不可判断。

为什么同时要这三个条件（而不是只看「手靠近脸」）：
    单纯「手靠近脸」误触发极多——托腮、挠脸、擦嘴、扶眼镜都会命中。
    条件 2 要求手确实抬到肘部上方，条件 3 要求肘部仍在肩下方，
    合起来就是「端起手臂把东西送到嘴边」的姿态，能滤掉大部分无关动作。

为什么不再单独卡「肘部夹角区间」：
    喝水时肘在肩下、手在嘴边，从几何上「肩→肘」与「腕→肘」两个向量
    都指向上方且方向接近，夹角天然很小（经验上常在几度到几十度）。
    若强行要求一个较大的夹角区间，反而会把正常喝水判成不喝水（漏检）。
    因此这里只用「手高于肘 + 肘低于肩」表达手臂姿态，不引入脆弱的夹角区间。

为什么要求「连续保持 hold_seconds 秒」：
    与 STRETCHING 同理，瞬时动作（抬手抹嘴）不该触发。同时这解决了
    「单帧误判」和「连续疯狂输出 DRINKING」。

已知局限（属于最小版本的取舍，后续若要提高准确度再迭代）：
    * 不识别水杯本身，因此「手里拿着笔/手机靠近嘴」也可能命中。
    * 托腮、手撑下巴这类「肘在桌上、手贴嘴」的姿势与喝水姿态接近，可能误触。
    * 高举杯子仰头喝（肘部抬到肩以上）会被条件 3 漏掉。
    * 单目 z 精度低，这里刻意不用 z，只用 x/y。
    * 阈值（尤其 max_mouth_distance）与摄像头视角、坐姿有关，
      真机验收时可用 CLI 参数微调。
"""

from __future__ import annotations

import math
import time
from typing import Callable, Optional

from .pose_detector import Landmark, Pose, PoseResult

# ---------------------------------------------------------------------------
# 事件名（与 presence_detector / stretching_detector 的风格保持一致）
# ---------------------------------------------------------------------------

#: 喝水事件：端杯靠近嘴部并稳定保持了一小段时间
DRINKING = "DRINKING"

#: 判定规则用到的关键点名字
_NOSE = "nose"
_MOUTH_LEFT = "mouth_left"
_MOUTH_RIGHT = "mouth_right"
_LEFT_SHOULDER = "left_shoulder"
_RIGHT_SHOULDER = "right_shoulder"
_LEFT_ELBOW = "left_elbow"
_RIGHT_ELBOW = "right_elbow"
_LEFT_WRIST = "left_wrist"
_RIGHT_WRIST = "right_wrist"

#: 左右两条手臂，每条给出 (肩, 肘, 腕) 三个关键点的名字
_ARMS = (
    (_LEFT_SHOULDER, _LEFT_ELBOW, _LEFT_WRIST),
    (_RIGHT_SHOULDER, _RIGHT_ELBOW, _RIGHT_WRIST),
)

#: 默认画面宽高比（x 归一化以宽为基准、y 以高为基准，算距离时需缩放 x）
_DEFAULT_ASPECT_RATIO = 4.0 / 3.0


def is_drinking_pose(
    pose: Optional[Pose],
    *,
    max_mouth_distance: float = 0.18,
    min_visibility: float = 0.5,
    aspect_ratio: float = _DEFAULT_ASPECT_RATIO,
) -> bool:
    """判断**单帧**姿势是不是「端杯喝水」动作。

    这是纯粹的判定函数，不涉及时间、不涉及状态，方便单独测试。

    Args:
        pose: 一个人的姿态；传 ``None`` 或关键点不全时返回 ``False``。
        max_mouth_distance: 手腕到嘴部的最大归一化距离（以画面高度为 1）。
        min_visibility: 关键点可见度阈值，低于此值的点视为不可信。
        aspect_ratio: 画面宽高比，用于把 x 方向的归一化距离换算到同一尺度。

    Returns:
        左右任一手臂是否同时满足「手近嘴 + 手高于肘 + 肘低于肩」。
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

    # -- 逐条手臂检查 ------------------------------------------------------
    for shoulder_name, elbow_name, wrist_name in _ARMS:
        shoulder = pose.get(shoulder_name)
        elbow = pose.get(elbow_name)
        wrist = pose.get(wrist_name)

        if (
            shoulder is None
            or elbow is None
            or wrist is None
            or shoulder.visibility < min_visibility
            or elbow.visibility < min_visibility
            or wrist.visibility < min_visibility
        ):
            # 这条手臂有关键点不可用（出画 / 被遮挡），跳过
            continue

        # 条件 1：手腕靠近嘴部
        dx = (wrist.x - mouth_x) * aspect_ratio
        dy = wrist.y - mouth_y
        if math.hypot(dx, dy) > max_mouth_distance:
            continue

        # 条件 2：手腕高于肘部（y 轴朝下，y 更小 = 更高）
        if wrist.y >= elbow.y:
            continue

        # 条件 3：肘部低于肩部（手臂呈「端起」而非「高举过头」）
        if elbow.y <= shoulder.y:
            continue

        return True

    return False


class DrinkingDetector:
    """喝水状态机：把逐帧的姿势判定，收敛成低频、不重复的 DRINKING 事件。

    典型用法（在摄像头主循环里逐帧调用）::

        drinking = DrinkingDetector()

        while True:
            result = pose_detector.detect(frame)      # PoseResult
            event = drinking.update(result)
            if event is not None:
                print(event)                          # "DRINKING"

    状态流转（与需求中的设计一致）::

        未喝水
          ↓ 满足喝水条件持续 hold_seconds 秒
        DRINKING（只报一次）
          ↓ 保持期间不再重复报（冷却期同样拦截）
        手放下 / 姿势中断 → 重新武装
          ↓
        下次再举杯可再次触发

    与 :class:`vision.stretching_detector.StretchingDetector` 的分工：
        两者都吃整个 ``PoseResult``，都只看第一个人，彼此完全独立、可并行使用。
        本模块复用了同一套「保持时长 + 本次已报 + 冷却期」三层防重复机制，
        只是判定函数不同（那里是「双手过头」，这里是「端杯近嘴」）。
    """

    def __init__(
        self,
        *,
        hold_seconds: float = 1.0,
        cooldown_seconds: float = 5.0,
        max_mouth_distance: float = 0.18,
        min_visibility: float = 0.5,
        aspect_ratio: float = _DEFAULT_ASPECT_RATIO,
        verbose: bool = True,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """
        Args:
            hold_seconds: 喝水姿势需要**连续保持**多少秒才触发，默认 1.0 秒。
                这是第一层防抖：抬手抹嘴之类的瞬时动作不会触发。
            cooldown_seconds: 两次 DRINKING 事件之间的最小间隔，默认 5.0 秒。
                这是第三层防重复：防止「举杯→放下→再举杯」快速抖动出一串事件。
                想连续测多次触发时，把它调小（例如 ``--drink-cooldown 1``）。
            max_mouth_distance: 手腕到嘴部的最大归一化距离，透传给判定函数。
            min_visibility: 关键点可见度阈值，透传给判定函数。
            aspect_ratio: 画面宽高比，用于距离计算的各向异性校正。
            verbose: 是否在事件产生时打印 ``[Drinking] DRINKING``。
                只打事件，不会每帧刷屏。
            clock: 取当前时间的函数，默认 ``time.monotonic``（不受系统改时间影响）。
                留出这个参数是为了不接摄像头也能手动测试时间逻辑。
        """
        if hold_seconds <= 0:
            raise ValueError("hold_seconds 必须为正数（单位：秒）")
        if cooldown_seconds < 0:
            raise ValueError("cooldown_seconds 不能为负数（单位：秒）")

        self.hold_seconds = float(hold_seconds)
        self.cooldown_seconds = float(cooldown_seconds)
        self.max_mouth_distance = float(max_mouth_distance)
        self.min_visibility = float(min_visibility)
        self.aspect_ratio = float(aspect_ratio)
        self.verbose = verbose
        self._clock = clock

        # -- 内部状态 ------------------------------------------------------
        #: 本次「连续保持喝水姿势」的起始时刻；None 表示当前没在保持
        self._hold_since: Optional[float] = None
        #: 本次连续保持是否已经报过事件（报过就不再重复报，直到姿势中断）
        self._fired_this_hold: bool = False
        #: 上一次产生事件的时刻，用于冷却判断
        self._last_event_time: Optional[float] = None
        #: 统计用：累计产生的事件条数
        self.event_count: int = 0

    # -- 只读属性 ---------------------------------------------------------
    @property
    def is_holding(self) -> bool:
        """当前是否正处于「喝水姿势连续保持」中（还没触发或已触发都算）。"""
        return self._hold_since is not None

    @property
    def hold_elapsed(self) -> float:
        """当前这次喝水姿势已经保持了多少秒；没在保持则返回 0.0。

        调试时很有用：可以看到「还差多久触发」。
        """
        if self._hold_since is None:
            return 0.0
        return max(0.0, self._clock() - self._hold_since)

    # -- 核心接口 ---------------------------------------------------------
    def update(
        self,
        pose_result: Optional[PoseResult],
        timestamp: Optional[float] = None,
    ) -> Optional[str]:
        """推进一帧，返回本次产生的事件（没有事件则返回 ``None``）。

        Args:
            pose_result: ``PoseDetector.detect()`` 的返回值。
                没人时 ``person_detected`` 为 False，这里会自动当作「没在喝水」。
                传 ``None`` 也可以（等同没人）。
            timestamp: 当前时刻（秒）。默认由 ``clock()`` 自动取，
                只有写测试时手动推进时间才需要显式传。

        Returns:
            ``"DRINKING"`` 或 ``None``。
        """
        now = self._clock() if timestamp is None else float(timestamp)

        # 只取第一个人（本阶段 num_poses=1）。没人时为 None。
        pose = pose_result.poses[0] if pose_result and pose_result.poses else None
        holding = is_drinking_pose(
            pose,
            max_mouth_distance=self.max_mouth_distance,
            min_visibility=self.min_visibility,
            aspect_ratio=self.aspect_ratio,
        )

        event = self._step(holding, now)

        if event is not None:
            self.event_count += 1
            if self.verbose:
                # 只在事件产生时打印：天然低频，不会每帧刷屏
                print(f"[Drinking] {event}")

        return event

    def reset(self) -> None:
        """恢复到刚创建时的状态（重新开始一段观测时用）。"""
        self._hold_since = None
        self._fired_this_hold = False
        self._last_event_time = None
        self.event_count = 0

    # -- 状态机内部实现 ---------------------------------------------------
    def _step(self, holding: bool, now: float) -> Optional[str]:
        """根据「这一帧是否在做喝水动作」推进状态，返回本次事件。"""
        if not holding:
            # 姿势中断：清掉保持计时，并**重新武装**（允许下一次再触发）。
            # 这一步决定了「必须先把手放下，才能再次触发」。
            self._hold_since = None
            self._fired_this_hold = False
            return None

        # 姿势满足：第一次进入时记下起始时刻
        if self._hold_since is None:
            self._hold_since = now

        # 第一层防抖：必须连续保持够久（滤掉抬手抹嘴等瞬时动作）
        if now - self._hold_since < self.hold_seconds:
            return None

        # 第二层防重复：本次连续保持已经报过了，不再重复报
        if self._fired_this_hold:
            return None

        # 第三层防重复：冷却期内不重复报（防止快速放下又举起刷屏）
        if (
            self._last_event_time is not None
            and now - self._last_event_time < self.cooldown_seconds
        ):
            return None

        self._fired_this_hold = True
        self._last_event_time = now
        return DRINKING
