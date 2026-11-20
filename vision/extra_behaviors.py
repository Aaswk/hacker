"""Local gesture, facial movement and phone observations."""

from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision


class HeldBehavior:
    def __init__(self, seconds: float, release: float = 0.6):
        self.seconds = seconds
        self.release = release
        self.started = None
        self.last_seen = None
        self.fired = False

    def update(self, present: bool, now: float) -> bool:
        if self.last_seen is not None and now - self.last_seen > self.release:
            self.started = self.last_seen = None
            self.fired = False
        if not present:
            return False
        if self.started is None:
            self.started = now
        self.last_seen = now
        if self.fired or now - self.started < self.seconds:
            return False
        self.fired = True
        return True


def gestures(pose) -> dict[str, bool]:
    if pose is None:
        return {}
    nose, left, right, left_hand, right_hand = (
        pose.get(name) for name in (
            "nose", "left_shoulder", "right_shoulder", "left_wrist", "right_wrist"
        )
    )
    nose_y = nose.y if visible(nose) else None
    raised = [visible(hand) and nose_y is not None and hand.y < nose_y + 0.015
              for hand in (left_hand, right_hand)]
    one_hand_raised = raised[0] != raised[1]
    arms_out = False
    if visible(left) and visible(right):
        span = abs(left.x - right.x)
        if span >= 0.04:
            direction = 1 if left.x > right.x else -1
            left_elbow, right_elbow = pose.get("left_elbow"), pose.get("right_elbow")
            arms_out = (
                arm_extended(left, left_elbow, left_hand, direction, span)
                and arm_extended(right, right_elbow, right_hand, -direction, span)
            )
    return {"HAND_RAISE": one_hand_raised, "ARMS_OUT": arms_out}


def visible(point) -> bool:
    return point is not None and point.visibility >= 0.35


def close_to_face(pose) -> dict[str, bool]:
    nose, left, right = (pose.get(name) for name in ("nose", "left_shoulder", "right_shoulder"))
    if not all(map(visible, (nose, left, right))):
        return {}
    span = abs(left.x - right.x)
    if span < 0.04:
        return {}
    eyes = [pose.get(f"{side}_eye") for side in ("left", "right")]
    left_hand, right_hand = [
        [point for joint in ("wrist", "index", "thumb", "pinky")
         if visible(point := pose.get(f"{side}_{joint}"))]
        for side in ("left", "right")
    ]
    hands = left_hand + right_hand
    # Fingertips can be partially occluded when the hand is in front of an eye.
    eye_hands = [point for side in ("left", "right") for joint in ("wrist", "index", "thumb", "pinky")
                 if (point := pose.get(f"{side}_{joint}")) is not None and point.visibility >= .22]
    eye_level = [(eye.x, eye.y) for eye in eyes if visible(eye)]
    if len(eye_level) < 2:
        eye_level.extend((nose.x + direction * .11 * span, nose.y - .12 * span)
                         for direction in (-1, 1))
    eye_touch = any(abs(hand.x - x) <= .32 * span and abs(hand.y - y) <= .30 * span
                    for x, y in eye_level for hand in eye_hands)
    head_touch = any(abs(hand.x - nose.x) <= .48 * span and
                     nose.y - .75 * span <= hand.y <= nose.y - .20 * span for hand in hands)
    palms_together = any(
        abs(a.x - b.x) <= .25 * span and abs(a.y - b.y) <= .28 * span
        and abs((a.x + b.x) / 2 - (left.x + right.x) / 2) <= .4 * span
        and nose.y + .14 * span < (a.y + b.y) / 2 < max(left.y, right.y) + .95 * span
        for a in left_hand for b in right_hand
    )
    return {"HEAD_TOUCH": head_touch and not eye_touch,
            "EYE_TOUCH": eye_touch, "HANDS_TOGETHER": palms_together}


def arm_extended(shoulder, elbow, wrist, direction: int, span: float) -> bool:
    for point, reach in ((elbow, 0.24), (wrist, 0.4)):
        if not visible(point):
            continue
        outward = direction * (point.x - shoulder.x)
        if outward > reach * span and abs(point.y - shoulder.y) <= max(0.045, 1.05 * outward):
            return True
    return False


def object_near_hand(detections, pose, width: int, height: int, margin_ratio: float = .12):
    hands = [pose.get(f"{side}_{joint}") for side in ("left", "right")
             for joint in ("wrist", "index", "thumb")] if pose else []
    margin = min(width, height) * margin_ratio
    for detection in detections:
        box = detection.bounding_box
        if any(
            visible(hand)
            and box.origin_x - margin <= hand.x * width <= box.origin_x + box.width + margin
            and box.origin_y - margin <= hand.y * height <= box.origin_y + box.height + margin
            for hand in hands
        ):
            return box
    return None


def container_at_mouth(detections, pose, width, height) -> bool:
    lips = [pose.get(name) for name in ("mouth_left", "mouth_right")]
    lips = [point for point in lips if visible(point)]
    if not lips:
        return False
    x = sum(point.x for point in lips) * width / len(lips)
    y = sum(point.y for point in lips) * height / len(lips)
    margin = min(width, height) * .07
    near_mouth = [d for d in detections
                  if d.bounding_box.origin_x - margin <= x <= d.bounding_box.origin_x + d.bounding_box.width + margin
                  and d.bounding_box.origin_y - margin <= y <= d.bounding_box.origin_y + d.bounding_box.height + margin]
    return object_near_hand(near_mouth, pose, width, height) is not None


