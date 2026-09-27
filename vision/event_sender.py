"""事件发送器：把统一 event JSON 异步 POST 到后端 ``/events``。

职责边界
--------------------------------------------------------------------------
本模块**只负责「把已经构造好的 payload 发出去」**：

    * 从环境变量读后端地址（``BACKEND_BASE_URL``），不硬编码；
    * ``POST {base_url}/events``；
    * 原始 payload（dict）直接作为请求体，**本模块不增删任何字段**——
      字段由 :mod:`vision.event_manager` 按后端协议构造；
    * 用后台 daemon 线程发送，摄像头主循环调用 ``send()`` 立即返回，不阻塞；
    * HTTP 错误 / 超时 / 连不上 / 未配置后端，一律只记日志、不抛异常，
      保证主循环不会因为后端挂掉而崩。

为什么用标准库 ``urllib``：项目 venv 里没有 requests/httpx，
沿用 :mod:`vision.vlm_client` 的零依赖做法。
"""

from __future__ import annotations

import json
import os
import queue
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional

#: 后端 base URL 的环境变量名（项目约定）
ENV_BACKEND_BASE_URL = "BACKEND_BASE_URL"

#: 事件接口路径
EVENTS_PATH = "/events"

#: 默认请求超时（秒）
DEFAULT_TIMEOUT = 5.0

#: 后台发送队列默认容量；满了就丢弃新事件（宁可丢事件，也不阻塞主循环）
DEFAULT_QUEUE_SIZE = 100


class BackendError(RuntimeError):
    """所有后端发送相关错误的基类。"""


class BackendConfigError(BackendError):
    """后端未配置（最典型：没有设置 BACKEND_BASE_URL）。"""


class BackendRequestError(BackendError):
    """请求阶段失败：超时 / 连不上 / HTTP 非 2xx。"""


@dataclass(frozen=True)
class BackendConfig:
    """后端连接配置。地址只从环境变量来。"""

    base_url: str
    timeout: float = DEFAULT_TIMEOUT

    @classmethod
    def from_env(cls) -> "BackendConfig":
        """从 ``BACKEND_BASE_URL`` 读取；未设置则 base_url 为空串。"""
        raw_timeout = os.environ.get("BACKEND_TIMEOUT", "").strip()
        try:
            timeout = float(raw_timeout) if raw_timeout else DEFAULT_TIMEOUT
        except ValueError:
            timeout = DEFAULT_TIMEOUT

        return cls(
            base_url=os.environ.get(ENV_BACKEND_BASE_URL, "").strip().rstrip("/"),
            timeout=timeout,
        )

    @property
    def is_configured(self) -> bool:
        return bool(self.base_url)

    @property
    def events_url(self) -> str:
        return f"{self.base_url}{EVENTS_PATH}"


#: 传输函数签名：``(url, payload, timeout) -> (status_code, body_text)``。
#: 抽出来是为了测试时能注入假传输，不用真的发网络请求。
Transport = Callable[[str, dict, float], "tuple[int, str]"]


def _default_transport(url: str, payload: dict, timeout: float) -> "tuple[int, str]":
    """用标准库发一次 POST，返回 ``(状态码, 响应体文本)``。

    Raises:
        BackendRequestError: 超时 / 连不上 / HTTP 非 2xx。
    """
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return int(resp.status), resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
        except Exception:  # noqa: BLE001 - 读错误体失败不影响主流程
            pass
        raise BackendRequestError(
            f"HTTP {exc.code}: {detail or exc.reason}"
        ) from exc
    except urllib.error.URLError as exc:
        raise BackendRequestError(f"无法连接后端: {exc.reason}") from exc
    except TimeoutError as exc:
        raise BackendRequestError(f"请求超时（>{timeout}s）") from exc
    except OSError as exc:
        raise BackendRequestError(f"请求失败: {exc}") from exc


