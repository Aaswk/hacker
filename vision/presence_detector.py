"""人物进出检测（Presence Detection）模块。

职责非常单一：
    根据「当前帧是否检测到稳定的人体」，判断人物的存在状态有没有发生变化，
    并在变化时产生一个事件。

本模块：
    * 不做动作识别（STRETCHING / DRINKING 属于后续阶段）
    * 不调用任何 LLM / VLM，不访问后端，不产生 Event JSON
    * 不引入任何新模型，只用上游 PoseDetector 给出的 ``person_detected`` 布尔值

产生的三个事件（字符串常量）：

    PERSON_ENTER     第一次从「没人」变成「有人」
    PERSON_LEFT      「有人」连续消失超过 N 秒（默认 2 秒）
    PERSON_RETURNED  离开之后又回来了（不是第一次出现）

状态机只有两个状态：

    ABSENT  ──连续 stable_frames 帧检测到人──▶  PRESENT
    PRESENT ──连续丢失超过 absent_timeout 秒──▶  ABSENT

为什么要防抖 / 滞后（本模块存在的意义）：
    MediaPipe 的逐帧输出本身是抖的——人只是转个头、抬手挡了一下脸、
    或者某一帧恰好置信度掉到阈值以下，就会出现单帧 ``person_detected=False``。
    如果直接拿单帧结果做状态切换，就会出现「人根本没走，却报 PERSON_LEFT，
    下一帧又报 PERSON_RETURNED」的疯抖日志。
    所以：
      * 进入 PRESENT 要求**连续多帧**稳定检测到人（帧级防抖）；
      * 离开 PRESENT 要求**连续丢失达到时间阈值**（时间级滞后）。

时间为什么用 time.monotonic() 而不是帧数 / 固定 FPS：
    摄像头实际帧率会随光照、CPU 负载、USB 带宽浮动（30fps 掉到 15fps 很常见），
    用「帧数」当时间单位会导致同一个 2 秒在不同机器上变成 4 秒或 1 秒。
    所以这里只对「进入」使用帧数防抖（要求响应快），
    对「离开」使用**真实时间**判断（要求准）。
"""

from __future__ import annotations

import time
from typing import Callable, Optional

# ---------------------------------------------------------------------------
# 事件名（对外的唯一定义处，其他地方请 import 这两个常量而不是手写字符串）
# ---------------------------------------------------------------------------

#: 第一次进入：ABSENT -> PRESENT，且此前从未出现过人
PERSON_ENTER = "PERSON_ENTER"

#: 离开：PRESENT -> ABSENT，连续丢失超过时间阈值
PERSON_LEFT = "PERSON_LEFT"

#: 回来：ABSENT -> PRESENT，但此前已经出现过人（不是第一次）
PERSON_RETURNED = "PERSON_RETURNED"

#: 状态常量
STATE_ABSENT = "ABSENT"
STATE_PRESENT = "PRESENT"


