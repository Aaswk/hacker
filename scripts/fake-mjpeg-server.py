#!/usr/bin/env python3
"""假 MJPEG 服务 —— 没有手机时，用它验证「C 吃网络视频源」这条链路。

为什么需要它：6.5 节的「用 iPhone 当 C 的视频源」里，Mac 这一侧（地址 → 打开 → 取帧 → 进管线）
是可以离线验证的，真正只能在手机上试的只有「IP 摄像头 App 会不会按你期望的地址吐流」。
本脚本就充当那个手机：按 MJPEG（`multipart/x-mixed-replace`）吐一个人造画面，
于是整条链路可以端到端跑通、且结果可复现。

用法：

    python3 scripts/fake-mjpeg-server.py &                  # 默认 127.0.0.1:8099/video
    python3 scripts/camera-probe.py --url http://127.0.0.1:8099/video
    python3 -u -m vision.main --source http://127.0.0.1:8099/video </dev/null
    pkill -f fake-mjpeg-server.py                           # 记得收尾

退出：Ctrl+C，或 `pkill -f fake-mjpeg-server.py`。
"""

from __future__ import annotations

import argparse
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

BOUNDARY = "frame"


def render_frame(width: int, height: int) -> np.ndarray:
    """画一帧：底色 + 会横向来回移动的绿球 + 文字，方便肉眼确认「画面在动」。"""
    img = np.zeros((height, width, 3), np.uint8)
    img[:] = (60, 90, 130)  # BGR：偏棕，和真实场景区分开
    text = "FAKE MJPEG"
    scale = max(width / 640.0, 0.5)
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 1.6 * scale, 3)
    cv2.putText(
        img,
        text,
        ((width - tw) // 2, height // 2),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.6 * scale,
        (255, 255, 255),
        3,
    )
    cx = int(width / 2 + (width / 2 - 40) * np.sin(time.time() * 2.0))
    cv2.circle(img, (cx, int(height * 0.25)), int(30 * scale), (0, 255, 0), -1)
    return img


class MjpegHandler(BaseHTTPRequestHandler):
    """只服务一个路径：/video。其余一律 404，避免误当成可用源。"""

    server_version = "FakeMjpeg/1.0"

    def do_GET(self) -> None:  # noqa: N802（stdlib 规定的命名）
        if self.path.split("?")[0] != self.server.stream_path:  # type: ignore[attr-defined]
            self.send_error(404, "only the configured stream path is served")
            return

        self.send_response(200)
        self.send_header(
            "Content-Type", f"multipart/x-mixed-replace; boundary={BOUNDARY}"
        )
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        interval = 1.0 / max(self.server.fps, 1)  # type: ignore[attr-defined]
        try:
            while True:
                img = render_frame(self.server.width, self.server.height)  # type: ignore[attr-defined]
                ok, jpg = cv2.imencode(
                    ".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), self.server.quality]  # type: ignore[attr-defined]
                )
                if not ok:
                    continue
                payload = jpg.tobytes()
                self.wfile.write(
                    f"--{BOUNDARY}\r\n".encode()
                    + b"Content-Type: image/jpeg\r\n"
                    + f"Content-Length: {len(payload)}\r\n\r\n".encode()
                    + payload
                    + b"\r\n"
                )
                time.sleep(interval)
        except (BrokenPipeError, ConnectionResetError):
            # 客户端（C / 探测脚本）断开，正常现象
            pass

    def log_message(self, fmt: str, *args) -> None:  # 静音访问日志，日志留给 C
        pass


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="假 MJPEG 服务：没有手机 / 摄像头时，用它验证 C 能吃网络视频源"
    )
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=8099, help="监听端口，默认 8099")
    parser.add_argument("--path", default="/video", help="流路径，默认 /video")
    parser.add_argument("--fps", type=float, default=15.0, help="发送帧率，默认 15")
    parser.add_argument("--width", type=int, default=640, help="画面宽度，默认 640")
    parser.add_argument("--height", type=int, default=480, help="画面高度，默认 480")
    parser.add_argument("--quality", type=int, default=80, help="JPEG 质量，默认 80")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    server = ThreadingHTTPServer((args.host, args.port), MjpegHandler)
    # 把渲染参数挂到 server 上，handler 里直接取（stdlib handler 不方便传参）
    server.stream_path = args.path  # type: ignore[attr-defined]
    server.fps = args.fps  # type: ignore[attr-defined]
    server.width = args.width  # type: ignore[attr-defined]
    server.height = args.height  # type: ignore[attr-defined]
    server.quality = args.quality  # type: ignore[attr-defined]

    url = f"http://{args.host}:{args.port}{args.path}"
    print(f"假 MJPEG 服务已启动：{url}  （{args.width}x{args.height} @ {args.fps}fps）")
    print("  下一步：python3 scripts/camera-probe.py --url " + url)
    print("  再：    python3 -u -m vision.main --source " + url + " </dev/null")
    print("  收尾：  pkill -f fake-mjpeg-server.py")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