class EventSender:
    """把 event payload 异步发到后端 ``/events`` 的发送器。

    典型用法::

        sender = EventSender()                 # 自动读 BACKEND_BASE_URL
        sender.send(payload, label="DRINKING") # 立即返回，后台线程发送
        ...
        sender.close()                         # 退出时收尾

    Args:
        config: 后端配置；``None`` 时用 :meth:`BackendConfig.from_env`。
        transport: 自定义传输函数（测试注入用）。
        verbose: 是否打印发送成功/失败日志。
        queue_size: 后台队列容量。
        clock: 保留参数，便于将来记录时间（当前未使用）。
    """

    def __init__(
        self,
        *,
        config: Optional[BackendConfig] = None,
        transport: Optional[Transport] = None,
        verbose: bool = True,
        queue_size: int = DEFAULT_QUEUE_SIZE,
    ) -> None:
        self.config = config or BackendConfig.from_env()
        self.verbose = verbose
        self._transport = transport or _default_transport
        self._queue: "queue.Queue[tuple[dict, Optional[str]]]" = queue.Queue(
            maxsize=queue_size
        )
        self._closed = False
        #: 统计
        self.sent_count = 0
        self.failed_count = 0
        self.dropped_count = 0

        # 后台发送线程：daemon，主程序退出时自动结束，不会挂住进程
        self._worker = threading.Thread(
            target=self._run, name="event-sender", daemon=True
        )
        self._worker.start()

    # -- 对外接口 ---------------------------------------------------------
    def send(self, payload: dict, *, label: Optional[str] = None) -> bool:
        """把 payload 放进队列，立即返回（不阻塞主循环）。

        Args:
            payload: 已经按协议构造好的 event JSON（本方法不改动它）。
            label: 日志用的短标签（如 ``"DRINKING"``）。为 ``None`` 时
                尝试从 payload 的 ``event_type`` / ``event`` / ``action`` 里取。

        Returns:
            ``True`` 表示已入队；``False`` 表示后端未配置或队列已满（事件被丢弃）。
        """
        if not self.config.is_configured:
            self.dropped_count += 1
            if self.verbose:
                print(
                    f"[Event] 未配置 {ENV_BACKEND_BASE_URL}，"
                    f"丢弃事件 {self._label_of(payload, label)}"
                )
            return False

        if self._closed:
            self.dropped_count += 1
            return False

        try:
            self._queue.put_nowait((payload, label))
        except queue.Full:
            self.dropped_count += 1
            if self.verbose:
                print(f"[Event] 发送队列已满，丢弃事件 {self._label_of(payload, label)}")
            return False
        return True

    def close(self, *, drain: bool = True, timeout: float = 3.0) -> None:
        """停止后台线程。``drain=True`` 时先尽量把队列里的事件发完。"""
        if drain:
            self._queue.join()
        self._closed = True
        self._queue.put((None, None))  # 哨兵，唤醒线程退出
        self._worker.join(timeout=timeout)

    # -- 后台线程 ---------------------------------------------------------
    def _run(self) -> None:
        while True:
            payload, label = self._queue.get()
            try:
                if payload is None:  # 哨兵
                    return
                self._deliver(payload, label)
            finally:
                self._queue.task_done()

    def _deliver(self, payload: dict, label: Optional[str]) -> None:
        """真正发一次；**任何异常都在这里被吞掉**，绝不外泄到后台线程之外。"""
        name = self._label_of(payload, label)
        try:
            status, _body = self._transport(
                self.config.events_url, payload, self.config.timeout
            )
        except BackendRequestError as exc:
            self.failed_count += 1
            if self.verbose:
                print(f"[Event] POST /events failed: {exc}")
            return
        except Exception as exc:  # noqa: BLE001 - 兜底，后台线程不能崩
            self.failed_count += 1
            if self.verbose:
                print(f"[Event] POST /events failed: 未预期错误 {exc!r}")
            return

        self.sent_count += 1
        if self.verbose:
            print(f"[Event] POST /events -> {status}")
            print(f"[Event] {name} sent")

    # -- 内部工具 ---------------------------------------------------------
    @staticmethod
    def _label_of(payload: dict, label: Optional[str]) -> str:
        """日志标签：优先用显式 label，其次从 payload 里猜，最后用 'EVENT'。"""
        if label:
            return label
        for key in ("event_type", "event", "action", "type"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                return value
        return "EVENT"
