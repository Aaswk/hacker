"""DRINKING（VLM 版）离线自测 —— **不调用真实 VLM、不需要摄像头**。

运行：
    cd C:\\3G实验室\\hack\\hacker
    .\\.venv\\Scripts\\python.exe -m vision.selftest_drinking_vlm

覆盖用户要求的四类情形：
    * VLM 返回 DRINKING
    * VLM 返回 NONE
    * VLM 返回非法 JSON
    * VLM 请求失败（超时/HTTP 错误/没配 key）

外加若干纯函数与解析健壮性用例。只要有一项 FAIL 就以退出码 1 结束。
"""

from __future__ import annotations

import os
import sys
import time
from typing import Optional

import numpy as np

from .action_result import ACTION_DRINKING, ACTION_NONE, ActionResult
from .drinking_vlm_detector import (
    DrinkingVlmDetector,
    encode_frame_jpeg,
    is_drinking_candidate,
)
from .pose_detector import LANDMARK_NAMES, NUM_LANDMARKS, Landmark, Pose, PoseResult
from .vlm_client import (
    VlmClient,
    VlmConfig,
    VlmConfigError,
    VlmRequestError,
    VlmResponseError,
    parse_json_text,
)

# ---------------------------------------------------------------------------
# 测试脚手架
# ---------------------------------------------------------------------------

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


class FakeClock:
    """可手动推进的时钟，用来在不 sleep 的情况下测 cooldown。"""

    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


class FakeVlm:
    """假 VLM：要么返回固定 dict，要么抛指定异常。"""

    def __init__(self, result: Optional[dict] = None, error: Optional[Exception] = None):
        self.result = result
        self.error = error
        self.calls = 0

    def ask_json(self, prompt, images, *, system=None, timeout=None):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.result


def make_pose(**overrides) -> Pose:
    """构造一个 33 点的 Pose；overrides 形如 ``name=(x, y, visibility)``。"""
    points = []
    for i in range(NUM_LANDMARKS):
        name = LANDMARK_NAMES[i]
        x = y = 0.5
        vis = 0.9
        if name in overrides:
            x, y, vis = overrides[name]
        points.append(
            Landmark(
                index=i, name=name, x=x, y=y, z=0.0, visibility=vis, presence=vis
            )
        )
    return Pose(landmarks=tuple(points), world_landmarks=())


def pose_result(pose: Optional[Pose]) -> PoseResult:
    return PoseResult(poses=(pose,) if pose else (), timestamp_ms=0, inference_ms=0.0)


#: 疑似喝水：右手抬到肩以上且离嘴很近
CANDIDATE_POSE = make_pose(
    mouth_left=(0.49, 0.28, 0.9),
    mouth_right=(0.51, 0.28, 0.9),
    right_shoulder=(0.60, 0.50, 0.9),
    right_wrist=(0.50, 0.31, 0.9),
)

#: 没在喝水：手垂在身侧
NON_CANDIDATE_POSE = make_pose(
    mouth_left=(0.49, 0.28, 0.9),
    mouth_right=(0.51, 0.28, 0.9),
    right_shoulder=(0.60, 0.50, 0.9),
    right_wrist=(0.62, 0.80, 0.9),
)

FRAME = np.zeros((480, 640, 3), dtype=np.uint8)


