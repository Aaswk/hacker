"""EventSender 离线自测 —— 不发真实网络请求、不需要后端、不需要摄像头。

运行：
    cd C:\\3G实验室\\hack\\hacker
    .\\.venv\\Scripts\\python.exe -m vision.selftest_event_sender

覆盖：
    * 未配置 BACKEND_BASE_URL 时优雅丢弃，不崩
    * 正常发送（200）并统计
    * HTTP 错误 / 超时（BackendRequestError）不崩、记失败
    * 传输层抛未预期异常也不崩
    * 队列满时丢弃、不阻塞
    * send() 是异步的（调用立即返回）

只要有一项 FAIL 就以退出码 1 结束。
"""

from __future__ import annotations

import os
import threading
import time
from typing import Optional

from .event_sender import (
    BackendConfig,
    BackendRequestError,
    EventSender,
)

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


class FakeTransport:
    """假传输：按配置返回状态码或抛异常，并记录收到的 payload。"""

    def __init__(self, status: int = 200, error: Optional[Exception] = None):
        self.status = status
        self.error = error
        self.calls: list[tuple[str, dict, float]] = []
        self.lock = threading.Lock()

    def __call__(self, url: str, payload: dict, timeout: float):
        with self.lock:
            self.calls.append((url, payload, timeout))
        if self.error is not None:
            raise self.error
        return self.status, '{"ok": true}'


def wait_until(predicate, timeout: float = 3.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return False


def configured(transport) -> EventSender:
    return EventSender(
        config=BackendConfig(base_url="http://127.0.0.1:8000"),
        transport=transport,
        verbose=False,
    )


def test_unconfigured() -> None:
    print("\nS1 未配置 BACKEND_BASE_URL")
    sender = EventSender(
        config=BackendConfig(base_url=""),
        transport=FakeTransport(),
        verbose=False,
    )
    try:
        check("is_configured 为假", sender.config.is_configured is False)
        ok = sender.send({"event_type": "PERSON_ENTER"}, label="PERSON_ENTER")
        check("未配置时 send 返回 False", ok is False)
        check("计入 dropped_count", sender.dropped_count == 1, str(sender.dropped_count))
        check("发送计数为 0", sender.sent_count == 0)
    finally:
        sender.close(drain=False)

    # from_env 在无变量时也应未配置
    saved = os.environ.pop("BACKEND_BASE_URL", None)
    try:
        check("from_env 无变量时未配置", BackendConfig.from_env().is_configured is False)
    finally:
        if saved is not None:
            os.environ["BACKEND_BASE_URL"] = saved


def test_success() -> None:
    print("\nS2 正常发送 200")
    transport = FakeTransport(status=200)
    sender = configured(transport)
    try:
        payload = {"event_type": "STRETCHING", "confidence": 1.0}
        ok = sender.send(payload, label="STRETCHING")
        check("send 返回 True", ok is True)
        check("后台确实发出", wait_until(lambda: len(transport.calls) == 1))
        url, got_payload, _ = transport.calls[0]
        check("请求路径为 /events", url == "http://127.0.0.1:8000/events", url)
        check("payload 原样发送（不增删字段）", got_payload == payload, str(got_payload))
        check("sent_count == 1", wait_until(lambda: sender.sent_count == 1))
    finally:
        sender.close(drain=False)


def test_http_error() -> None:
    print("\nS3 HTTP 错误 / 超时（BackendRequestError）")
    transport = FakeTransport(error=BackendRequestError("HTTP 500: boom"))
    sender = configured(transport)
    try:
        sender.send({"event_type": "DRINKING"}, label="DRINKING")
        check("失败被记录", wait_until(lambda: sender.failed_count == 1))
        check("不崩溃（进程仍在）", True)
        check("sent_count 仍为 0", sender.sent_count == 0)
    finally:
        sender.close(drain=False)


def test_unexpected_error() -> None:
    print("\nS4 传输层抛未预期异常")
    transport = FakeTransport(error=ValueError("奇怪的错误"))
    sender = configured(transport)
    try:
        sender.send({"event_type": "DRINKING"}, label="DRINKING")
        check("未预期异常也被吞掉并计数", wait_until(lambda: sender.failed_count == 1))
        check("进程未崩溃", True)
    finally:
        sender.close(drain=False)


def test_non_blocking() -> None:
    print("\nS5 send() 异步非阻塞 + 队列满丢弃")

    gate = threading.Event()

    def slow_transport(url, payload, timeout):
        gate.wait(timeout=2.0)  # 卡住后台线程
        return 200, "{}"

    sender = EventSender(
        config=BackendConfig(base_url="http://127.0.0.1:8000"),
        transport=slow_transport,
        verbose=False,
        queue_size=2,
    )
    try:
        start = time.perf_counter()
        for i in range(5):
            sender.send({"event_type": "X", "i": i})
        elapsed = time.perf_counter() - start
        check("5 次 send 立即返回（<0.1s）", elapsed < 0.1, f"{elapsed:.4f}s")
        check("队列满时有事件被丢弃", sender.dropped_count > 0, str(sender.dropped_count))
    finally:
        gate.set()
        sender.close(drain=False)


def test_close_drains() -> None:
    print("\nS6 close(drain=True) 会把队列里的事件发完")
    transport = FakeTransport(status=200)
    sender = configured(transport)
    for i in range(3):
        sender.send({"event_type": "X", "i": i})
    sender.close(drain=True)
    check("3 条全部发出", len(transport.calls) == 3, str(len(transport.calls)))
    check("sent_count == 3", sender.sent_count == 3, str(sender.sent_count))


def main() -> int:
    print("=" * 60)
    print("EventSender 离线自测 —— 不发真实网络请求")
    print("=" * 60)
    test_unconfigured()
    test_success()
    test_http_error()
    test_unexpected_error()
    test_non_blocking()
    test_close_drains()
    print("\n" + "=" * 60)
    print(f"结果：{_PASS} PASS / {_FAIL} FAIL")
    print("=" * 60)
    return 0 if _FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
