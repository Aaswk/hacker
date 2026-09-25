"""可视化 / debug 绘制模块。

职责：把 PoseResult 画成人类看得懂的画面（骨架 + 关键点 + 状态文字）。

为什么自己画而不用 MediaPipe 的 ``drawing_utils``？
1. MediaPipe 1.0 的 ``drawing_utils`` 只接受它自家的 landmark 对象，
   我们已经在 PoseDetector 里转成了自己的数据类；
2. 自己画可以顺手实现「左右分色」「低置信度点不画」这些调试时很实用的细节；
3. 用 cv2 画就是把归一化坐标 × 宽高，能顺便把坐标换算讲清楚。

颜色注意：cv2 的颜色顺序是 **BGR**，不是 RGB。
"""

from __future__ import annotations

from typing import Optional

import cv2
import numpy as np

from .pose_detector import POSE_CONNECTIONS, Landmark, Pose, PoseResult

# -- 配色（BGR）-------------------------------------------------------------
COLOR_LEFT = (80, 200, 80)      # 绿色：MediaPipe 的 left_* 系列
COLOR_RIGHT = (0, 150, 255)     # 橙色：MediaPipe 的 right_* 系列
COLOR_CENTER = (255, 190, 60)   # 青色：鼻子 / 眼睛 / 嘴 / 躯干中线
COLOR_BONE = (220, 220, 220)    # 灰白：骨骼连线
COLOR_TEXT = (255, 255, 255)
COLOR_OK = (80, 220, 80)
COLOR_FAIL = (60, 60, 255)
COLOR_HIGHLIGHT = (0, 255, 255)  # 黄色：重点标注的肩/腕

#: 需要「加粗高亮」的关键点，方便确认 shoulder / wrist 取对了没有
HIGHLIGHT_NAMES = (
    "left_shoulder",
    "right_shoulder",
    "left_wrist",
    "right_wrist",
)


def draw_pose_debug(
    bgr_frame: np.ndarray,
    result: PoseResult,
    *,
    visibility_threshold: float = 0.5,
    fps: Optional[float] = None,
    draw_labels: bool = False,
) -> np.ndarray:
    """在帧上画出骨架、关键点和状态信息。

    本函数**不会修改**传入的帧，而是先 copy 一份再画（方便「原始画面」和
    「标注画面」同时显示）。

    Args:
        bgr_frame: 原始 BGR 帧。
        result: PoseDetector.detect() 的返回值。
        visibility_threshold: 低于此可见度的关键点/连线不绘制，避免画出乱线。
        fps: 实时帧率，仅用于显示；传 None 则不显示。
        draw_labels: 是否在每个点旁标注名字。画面会很乱，只在排查问题时开。

    Returns:
        画好标注的新帧（np.ndarray）。
    """
    canvas = bgr_frame.copy()

    # 多人时全部画出来；本阶段默认 num_poses=1，只会有一个
    for pose in result.poses:
        _draw_skeleton(canvas, pose, visibility_threshold)
        _draw_landmarks(canvas, pose, visibility_threshold, draw_labels)

    _draw_hud(canvas, result, fps)
    return canvas


def _draw_skeleton(
    canvas: np.ndarray,
    pose: Pose,
    visibility_threshold: float,
) -> None:
    """画骨骼连线。"""
    height, width = canvas.shape[:2]
    for start_idx, end_idx in POSE_CONNECTIONS:
        if start_idx >= len(pose.landmarks) or end_idx >= len(pose.landmarks):
            continue
        a = pose.landmarks[start_idx]
        b = pose.landmarks[end_idx]

        # 两端都足够可信才连线，否则容易出现「凭空一条线飘出去」
        if a.visibility < visibility_threshold or b.visibility < visibility_threshold:
            continue

        pa = a.to_pixel(width, height)
        pb = b.to_pixel(width, height)
        cv2.line(canvas, pa, pb, _side_color(a), 2, cv2.LINE_AA)


