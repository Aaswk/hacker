"""伸展（STRETCHING）检测模块。

职责非常单一：
    根据当前帧的人体关键点，判断「这个人是不是正在伸懒腰 / 高举双手伸展」，
    并在满足条件且稳定保持了一小段时间后，产生一次 STRETCHING 事件。

本模块：
    * 不做人物进出判断（那是 presence_detector.py 的事）
    * 不做喝水检测（DRINKING 属于后续阶段）
    * 不调用任何 LLM / VLM，不访问后端，不产生 Event JSON
    * 不引入任何新模型，只复用上游 PoseDetector 的 33 个关键点

--------------------------------------------------------------------------
⚠️ 判定规则说明（重要）
--------------------------------------------------------------------------
本项目仓库中**没有**统一接口协议文件（只有主题类 md 文档），因此协议中
并未规定 STRETCHING 的判定方式。按「先做最小可验证版本」的原则，
这里采用一条**最简单、最容易人工复现**的规则：

    「双手同时举过头顶」= STRETCHING

具体实现（全部基于归一化坐标，见 pose_detector.Landmark 的注释）：

    记 nose = 关键点 0（鼻子），lw / rw = 左右手腕（15 / 16）。
    由于图像坐标系 y 轴朝下，y 越小越靠上，所以「举过头顶」即：

        left_wrist.y  < nose.y   且   right_wrist.y < nose.y

    并且要求鼻子、左右肩、左右腕这几个点都足够可信（visibility > 阈值），
    否则手出画 / 被遮挡时坐标不可信，不能算数。

为什么用「鼻子」而不是固定像素高度当基准：
    y 是相对画面高度归一化的，且这里做的是**同一帧内的相对比较**
    （手腕 vs 鼻子），所以人离镜头远近、站着还是坐着都不影响判断，
    不需要再额外做人体的尺度归一化。

为什么要求「连续保持 hold_seconds 秒」：
    抬手、挠头、拿高处的物品、挥手，都会瞬间让手腕高于鼻子。
    只有**持续保持**这个姿势才算真的在伸展。这同时解决了两件事：
    「单帧误判」和「连续疯狂输出 STRETCHING」。

已知局限（属于最小版本的取舍，后续若要提高准确度再迭代）：
    * 只认「双手举过头顶」这一种伸展；侧腰拉伸、单臂上举、扩胸等都不算。
    * 不区分「伸懒腰」和「站在那儿举着东西」。要区分就得引入更多约束
      （例如手臂是否近乎伸直、手腕是否超出画面等），当前阶段刻意不做。
"""

from __future__ import annotations

import time
from typing import Callable, Optional

from .pose_detector import Landmark, Pose, PoseResult

# ---------------------------------------------------------------------------
# 事件名（与 presence_detector 的风格保持一致，统一用字符串常量）
# ---------------------------------------------------------------------------

#: 伸展事件：双手举过头顶并稳定保持了一小段时间
STRETCHING = "STRETCHING"

#: 判定规则用到的关键点名字（用名字而不是魔法数字，可读性更好）
_NOSE = "nose"
_LEFT_SHOULDER = "left_shoulder"
_RIGHT_SHOULDER = "right_shoulder"
_LEFT_WRIST = "left_wrist"
_RIGHT_WRIST = "right_wrist"

#: 参与「可信度」检查的关键点集合
_REQUIRED_POINTS = (
    _NOSE,
    _LEFT_SHOULDER,
    _RIGHT_SHOULDER,
    _LEFT_WRIST,
    _RIGHT_WRIST,
)


def is_stretching_pose(
    pose: Optional[Pose],
    *,
    min_visibility: float = 0.5,
) -> bool:
    """判断**单帧**姿势是不是「双手举过头顶」。

    这是纯粹的判定函数，不涉及时间、不涉及状态，方便单独测试。

    Args:
        pose: 一个人的姿态；传 ``None`` 或关键点不全时返回 ``False``。
        min_visibility: 关键点可见度阈值，低于此值的点视为不可信。

    Returns:
        双手是否都高于鼻子（且所需关键点都可信）。
    """
    if pose is None:
        return False

    points: dict[str, Landmark] = {}
    for name in _REQUIRED_POINTS:
        landmark = pose.get(name)
        # 点缺失，或可见度太低（手出画、被身体挡住），都无法判断
        if landmark is None or landmark.visibility < min_visibility:
            return False
        points[name] = landmark

    nose_y = points[_NOSE].y
    left_wrist_y = points[_LEFT_WRIST].y
    right_wrist_y = points[_RIGHT_WRIST].y

    # y 轴朝下：y 更小 = 更高。两个手腕都要高过鼻子。
    return left_wrist_y < nose_y and right_wrist_y < nose_y


