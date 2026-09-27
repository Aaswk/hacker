#!/usr/bin/env python3
"""视频源探测工具：找出「iPhone / USB / 内置」摄像头正确的 index，或验证网络流 URL。

用法
--------------------------------------------------------------------------
    python3 scripts/camera-probe.py                      # 扫描 camera index 0~4
    python3 scripts/camera-probe.py --indices 1 2        # 只试指定 index
    python3 scripts/camera-probe.py --url http://192.168.11.20:8080/video
    python3 scripts/camera-probe.py --url rtsp://192.168.11.20:8554/live --show

为什么需要它
--------------------------------------------------------------------------
* **连续互通相机**（把 iPhone 当 Mac 的摄像头用）会随连接状态出现 / 消失，
  index 并不固定，macOS 也不会告诉你「几号是 iPhone」；
* **IP 摄像头 App** 各家给的地址不一样（MJPEG 常见 ``/video``、``/live``，
  RTSP 常见 ``/live``、``/h264``、``/stream``），填错时 ``vision.main`` 只会
  抛一句「无法打开视频源」，看不出是哪一步的问题。

这里按 **和 ``vision.main`` 完全相同的解析与打开逻辑**（直接复用
:mod:`vision.video_source`）把候选源逐个试一遍，并把首帧存成 JPEG 给你肉眼确认。

输出
--------------------------------------------------------------------------
首帧默认存到 ``/tmp/human-observatory/probe/``（``--out`` 可改），
文件名带 index 或 URL 摘要。``--show`` 会额外弹窗预览（按 ``q`` / ``ESC`` 关闭）。

退出码
--------------------------------------------------------------------------
至少有一路成功 = ``0``，全部失败 = ``1``。

提示
--------------------------------------------------------------------------
* 正在跑 ``vision.main`` 时，内置摄像头（通常 index 0）已被占用，
  建议 ``--indices 1 2 3 4`` 避开它。
* 主机填错（如手机 IP 不对）时，OpenCV 可能要等几十秒才返回，可 ``Ctrl+C``。
* 想在后台跑并弹窗时，注意 macOS 上 OpenCV 的 ``waitKey`` 会读启动终端的按键，
  必须把 stdin 接到 ``/dev/null``（详见 README 第 5.3 节）。
"""

from __future__ import annotations

import argparse
import platform
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cv2  # noqa: E402  （必须先补 sys.path，才能 import vision 包）

from vision.video_source import (  # noqa: E402
    SOURCE_CAMERA,
    VideoSource,
    VideoSourceError,
    mask_credentials,
    parse_source,
)

DEFAULT_OUT = Path("/tmp/human-observatory/probe")
DEFAULT_INDICES = [0, 1, 2, 3, 4]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="探测可用的摄像头 index / 网络视频流，并保存首帧用于肉眼确认",
    )
    parser.add_argument(
        "--indices",
        type=int,
        nargs="+",
        default=None,
        help=f"要扫描的摄像头 index，默认 {' '.join(map(str, DEFAULT_INDICES))}",
    )
    parser.add_argument(
        "--url",
        type=str,
        nargs="+",
        default=None,
        help="要测试的网络流地址（可给多个），如 http://ip:8080/video 或 rtsp://ip:8554/live",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="首帧保存目录")
    parser.add_argument(
        "--reads",
        type=int,
        default=30,
        help="打开后最多重试读几帧再判定失败，默认 30（网络流刚握手时前几帧常为空）",
    )
    parser.add_argument("--width", type=int, default=640, help="期望宽度，默认 640")
    parser.add_argument("--height", type=int, default=480, help="期望高度，默认 480")
    parser.add_argument("--show", action="store_true", help="弹窗预览首帧（需人工按 q / ESC 关闭）")
    return parser.parse_args(argv)


