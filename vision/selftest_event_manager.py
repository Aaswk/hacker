"""EventManager 离线自测 —— 不发网络、不需要后端、不调用真实 VLM。

运行：
    cd C:\\3G实验室\\hack\\hacker
    .\\.venv\\Scripts\\python.exe -m vision.selftest_event_manager

覆盖（对应任务清单 1~11）：
    1.  PERSON_ENTER  转换正确
    2.  PERSON_LEFT   转换正确
    3.  PERSON_RETURNED 转换正确
    4.  STRETCHING    转换正确
    5.  DRINKING      转换正确
    6.  UNKNOWN 不会被错误发送（无识别结果时不发）
    7.  confidence < 0 被夹到 0
    8.  confidence > 1 被夹到 1
    9.  timestamp 是带时区的 ISO 8601
    10. 不同事件不会互相污染
    11. 重复事件不会在同一事件周期内无限发送（且跨周期可再次发送）

只要有一项 FAIL 就以退出码 1 结束。
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Optional

from .action_result import ACTION_DRINKING, ACTION_NONE, ActionResult
from .event_manager import (
    ALLOWED_EVENTS,
    EVENT_DRINKING,
    EVENT_PERSON_ENTER,
    EVENT_PERSON_LEFT,
    EVENT_PERSON_RETURNED,
    EVENT_STRETCHING,
    EVENT_UNKNOWN,
    SUBJECT_ID,
    EventManager,
    build_event,
    clamp_confidence,
    to_iso_timestamp,
)
from .event_sender import BackendConfig

_PASS = 0
_FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global _PASS, _FAIL
    if condition:
        _PASS += 1
        print(f"  [PASS] {name}")
    else:
        _FAIL += 1
        print(f"  [FAIL] {name} {detail}")


class FakeSender:
    """假发送器：只记录 payload，不发任何网络请求。"""

    def __init__(self, configured: bool = True):
        self.config = BackendConfig(base_url="http://fake-backend" if configured else "")
        self.sent: list[tuple[dict, Optional[str]]] = []
        self.closed = False

    def send(self, payload: dict, *, label: Optional[str] = None) -> bool:
        self.sent.append((payload, label))
        return True

    def close(self, *, drain: bool = True) -> None:
        self.closed = True

    # 便捷断言
    def events(self) -> list[str]:
        return [p["event"] for p, _ in self.sent]


def make_manager(**kw) -> tuple[EventManager, FakeSender]:
    sender = FakeSender(**kw)
    return EventManager(sender=sender, verbose=False), sender


def assert_payload(name: str, payload: Optional[dict], expected_event: str) -> None:
    """校验一个 payload 严格符合协议：4 个字段、值正确。"""
    if payload is None:
        check(name, False, "payload 为 None")
        return
    keys_ok = set(payload.keys()) == {"subject_id", "event", "confidence", "timestamp"}
    check(
        name,
        keys_ok
        and payload["subject_id"] == SUBJECT_ID
        and payload["event"] == expected_event
        and 0.0 <= payload["confidence"] <= 1.0,
        f"实际={payload}",
    )


def main() -> int:
    print("=" * 60)
    print("EventManager 离线自测")
    print("=" * 60)

    # -- 1~5 各事件转换 --------------------------------------------------
    print("\n[1-5] 各事件转换正确")

    mgr, sender = make_manager()
    p = mgr.handle_presence(EVENT_PERSON_ENTER)
    assert_payload("1. PERSON_ENTER 转换正确", p, EVENT_PERSON_ENTER)

    mgr, sender = make_manager()
    p = mgr.handle_presence(EVENT_PERSON_LEFT)
    assert_payload("2. PERSON_LEFT 转换正确", p, EVENT_PERSON_LEFT)

    mgr, sender = make_manager()
    p = mgr.handle_presence(EVENT_PERSON_RETURNED)
    assert_payload("3. PERSON_RETURNED 转换正确", p, EVENT_PERSON_RETURNED)

    mgr, sender = make_manager()
    p = mgr.handle_stretching(EVENT_STRETCHING)
    assert_payload("4. STRETCHING 转换正确", p, EVENT_STRETCHING)

    mgr, sender = make_manager()
    verdict = ActionResult(
        action=ACTION_DRINKING,
        confidence=0.91,
        timestamp=time.time(),
        is_drinking=True,
    )
    p = mgr.handle_drinking(verdict)
    assert_payload("5. DRINKING 转换正确", p, EVENT_DRINKING)
    check(
        "5b. DRINKING confidence 原样保留",
        p is not None and abs(p["confidence"] - 0.91) < 1e-9,
        f"实际={p}",
    )

    # -- 6 UNKNOWN 不被错误发送 -----------------------------------------
    print("\n[6] UNKNOWN 不会被错误发送")
    mgr, sender = make_manager()
    r1 = mgr.handle_presence(None)
    r2 = mgr.handle_stretching(None)
    r3 = mgr.handle_drinking(None)
    r4 = mgr.handle_drinking(
        ActionResult(ACTION_NONE, 0.2, time.time(), is_drinking=False)
    )
    check(
        "6. 无识别结果时不发送任何事件",
        r1 is None and r2 is None and r3 is None and r4 is None and not sender.sent,
        f"sent={sender.events()}",
    )
    check(
        "6b. UNKNOWN 在协议白名单内（但不会被主动发送）",
        EVENT_UNKNOWN in ALLOWED_EVENTS,
    )

    # -- 7 / 8 confidence 夹取 ------------------------------------------
    print("\n[7-8] confidence 夹到 0~1")
    check("7. confidence < 0 → 0", clamp_confidence(-0.5) == 0.0, f"={clamp_confidence(-0.5)}")
    check("8. confidence > 1 → 1", clamp_confidence(1.7) == 1.0, f"={clamp_confidence(1.7)}")

    mgr, sender = make_manager()
    p_low = mgr.handle_presence(EVENT_PERSON_ENTER, confidence=-0.3)
    check("7b. 事件里的 confidence 被夹为 0", p_low is not None and p_low["confidence"] == 0.0)

    mgr, sender = make_manager()
    p_high = mgr.handle_stretching(EVENT_STRETCHING, confidence=5.0)
    check("8b. 事件里的 confidence 被夹为 1", p_high is not None and p_high["confidence"] == 1.0)

    # -- 9 timestamp 带时区 ---------------------------------------------
    print("\n[9] timestamp 是带时区的 ISO 8601")
    ts = to_iso_timestamp()
    parsed = datetime.fromisoformat(ts)
    check(
        "9. 默认 timestamp 带时区",
        parsed.tzinfo is not None and parsed.utcoffset() is not None,
        f"ts={ts}",
    )
    payload = build_event(EVENT_DRINKING, 0.9)
    parsed2 = datetime.fromisoformat(payload["timestamp"])
    check(
        "9b. 事件 payload 的 timestamp 带时区",
        parsed2.tzinfo is not None and parsed2.utcoffset() is not None,
        f"ts={payload['timestamp']}",
    )
    # 注入固定时刻，校验格式与偏移
    fixed = datetime(2026, 9, 25, 21, 8, 32).astimezone()
    fixed_iso = to_iso_timestamp(fixed)
    check(
        "9c. 注入 datetime 后格式正确且带偏移",
        datetime.fromisoformat(fixed_iso).utcoffset() is not None,
        f"iso={fixed_iso}",
    )

    # -- 10 不同事件不互相污染 ------------------------------------------
    print("\n[10] 不同事件不会互相污染")
    mgr, sender = make_manager()
    a = mgr.handle_presence(EVENT_PERSON_ENTER)
    b = mgr.handle_stretching(EVENT_STRETCHING)
    c = mgr.handle_presence(EVENT_PERSON_LEFT)
    check(
        "10. 连续不同事件都各自发出且类型正确",
        sender.events() == [EVENT_PERSON_ENTER, EVENT_STRETCHING, EVENT_PERSON_LEFT],
        f"实际={sender.events()}",
    )
    check(
        "10b. 每个 payload 只含自己的事件、无串味",
        a is not None
        and b is not None
        and c is not None
        and a["event"] == EVENT_PERSON_ENTER
        and b["event"] == EVENT_STRETCHING
        and c["event"] == EVENT_PERSON_LEFT
        and a["timestamp"] != ""
        and b["timestamp"] != "",
    )

    # -- 11 重复事件抑制 + 跨周期可再发 ---------------------------------
    print("\n[11] 重复事件不会在同一事件周期内无限发送")
    mgr, sender = make_manager()
    first = mgr.handle_presence(EVENT_PERSON_ENTER)
    second = mgr.handle_presence(EVENT_PERSON_ENTER)  # 同一周期内重复
    third = mgr.handle_presence(EVENT_PERSON_ENTER)
    check(
        "11. 同一周期内重复只发一次",
        first is not None
        and second is None
        and third is None
        and len(sender.sent) == 1,
        f"sent={sender.events()}",
    )
    # 中间插入「无事件」→ 进入新周期 → 允许再次发送同一事件
    mgr.handle_presence(None)
    again = mgr.handle_presence(EVENT_PERSON_ENTER)
    check(
        "11b. 跨事件周期后同一事件可再次发送",
        again is not None and sender.events() == [EVENT_PERSON_ENTER, EVENT_PERSON_ENTER],
        f"sent={sender.events()}",
    )

    # -- 12 未配置后端不崩（额外保险） ----------------------------------
    print("\n[12] 未配置后端时优雅处理")
    mgr, sender = make_manager(configured=False)
    check("12. is_backend_configured=False", mgr.is_backend_configured is False)
    p = mgr.handle_presence(EVENT_PERSON_ENTER)
    check("12b. 未配置后端仍返回 payload、不抛异常", p is not None and p["event"] == EVENT_PERSON_ENTER)
    mgr.close()
    check("12c. close() 透传到 sender", sender.closed is True)

    print("\n" + "=" * 60)
    print(f"结果：{_PASS} PASS / {_FAIL} FAIL")
    print("=" * 60)
    return 1 if _FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