class StretchingDetector:
    """伸展状态机：把逐帧的姿势判定，收敛成低频、不重复的 STRETCHING 事件。

    典型用法（在摄像头主循环里逐帧调用）::

        stretching = StretchingDetector()

        while True:
            result = pose_detector.detect(frame)      # PoseResult
            event = stretching.update(result)
            if event is not None:
                print(event)                          # "STRETCHING"

    与 :class:`vision.presence_detector.PresenceDetector` 的分工：
        * PresenceDetector 只吃一个 bool（有没有人），管「人在不在」；
        * StretchingDetector 需要看关键点（姿势长什么样），所以吃整个 PoseResult。
        两者互不依赖，可以并行使用。
    """

    def __init__(
        self,
        *,
        hold_seconds: float = 0.6,
        cooldown_seconds: float = 5.0,
        min_visibility: float = 0.5,
        verbose: bool = True,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """
        Args:
            hold_seconds: 双手举过头顶需要**连续保持**多少秒才触发，默认 0.6 秒。
                这是第一层防抖：抬手挠头之类的瞬时动作不会触发。
            cooldown_seconds: 两次 STRETCHING 事件之间的最小间隔，默认 5.0 秒。
                这是第三层防重复：防止「举手→放下→再举手」快速抖动出一串事件。
                想连续测多次触发时，把它调小（例如 ``--stretch-cooldown 1``）。
            min_visibility: 关键点可见度阈值，直接透传给 is_stretching_pose()。
            verbose: 是否在事件产生时打印 ``[Stretching] STRETCHING``。
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
        self.min_visibility = float(min_visibility)
        self.verbose = verbose
        self._clock = clock

        # -- 内部状态 ------------------------------------------------------
        #: 本次「连续保持举手姿势」的起始时刻；None 表示当前没在保持
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
        """当前是否正处于「举手姿势连续保持」中（还没触发或已触发都算）。"""
        return self._hold_since is not None

    @property
    def hold_elapsed(self) -> float:
        """当前这次举手已经保持了多少秒；没在保持则返回 0.0。

        调试时很有用：可以看到「还差多久触发」。也可以在接前端时
        用来画一个「伸展进度条」。
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
                没人时 ``person_detected`` 为 False，这里会自动当作「没在伸展」。
                传 ``None`` 也可以（等同没人）。
            timestamp: 当前时刻（秒）。默认由 ``clock()`` 自动取，
                只有写测试时手动推进时间才需要显式传。

        Returns:
            ``"STRETCHING"`` 或 ``None``。
        """
        now = self._clock() if timestamp is None else float(timestamp)

        # 只取第一个人（本阶段 num_poses=1）。没人时为 None。
        pose = pose_result.poses[0] if pose_result and pose_result.poses else None
        holding = is_stretching_pose(pose, min_visibility=self.min_visibility)

        event = self._step(holding, now)

        if event is not None:
            self.event_count += 1
            if self.verbose:
                # 只在事件产生时打印：天然低频，不会每帧刷屏
                print(f"[Stretching] {event}")

        return event

    def reset(self) -> None:
        """恢复到刚创建时的状态（重新开始一段观测时用）。"""
        self._hold_since = None
        self._fired_this_hold = False
        self._last_event_time = None
        self.event_count = 0

    # -- 状态机内部实现 ---------------------------------------------------
    def _step(self, holding: bool, now: float) -> Optional[str]:
        """根据「这一帧是否在举手」推进状态，返回本次事件。"""
        if not holding:
            # 姿势中断：清掉保持计时，并**重新武装**（允许下一次再触发）。
            # 这一步决定了「必须先把手放下，才能再次触发」。
            self._hold_since = None
            self._fired_this_hold = False
            return None

        # 姿势满足：第一次进入时记下起始时刻
        if self._hold_since is None:
            self._hold_since = now

        # 第一层防抖：必须连续保持够久（滤掉挠头、挥手等瞬时动作）
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
        return STRETCHING
