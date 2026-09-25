"""摄像头读取封装（OpenCV）。

单独成文件的原因：摄像头这块最容易出平台差异（Windows 上不同后端打开速度差很多），
把它和 Pose 检测解耦，出问题时能一眼看出是「读不到帧」还是「检测不到人」。
"""

from __future__ import annotations

from typing import Optional

import cv2
import numpy as np


class CameraStream:
    """OpenCV 摄像头流。

    典型用法::

        with CameraStream(device_id=0) as cam:
            ok, frame = cam.read()
    """

    def __init__(
        self,
        device_id: int = 0,
        *,
        width: int = 640,
        height: int = 480,
        fps: int = 30,
        mirror: bool = True,
    ) -> None:
        """
        Args:
            device_id: 摄像头序号，0 一般是默认摄像头。
            width: 期望画面宽度（驱动不一定会完全照做）。
            height: 期望画面高度。
            fps: 期望帧率。
            mirror: 是否水平镜像。**默认开启**，因为人看自己的镜像更自然；
                    而且镜像必须在检测**之前**做，否则左右手会和画面对不上。
        """
        self.device_id = device_id
        self.width = width
        self.height = height
        self.fps = fps
        self.mirror = mirror
        self._capture: Optional[cv2.VideoCapture] = None

    # -- 生命周期 ---------------------------------------------------------
    def open(self) -> "CameraStream":
        """打开摄像头，失败抛 RuntimeError。"""
        # Windows 上 CAP_DSHOW 打开更快、也更少出现黑屏，优先使用
        backend = getattr(cv2, "CAP_DSHOW", cv2.CAP_ANY) if _is_windows() else cv2.CAP_ANY
        capture = cv2.VideoCapture(self.device_id, backend)
        if not capture.isOpened():
            # 退一步用默认后端再试一次
            capture.release()
            capture = cv2.VideoCapture(self.device_id)
        if not capture.isOpened():
            raise RuntimeError(
                f"打不开摄像头 device_id={self.device_id}。"
                "请检查：摄像头是否被其他程序（会议软件等）占用、"
                "是否授予了相机权限，或换一个 --camera 编号试试。"
            )

        capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        capture.set(cv2.CAP_PROP_FPS, self.fps)
        # 缓冲设为 1，尽量拿到最新帧，降低延迟
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self._capture = capture
        return self

    def release(self) -> None:
        """释放摄像头。"""
        if self._capture is not None:
            self._capture.release()
            self._capture = None

    def __enter__(self) -> "CameraStream":
        return self.open()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()

    # -- 读取 -------------------------------------------------------------
    def read(self) -> tuple[bool, Optional[np.ndarray]]:
        """读一帧。

        Returns:
            ``(ok, frame)``。``ok`` 为 False 时 frame 可能是 None，
            调用方应跳过这一帧而不是直接崩溃（摄像头偶尔会读失败）。
        """
        if self._capture is None:
            raise RuntimeError("摄像头尚未打开，请先调用 open() 或用 with 语句。")

        ok, frame = self._capture.read()
        if not ok or frame is None:
            return False, None

        if self.mirror:
            # 水平翻转：np.fliplr 也行，这里用 cv2 更好衔接后续处理
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


def _is_windows() -> bool:
    import sys

    return sys.platform.startswith("win")
