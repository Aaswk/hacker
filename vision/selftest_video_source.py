"""VideoSource 离线自测 —— 不需要真实摄像头 / RTSP / 后端。

运行：
    cd C:\\3G实验室\\hack\\hacker
    .\\.venv\\Scripts\\python.exe -m vision.selftest_video_source

覆盖：
    * 模块可 import
    * camera / file / rtsp / http 四种 source 参数解析
    * 未传 --source 时退回 --camera
    * RTSP URL 密码脱敏
    * 打不开的视频源抛出带友好提示的 VideoSourceError（不出现裸 OpenCV traceback）
    * 未 open() 就 read() 会明确报错
    * 镜像默认值：摄像头开、文件/网络流关

只要有一项 FAIL 就以退出码 1 结束。
"""

from __future__ import annotations

from .video_source import (
    SOURCE_CAMERA,
    SOURCE_FILE,
    SOURCE_HTTP,
    SOURCE_RTSP,
    VideoSource,
    VideoSourceError,
    mask_credentials,
    parse_source,
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


def main() -> int:
    print("=" * 60)
    print("VideoSource 离线自测")
    print("=" * 60)

    # -- 1 import ---------------------------------------------------------
    print("\n[1] 模块 import")
    check("1. vision.video_source 可 import", parse_source is not None)
    check(
        "1b. 四种类型常量齐备",
        {SOURCE_CAMERA, SOURCE_FILE, SOURCE_RTSP, SOURCE_HTTP}
        == {"camera", "file", "rtsp", "http"},
    )

    # -- 2 camera 解析 ----------------------------------------------------
    print("\n[2] camera source 解析")
    s = parse_source(None)
    check("2. 不传 --source → camera 0", s.kind == SOURCE_CAMERA and s.camera_index == 0)
    check("2b. --source '0' → camera 0", parse_source("0").camera_index == 0)
    check("2c. --source '1' → camera 1", parse_source("1").camera_index == 1)
    check(
        "2d. --source 为空 → 用 --camera 值",
        parse_source("", camera_index=2).camera_index == 2,
    )
    check("2e. display 形如 'camera 0'", parse_source(None).display == "camera 0")

    # -- 3 file 解析 ------------------------------------------------------
    print("\n[3] file source 解析")
    f1 = parse_source(r"D:\video\test.mp4")
    check("3. Windows 绝对路径 → file", f1.kind == SOURCE_FILE and f1.value == r"D:\video\test.mp4")
    f2 = parse_source("clips/a.mkv")
    check("3b. 相对路径 → file", f2.kind == SOURCE_FILE)
    check("3c. display 原样输出路径", f1.display == r"D:\video\test.mp4")

    # -- 4 rtsp 解析 ------------------------------------------------------
    print("\n[4] rtsp source 解析")
    r = parse_source("rtsp://user:pass@192.168.1.100:554/stream")
    check("4. rtsp:// → rtsp", r.kind == SOURCE_RTSP)
    check("4b. rtsps:// → rtsp", parse_source("rtsps://h/s").kind == SOURCE_RTSP)
    check(
        "4c. rtsp display 密码脱敏",
        r.display == "rtsp://user:****@192.168.1.100:554/stream",
        f"实际={r.display}",
    )
    check(
        "4d. 密码原文不出现在 display 里",
        "pass" not in r.display,
    )

    # -- 5 http 解析 ------------------------------------------------------
    print("\n[5] http source 解析")
    h = parse_source("http://192.168.1.5:8080/video")
    check("5. http:// → http", h.kind == SOURCE_HTTP)
    check("5b. https:// → http", parse_source("https://cam/live").kind == SOURCE_HTTP)
    check(
        "5c. http 带凭据也脱敏",
        mask_credentials("http://a:b@host/v") == "http://a:****@host/v",
    )

    # -- 6 镜像默认值 -----------------------------------------------------
    print("\n[6] 镜像默认值")
    check("6. 摄像头默认镜像", VideoSource(parse_source("0")).mirror is True)
    check("6b. 文件默认不镜像", VideoSource(parse_source("x.mp4")).mirror is False)
    check("6c. 网络流默认不镜像", VideoSource(parse_source("rtsp://h/s")).mirror is False)

    # -- 7 打不开的视频源 → 友好报错 -------------------------------------
    print("\n[7] 视频源打开失败的友好报错")
    try:
        VideoSource(parse_source(r"D:\definitely\not\here.mp4"), verbose=False).open()
        check("7. 不存在的文件应抛 VideoSourceError", False, "没有抛异常")
    except VideoSourceError as exc:
        text = str(exc)
        check("7. 不存在的文件抛 VideoSourceError", True)
        check("7b. 含 '[Video] ERROR: 无法打开视频源'", "[Video] ERROR: 无法打开视频源" in text)
        check("7c. 含 source 信息", "not\\here.mp4" in text)
        check("7d. 含文件类排查提示", "请检查文件路径是否正确。" in text)
    except Exception as exc:  # noqa: BLE001
        check("7. 不存在的文件抛 VideoSourceError", False, f"抛了 {exc!r}")

    # 摄像头提示文案单独校验（不真的开摄像头）
    cam = VideoSource(parse_source("0"), verbose=False)
    check(
        "7e. 摄像头排查提示正确",
        "请检查摄像头是否连接、camera index 是否正确。" in cam._error_message(),
    )
    rts = VideoSource(parse_source("rtsp://h/s"), verbose=False)
    check(
        "7f. RTSP 排查提示正确",
        "请检查 RTSP 地址、网络连接和账号密码。" in rts._error_message(),
    )

    # -- 8 未 open 就 read ------------------------------------------------
    print("\n[8] 未打开就读取")
    try:
        VideoSource(parse_source("0"), verbose=False).read()
        check("8. 未 open() 就 read() 应抛 RuntimeError", False, "没有抛异常")
    except RuntimeError:
        check("8. 未 open() 就 read() 抛 RuntimeError", True)

    print("\n" + "=" * 60)
    print(f"结果：{_PASS} PASS / {_FAIL} FAIL")
    print("=" * 60)
    return 1 if _FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