def list_macos_cameras() -> list[str]:
    """macOS 上顺手列出系统认识的所有摄像头名字（含「连续互通相机」的 iPhone）。"""
    if platform.system() != "Darwin":
        return []
    try:
        result = subprocess.run(
            ["system_profiler", "SPCameraDataType"],
            capture_output=True, text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    names = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        # 形如：   内置摄像头： / iPhone 的摄像头： / FaceTime HD Camera:
        if not stripped or not stripped.endswith(("：", ":")):
            continue
        name = stripped.rstrip("：:").strip()
        # 跳过最外层的段标题（Camera: / 相机:），它不是设备名
        if name in ("Camera", "相机"):
            continue
        names.append(name)
    return names


def safe_filename(text: str) -> str:
    """把 URL / 路径变成安全的文件名片段。"""
    cleaned = mask_credentials(text)
    keep = [ch if (ch.isalnum() or ch in ".-_") else "-" for ch in cleaned]
    return "".join(keep).strip("-")[-48:] or "source"

def probe(spec, args: argparse.Namespace, out_dir: Path) -> bool:
    """打开一个视频源，读一帧存盘，打印结果；成功返回 True。"""
    label = spec.display
    print(f"\n▶ 尝试 {label}")
    started = time.time()
    source = VideoSource(spec, width=args.width, height=args.height, verbose=False)
    try:
        source.open()
    except VideoSourceError as exc:
        print(f"  ✗ 打不开（{time.time() - started:.1f}s）")
        for line in str(exc).splitlines():
            print(f"    {line}")
        return False
    except Exception as exc:  # 单个源的驱动异常不应中断整轮扫描
        print(f"  ✗ 异常：{type(exc).__name__}: {exc}")
        return False

    try:
        frame = None
        for _ in range(args.reads):
            ok, candidate = source.read()
            if ok and candidate is not None:
                frame = candidate
                break
            time.sleep(0.1)
        if frame is None:
            print(f"  ✗ 打开成功但读不到帧（试了 {args.reads} 次，共 {time.time() - started:.1f}s）")
            return False

        height, width = frame.shape[:2]
        if spec.kind == SOURCE_CAMERA:
            name = f"camera-{spec.camera_index}.jpg"
        else:
            name = f"stream-{safe_filename(spec.value)}.jpg"
        path = out_dir / name
        cv2.imwrite(str(path), frame)
        print(
            f"  ✓ 可用：{width}×{height}  OpenCV 报告帧率 {source.actual_fps:.1f}  "
            f"耗时 {time.time() - started:.1f}s"
        )
        print(f"    首帧已存：{path}")

        if args.show:
            window = f"probe: {label}"
            cv2.imshow(window, frame)
            print("    预览窗口已弹出：确认是不是 iPhone 拍的画面，按 q / ESC 关闭")
            while True:
                key = cv2.waitKey(30) & 0xFF
                if key in (ord("q"), ord("Q"), 27):
                    break
            cv2.destroyWindow(window)
        return True
    finally:
        source.release()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    indices = args.indices
    urls = args.url
    if indices is None and not urls:
        indices = list(DEFAULT_INDICES)

    print("=" * 68)
    print("视频源探测（解析与打开逻辑与 vision.main 完全一致）")
    print("=" * 68)

    names = list_macos_cameras()
    if names:
        print("\nmacOS 认识的摄像头（名字顺序不保证等于 index，最终以画面为准）：")
        for name in names:
            print(f"  · {name}")
        print("  提示：连上「连续互通相机」后再跑一次，这里会多出「iPhone 的摄像头」。")
    else:
        print("\n（非 macOS，或 system_profiler 没有返回摄像头列表）")

    print(f"\n首帧输出目录：{out_dir}")
    print(f"OpenCV {cv2.__version__}")

    ok_count = 0
    total = 0
    for index in indices or []:
        total += 1
        if probe(parse_source(str(index)), args, out_dir):
            ok_count += 1
    for url in urls or []:
        total += 1
        try:
            spec = parse_source(url)
        except ValueError as exc:
            print(f"\n▶ 跳过 {mask_credentials(url)}：{exc}")
            continue
        if probe(spec, args, out_dir):
            ok_count += 1

    print("\n" + "=" * 68)
    print(f"结果：{ok_count}/{total} 路可用")
    if ok_count:
        print("找到可用的源后，让 C 用它：")
        print("  python3 -u -m vision.main --source <上面的 index 或 URL>")
    else:
        print("一路都没成功，逐项自查：")
        print("  · iPhone 当摄像头（连续互通相机）：iPhone 与 Mac 同一 Apple ID、Wi-Fi 与蓝牙都开，")
        print("    iPhone「设置 → 通用 → 隔空播放与连续互通 → 连续互通相机」已打开，且 iPhone 未被占用；")
        print("  · IP 摄像头 App：手机与 Mac 在同一 WiFi、App 里已「开始广播」、地址抄写正确、")
        print("    手机保持前台不锁屏；")
        print("  · macOS 防火墙：首次可能弹窗询问是否允许 Python 接受连接，需要允许。")
    print("=" * 68)
    return 0 if ok_count else 1


if __name__ == "__main__":
    raise SystemExit(main())

