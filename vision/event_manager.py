"""统一事件管理器：把各视觉模块的识别结果收敛成协议规定的事件 JSON。

数据流
--------------------------------------------------------------------------
    Camera → Pose → Presence / Stretching / Drinking
            → EventManager → EventSender → POST /events

本模块只做两件事：

    1. **翻译**：把 detector 的输出（``"PERSON_ENTER"`` / ``"STRETCHING"`` /
       ``ActionResult``）转成《统一的接口协议》里 C → B 的事件 JSON；
    2. **去重**：同一个事件在「一个事件周期内」只发一次，避免每帧重复发送。

它**不负责**网络发送——那是 :mod:`vision.event_sender` 的职责；也**不做**
任何识别——识别仍在各 detector 里。

协议（严格照抄，不增删字段）
--------------------------------------------------------------------------
C → B：``POST /events``，请求体只有 4 个字段::

    {
      "subject_id": "HUMAN_001",
      "event": "DRINKING",
      "confidence": 0.91,
      "timestamp": "2026-09-25T21:08:32+08:00"
    }

    * ``subject_id``：固定 ``"HUMAN_001"``；
    * ``event``：只允许 ``PERSON_ENTER`` / ``DRINKING`` / ``STRETCHING`` /
      ``PERSON_LEFT`` / ``PERSON_RETURNED`` / ``UNKNOWN``；
    * ``confidence``：0 ~ 1；
    * ``timestamp``：带时区的 ISO 8601。

关于 ``UNKNOWN``：协议保留了这个值，但本项目**不会为了凑数量而主动发
UNKNOWN**。只有外部显式请求 ``emit(EVENT_UNKNOWN)`` 时才会发。
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional, Union

from .action_result import ACTION_DRINKING, ActionResult
from .event_sender import EventSender

# ---------------------------------------------------------------------------
# 协议常量
# ---------------------------------------------------------------------------

#: 协议固定主体 ID（当前只观察一个人）
SUBJECT_ID = "HUMAN_001"

#: 允许的事件类型（白名单，协议原文）
EVENT_PERSON_ENTER = "PERSON_ENTER"
EVENT_DRINKING = "DRINKING"
EVENT_STRETCHING = "STRETCHING"
EVENT_PERSON_LEFT = "PERSON_LEFT"
EVENT_PERSON_RETURNED = "PERSON_RETURNED"
EVENT_UNKNOWN = "UNKNOWN"

#: 一次性建立白名单，``build_event`` 用它做校验
ALLOWED_EVENTS = frozenset(
    {
        EVENT_PERSON_ENTER,
        EVENT_DRINKING,
        EVENT_STRETCHING,
        EVENT_PERSON_LEFT,
        EVENT_PERSON_RETURNED,
        EVENT_UNKNOWN,
    }
)

#: ``when`` 参数可以接受的类型
TimeLike = Union[None, datetime, int, float]


# ---------------------------------------------------------------------------
# 纯函数：构造 / 规整
# ---------------------------------------------------------------------------


def clamp_confidence(value: object, *, default: float = 1.0) -> float:
    """把任意输入夹到 ``[0.0, 1.0]``。

    * ``None`` / 非数字 → ``default``；
    * ``< 0`` → ``0.0``；
    * ``> 1`` → ``1.0``。
    """
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        number = float(default)

    if number < 0.0:
        return 0.0
    if number > 1.0:
        return 1.0
    return number


def to_iso_timestamp(when: TimeLike = None) -> str:
    """把时刻转成**带时区**的 ISO 8601 字符串。

    Args:
        when: ``None`` 用当前本地时间；``datetime`` 接受 naive（补本地时区）
            或 aware；``int`` / ``float`` 视为 Unix 秒。
    """
    if when is None:
        moment = datetime.now().astimezone()
    elif isinstance(when, datetime):
        # astimezone()：aware 的转成本地时区；naive 的按本地时区补上时区信息
        moment = when.astimezone()
    elif isinstance(when, (int, float)):
        moment = datetime.fromtimestamp(float(when)).astimezone()
    else:
        raise TypeError(f"不支持的时间类型: {type(when)!r}")

    return moment.isoformat()


def build_event(
    event: str,
    confidence: float = 1.0,
    *,
    subject_id: str = SUBJECT_ID,
    when: TimeLike = None,
) -> dict:
    """按协议构造事件 JSON（**只有 4 个字段**）。

    Args:
        event: 必须是 :data:`ALLOWED_EVENTS` 之一，否则抛 ``ValueError``。
        confidence: 会被夹到 ``[0, 1]``。
        subject_id: 默认协议固定值 ``"HUMAN_001"``。
        when: 时间戳来源，默认当前时间。

    Returns:
        只含 ``subject_id`` / ``event`` / ``confidence`` / ``timestamp`` 的 dict。
    """
    if event not in ALLOWED_EVENTS:
        raise ValueError(
            f"非法事件类型 {event!r}；只允许 {sorted(ALLOWED_EVENTS)}"
        )

    return {
        "subject_id": subject_id,
        "event": event,
        "confidence": clamp_confidence(confidence),
        "timestamp": to_iso_timestamp(when),
    }


# ---------------------------------------------------------------------------
# EventManager
# ---------------------------------------------------------------------------


class EventManager:
    """把识别结果转成协议事件，并交给 :class:`EventSender` 异步发出。

    典型用法（摄像头主循环里）::

        manager = EventManager()                      # 自动读 BACKEND_BASE_URL
        ...
        manager.handle_presence(presence.update(detected))
        manager.handle_stretching(stretching.update(result))
        manager.handle_drinking(drinking.update(frame, result))
        ...
        manager.close()                               # 退出时收尾

    去重语义
    ------------------------------------------------------------------
    内部只记一个 ``_last_event``：

    * 传入 ``None``（本帧没事件）→ **重置** ``_last_event``，表示进入新的
      事件周期；
    * 传入与 ``_last_event`` **相同**的事件 → 抑制，不再发送；
    * 传入不同的事件 → 正常发送并更新 ``_last_event``。

    这样：同一事件连续出现（例如 detector 抖动导致连续两帧都报 STRETCHING）
    只会发一次；而要再次发同一个事件，必须先经过「无事件」的间隔（真正的
    事件周期切换），或者由 detector 自己的冷却/重新武装逻辑驱动。

    Args:
        sender: 事件发送器；``None`` 时新建一个（读环境变量）。
        subject_id: 协议主体 ID，默认 ``"HUMAN_001"``。
        verbose: 是否打印事件日志。
    """

    def __init__(
        self,
        sender: Optional[EventSender] = None,
        *,
        subject_id: str = SUBJECT_ID,
        verbose: bool = True,
    ) -> None:
        self.sender = sender if sender is not None else EventSender()
        self.subject_id = subject_id
        self.verbose = verbose
        #: 上一个真正发出的事件名；``None`` 表示「当前不在任何事件周期内」
        self._last_event: Optional[str] = None
        #: 统计：真正发出的（含被丢弃前的入队）事件数
        self.emitted_count = 0

    # -- 后端配置状态 -----------------------------------------------------
    @property
    def is_backend_configured(self) -> bool:
        """后端地址是否已配置（未配置时事件会被丢弃，但不会崩）。"""
        return bool(getattr(self.sender.config, "is_configured", False))

    # -- 各 detector 的入口 ----------------------------------------------
    def handle_presence(
        self, event: Optional[str], confidence: float = 1.0
    ) -> Optional[dict]:
        """处理 :class:`PresenceDetector` 的返回值（``PERSON_ENTER`` 等）。"""
        return self.emit(event, confidence)

    def handle_stretching(
        self, event: Optional[str], confidence: float = 1.0
    ) -> Optional[dict]:
        """处理 :class:`StretchingDetector` 的返回值（``STRETCHING`` / None）。"""
        return self.emit(event, confidence)

    def handle_drinking(self, verdict: Optional[ActionResult]) -> Optional[dict]:
        """处理 :class:`DrinkingVlmDetector` 的返回值。

        只有 ``verdict`` 明确是「正在喝水」（``is_drinking`` 且
        ``action == DRINKING`` 且无 error）时才发事件；其它情况（含 ``None``、
        NONE 结论、VLM 调用失败）都只当作「本帧无事件」，不发 UNKNOWN。
        """
        if (
            verdict is not None
            and verdict.is_drinking
            and verdict.action == ACTION_DRINKING
            and verdict.error is None
        ):
            return self.emit(ACTION_DRINKING, verdict.confidence)
        return self.emit(None)

    # -- 核心 -------------------------------------------------------------
    def emit(
        self,
        event: Optional[str],
        confidence: float = 1.0,
        *,
        when: TimeLike = None,
    ) -> Optional[dict]:
        """转换并发送一个事件；返回实际发出的 payload（被抑制时返回 ``None``）。

        Args:
            event: 事件名；``None`` / 空串表示本帧没有事件（会重置去重状态）。
            confidence: 会被夹到 ``[0, 1]``。
            when: 时间戳来源，默认当前时间（测试可注入）。
        """
        # 1) 本帧无事件：重置去重状态，不发任何东西（尤其不发 UNKNOWN）
        if not event:
            self._last_event = None
            return None

        # 2) 非白名单事件：拒绝，不改动去重状态
        if event not in ALLOWED_EVENTS:
            if self.verbose:
                print(f"[EventManager] 忽略未知事件 {event!r}")
            return None

        # 3) 同一事件周期内重复：抑制
        if event == self._last_event:
            return None

        # 4) 正常构造并发送
        payload = build_event(
            event, confidence, subject_id=self.subject_id, when=when
        )
        self.sender.send(payload, label=event)
        self._last_event = event
        self.emitted_count += 1

        if self.verbose:
            print(
                f"[EventManager] {event} "
                f"(confidence={payload['confidence']:.2f}, "
                f"timestamp={payload['timestamp']})"
            )
        return payload

    # -- 收尾 -------------------------------------------------------------
    def close(self, *, drain: bool = True) -> None:
        """停止发送器（``drain=True`` 时先尽量把队列里的事件发完）。"""
        self.sender.close(drain=drain)
