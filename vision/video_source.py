"""统一的视频输入层：把「本机摄像头 / USB 摄像头 / RTSP / HTTP(MJPEG) / 本地文件」
都抽象成同一个 OpenCV ``VideoCapture``，对外只暴露与 :class:`vision.camera.CameraStream`
一致的接口（``open`` / ``read`` / ``release`` / ``__enter__`` / ``actual_*``）。

分层位置
--------------------------------------------------------------------------
    VideoSource → 统一输出 frame → 现有 Pose / Presence / STRETCHING / DRINKING
                → EventManager → POST /events

本模块**只负责拿到帧**，不碰任何检测逻辑、事件协议或后端地址。
下游拿到的仍然是各 detector 一直在用的 ``(ok, frame)``。

支持的 ``--source`` 写法
--------------------------------------------------------------------------
    * ``0`` / ``1`` / 纯数字   → 本机 / USB 摄像头（按 index）
    * ``rtsp://...``           → RTSP 网络摄像头
    * ``http://...`` / ``https://...`` → HTTP / MJPEG 视频流
    * 其它字符串               → 本地视频文件路径（如 ``D:\\video\\test.mp4``）

不传 ``--source`` 时退回 ``--camera``（默认 0），保持原有本机摄像头行为不变。
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# 视频源类型
# ---------------------------------------------------------------------------

SOURCE_CAMERA = "camera"
SOURCE_FILE = "file"
SOURCE_RTSP = "rtsp"
SOURCE_HTTP = "http"

_RTSP_PREFIXES = ("rtsp://", "rtsps://")
_HTTP_PREFIXES = ("http://", "https://")

#: 匹配 ``scheme://user:password@host``，用于日志脱敏
_CREDENTIAL_RE = re.compile(r"://([^:/@]+):([^@]+)@")


def mask_credentials(text: str) -> str:
    """把 URL 里的密码替换成 ``****``，避免日志泄露凭据。

    ``rtsp://user:secret@1.2.3.4:554/s`` → ``rtsp://user:****@1.2.3.4:554/s``
    """
    return _CREDENTIAL_RE.sub(r"://\1:****@", text)


@dataclass(frozen=True)
class SourceSpec:
    """解析后的视频源描述。

    Attributes:
        kind: :data:`SOURCE_CAMERA` / :data:`SOURCE_FILE` / :data:`SOURCE_RTSP`
            / :data:`SOURCE_HTTP` 之一。
        value: 传给 ``cv2.VideoCapture`` 的值（摄像头是 index，其余是 URL / 路径）。
        camera_index: 仅摄像头源有意义。
    """

    kind: str
    value: str
    camera_index: int = 0

    @property
    def is_camera(self) -> bool:
        return self.kind == SOURCE_CAMERA

    @property
    def display(self) -> str:
        """日志用显示串（摄像头显示 ``camera N``，URL 自动脱敏）。"""
        if self.kind == SOURCE_CAMERA:
            return f"camera {self.camera_index}"
        return mask_credentials(self.value)


def parse_source(source: Optional[str], *, camera_index: int = 0) -> SourceSpec:
    """把命令行传入的 ``--source`` / ``--camera`` 解析成 :class:`SourceSpec`。

    Args:
        source: ``--source`` 的原始值；``None`` / 空串表示「用摄像头」。
        camera_index: ``--camera`` 的值，仅在 ``source`` 为空或为数字时生效。

    Returns:
        :class:`SourceSpec`。

    Raises:
        ValueError: ``source`` 是数字但不是一个合法的摄像头序号。
    """
    if source is None or str(source).strip() == "":
        return SourceSpec(SOURCE_CAMERA, str(camera_index), camera_index)

    text = str(source).strip()
    lowered = text.lower()

    # 1) 纯数字 → 摄像头 index
    if text.lstrip("+-").isdigit():
        index = int(text)
        if index < 0:
            raise ValueError(f"摄像头编号不能为负数：{text}")
        return SourceSpec(SOURCE_CAMERA, str(index), index)

    # 2) RTSP / RTSPS
    if lowered.startswith(_RTSP_PREFIXES):
        return SourceSpec(SOURCE_RTSP, text)

    # 3) HTTP / HTTPS（含 MJPEG）
    if lowered.startswith(_HTTP_PREFIXES):
        return SourceSpec(SOURCE_HTTP, text)

    # 4) 其余按本地文件路径
    return SourceSpec(SOURCE_FILE, text)


class VideoSourceError(RuntimeError):
    """视频源打开失败。携带给用户看的完整、友好提示（已含 source 信息）。"""


class VideoSource:
    """统一视频源。

    典型用法::

        spec = parse_source("rtsp://user:pwd@1.2.3.4:554/s")
        with VideoSource(spec) as src:
            ok, frame = src.read()
    """

    def __init__(
        self,
        spec: SourceSpec,
        *,
        width: int = 640,
        height: int = 480,
        fps: int = 30,
        mirror: Optional[bool] = None,
        verbose: bool = True,
    ) -> None:
        """
        Args:
            spec: 解析好的视频源。
            width / height / fps: 期望参数（主要对摄像头生效，驱动不保证照做）。
            mirror: 是否水平镜像。``None`` 时**只有摄像头**默认镜像
                （人看自己的镜像更自然，且必须在检测前镜像）；文件 / 网络流不镜像。
            verbose: 是否打印 ``[Video] source: ...`` 启动日志。
        """
        self.spec = spec
        self.width = width
        self.height = height
        self.fps = fps
        self.mirror = spec.is_camera if mirror is None else bool(mirror)
        self.verbose = verbose
        self._capture: Optional[cv2.VideoCapture] = None

    # -- 生命周期 ---------------------------------------------------------
    def open(self) -> "VideoSource":
        """打开视频源；失败抛 :class:`VideoSourceError`（带友好提示）。"""
        # 本地文件先做存在性检查，给出比 OpenCV 更清晰的报错
        if self.spec.kind == SOURCE_FILE and not os.path.isfile(self.spec.value):
            raise VideoSourceError(self._error_message())

        capture = self._create_capture()
        if capture is None or not capture.isOpened():
            if capture is not None:
                capture.release()
            raise VideoSourceError(self._error_message())

        # 摄像头才需要改分辨率 / 帧率；网络流和文件保持原样，避免拖慢握手
        if self.spec.is_camera:
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
            capture.set(cv2.CAP_PROP_FPS, self.fps)
        # 缓冲设为 1：尽量拿最新帧，降低延迟（尤其是 RTSP/HTTP）
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        self._capture = capture
        if self.verbose:
            print(f"[Video] source: {self.spec.display}")
        return self

    def release(self) -> None:
        """释放底层 VideoCapture。"""
        if self._capture is not None:
            self._capture.release()
            self._capture = None

    def __enter__(self) -> "VideoSource":
        return self.open()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()

    # -- 读取 -------------------------------------------------------------
    def read(self) -> tuple[bool, Optional[np.ndarray]]:
        """读一帧，返回 ``(ok, frame)``；``ok=False`` 时 frame 为 ``None``。"""
        if self._capture is None:
            raise RuntimeError("视频源尚未打开，请先调用 open() 或用 with 语句。")

        ok, frame = self._capture.read()
        if not ok or frame is None:
            return False, None

        if self.mirror:
            frame = cv2.flip(frame, 1)
        return True, frame

    # -- 信息 -------------------------------------------------------------
    @property
    def actual_width(self) -> int:
        return int(self._capture.get(cv2.CAP_PROP_FRAME_WIDTH)) if self._capture else 0

    @property
    def actual_height(self) -> int:
        return int(self._capture.get(cv2.CAP_PROP_FRAME_HEIGHT)) if self._capture else 0

    @property
    def actual_fps(self) -> float:
        return float(self._capture.get(cv2.CAP_PROP_FPS)) if self._capture else 0.0

    # -- 内部 -------------------------------------------------------------
    def _create_capture(self) -> Optional[cv2.VideoCapture]:
        """按类型创建 ``cv2.VideoCapture``；打不开返回一个未打开的 capture。"""
        if self.spec.is_camera:
            index = self.spec.camera_index
            # Windows 上 CAP_DSHOW 打开更快、更少黑屏，优先尝试
            if _is_windows():
                capture = cv2.VideoCapture(index, getattr(cv2, "CAP_DSHOW", cv2.CAP_ANY))
                if capture.isOpened():
                    return capture
                capture.release()
            return cv2.VideoCapture(index)

        # 网络流 / 文件：优先 FFMPEG 后端（RTSP / HTTP-MJPEG 支持最好）
        backends = []
        if hasattr(cv2, "CAP_FFMPEG"):
            backends.append(cv2.CAP_FFMPEG)
        backends.append(cv2.CAP_ANY)

        last: Optional[cv2.VideoCapture] = None
        for backend in backends:
            capture = cv2.VideoCapture(self.spec.value, backend)
            if capture.isOpened():
                return capture
            capture.release()
            last = capture
        return last

    def _hint(self) -> str:
        """按视频源类型给出排查建议。"""
        if self.spec.kind == SOURCE_CAMERA:
            return "请检查摄像头是否连接、camera index 是否正确。"
        if self.spec.kind == SOURCE_RTSP:
            return "请检查 RTSP 地址、网络连接和账号密码。"
        if self.spec.kind == SOURCE_FILE:
            return "请检查文件路径是否正确。"
        return "请检查 URL 是否正确、网络是否可达、服务是否已启动。"

    def _error_message(self) -> str:
        return (
            "[Video] ERROR: 无法打开视频源\n"
            f"  source: {self.spec.display}\n"
            f"  {self._hint()}"
        )


def _is_windows() -> bool:
    return sys.platform.startswith("win")