class ExtraBehaviors:
    def __init__(self, phone_seconds: float, local_drinking: bool = True):
        self.local_drinking = local_drinking
        self.rules = {
            "HAND_RAISE": HeldBehavior(0.7),
            "ARMS_OUT": HeldBehavior(0.8),
            "SMILING": HeldBehavior(0.7),
            "MOUTH_OPEN": HeldBehavior(0.9),
            "PHONE_HELD_LONG": HeldBehavior(phone_seconds, release=0.65),
            "HEAD_TOUCH": HeldBehavior(0.65),
            "EYE_TOUCH": HeldBehavior(0.28),
            "HANDS_TOGETHER": HeldBehavior(0.4),
            "DRINKING": HeldBehavior(0.55, release=0.9),
        }
        self.next_sample = 0.0
        self.phone_boxes = []
        self.held_phone_box = None
        models = Path(__file__).resolve().parent.parent / "models"
        self.face = self._load(
            models / "face_landmarker.task",
            lambda base: vision.FaceLandmarker.create_from_options(
                vision.FaceLandmarkerOptions(base_options=base, output_face_blendshapes=True)
            ),
        )
        self.phone = self._load(
            models / "efficientdet_lite0.tflite",
            lambda base: vision.ObjectDetector.create_from_options(
                vision.ObjectDetectorOptions(
                    base_options=base, score_threshold=0.22,
                    category_allowlist=["cell phone", "cup", "bottle", "wine glass"]
                )
            ),
        )

    @staticmethod
    def _load(path, create):
        try:
            model = create(python.BaseOptions(model_asset_path=str(path)))
        except (OSError, RuntimeError, ValueError) as exc:
            print(f"[Behavior] {path.name}: {exc}")
            return None
        print(f"[Behavior] ready: {path.name}")
        return model

    def update(self, frame, pose, now: float) -> list[str]:
        active = gestures(pose)
        if pose is not None:
            active.update(close_to_face(pose))
            if active.get("HEAD_TOUCH") or active.get("EYE_TOUCH"):
                active["HAND_RAISE"] = False
        if now >= self.next_sample:
            self.next_sample = now + 0.22
            self.phone_boxes = []
            self.held_phone_box = None
            active.update(SMILING=False, MOUTH_OPEN=False, PHONE_HELD_LONG=False, DRINKING=False)
            if pose is not None and (self.face is not None or self.phone is not None):
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                if self.face is not None:
                    face = self.face.detect(image)
                    scores = face.face_blendshapes
                    if scores:
                        weights = {score.category_name: score.score for score in scores[0]}
                        active["SMILING"] = min(weights.get("mouthSmileLeft", 0.0),
                                                weights.get("mouthSmileRight", 0.0)) >= 0.5
                        active["MOUTH_OPEN"] = weights.get("jawOpen", 0.0) >= 0.55
                if self.phone is not None:
                    height, width = frame.shape[:2]
                    detections = self.phone.detect(image).detections
                    phones = [d for d in detections if d.categories[0].category_name == "cell phone"
                              and d.categories[0].score >= .45]
                    containers = [d for d in detections if d.categories[0].category_name in ("cup", "bottle", "wine glass")]
                    self.phone_boxes = [detection.bounding_box for detection in phones]
                    self.held_phone_box = object_near_hand(phones, pose, width, height, margin_ratio=.055)
                    active["PHONE_HELD_LONG"] = self.held_phone_box is not None
                    if self.local_drinking:
                        active["DRINKING"] = container_at_mouth(containers, pose, width, height)
        return [name for name, present in active.items() if self.rules[name].update(present, now)]

    def draw_status(self, frame, now: float) -> None:
        for box in self.phone_boxes:
            color = (90, 225, 90) if box is self.held_phone_box else (30, 185, 255)
            cv2.rectangle(frame, (box.origin_x, box.origin_y),
                          (box.origin_x + box.width, box.origin_y + box.height), color, 2)
        phone_status = "phone not found"
        if self.phone is None:
            phone_status = "phone model unavailable"
        elif self.phone_boxes and self.held_phone_box is None:
            phone_status = "phone found, show the hand holding it"
        status = [("HAND_RAISE", "Raise one hand", "waiting"),
                  ("ARMS_OUT", "Arms out", "waiting"),
                  ("EYE_TOUCH", "Hand near eye", "waiting"),
                  ("HANDS_TOGETHER", "Hands together", "waiting"),
                  ("PHONE_HELD_LONG", "Phone", phone_status)]
        height, width = frame.shape[:2]
        top = height - 22 * len(status) - 6
        cv2.rectangle(frame, (0, top), (width, height), (24, 24, 24), -1)
        for i, (event, label, message) in enumerate(status):
            rule = self.rules[event]
            if rule.last_seen is not None and now - rule.last_seen <= rule.release:
                message = "recorded" if rule.fired else f"{now - rule.started:.1f}/{rule.seconds:g}s"
            cv2.putText(frame, f"{label}: {message}", (8, top + 19 + i * 22),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.52, (240, 240, 240), 1, cv2.LINE_AA)

    def close(self):
        for model in (self.face, self.phone):
            if model is not None:
                model.close()
