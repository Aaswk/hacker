"""VLM **真实调用**探针 —— 用本机 ``.env`` 里的 key 真发一次请求，自证链路通。

和 :mod:`vision.selftest_drinking_vlm` 的分工
--------------------------------------------------------------------------
* ``selftest_drinking_vlm``：**离线**自测，用假 VLM 覆盖 Detector 的分支逻辑，
  不联网、不需要 key、需要 numpy/cv2。
* 本文件：**联网**探针，只回答一个问题 ——
  「这把 key + 这个 base_url + 这个模型，能不能看图、能不能按约定回 JSON？」
  喝水裁决（:mod:`vision.drinking_vlm_detector`）走的就是这条链路，
  所以这里通了，真跑摄像头时 VLM 这一步就没问题。

它只依赖 :mod:`vision.vlm_client`（纯标准库），**不 import cv2 / numpy**，
因此没装视觉依赖的机器（例如只跑 VLM 的 Mac）也能用来排查配置。

覆盖三件事
--------------------------------------------------------------------------
1. 配置检查：``.env`` 是否被读到、key 打码打印、base_url / model / timeout；
2. 文本往返：发一次纯文本请求，验证 key、网络、OpenAI 兼容协议、JSON 解析；
3. 图片往返（``--image`` 给了才做）：发一张真实 JPEG，验证多模态（图片能传进去）。

用法::

    python -m vision.selftest_vlm_live                       # 配置 + 文本往返
    python -m vision.selftest_vlm_live --image frame.jpg     # 再验证一次图片往返

全部通过退出码 0，有 FAIL 退出码 1。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

from .dotenv import ENV_FILE_NAMES, loaded_files, mask_secret
from .vlm_client import (
    VlmClient,
    VlmConfig,
    VlmError,
    VlmResponseError,
)

_PASS = 0
_FAIL = 0

#: 文本往返用的 prompt：要求回一个形状固定的 JSON，便于断言
TEXT_PROMPT = (
    "Reply with ONE JSON object and nothing else, no markdown fence. "
    'The JSON must be exactly: {"ok": true, "echo": "hello"}'
)

#: 图片往返用的 prompt：形状对齐「看图后回 JSON」的用法（喝水裁决同理）
IMAGE_PROMPT = (
    "Look at the image and reply with ONE JSON object and nothing else "
    "(no markdown fence), in this shape: "
    '{"has_text": <true|false>, "objects": ["<object>", ...], '
    '"summary": "<one short Chinese sentence describing the image>"}'
)


def check(name: str, condition: bool, detail: str = "") -> None:
    global _PASS, _FAIL
    if condition:
        _PASS += 1
        print(f"  [PASS] {name}")
    else:
        _FAIL += 1
        print(f"  [FAIL] {name} {detail}".rstrip())


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="VLM 真实调用探针（读根目录 .env 的 VLM_API_KEY，真发一次请求）",
    )
    parser.add_argument(
        "--image",
        default=None,
        help="可选：一张 JPEG/PNG 的路径，给了就额外验证「图片能传进去」",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="覆盖配置里的超时秒数（默认用 VLM_TIMEOUT，缺省 15）",
    )
    return parser.parse_args(argv)


def describe_config(config: VlmConfig) -> None:
    """把「配置从哪来」打印清楚，配置问题一眼可见。"""
    files = loaded_files()
    print("配置")
    if files:
        for path in files:
            print(f"  .env      : {path}")
    else:
        print(
            f"  .env      : 未读到（可在项目根目录建 {ENV_FILE_NAMES[0]}，"
            "或直接 export 环境变量）"
        )
    print(f"  VLM_API_KEY : {mask_secret(config.api_key)}")
    print(f"  VLM_BASE_URL: {config.base_url}")
    print(f"  VLM_MODEL   : {config.model}")
    print(f"  VLM_TIMEOUT : {config.timeout:g}s")
    print(f"  请求地址    : {config.chat_url}")


def explain(error: VlmError) -> str:
    """把异常翻译成「大概率是什么问题」，省去翻日志猜。"""
    text = str(error)
    if isinstance(error, VlmResponseError):
        return text
    lowered = text.lower()
    if " 401" in lowered or " 403" in lowered:
        return f"{text}\n         → key 不对 / 被停用：检查 .env 里 VLM_API_KEY 是否完整"
    if " 400" in lowered or " 404" in lowered:
        return f"{text}\n         → 多半是模型名不对：检查 .env 里 VLM_MODEL"
    if "超时" in text:
        return f"{text}\n         → 网络慢或图片太大：可调大 VLM_TIMEOUT"
    if "无法连接" in text:
        return f"{text}\n         → 网络 / 代理问题：确认能访问 VLM_BASE_URL"
    return text


def test_text_roundtrip(client: VlmClient, timeout: Optional[float]) -> Optional[dict]:
    print("\nT1 文本往返（验证 key / 网络 / OpenAI 兼容协议 / JSON 解析）")
    try:
        data = client.ask_json(TEXT_PROMPT, [], timeout=timeout)
    except VlmError as exc:
        check("文本请求成功", False, f": {explain(exc)}")
        return None

    check("文本请求成功", True)
    check("返回是 JSON 对象", isinstance(data, dict), str(data))
    check("返回含 ok 字段", "ok" in data, str(data))
    check("ok 为真", bool(data.get("ok")) is True, str(data.get("ok")))
    print(f"  原始返回    : {json.dumps(data, ensure_ascii=False)}")
    return data


def test_image_roundtrip(
    client: VlmClient, image_path: Path, timeout: Optional[float]
) -> Optional[dict]:
    print(f"\nT2 图片往返（{image_path.name}，验证多模态：图片真的传进去了）")
    try:
        image_bytes = image_path.read_bytes()
    except OSError as exc:
        check("读取图片", False, f": {exc}")
        return None
    check("读取图片", True, f"：{len(image_bytes)} 字节")
    if not image_bytes:
        check("图片非空", False)
        return None

    try:
        data = client.ask_json(IMAGE_PROMPT, [image_bytes], timeout=timeout)
    except VlmError as exc:
        check("图片请求成功", False, f": {explain(exc)}")
        return None

    check("图片请求成功", True)
    check("返回是 JSON 对象", isinstance(data, dict), str(data))
    check("返回含 summary", "summary" in data, str(data))
    summary = str(data.get("summary") or "").strip()
    check("summary 非空", bool(summary), "模型没给出描述")
    if summary:
        print(f"  模型看到的  : {summary}")
    print(f"  原始返回    : {json.dumps(data, ensure_ascii=False)}")
    return data


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)

    print("=" * 60)
    print("VLM 真实调用探针 —— 联网 / 不依赖 cv2·numpy / 不碰摄像头")
    print("=" * 60)

    config = VlmConfig.from_env()
    describe_config(config)

    if not config.is_configured:
        print(
            "\n[跳过] 没有 VLM_API_KEY：把 key 写进项目根目录的 .env 后重跑，例如\n"
            "       VLM_API_KEY=sk-xxxx\n"
            "       （.env 已在 .gitignore 里，不会被提交）"
        )
        print("\n" + "=" * 60)
        print("结果：0 PASS / 1 FAIL")
        print("=" * 60)
        return 1

    client = VlmClient(config)
    test_text_roundtrip(client, args.timeout)

    if args.image:
        image_path = Path(args.image).expanduser()
        if not image_path.is_file():
            check("图片文件存在", False, f": 找不到 {image_path}")
        else:
            test_image_roundtrip(client, image_path, args.timeout)
    else:
        print("\nT2 图片往返：跳过（没给 --image）")
        print("  想验证「看图」这一步，加一张真实照片：")
        print("    python -m vision.selftest_vlm_live --image /path/to/frame.jpg")

    print("\n" + "=" * 60)
    print(f"结果：{_PASS} PASS / {_FAIL} FAIL")
    print("=" * 60)
    return 0 if _FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
