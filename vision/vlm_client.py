"""通用 VLM（视觉语言模型）客户端：OpenAI 兼容 ``/chat/completions`` 协议。

设计目标
--------------------------------------------------------------------------
* **零新增依赖**：项目 venv 里没有 requests / openai / httpx，
  这里只用标准库 ``urllib.request`` 发 HTTP，避免为了一个喝水判断就动
  requirements.txt。
* **配置全部走环境变量**，禁止把 key 写进代码：
      VLM_API_KEY    必填，没有它就无法调用（抛 :class:`VlmConfigError`）
      VLM_BASE_URL   默认 https://dashscope.aliyuncs.com/compatible-mode/v1
      VLM_MODEL      默认 qwen-vl-plus
      VLM_TIMEOUT    默认 15.0 秒
* **把失败分类成异常**，方便上层区分「配置缺失 / 网络请求失败 / 返回内容
  不是合法 JSON」，从而决定怎么降级，而不是整个主循环崩掉。

本模块只负责「把图片和 prompt 发出去、把 JSON 拿回来」，
不包含任何喝水业务判断（那属于 drinking_vlm_detector）。
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional, Sequence

#: 未显式配置时的默认地址（OpenAI 兼容模式，DashScope / 通义千问）
DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
#: 未显式配置时的默认模型
DEFAULT_MODEL = "qwen-vl-plus"
#: 未显式配置时的默认超时（秒）
DEFAULT_TIMEOUT = 15.0


class VlmError(RuntimeError):
    """所有 VLM 相关错误的基类。"""


class VlmConfigError(VlmError):
    """配置缺失/非法（最典型：没有设置 VLM_API_KEY）。"""


class VlmRequestError(VlmError):
    """请求阶段失败：超时、连不上、HTTP 非 2xx。"""


class VlmResponseError(VlmError):
    """请求成功但内容不可用：结构不对、不是合法 JSON。"""


@dataclass(frozen=True)
class VlmConfig:
    """VLM 连接配置。优先从环境变量读取。"""

    api_key: str
    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    timeout: float = DEFAULT_TIMEOUT

    @classmethod
    def from_env(cls) -> "VlmConfig":
        """从环境变量读取配置；缺失项用默认值兜底。"""
        raw_timeout = os.environ.get("VLM_TIMEOUT", "").strip()
        try:
            timeout = float(raw_timeout) if raw_timeout else DEFAULT_TIMEOUT
        except ValueError:
            timeout = DEFAULT_TIMEOUT

        return cls(
            api_key=os.environ.get("VLM_API_KEY", "").strip(),
            base_url=(
                os.environ.get("VLM_BASE_URL", "").strip().rstrip("/")
                or DEFAULT_BASE_URL
            ),
            model=os.environ.get("VLM_MODEL", "").strip() or DEFAULT_MODEL,
            timeout=timeout,
        )

    @property
    def is_configured(self) -> bool:
        """是否具备调用条件（至少要有 key）。"""
        return bool(self.api_key)

    @property
    def chat_url(self) -> str:
        return f"{self.base_url}/chat/completions"


def parse_json_text(text: str) -> dict:
    """从模型返回的文本里尽力抠出一个 JSON 对象。

    真实模型常常不老实，会带 ```json 围栏、前后加一句解释，
    所以这里先尝试直接 ``json.loads``，失败再去掉围栏、截取首个 ``{``
    到末个 ``}`` 再解析。

    Raises:
        VlmResponseError: 怎么都解析不出 JSON 对象时。
    """
    if not isinstance(text, str) or not text.strip():
        raise VlmResponseError("模型返回内容为空")

    candidate = text.strip()

    # 1) 直接解析
    try:
        data = json.loads(candidate)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass

    # 2) 去掉 ``` / ```json 围栏
    if candidate.startswith("```"):
        lines = candidate.splitlines()
        # 丢掉第一行（``` 或 ```json）和可能的结尾 ```
        if lines and lines[0].strip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        candidate = "\n".join(lines).strip()

    # 3) 截取首个 { 到末个 }
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidate = candidate[start : end + 1]

    try:
        data = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise VlmResponseError(f"模型返回不是合法 JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise VlmResponseError("模型返回的 JSON 不是对象")
    return data


def _extract_content(raw: dict) -> str:
    """从 OpenAI 兼容响应体里取出 assistant 的文本内容。"""
    try:
        choices = raw["choices"]
        message = choices[0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise VlmResponseError(f"响应结构异常，缺少 choices/message: {exc}") from exc

    content = message.get("content")
    # 有些服务会把 content 返回成 [{type, text}, ...] 形式
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and "text" in item:
                parts.append(str(item["text"]))
            elif isinstance(item, str):
                parts.append(item)
        content = "".join(parts)

    if not isinstance(content, str) or not content.strip():
        raise VlmResponseError("响应里没有可用的文本内容")
    return content


class VlmClient:
    """最小可用的 OpenAI 兼容 VLM 客户端。"""

    def __init__(self, config: Optional[VlmConfig] = None) -> None:
        self.config = config or VlmConfig.from_env()

    def ask_json(
        self,
        prompt: str,
        images: Sequence[bytes],
        *,
        system: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> dict:
        """发一次多模态请求，并把返回文本解析成 dict。

        Args:
            prompt: 用户指令（业务问题）。
            images: 图片列表，每张是 **JPEG/PNG 的原始字节**，
                这里会自动转成 base64 data URL。
            system: 可选的 system prompt。
            timeout: 覆盖配置里的超时。

        Raises:
            VlmConfigError: 没有配置 key。
            VlmRequestError: 超时 / 连接失败 / HTTP 非 2xx。
            VlmResponseError: 返回内容不是合法 JSON 对象。
        """
        if not self.config.is_configured:
            raise VlmConfigError(
                "未配置 VLM_API_KEY，无法调用 VLM（请设置环境变量后重试）"
            )

        content: list[dict] = [{"type": "text", "text": prompt}]
        for image_bytes in images:
            if not image_bytes:
                continue
            b64 = base64.b64encode(image_bytes).decode("ascii")
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                }
            )

        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": content})

        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": 0,
        }
        raw = self._post_json(payload, timeout=timeout)
        return parse_json_text(_extract_content(raw))

    def _post_json(self, payload: dict, *, timeout: Optional[float] = None) -> dict:
        """底层 HTTP POST，返回解析后的响应体 dict。"""
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.config.chat_url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.config.api_key}",
            },
        )
        effective_timeout = timeout or self.config.timeout

        try:
            with urllib.request.urlopen(request, timeout=effective_timeout) as resp:
                raw_bytes = resp.read()
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", errors="replace")[:300]
            except Exception:  # noqa: BLE001 - 读错误体失败不重要
                pass
            raise VlmRequestError(
                f"VLM 返回 HTTP {exc.code}: {detail or exc.reason}"
            ) from exc
        except urllib.error.URLError as exc:
            raise VlmRequestError(f"无法连接 VLM 服务: {exc.reason}") from exc
        except TimeoutError as exc:
            raise VlmRequestError(f"VLM 请求超时（>{effective_timeout}s）") from exc
        except OSError as exc:
            raise VlmRequestError(f"VLM 请求失败: {exc}") from exc

        try:
            return json.loads(raw_bytes.decode("utf-8", errors="replace"))
        except json.JSONDecodeError as exc:
            raise VlmResponseError(f"HTTP 响应体不是合法 JSON: {exc}") from exc
