"""演示入口：摄像头实时 Pose 检测 + 人物进出检测 + 伸展检测 + 喝水检测。

做四件事：
1. 把摄像头画面 + 人体骨架 + person_detected 状态实时显示出来（1.1）。
2. 把每帧的 person_detected 喂给 PresenceDetector，在终端打印
   [Presence] PERSON_ENTER / PERSON_LEFT / PERSON_RETURNED（1.2）。
3. 把每帧的关键点喂给 StretchingDetector，双手举过头顶并保持一小段时间时
   在终端打印 [Stretching] STRETCHING（1.3）。
4. 把每帧的原始帧 + 关键点喂给 DrinkingVlmDetector（1.4）：
   Pose 只负责发现「疑似喝水」，连续若干帧后截取关键帧，
   交给 VLM 看图裁决，确认喝水时在终端打印 [Drinking] DRINKING。
   （旧版纯 Pose 规则判断已停用，见 drinking_detector.py 顶部弃用说明。）

本文件只负责「串流程」（组装 camera / detector / presence / stretching /
drinking / visualizer），不堆放具体算法实现，方便后续接桌宠前端时替换显示层。

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

from .drinking_vlm_detector import DrinkingVlmDetector
from .event_manager import EventManager
from .event_sender import ENV_BACKEND_BASE_URL, BackendConfig
from .pose_detector import DEFAULT_MODEL_PATH, NUM_LANDMARKS, PoseDetector
from .presence_detector import PresenceDetector
from .stretching_detector import StretchingDetector
from .dotenv import loaded_files
from .video_source import VideoSource, VideoSourceError, parse_source
from .visualizer import draw_pose_debug
from .vlm_client import VlmConfig

WINDOW_NAME = "DeskPet Vision - Phase 1 Pose"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="摄像头实时人体姿态检测 + 人物进出检测 + 伸展检测 + 喝水检测（调试用）",
    )
    parser.add_argument("--camera", type=int, default=0, help="摄像头编号，默认 0")
    parser.add_argument(
        "--source",
        type=str,
        default=None,
        help=(
            "统一视频源；不填则用 --camera。支持：数字=摄像头 index、"
            "rtsp://... 、http(s)://... 、本地视频文件路径（如 D:\\video\\test.mp4）"
        ),
    )
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
    # -- 1.3 伸展检测的参数 ------------------------------------------------
    parser.add_argument(
        "--stretch-hold",
        type=float,
        default=0.6,
        help="双手举过头顶需要连续保持几秒才算伸展，默认 0.6 秒",
    )
    parser.add_argument(
        "--stretch-cooldown",
        type=float,
        default=5.0,
        help="两次 STRETCHING 事件的最小间隔秒数，默认 5.0（连续测试可调小）",
    )
    # -- 1.4 喝水检测（Pose 疑似 + VLM 裁决）的参数 -----------------------
    parser.add_argument(
        "--drink-trigger-frames",
        type=int,
        default=5,
        help="连续多少帧疑似喝水才触发一次 VLM 调用，默认 5（防抖，约 0.17s@30fps）",
    )
    parser.add_argument(
        "--drink-cooldown",
        type=float,
        default=15.0,
        help="两次 VLM 调用的最小间隔秒数，默认 15.0（对 DRINKING 和 NONE 都生效）",
    )
    parser.add_argument(
        "--drink-trigger-distance",
        type=float,
        default=0.30,
        help="疑似判定：手腕到嘴部的最大归一化距离，默认 0.30（刻意宽松，交 VLM 裁决）",
    )
    parser.add_argument(
        "--drink-keyframes",
        type=int,
        default=3,
        help="每次送给 VLM 的关键帧张数（1~3），默认 3",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    # 解析统一的视频源（不传 --source 时退回 --camera，默认摄像头 0）
    try:
        spec = parse_source(args.source, camera_index=args.camera)
    except ValueError as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2

    print("=" * 60)
    print("DeskPet Vision / Phase 1 —— 实时 Pose 检测")
    print(f"  模型      : {args.model}")
    print(f"  关键点数量: {NUM_LANDMARKS}")
    print(f"  视频源    : {spec.display}  {args.width}x{args.height}")
    print(
        f"  进出检测  : 连续 {args.stable_frames} 帧命中算进入 / "
        f"丢失 {args.absent_timeout:g}s 算离开"
    )
    print(
        f"  伸展检测  : 双手举过头顶保持 {args.stretch_hold:g}s 触发 / "
        f"冷却 {args.stretch_cooldown:g}s"
    )
    # 配置来源：shell 环境变量，或项目根目录的 .env（由 vision 包导入时自动加载）
    vlm_config = VlmConfig.from_env()
    if vlm_config.is_configured:
        env_files = loaded_files()
        origin = f".env: {env_files[-1].name}" if env_files else "环境变量"
        vlm_line = (
            f"模型 {vlm_config.model} / {vlm_config.base_url}（{origin}）"
        )
    else:
        vlm_line = (
            "未配置（未检测到 VLM_API_KEY，喝水检测将直接返回 NONE）\n"
            "              把 VLM_API_KEY 写进项目根目录 .env，或 export 到环境变量；"
            "详见 .env.example"
        )
    print(
        f"  喝水检测  : Pose 疑似连续 {args.drink_trigger_frames} 帧 → 截 "
        f"{args.drink_keyframes} 张关键帧 → VLM / 冷却 {args.drink_cooldown:g}s"
    )
    print(f"  VLM       : {vlm_line}")
    backend = BackendConfig.from_env()
    if backend.is_configured:
        backend_line = f"POST {backend.events_url}"
    else:
        backend_line = (
            f"未配置（未检测到 {ENV_BACKEND_BASE_URL}，事件只打印不发送）"
        )
    print(f"  事件上报  : {backend_line}")
    print("  退出      : 窗口内按 q 或 ESC（或终端 Ctrl+C）")
    print("=" * 60)

    # with 语句确保异常退出时也会释放视频源和模型资源
    try:
        with VideoSource(
            spec,
            width=args.width,
            height=args.height,
            fps=args.fps,
            # 仅摄像头默认镜像；文件 / 网络流不镜像（除非显式关掉 --no-mirror 的语义）
            mirror=(not args.no_mirror) and spec.is_camera,
        ) as camera, PoseDetector(
            model_path=args.model,
            num_poses=args.num_poses,
            min_detection_confidence=args.min_detection_confidence,
        ) as detector:
            print(
                f"[Video] 实际分辨率 {camera.actual_width}x{camera.actual_height} "
                f"@ {camera.actual_fps:.0f}fps"
            )
            return _loop(camera, detector, args)
    except VideoSourceError as exc:
        # 视频源打不开：错误信息已由 VideoSource 组织好，原样打印（含 [Video] ERROR）
        print(str(exc), file=sys.stderr)
        return 5
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


def _loop(camera: VideoSource, detector: PoseDetector, args: argparse.Namespace) -> int:
    """主循环：读帧 → 检测 → 绘制 → 显示。"""
    # 第二阶段新增：人物进出检测（只消费 person_detected 布尔值，不碰画面）
    presence = PresenceDetector(
        stable_frames=args.stable_frames,
        absent_timeout=args.absent_timeout,
    )
    # 1.3 新增：伸展检测（需要看关键点，所以消费整个 PoseResult）
    stretching = StretchingDetector(
        hold_seconds=args.stretch_hold,
        cooldown_seconds=args.stretch_cooldown,
    )
    # 1.4 新增：喝水检测（Pose 疑似 → 关键帧 → VLM 裁决）。
    # 关键点是按画面宽高分别归一化的，所以把真实宽高比传进去，
    # 让「手腕到嘴部距离」的计算不受分辨率比例影响。
    camera_aspect = (
        camera.actual_width / camera.actual_height
        if camera.actual_height
        else 4.0 / 3.0
    )
    drinking = DrinkingVlmDetector(
        trigger_frames=args.drink_trigger_frames,
        cooldown_seconds=args.drink_cooldown,
        trigger_distance=args.drink_trigger_distance,
        aspect_ratio=camera_aspect,
        keyframes=args.drink_keyframes,
    )

    # Stage 1 末段新增：统一事件管理器，把识别结果转成协议 JSON 并异步上报。
    # 内部用 EventSender（后台 daemon 线程），未配置 BACKEND_BASE_URL 时只打印
    # 日志、不发送，也不会影响下面主循环。
    event_manager = EventManager()

    frame_count = 0
    fps = 0.0
    fps_timer = time.perf_counter()
    read_fail_count = 0

    try:
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

            # 第二阶段：人物进出检测。状态机内部做防抖 / 滞后，只在状态变化时
            # 返回事件（PERSON_ENTER / PERSON_LEFT / PERSON_RETURNED），
            # 其余帧返回 None；事件交给 EventManager 转成协议 JSON。
            presence_event = presence.update(result.person_detected)

            # 1.3：伸展检测。只在真正触发时返回 STRETCHING（连续保持只报一次），
            # 其余帧返回 None。
            stretching_event = stretching.update(result)

            # 1.4：喝水检测（Pose 疑似 → 关键帧 → 异步 VLM 裁决）。
            # 注意要传原始帧（截关键帧用）；VLM 在后台线程跑，这里不阻塞。
            # verdict 可能是 NONE（含 VLM 调用失败的 NONE），只有确认为
            # DRINKING 才会由 EventManager 发事件。
            verdict = drinking.update(frame, result)
            if verdict is not None and verdict.is_drinking:
                print(
                    f"[Drinking] {verdict.action} "
                    f"(confidence={verdict.confidence:.2f}, "
                    f"timestamp={verdict.timestamp:.0f})"
                )

            # 统一上报：三个 detector 只在真正发生事件时才返回事件值，
            # EventManager 内部再做一次「同一事件周期内不重复」的去重。
            event_manager.handle_presence(presence_event)
            event_manager.handle_stretching(stretching_event)
            event_manager.handle_drinking(verdict)

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
    finally:
        # 退出前把后台队列里的事件尽量发完，避免丢事件
        event_manager.close()


if __name__ == "__main__":
    raise SystemExit(main())
