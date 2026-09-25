"""Vision 模块（C：Vision / AI）。

第一阶段职责：摄像头实时读取 → MediaPipe Pose 检测人体关键点 → 画面叠加 debug 标注。

对外主要接口：
    PoseDetector  姿态检测器（输入 BGR 帧，输出 PoseResult）
    PoseResult    检测结果（person_detected / poses / 便捷取点）
    CameraStream  OpenCV 摄像头封装
    draw_pose_debug  绘制 debug 画面
"""

from .camera import CameraStream
from .pose_detector import (
    DEFAULT_MODEL_PATH,
    LANDMARK_NAMES,
    NUM_LANDMARKS,
    POSE_CONNECTIONS,
    Landmark,
    Pose,
    PoseDetector,
    PoseResult,
)
from .visualizer import draw_pose_debug

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
]