def wait_verdict(det: DrinkingVlmDetector, pose: Pose, timeout: float = 5.0):
    """反复喂帧直到后台 VLM 结论返回（模拟主循环继续跑）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        verdict = det.update(FRAME, pose_result(pose))
        if verdict is not None:
            return verdict
        time.sleep(0.005)
    return None


# ---------------------------------------------------------------------------
# 用例
# ---------------------------------------------------------------------------


def test_candidate_function() -> None:
    print("\nT1 疑似判定纯函数 is_drinking_candidate")
    check("抬手指向嘴部 → 疑似", is_drinking_candidate(CANDIDATE_POSE) is True)
    check("手垂在身侧 → 不疑似", is_drinking_candidate(NON_CANDIDATE_POSE) is False)
    check("pose 为 None → 不疑似", is_drinking_candidate(None) is False)
    # 手抬起来但离嘴很远（举手）不应疑似
    far = make_pose(
        mouth_left=(0.49, 0.28, 0.9),
        mouth_right=(0.51, 0.28, 0.9),
        right_shoulder=(0.60, 0.50, 0.9),
        right_wrist=(0.05, 0.10, 0.9),
    )
    check("手举很高但离嘴远 → 不疑似", is_drinking_candidate(far) is False)


def test_vlm_drinking() -> None:
    print("\nT2 VLM 返回 DRINKING")
    clock = FakeClock()
    vlm = FakeVlm(result={"action": "DRINKING", "confidence": 0.92, "is_drinking": True})
    det = DrinkingVlmDetector(
        vlm=vlm,
        trigger_frames=3,
        cooldown_seconds=15.0,
        clock=clock,
        wall_clock=lambda: 1234567890.0,
        verbose=False,
    )

    # 前两帧还不该触发
    det.update(FRAME, pose_result(CANDIDATE_POSE))
    det.update(FRAME, pose_result(CANDIDATE_POSE))
    check("未达触发帧数时不调用 VLM", vlm.calls == 0)
    det.update(FRAME, pose_result(CANDIDATE_POSE))
    check("达到触发帧数后调用一次 VLM", vlm.calls == 1)

    verdict = wait_verdict(det, CANDIDATE_POSE)
    check("拿到 ActionResult", verdict is not None)
    assert verdict is not None
    check("action == DRINKING", verdict.action == ACTION_DRINKING, verdict.action)
    check("is_drinking 为真", verdict.is_drinking is True)
    check("confidence 解析正确", abs(verdict.confidence - 0.92) < 1e-6)
    check("timestamp 使用 wall_clock", verdict.timestamp == 1234567890.0)
    check("is_event 为真", verdict.is_event is True)
    check("event_count == 1", det.event_count == 1, str(det.event_count))

    # 继续举着手：不重新武装，不应再次调用
    for _ in range(5):
        det.update(FRAME, pose_result(CANDIDATE_POSE))
    check("保持举手不重复触发", vlm.calls == 1, str(vlm.calls))

    # 放下手 → 重新武装；但冷却内仍不触发
    det.update(FRAME, pose_result(NON_CANDIDATE_POSE))
    for _ in range(4):
        det.update(FRAME, pose_result(CANDIDATE_POSE))
    check("冷却期内不触发", vlm.calls == 1, str(vlm.calls))

    # 推进时钟越过冷却 → 再次触发
    clock.advance(16.0)
    det.update(FRAME, pose_result(NON_CANDIDATE_POSE))  # 再武装一次
    for _ in range(3):
        det.update(FRAME, pose_result(CANDIDATE_POSE))
    verdict2 = wait_verdict(det, CANDIDATE_POSE)
    check("冷却结束后可再次触发", vlm.calls == 2, str(vlm.calls))
    check("再次得到 DRINKING", verdict2 is not None and verdict2.is_drinking)
    check("event_count == 2", det.event_count == 2, str(det.event_count))


def test_vlm_none() -> None:
    print("\nT3 VLM 返回 NONE（例如其实是托腮）")
    vlm = FakeVlm(result={"action": "NONE", "confidence": 0.1, "is_drinking": False})
    det = DrinkingVlmDetector(vlm=vlm, trigger_frames=1, verbose=False)
    det.update(FRAME, pose_result(CANDIDATE_POSE))
    verdict = wait_verdict(det, CANDIDATE_POSE)
    check("拿到 ActionResult", verdict is not None)
    assert verdict is not None
    check("action == NONE", verdict.action == ACTION_NONE, verdict.action)
    check("is_drinking 为假", verdict.is_drinking is False)
    check("is_event 为假", verdict.is_event is False)
    check("event_count == 0", det.event_count == 0)
    check("无错误信息", verdict.error is None)


def test_vlm_invalid_json() -> None:
    print("\nT4 VLM 返回非法 JSON（解析层应抛 VlmResponseError）")
    try:
        parse_json_text("这不是 JSON，只是一段自然语言")
        check("非法文本应抛 VlmResponseError", False, "没有抛异常")
    except VlmResponseError:
        check("非法文本应抛 VlmResponseError", True)

    # 通过 detector 跑一遍：非法 JSON 被吞掉、不崩、返回 error 非空的 NONE
    vlm = FakeVlm(error=VlmResponseError("模型返回不是合法 JSON"))
    det = DrinkingVlmDetector(vlm=vlm, trigger_frames=1, verbose=False)
    det.update(FRAME, pose_result(CANDIDATE_POSE))
    verdict = wait_verdict(det, CANDIDATE_POSE)
    check("非法 JSON 不崩溃且返回结果", verdict is not None)
    assert verdict is not None
    check("降级为 NONE", verdict.action == ACTION_NONE and not verdict.is_drinking)
    check("error 字段非空", bool(verdict.error))


def test_vlm_request_failure() -> None:
    print("\nT5 VLM 请求失败（超时 / HTTP 错误）")
    vlm = FakeVlm(error=VlmRequestError("VLM 请求超时（>15.0s）"))
    det = DrinkingVlmDetector(vlm=vlm, trigger_frames=1, verbose=False)
    det.update(FRAME, pose_result(CANDIDATE_POSE))
    verdict = wait_verdict(det, CANDIDATE_POSE)
    check("请求失败不崩溃", verdict is not None)
    assert verdict is not None
    check("降级为 NONE", verdict.action == ACTION_NONE and not verdict.is_drinking)
    check("error 记录原因", "超时" in (verdict.error or ""), str(verdict.error))
    check("is_event 为假", verdict.is_event is False)


def test_no_api_key() -> None:
    print("\nT6 没有配置 API key")
    # 直接测客户端：空 key 应抛 VlmConfigError
    client = VlmClient(VlmConfig(api_key=""))
    check("空 key 时 is_configured 为假", client.config.is_configured is False)
    try:
        client.ask_json("hello", [b"\xff\xd8\xff"])
        check("空 key 应抛 VlmConfigError", False, "没有抛异常")
    except VlmConfigError:
        check("空 key 应抛 VlmConfigError", True)

    # detector 用这个客户端：应优雅降级，不崩
    det = DrinkingVlmDetector(vlm=client, trigger_frames=1, verbose=False)
    det.update(FRAME, pose_result(CANDIDATE_POSE))
    verdict = wait_verdict(det, CANDIDATE_POSE)
    check("无 key 时 detector 不崩溃", verdict is not None)
    assert verdict is not None
    check("降级为 NONE 且记录 error", verdict.action == ACTION_NONE and bool(verdict.error))

    # from_env 在无 key 时应报告未配置
    saved = os.environ.pop("VLM_API_KEY", None)
    try:
        check("from_env 无 key 时未配置", VlmConfig.from_env().is_configured is False)
    finally:
        if saved is not None:
            os.environ["VLM_API_KEY"] = saved


def test_parse_robustness() -> None:
    print("\nT7 JSON 解析健壮性")
    check("直接 JSON", parse_json_text('{"a": 1}') == {"a": 1})
    fenced = '```json\n{"action": "DRINKING", "is_drinking": true}\n```'
    check("剥 ```json 围栏", parse_json_text(fenced).get("action") == "DRINKING")
    noisy = 'Sure! Here it is: {"action": "NONE", "is_drinking": false} Hope it helps.'
    check("截取首个 { 到末个 }", parse_json_text(noisy).get("action") == "NONE")

    # action 与 is_drinking 矛盾 → 归 NONE
    print("\nT8 矛盾输出按 NONE 处理")
    vlm = FakeVlm(result={"action": "DRINKING", "confidence": 5, "is_drinking": False})
    det = DrinkingVlmDetector(vlm=vlm, trigger_frames=1, verbose=False)
    det.update(FRAME, pose_result(CANDIDATE_POSE))
    verdict = wait_verdict(det, CANDIDATE_POSE)
    check("矛盾输出 → NONE", verdict is not None and verdict.action == ACTION_NONE)
    assert verdict is not None
    check("confidence 被夹到 [0,1]", verdict.confidence == 1.0, str(verdict.confidence))


def test_encode_frame() -> None:
    print("\nT9 关键帧编码 encode_frame_jpeg")
    check("None → None", encode_frame_jpeg(None) is None)
    data = encode_frame_jpeg(FRAME)
    check("正常帧 → JPEG 字节", isinstance(data, bytes) and data[:2] == b"\xff\xd8")
    wide = np.zeros((1080, 1920, 3), dtype=np.uint8)
    data_wide = encode_frame_jpeg(wide, max_width=640)
    check("超宽帧被缩小后仍能编码", isinstance(data_wide, bytes) and len(data_wide) > 0)


def test_action_result_dict() -> None:
    print("\nT10 ActionResult.to_dict")
    result = ActionResult(
        action=ACTION_DRINKING,
        confidence=0.9137,
        timestamp=1700000000.5,
        is_drinking=True,
    )
    data = result.to_dict()
    check("包含 action/confidence/is_drinking/timestamp",
          {"action", "confidence", "is_drinking", "timestamp"} <= set(data))
    check("confidence 四舍五入", data["confidence"] == 0.9137, str(data["confidence"]))
    check("正常结果不带 error/source", "error" not in data and "source" not in data)


def main() -> int:
    print("=" * 60)
    print("DRINKING（VLM 版）离线自测 —— 不调用真实 VLM / 不需要摄像头")
    print("=" * 60)

    test_candidate_function()
    test_vlm_drinking()
    test_vlm_none()
    test_vlm_invalid_json()
    test_vlm_request_failure()
    test_no_api_key()
    test_parse_robustness()
    test_encode_frame()
    test_action_result_dict()

    print("\n" + "=" * 60)
    print(f"结果：{_PASS} PASS / {_FAIL} FAIL")
    print("=" * 60)
    return 0 if _FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
