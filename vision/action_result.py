"""统一「动作识别结果」（Action Result）数据契约。

背景
--------------------------------------------------------------------------
项目把动作分成两类来识别：

    * **明确动作**：规则就能可靠判断的（例如「双手举过头顶」= STRETCHING），
      直接由规则模块输出事件，不经过 VLM。
    * **模糊动作**：规则不可靠的（例如 DRINKING，规则版实测误报太多），
      走「Pose 发现疑似 → 截关键帧 → VLM 判断」，由 VLM 给出结论。

不管哪条路径，最终都收敛成本文件里的 :class:`ActionResult`，
再交给后续的 Event Manager 决定是否生成对外统一事件。

⚠️ 本阶段（1.4）只做到「视觉模块产出可靠的 Action Result」为止。
Event Manager 与前后端联调属于后续阶段，本文件**不涉及**任何后端接口、
不产生网络请求、不改动原有事件协议。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

#: 确认发生了该动作
ACTION_DRINKING = "DRINKING"

#: 没有发生该动作（也叫 unknown：无法确认时统一归到这里）
ACTION_NONE = "NONE"


@dataclass(frozen=True)
class ActionResult:
    """一次动作识别的结论。

    Attributes:
        action: ``"DRINKING"`` 或 ``"NONE"``。
        confidence: 0.0 ~ 1.0 的置信度；``NONE`` 时由 VLM 返回或为 0.0。
        timestamp: 结论产生时刻，**Unix 时间戳（秒，浮点）**，
            便于后续写入事件 JSON。注意它和模块内部用于计时的
            ``time.monotonic()`` 不是同一个时钟。
        is_drinking: 是否判定为正在喝水。冗余字段，方便下游直接用。
        source: 结论来源，默认 ``"vlm"``；规则路径可以传 ``"rule"``。
        error: 调用/解析失败的原因。``None`` 表示本次判断流程本身正常
            （无论结论是 DRINKING 还是 NONE）。
            有值时 action 一定是 ``"NONE"``，用于告知「这次判断没做成」，
            而不是「确认没在喝水」。
    """

    action: str
    confidence: float
    timestamp: float
    is_drinking: bool
    source: str = "vlm"
    error: Optional[str] = None

    @property
    def is_event(self) -> bool:
        """是否是一次「可以对外输出的事件」（即确认了动作且流程无错）。"""
        return self.is_drinking and self.error is None

    def to_dict(self) -> dict:
        """转成适合写日志 / 交给 Event Manager 的普通 dict。"""
        data: dict = {
            "action": self.action,
            "confidence": round(float(self.confidence), 4),
            "is_drinking": bool(self.is_drinking),
            "timestamp": float(self.timestamp),
        }
        if self.source != "vlm":
            data["source"] = self.source
        if self.error:
            data["error"] = self.error
        return data

    def __str__(self) -> str:  # 便于日志打印
        base = f"{self.action}(confidence={self.confidence:.2f})"
        return f"{base} error={self.error}" if self.error else base
