"""Vision 模块（C：Vision / AI）。

第一阶段职责：摄像头实时读取 → MediaPipe Pose 检测人体关键点 → 画面叠加 debug 标注。

对外主要接口：
    PoseDetector  姿态检测器（输入 BGR 帧，输出 PoseResult）
    PoseResult    检测结果（person_detected / poses / 便捷取点）
    CameraStream  OpenCV 摄像头封装
    draw_pose_debug  绘制 debug 画面

两件和「配置 / 依赖」有关的事（都在本文件里做，子模块不用各自操心）
--------------------------------------------------------------------------
1. **导入本包即加载 ``.env``**：项目根目录的 ``.env`` / ``.env.local``
   （见 :mod:`vision.dotenv`）会被灌进 ``os.environ``，shell 里已 export 的
   同名变量优先。于是 ``VLM_API_KEY`` / ``BACKEND_BASE_URL`` 写在 .env 里就行，
   不用每个终端手动 export；密钥本身也不进代码、不进仓库。
2. **子模块懒导入**（PEP 562 ``__getattr__``）：原先本文件一上来就 import
   camera / pose_detector / visualizer，于是「只想用 vlm_client 发一次 VLM 请求」
   也必须先装好 mediapipe + opencv。改成用到才导入后：
   ``from vision import PoseDetector`` 依旧照常可用，而
   ``vision.selftest_vlm_live`` 这类只碰纯标准库模块的脚本，
   在没装视觉依赖的机器上也能跑起来（排查 key / 网络问题很有用）。
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

from .dotenv import load_dotenv, mask_secret

#: 包被导入时就把 .env 加载好——必须早于任何 ``from_env()`` 调用
load_dotenv()

#: 公开名字 → 定义它的子模块（懒导入用）
_LAZY_ATTRS: dict[str, str] = {
    "CameraStream": ".camera",
    "Landmark": ".pose_detector",
    "Pose": ".pose_detector",
    "PoseDetector": ".pose_detector",
    "PoseResult": ".pose_detector",
    "draw_pose_debug": ".visualizer",
    "DEFAULT_MODEL_PATH": ".pose_detector",
    "LANDMARK_NAMES": ".pose_detector",
    "NUM_LANDMARKS": ".pose_detector",
    "POSE_CONNECTIONS": ".pose_detector",
}

__all__ = [
    "CameraStream",
    "Landmark",
    "Pose",
    "PoseDetector",
    "PoseResult",
    "draw_pose_debug",
    "DEFAULT_MODEL_PATH",
    "LANDMARK_NAMES",
    "NUM_LANDMARKS",
    "POSE_CONNECTIONS",
    # 配置相关（新增）
    "load_dotenv",
    "mask_secret",
]


def __getattr__(name: str) -> Any:
    """按需导入子模块里的名字；取过一次就缓存进 globals，不再走这里。"""
    module_name = _LAZY_ATTRS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    module = import_module(module_name, __name__)
    value = getattr(module, name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(__all__) | set(globals()))
