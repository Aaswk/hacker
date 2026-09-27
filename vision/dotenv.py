"""零依赖 ``.env`` 加载器：把本机私有配置读进 ``os.environ``。

为什么需要它
--------------------------------------------------------------------------
:mod:`vision.vlm_client` / :mod:`vision.event_sender` 的配置**一律从环境变量读**
（这是刻意设计：密钥永不进代码、不进仓库），但本项目 venv 里没有 python-dotenv，
之前只能在每个终端手动 ``export VLM_API_KEY=...``，关掉终端就丢。
本模块用标准库复刻 dotenv 的最小行为：

    * 项目根目录的 ``.env``、``.env.local`` 依次读取（纯文本，UTF-8）；
    * **shell 里已经 export 的同名变量优先**，文件不会把它盖掉；
    * 多个文件之间：后读的（``.env.local``）覆盖先读的（``.env``）；
    * 支持 ``KEY=value``、``export KEY=value``、``# 注释``、空行、
      值两端单/双引号、值里含 ``=``；
    * 任何一行不合法只跳过，不抛异常 —— 配置问题不该让程序起不来。

密钥放哪
--------------------------------------------------------------------------
真实 key 只写进本机 ``.env``（已在 ``.gitignore`` 里），仓库里只留
``.env.example`` 这种不含密钥的模板。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Sequence

#: 默认读取的文件名，按「先低优先级、后高优先级」排列
ENV_FILE_NAMES: tuple[str, ...] = (".env", ".env.local")

#: 已经成功加载过的文件（供启动日志展示「配置从哪来」）
_LOADED_FILES: list[Path] = []


def project_root() -> Path:
    """项目根目录（``vision/`` 的上一级）。"""
    return Path(__file__).resolve().parent.parent


def loaded_files() -> tuple[Path, ...]:
    """返回本次运行中真正被读取到的 ``.env`` 文件（按读取顺序）。"""
    return tuple(_LOADED_FILES)


def parse_env_text(text: str) -> dict[str, str]:
    """把 ``.env`` 文本解析成 ``{KEY: value}``；无法识别的行直接忽略。"""
    values: dict[str, str] = {}

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        # 允许 `export KEY=value` 写法（从 shell 脚本里复制过来很常见）
        if line.startswith("export ") or line.startswith("export\t"):
            line = line[len("export") :].strip()

        key, separator, value = line.partition("=")
        if not separator:
            continue

        key = key.strip()
        if not _is_valid_key(key):
            continue

        value = value.strip()
        # 值两端成对的引号去掉（引号内可能包含 # 或空格）
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]

        values[key] = value

    return values


def load_dotenv(
    paths: Optional[Sequence[Path]] = None,
    *,
    override: bool = False,
) -> list[Path]:
    """把 ``.env`` 里的变量灌进 ``os.environ``，返回被读取到的文件列表。

    Args:
        paths: 要读取的文件；默认项目根目录下的 ``.env`` / ``.env.local``。
        override: 为 ``True`` 时连 shell 里已有的变量也覆盖（默认不覆盖）。
    """
    candidates = [Path(p) for p in paths] if paths else [
        project_root() / name for name in ENV_FILE_NAMES
    ]

    #: 本次由「文件」写进去的变量名：用于实现「文件之间后读的覆盖先读的，
    #: 但都不覆盖真正的 shell 环境变量」
    from_files: set[str] = set()
    touched: list[Path] = []

    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        used = False
        for key, value in parse_env_text(text).items():
            if key in from_files or override:
                os.environ[key] = value
                from_files.add(key)
                used = True
            elif key not in os.environ:
                os.environ[key] = value
                from_files.add(key)
                used = True

        if used:
            touched.append(path)
            if path not in _LOADED_FILES:
                _LOADED_FILES.append(path)

    return touched


def mask_secret(value: str, *, keep: int = 6) -> str:
    """把密钥打码后再打印：只留前若干位，其余用 ``*`` 代替。"""
    value = (value or "").strip()
    if not value:
        return "(空)"
    if len(value) <= keep:
        return "*" * len(value)
    return f"{value[:keep]}{'*' * (len(value) - keep)}"


def _is_valid_key(key: str) -> bool:
    """``KEY`` 必须是 ``[A-Za-z_][A-Za-z0-9_]*``，避免把乱码行当配置。"""
    if not key:
        return False
    if not (key[0].isalpha() or key[0] == "_"):
        return False
    return all(char.isalnum() or char == "_" for char in key)
