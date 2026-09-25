"""演示入口：摄像头实时 Pose 检测 + 人物进出检测。

做两件事：
1. 把摄像头画面 + 人体骨架 + person_detected 状态实时显示出来（第一阶段）。
2. 把每帧的 person_detected 喂给 PresenceDetector，在终端打印
   [Presence] PERSON_ENTER / PERSON_LEFT / PERSON_RETURNED（第二阶段）。

本文件只负责「串流程」（组装 camera / detector / presence / visualizer），
不堆放具体算法实现，方便后续接桌宠前端时替换显示层。

运行：
    python -m vision.main
退出：
    在窗口里按 q 或 ESC，或者直接在终端 Ctrl+C。
"""

from __future__ import annotations

import argparse
import sys
import time

import cv2

from .camera import CameraStream
from .pose_detector import DEFAULT_MODEL_PATH, NUM_LANDMARKS, PoseDetector
from .presence_detector import PresenceDetector
from .visualizer import draw_pose_debug

WINDOW_NAME = "DeskPet Vision - Phase 1 Pose"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="摄像头实时人体姿态检测 + 人物进出检测（调试用）",
    )
    parser.add_argument("--camera", type=int, default=0, help="摄像头编号，默认 0")
    parser.add_argument("--width", type=int, default=640, help="画面宽度，默认 640")
    parser.add_argument("--height", type=int, default=480, help="画面高度，默认 480")
    parser.add_argument("--fps", type=int, default=30, help="期望帧率，默认 30")
    parser.add_argument(
        "--model",
        type=str,
        default=str(DEFAULT_MODEL_PATH),
        help="Pose 模型 .task 文件路径",
    )
    parser.add_argument(
        "--num-poses", type=int, default=1, help="最多检测几个人，默认 1"
    )
    parser.add_argument(
        "--min-detection-confidence",
        type=float,
        default=0.5,
        help="人体检测置信度阈值，默认 0.5",
    )
    parser.add_argument(
        "--no-mirror",
        action="store_true",
        help="关闭画面镜像（默认开启镜像，像照镜子）",
    )
    parser.add_argument(
        "--show-raw",
        action="store_true",
        help="额外弹一个窗口显示原始画面（不带标注），方便对比",
    )
    parser.add_argument(
        "--debug-labels",
        action="store_true",
        help="在画面上的每个关键点旁标注名字（很乱，仅排查用）",
    )
    # -- 第二阶段：人物进出检测的参数 --------------------------------------
    parser.add_argument(
        "--stable-frames",
        type=int,
        default=8,
        help="连续多少帧检测到人才算「真的来了」，默认 8（防抖，约 0.27s@30fps）",
    )
    parser.add_argument(
        "--absent-timeout",
        type=float,
        default=2.0,
        help="连续丢失多少秒才算「真的走了」，默认 2.0 秒",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    print("=" * 60)
    print("DeskPet Vision / Phase 1 —— 实时 Pose 检测")
    print(f"  模型      : {args.model}")
    print(f"  关键点数量: {NUM_LANDMARKS}")
    print(f"  摄像头    : {args.camera}  {args.width}x{args.height}")
    print(
        f"  进出检测  : 连续 {args.stable_frames} 帧命中算进入 / "
        f"丢失 {args.absent_timeout:g}s 算离开"
    )
    print("  退出      : 窗口内按 q 或 ESC（或终端 Ctrl+C）")
    print("=" * 60)

    # with 语句确保异常退出时也会释放摄像头和模型资源
    try:
        with CameraStream(
            device_id=args.camera,
            width=args.width,
            height=args.height,
            fps=args.fps,
            mirror=not args.no_mirror,
        ) as camera, PoseDetector(
            model_path=args.model,
            num_poses=args.num_poses,
            min_detection_confidence=args.min_detection_confidence,
        ) as detector:
            print(
                f"[camera] 实际分辨率 {camera.actual_width}x{camera.actual_height} "
                f"@ {camera.actual_fps:.0f}fps"
            )
            return _loop(camera, detector, args)
    except FileNotFoundError as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2
    except RuntimeError as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        print("\n[exit] 已通过 Ctrl+C 退出")
        return 0
    finally:
        cv2.destroyAllWindows()


def _loop(camera: CameraStream, detector: PoseDetector, args: argparse.Namespace) -> int:
    """主循环：读帧 → 检测 → 绘制 → 显示。"""
    # 第二阶段新增：人物进出检测（只消费 person_detected 布尔值，不碰画面）
    presence = PresenceDetector(
        stable_frames=args.stable_frames,
        absent_timeout=args.absent_timeout,
    )

    frame_count = 0
    fps = 0.0
    fps_timer = time.perf_counter()
    read_fail_count = 0

    while True:
        ok, frame = camera.read()
        if not ok or frame is None:
            # 摄像头偶尔会读失败，连续失败太多次才认为是真的坏了
            read_fail_count += 1
            if read_fail_count > 60:
                print("[错误] 连续 60 帧读取失败，退出。", file=sys.stderr)
                return 4
            continue
        read_fail_count = 0

        result = detector.detect(frame)

        # 第二阶段新增：把「这一帧有没有可靠人体」交给状态机。
        # 状态机内部做防抖 / 滞后，并在状态变化时自己打印 [Presence] 事件，
        # 所以这里不需要接收返回值（后续阶段才需要把事件发给 B）。
        presence.update(result.person_detected)

        annotated = draw_pose_debug(
            frame,
            result,
            fps=fps,
            draw_labels=args.debug_labels,
        )

        cv2.imshow(WINDOW_NAME, annotated)
        if args.show_raw:
            cv2.imshow("raw", frame)

        # 每 30 帧统计一次真实帧率，避免每帧算导致的数字乱跳
        frame_count += 1
        if frame_count % 30 == 0:
            now = time.perf_counter()
            fps = 30.0 / max(now - fps_timer, 1e-6)
            fps_timer = now

        # waitKey 既负责刷新窗口，也负责收键盘事件
        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), ord("Q"), 27):  # 27 = ESC
            print("[exit] 收到退出按键")
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