class PresenceDetector:
    """人物存在状态机。

    典型用法（在摄像头主循环里逐帧调用）::

        presence = PresenceDetector()          # 初始状态 ABSENT

        while True:
            result = pose_detector.detect(frame)
            event = presence.update(result.person_detected)   # 传入 bool
            if event is not None:
                print(f"[Presence] {event}")   # 或者发给后续模块

    也可以在构造时传入参数，用时间戳手动测试（不需要摄像头）::

        clock = lambda: 0.0                    # 用假时钟
        p = PresenceDetector(clock=clock)

    ``update()`` 的返回值语义（严格执行，方便下游判断）：
        * 发生状态变化 → 返回事件名字符串（三个常量之一）
        * 没有变化     → 返回 ``None``
        * 事件只产生一次：人一直站在镜头前 30 秒，也只会返回一次 PERSON_ENTER。
    """

    def __init__(
        self,
        *,
        stable_frames: int = 8,
        absent_timeout: float = 2.0,
        verbose: bool = True,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """
        Args:
            stable_frames: 进入 PRESENT 所需的**连续**检测到人的帧数。
                默认 8 帧，30fps 下约 0.27 秒——够快，又能滤掉单帧误检。
                调大更稳但反应更迟钝；调小响应快但容易被抖动带偏。
            absent_timeout: 离开 PRESENT 所需的**连续丢失秒数**，默认 2.0 秒。
                这就是需求里说的「连续消失超过 2 秒才 PERSON_LEFT」。
            verbose: 是否在事件产生时打印 ``[Presence] xxx`` 调试日志。
                只打事件，不会每帧刷屏。
            clock: 取当前时间的函数，默认 ``time.monotonic``。
                用单调时钟是因为它**不受系统时间被修改影响**（墙上时钟被 NTP
                校准或手动改时间时可能出现负数间隔）。留出这个参数是为了
                在不接摄像头的情况下也能手动测试时间逻辑。
        """
        if stable_frames < 1:
            raise ValueError("stable_frames 至少为 1（否则等于没有防抖）")
        if absent_timeout <= 0:
            raise ValueError("absent_timeout 必须为正数（单位：秒）")

        self.stable_frames = int(stable_frames)
        self.absent_timeout = float(absent_timeout)
        self.verbose = verbose
        self._clock = clock

        # -- 内部状态 ------------------------------------------------------
        #: 当前状态，初始必须是 ABSENT（程序刚起来时不知道有没有人，先当没人）
        self._state: str = STATE_ABSENT
        #: 进入 PRESENT 前的连续命中计数
        self._present_streak: int = 0
        #: 本次「开始连续丢失」的时刻；None 表示当前没有在丢失中
        self._absent_since: Optional[float] = None
        #: 是否**曾经**进入过 PRESENT，用来区分 ENTER 和 RETURNED
        self._has_entered: bool = False
        #: 统计用：累计产生的事件条数（调试时看有没有重复触发）
        self.event_count: int = 0

    # -- 只读属性 ---------------------------------------------------------
    @property
    def state(self) -> str:
        """当前状态：``STATE_ABSENT`` 或 ``STATE_PRESENT``。"""
        return self._state

    @property
    def is_present(self) -> bool:
        """当前是否判定为「有人」。"""
        return self._state == STATE_PRESENT

    @property
    def absent_seconds(self) -> float:
        """当前已经连续丢失了多少秒；不在丢失中则返回 0.0。

        调试时很有用：可以确认「还差多久触发 PERSON_LEFT」。
        """
        if self._absent_since is None:
            return 0.0
        return max(0.0, self._clock() - self._absent_since)

    # -- 核心接口 ---------------------------------------------------------
    def update(
        self,
        person_detected: bool,
        timestamp: Optional[float] = None,
    ) -> Optional[str]:
        """推进一帧，返回本次产生的事件（没有事件则返回 ``None``）。

        Args:
            person_detected: 当前帧是否检测到**可靠**的人体。
                直接来自 ``PoseResult.person_detected`` 即可。
                可靠性的把关由上游 PoseDetector 的置信度阈值负责
                （min_pose_detection_confidence / min_pose_presence_confidence
                / min_tracking_confidence），这里不再重复做判断。
            timestamp: 当前时刻（秒）。默认由 ``clock()`` 自动取，
                只有在写测试时手动推进时间才需要显式传。

        Returns:
            ``"PERSON_ENTER"`` / ``"PERSON_LEFT"`` / ``"PERSON_RETURNED"`` 或 ``None``。
        """
        now = self._clock() if timestamp is None else float(timestamp)

        event = (
            self._step_absent(person_detected, now)
            if self._state == STATE_ABSENT
            else self._step_present(person_detected, now)
        )

        if event is not None:
            self.event_count += 1
            if self.verbose:
                # 只在这里打印：事件天然是低频的，不会每帧刷屏
                print(f"[Presence] {event}")

        return event

    def reset(self) -> None:
        """把状态机恢复到刚创建时的样子（初始 ABSENT、从未出现过人）。

        用于重新开始一段观测（例如切换摄像头），日常主循环里不需要调用。
        """
        self._state = STATE_ABSENT
        self._present_streak = 0
        self._absent_since = None
        self._has_entered = False
        self.event_count = 0

    # -- 状态机内部实现 ---------------------------------------------------
    def _step_absent(self, person_detected: bool, now: float) -> Optional[str]:
        """处于 ABSENT 时的一步：等待连续稳定检测到人。"""
        if not person_detected:
            # 只要断一次就重新计数，避免「零星几帧命中」凑够阈值
            self._present_streak = 0
            return None

        self._present_streak += 1
        if self._present_streak < self.stable_frames:
            # 还在攒连续帧，先不切状态（这一步就是「进入侧的防抖」）
            return None

        # 连续稳定 → 进入 PRESENT
        self._state = STATE_PRESENT
        self._present_streak = 0
        self._absent_since = None

        # 第一次出现 vs 曾经出现过，决定事件名
        if not self._has_entered:
            self._has_entered = True
            return PERSON_ENTER
        return PERSON_RETURNED

    def _step_present(self, person_detected: bool, now: float) -> Optional[str]:
        """处于 PRESENT 时的一步：等待连续丢失超过时间阈值。"""
        if person_detected:
            # 人还在：清掉丢失计时器。
            # 这一步保证了「短暂遮挡 / 单帧丢检测」不会积累成 PERSON_LEFT。
            self._absent_since = None
            return None

        # 人不见了：第一次丢失时记下起始时刻，先不报事件
        if self._absent_since is None:
            self._absent_since = now
            return None

        # 还没到阈值 → 继续等（滞后区）
        if now - self._absent_since < self.absent_timeout:
            return None

        # 连续丢失超过阈值 → 判定离开
        self._state = STATE_ABSENT
        self._absent_since = None
        return PERSON_LEFT