def _draw_landmarks(
    canvas: np.ndarray,
    pose: Pose,
    visibility_threshold: float,
    draw_labels: bool,
) -> None:
    """画关键点圆点。"""
    height, width = canvas.shape[:2]
    for landmark in pose.landmarks:
        if landmark.visibility < visibility_threshold:
            continue

        px, py = landmark.to_pixel(width, height)
        if px < 0 or py < 0 or px >= width or py >= height:
            continue  # 出画的点不画

        is_highlight = landmark.name in HIGHLIGHT_NAMES
        radius = 5 if is_highlight else 3
        color = COLOR_HIGHLIGHT if is_highlight else _side_color(landmark)
        cv2.circle(canvas, (px, py), radius, color, -1, cv2.LINE_AA)

        if draw_labels:
            cv2.putText(
                canvas,
                landmark.name,
                (px + 6, py - 6),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.35,
                COLOR_TEXT,
                1,
                cv2.LINE_AA,
            )


def _draw_hud(
    canvas: np.ndarray,
    result: PoseResult,
    fps: Optional[float],
) -> None:
    """在左上角画状态面板：person_detected、耗时、帧率、肩/腕坐标。"""
    detected = result.person_detected
    lines: list[tuple[str, tuple[int, int, int]]] = [
        (f"person_detected: {str(detected).lower()}", COLOR_OK if detected else COLOR_FAIL),
    ]

    if detected:
        lines.append((f"landmarks: {len(result.landmarks)}", COLOR_TEXT))
        # 展示如何从结果里取出具体关键点（shoulder / wrist）
        lines.append((_key_points_text(canvas, result.poses[0]), COLOR_TEXT))

    timing = f"inference: {result.inference_ms:.1f} ms"
    if fps is not None:
        timing += f"   fps: {fps:.1f}"
    lines.append((timing, COLOR_TEXT))
    lines.append(("quit: q / ESC", COLOR_TEXT))

    _draw_text_panel(canvas, lines)


def _key_points_text(canvas: np.ndarray, pose: Pose) -> str:
    """把左右肩、左右腕的像素坐标拼成一行，用于验证取值是否正确。"""
    height, width = canvas.shape[:2]
    parts = []
    for short_name, landmark_name in (
        ("L-shoulder", "left_shoulder"),
        ("R-shoulder", "right_shoulder"),
        ("L-wrist", "left_wrist"),
        ("R-wrist", "right_wrist"),
    ):
        landmark = pose.get(landmark_name)
        if landmark is None:
            parts.append(f"{short_name}=n/a")
            continue
        px, py = landmark.to_pixel(width, height)
        parts.append(f"{short_name}=({px},{py})")
    return "  ".join(parts)


def _draw_text_panel(
    canvas: np.ndarray,
    lines: list[tuple[str, tuple[int, int, int]]],
) -> None:
    """画一个半透明黑底 + 多行文字的面板。"""
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = 0.5
    thickness = 1
    line_height = 22
    margin = 10

    # 先算出文本块大小，再决定底板尺寸
    widths = []
    for text, _ in lines:
        (text_w, _), _ = cv2.getTextSize(text, font, scale, thickness)
        widths.append(text_w)
    panel_w = max(widths) + margin * 2
    panel_h = line_height * len(lines) + margin

    # 半透明底板：copy 一份 → 画实心矩形 → 按权重混合回去
    overlay = canvas.copy()
    cv2.rectangle(overlay, (0, 0), (panel_w, panel_h), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.5, canvas, 0.5, 0, canvas)

    y = margin + 12
    for text, color in lines:
        cv2.putText(
            canvas, text, (margin, y), font, scale, color, thickness, cv2.LINE_AA
        )
        y += line_height


def _side_color(landmark: Landmark) -> tuple[int, int, int]:
    """按名字前缀决定颜色：left_* 绿、right_* 橙、其余青。"""
    if landmark.name.startswith("left_"):
        return COLOR_LEFT
    if landmark.name.startswith("right_"):
        return COLOR_RIGHT
    return COLOR_CENTER
