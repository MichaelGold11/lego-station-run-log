"""Phase 4: live step checker for the LEGO station.

Watches the station through a camera, waits until the operator's hands are out of view,
then checks the build against the calibrated "correct" build. Correct steps turn green and
the checklist advances; mistakes get a red box, a message and a buzz. If the system is not
sure, it says "Needs review" instead of guessing.

Run from the repo folder:
    python vision/live_check.py --list-cameras          # find your phone camera's number
    python vision/live_check.py --calibrate --camera 1  # once: build it correctly, SPACE after each step
    python vision/live_check.py --camera 1              # live checking

Keys in the window:  Q quit  ·  R restart the cycle  ·  SPACE (calibration) save this step
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
MODEL = HERE / "models" / "best.pt"
HAND_MODEL = HERE / "models" / "hand_landmarker.task"
HAND_MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
                  "hand_landmarker/float16/latest/hand_landmarker.task")
CALIBRATION = HERE / "calibration" / "reference.json"
LOGS = HERE / "logs"

# ---- the build -------------------------------------------------------------------------
PLATE, PINK, BLUE = "plate", "pink_brick", "blue_slope"
STEPS = [  # (part that this step adds, text shown in the checklist)
    (PLATE, "Place base plate"),
    (PINK, "Attach pink brick"),
    (BLUE, "Secure blue slope"),
]
PART_NAME = {PLATE: "white plate", PINK: "pink brick", BLUE: "blue slope"}

# ---- tuning ----------------------------------------------------------------------------
DETECT_CONF = 0.35      # boxes below this are ignored
SURE_CONF = 0.60        # a decision that rests on a box below this becomes "Needs review"
CLEAR_SECONDS = 0.3     # hands must be gone this long before a check
POS_TOLERANCE = 0.14    # allowed position error, as a fraction of the plate size (1 stud ~ 0.17-0.25)
RECHECK_SECONDS = 1.0   # while the view stays clear after a mistake, look again this often
MOTION_LIMIT = 4.0      # mean pixel change that still counts as "still" (fallback when no hand model)

# ---- colours (BGR) -----------------------------------------------------------------------
GREEN, RED, AMBER, GREY = (80, 175, 76), (60, 60, 230), (40, 140, 240), (150, 150, 150)
WHITE, DARK, PANEL = (245, 245, 245), (40, 40, 40), (250, 250, 250)


# =========================================================================================
# Detection
# =========================================================================================
@dataclass
class Det:
    cls: str
    conf: float
    box: tuple  # x1, y1, x2, y2 in pixels

    @property
    def center(self):
        x1, y1, x2, y2 = self.box
        return (x1 + x2) / 2, (y1 + y2) / 2


class Detector:
    def __init__(self, path=MODEL):
        from ultralytics import YOLO
        if not Path(path).exists():
            sys.exit(f"Model not found: {path}\nPut best.pt from Colab in vision/models/.")
        self.model = YOLO(str(path))
        self.names = self.model.names

    def __call__(self, frame) -> dict[str, Det]:
        r = self.model.predict(frame, conf=DETECT_CONF, verbose=False)[0]
        best: dict[str, Det] = {}
        for box, conf, cls in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist(), r.boxes.cls.tolist()):
            name = self.names[int(cls)]
            if name == PLATE and not looks_white(frame, box):
                continue  # e.g. a dark speaker grille mistaken for the plate
            if name not in best or conf > best[name].conf:
                best[name] = Det(name, float(conf), tuple(box))
        return best


def looks_white(frame, box) -> bool:
    x1, y1, x2, y2 = (int(v) for v in box)
    crop = frame[max(0, y1):y2, max(0, x1):x2]
    if crop.size == 0:
        return False
    v = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)[:, :, 2]
    return float(np.median(v)) > 110


# =========================================================================================
# "Is the view clear?"  MediaPipe hands, with a motion-based fallback
# =========================================================================================
class ClearView:
    def __init__(self, use_hands=True):
        self.hands = None
        self.prev = None
        self.clear_since = None
        self.mode = "motion"
        if use_hands:
            try:
                self.hands = self._load_hands()
                self.mode = "hands+motion"
            except Exception as e:  # noqa: BLE001
                print(f"[note] Hand detection unavailable ({e.__class__.__name__}: {e}). "
                      "Using motion only: keep hands out of view during checks.")
        self.t0 = time.monotonic()

    @staticmethod
    def _load_hands():
        import mediapipe as mp
        from mediapipe.tasks import python as mpt
        from mediapipe.tasks.python import vision
        if not HAND_MODEL.exists():
            print("Downloading MediaPipe hand model (one time, ~8 MB)...")
            HAND_MODEL.parent.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(HAND_MODEL_URL, HAND_MODEL)
        opts = vision.HandLandmarkerOptions(
            base_options=mpt.BaseOptions(model_asset_path=str(HAND_MODEL)),
            running_mode=vision.RunningMode.VIDEO, num_hands=2,
            min_hand_detection_confidence=0.4, min_hand_presence_confidence=0.4)
        lm = vision.HandLandmarker.create_from_options(opts)
        return mp, lm

    def hands_visible(self, frame) -> bool:
        if not self.hands:
            return False
        mp, lm = self.hands
        small = cv2.resize(frame, (0, 0), fx=0.5, fy=0.5)
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
        ts = int((time.monotonic() - self.t0) * 1000)
        return len(lm.detect_for_video(img, ts).hand_landmarks) > 0

    def motion(self, frame) -> float:
        g = cv2.GaussianBlur(cv2.cvtColor(cv2.resize(frame, (160, 120)), cv2.COLOR_BGR2GRAY), (5, 5), 0)
        m = 0.0 if self.prev is None else float(np.mean(cv2.absdiff(g, self.prev)))
        self.prev = g
        return m

    def update(self, frame, now) -> tuple[bool, bool]:
        """Returns (view_is_clear, hands_visible)."""
        hands = self.hands_visible(frame)
        still = self.motion(frame) < MOTION_LIMIT
        if hands or not still:
            self.clear_since = None
            return False, hands
        if self.clear_since is None:
            self.clear_since = now
        return now - self.clear_since >= CLEAR_SECONDS, hands


# =========================================================================================
# Geometry: everything is measured relative to the plate, so moving the whole build is fine
# =========================================================================================
def on_plate(part: Det, plate: Det) -> bool:
    """A part counts as placed if its centre is on the plate, or a good share of it overlaps the plate
    (e.g. a brick hanging half off the edge). Parts lying loose next to the plate don't count."""
    x1, y1, x2, y2 = plate.box
    cx, cy = part.center
    if x1 <= cx <= x2 and y1 <= cy <= y2:
        return True
    a1, b1, a2, b2 = part.box
    inter = max(0, min(x2, a2) - max(x1, a1)) * max(0, min(y2, b2) - max(y1, b1))
    return inter / max(1e-6, (a2 - a1) * (b2 - b1)) > 0.35


def relative(part: Det, plate: Det) -> dict:
    x1, y1, x2, y2 = plate.box
    pw, ph = x2 - x1, y2 - y1
    cx, cy = part.center
    bx1, by1, bx2, by2 = part.box
    return {"x": (cx - x1) / pw, "y": (cy - y1) / ph,
            "w": (bx2 - bx1) / pw, "h": (by2 - by1) / ph}


def landscape(det: Det) -> bool:
    x1, y1, x2, y2 = det.box
    return (x2 - x1) >= (y2 - y1)


# =========================================================================================
# Checking a snapshot against the calibrated reference
# =========================================================================================
@dataclass
class Verdict:
    kind: str            # "verified" | "error" | "review" | "waiting" | "complete" | "idle"
    message: str
    step: int = -1       # step index this verdict is about
    bad_part: str | None = None
    confidence: float = 0.0


@dataclass
class Cycle:
    done: int = 0                         # number of verified steps
    started: float | None = None          # time the cycle started
    step_started: float | None = None
    step_times: list = field(default_factory=list)
    errors: int = 0


def check(dets: dict[str, Det], ref: dict, cycle: Cycle) -> Verdict:
    plate = dets.get(PLATE)
    if plate is None:
        if cycle.done in (0, len(STEPS)):   # nothing started yet, or finished build taken away
            return Verdict("idle", "Place the white plate to start", 0)
        return Verdict("review", "Plate not visible - is it covered or out of view?", cycle.done)
    if landscape(plate) != ref["plate_landscape"]:
        return Verdict("review", "Plate is turned. Turn it back the way it was calibrated.",
                       cycle.done, PLATE, plate.conf)

    placed = {n: d for n, d in dets.items() if n != PLATE and on_plate(d, plate)}
    order = [p for p, _ in STEPS]

    # 1) Something placed out of order / a step skipped
    for i, (part, _) in enumerate(STEPS[1:], start=1):
        if part in placed:
            missing = [p for p in order[1:i] if p not in placed]
            if missing:
                d = placed[part]
                kind = "error" if min(d.conf, plate.conf) >= SURE_CONF else "review"
                return Verdict(kind, f"Wrong order: {PART_NAME[part]} placed before "
                                     f"{PART_NAME[missing[0]]} (step {order.index(missing[0]) + 1} skipped)",
                               order.index(missing[0]), part, d.conf)

    # 2) Every placed part must be where the calibration says
    for part, d in placed.items():
        r, want = relative(d, plate), ref["parts"][part]
        off = max(abs(r["x"] - want["x"]), abs(r["y"] - want["y"]))
        turned = (r["w"] >= r["h"]) != (want["w"] >= want["h"])
        if off > POS_TOLERANCE or turned:
            what = "turned the wrong way" if turned else "in the wrong position"
            kind = "error" if min(d.conf, plate.conf) >= SURE_CONF else "review"
            return Verdict(kind, f"{PART_NAME[part].capitalize()} {what}",
                           order.index(part), part, d.conf)

    # 3) A part that was already verified has gone missing
    for i in range(1, cycle.done):
        part = order[i]
        if part not in placed:
            return Verdict("error", f"{PART_NAME[part].capitalize()} is missing (step {i + 1})", i, part)

    # 4) Progress
    n_present = 1 + sum(1 for p in order[1:] if p in placed)   # plate + placed parts, in order
    if n_present > cycle.done:
        part = order[n_present - 1]
        conf = plate.conf if part == PLATE else placed[part].conf
        if conf < SURE_CONF:
            return Verdict("review", f"Step {n_present} looks done but I'm not sure "
                                     f"(confidence {conf:.0%}). Please check.", n_present - 1, part, conf)
        if n_present == len(STEPS):
            return Verdict("complete", "Assembly complete", n_present - 1, None, conf)
        return Verdict("verified", f"Step {n_present} verified", n_present - 1, None, conf)
    return Verdict("waiting", "No change yet", cycle.done)


# =========================================================================================
# Drawing
# =========================================================================================
def draw_feed(frame, dets, verdict: Verdict | None, cycle: Cycle, ref: dict | None = None):
    out = frame.copy()
    plate = dets.get(PLATE)
    if ref and plate:   # --debug: distance from the calibrated spot (must be under POS_TOLERANCE)
        for k, (name, d) in enumerate((n, d) for n, d in dets.items() if n != PLATE):
            if name in ref["parts"]:
                r, want = relative(d, plate), ref["parts"][name]
                txt = (f"{name}: on_plate={on_plate(d, plate)} dx={r['x'] - want['x']:+.2f} "
                       f"dy={r['y'] - want['y']:+.2f} (limit {POS_TOLERANCE})")
                cv2.putText(out, txt, (10, out.shape[0] - 14 - 24 * k), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                            (0, 255, 255), 2, cv2.LINE_AA)
    order = [p for p, _ in STEPS]
    for name, d in dets.items():
        x1, y1, x2, y2 = (int(v) for v in d.box)
        verified = order.index(name) < cycle.done
        if verdict and verdict.kind in ("error", "review") and verdict.bad_part == name:
            color, thick = (RED if verdict.kind == "error" else AMBER), 5
        else:
            color, thick = (GREEN if verified else GREY), 2
        cv2.rectangle(out, (x1, y1), (x2, y2), color, thick)
        label = f"{PART_NAME[name]} {d.conf:.0%}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1)
        cv2.rectangle(out, (x1, max(0, y1 - th - 8)), (x1 + tw + 6, y1), color, -1)
        cv2.putText(out, label, (x1 + 3, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.55, WHITE, 1, cv2.LINE_AA)
    return out


def icon(img, center, kind):
    x, y = center
    if kind == "done":
        cv2.circle(img, (x, y), 12, GREEN, 2, cv2.LINE_AA)
        cv2.polylines(img, [np.array([(x - 6, y), (x - 2, y + 5), (x + 7, y - 5)])], False, GREEN, 2, cv2.LINE_AA)
    elif kind == "error":
        cv2.circle(img, (x, y), 12, RED, 2, cv2.LINE_AA)
        cv2.line(img, (x, y - 6), (x, y + 2), RED, 2, cv2.LINE_AA)
        cv2.circle(img, (x, y + 6), 1, RED, 2)
    elif kind == "review":
        cv2.circle(img, (x, y), 12, AMBER, 2, cv2.LINE_AA)
        cv2.line(img, (x, y - 6), (x, y + 2), AMBER, 2, cv2.LINE_AA)
        cv2.circle(img, (x, y + 6), 1, AMBER, 2)
    else:  # pending: dashed circle
        for a in range(0, 360, 40):
            cv2.ellipse(img, (x, y), (12, 12), 0, a, a + 22, GREY, 2, cv2.LINE_AA)


def draw_panel(h, cycle: Cycle, verdict: Verdict | None, status: str, mode: str, flash: bool):
    w = 420
    p = np.full((h, w, 3), PANEL, np.uint8)
    put = lambda t, xy, s=0.6, c=DARK, th=1: cv2.putText(p, t, xy, cv2.FONT_HERSHEY_SIMPLEX, s, c, th, cv2.LINE_AA)
    put("STATION 01 - LEGO BUILD", (24, 36), 0.45, GREY)
    put("Assembly Progress", (24, 70), 0.8, DARK, 2)
    put(f"{cycle.done} of {len(STEPS)}", (w - 90, 70), 0.7, GREY, 2)
    cv2.rectangle(p, (24, 88), (w - 24, 96), (230, 230, 230), -1)
    cv2.rectangle(p, (24, 88), (24 + int((w - 48) * cycle.done / len(STEPS)), 96), GREEN, -1)

    y = 140
    for i, (_, text) in enumerate(STEPS):
        if i < cycle.done:
            kind, sub = "done", "Visually verified"
            if i < len(cycle.step_times):
                sub += f"  ({cycle.step_times[i]:.1f} s)"
        elif verdict and verdict.kind in ("error", "review") and verdict.step == i:
            kind, sub = verdict.kind, ("Mistake - fix and clear the view" if verdict.kind == "error"
                                       else "Needs review")
        else:
            kind, sub = "pending", ("Waiting for visual confirmation" if i == cycle.done else "Not started")
        icon(p, (40, y - 6), kind)
        put(f"Step {i + 1} - {text}", (64, y - 2), 0.6, DARK, 2)
        put(sub, (64, y + 20), 0.5, RED if kind == "error" else (AMBER if kind == "review" else GREY))
        y += 64

    # status card
    if verdict and verdict.kind == "error":
        bg, fg, title = ((210, 210, 255) if flash else (235, 235, 255)), RED, "MISTAKE"
    elif verdict and verdict.kind == "review":
        bg, fg, title = (220, 240, 255), AMBER, "NEEDS REVIEW"
    elif verdict and verdict.kind == "complete":
        bg, fg, title = (225, 245, 225), GREEN, "ASSEMBLY COMPLETE"
    elif verdict and verdict.kind == "verified":
        bg, fg, title = (225, 245, 225), GREEN, "STEP VERIFIED"
    else:
        bg, fg, title = (240, 240, 240), GREY, "WAITING FOR CLEAR VIEW"
    top = y + 4
    cv2.rectangle(p, (20, top), (w - 20, top + 110), bg, -1)
    put(title, (34, top + 32), 0.65, fg, 2)
    msg = verdict.message if verdict and (verdict.kind != "waiting" or "cleared" in verdict.message) else status
    for k, line in enumerate(wrap(msg, 38)[:3]):
        put(line, (34, top + 60 + 22 * k), 0.5, DARK)

    if cycle.done < len(STEPS):
        put(f"Clear the camera view briefly to verify Step {cycle.done + 1}.", (24, h - 52), 0.45, DARK)
    put(f"Q quit   R restart   |  view check: {mode}", (24, h - 22), 0.42, GREY)
    return p


def wrap(text, n):
    words, lines, cur = text.split(), [], ""
    for wd in words:
        if len(cur) + len(wd) + 1 > n:
            lines.append(cur)
            cur = wd
        else:
            cur = (cur + " " + wd).strip()
    return lines + [cur] if cur else lines


# =========================================================================================
# Sound and logging
# =========================================================================================
def beep(kind):
    def run():
        try:
            import winsound
            if kind == "error":
                for _ in range(3):
                    winsound.Beep(880, 220)
            elif kind == "review":
                winsound.Beep(600, 300)
            else:
                winsound.Beep(1320, 120)
        except Exception:  # noqa: BLE001  (not Windows)
            print("\a", end="", flush=True)
    threading.Thread(target=run, daemon=True).start()


class Log:
    def __init__(self):
        LOGS.mkdir(exist_ok=True)
        self.path = LOGS / f"session_{datetime.now():%Y%m%d_%H%M%S}.csv"
        self.f = open(self.path, "w", newline="", encoding="utf-8")
        self.w = csv.writer(self.f)
        self.w.writerow(["time", "cycle", "step", "event", "message", "confidence", "step_seconds", "cycle_seconds"])

    def write(self, cycle_no, v: Verdict, step_s="", cycle_s=""):
        self.w.writerow([datetime.now().isoformat(timespec="seconds"), cycle_no, v.step + 1, v.kind,
                         v.message, f"{v.confidence:.2f}", step_s, cycle_s])
        self.f.flush()


# =========================================================================================
# Camera / video source
# =========================================================================================
ROTATE = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


class LatestFrame:
    """Reads the camera in a background thread and keeps only the newest frame.
    Without this, frames queue up while the model is busy and the picture lags behind."""

    def __init__(self, cap):
        self.cap, self.frame, self.ok = cap, None, True
        self.lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while self.ok:
            ok, f = self.cap.read()
            if not ok:
                self.ok = False
                break
            with self.lock:
                self.frame = f

    def read(self):
        for _ in range(300):              # wait up to ~3 s for the first frame
            with self.lock:
                f, self.frame = self.frame, None
            if f is not None or not self.ok:
                return f is not None, f
            time.sleep(0.01)
        return False, None

    def release(self):
        self.ok = False
        time.sleep(0.05)
        self.cap.release()


def open_source(args):
    if args.video:
        cap = cv2.VideoCapture(args.video)
    else:
        backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
        cap = cv2.VideoCapture(args.camera, backend)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    if not cap.isOpened():
        sys.exit(f"Could not open {'video ' + args.video if args.video else 'camera ' + str(args.camera)}. "
                 "Try --list-cameras.")
    return cap if args.video else LatestFrame(cap)


def read(cap, args):
    ok, frame = cap.read()
    if not ok:
        return None
    if args.rotate in ROTATE:
        frame = cv2.rotate(frame, ROTATE[args.rotate])
    if max(frame.shape[:2]) > 960:          # smaller = faster, still plenty for the model
        s = 960 / max(frame.shape[:2])
        frame = cv2.resize(frame, (0, 0), fx=s, fy=s, interpolation=cv2.INTER_AREA)
    return frame


def list_cameras():
    backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
    print("Checking cameras 0-5 ...")
    for i in range(6):
        cap = cv2.VideoCapture(i, backend)
        ok, frame = cap.read() if cap.isOpened() else (False, None)
        if ok:
            print(f"  camera {i}: {frame.shape[1]}x{frame.shape[0]}  -> try  --camera {i}")
            cv2.imshow(f"camera {i} (press any key)", frame)
            cv2.waitKey(1500)
            cv2.destroyAllWindows()
        cap.release()
    print("The phone (Iriun) is usually camera 1 or 2. Laptop webcam is usually 0.")


def fit_window(img, max_w=1500, max_h=820):
    s = min(1.0, max_w / img.shape[1], max_h / img.shape[0])
    return cv2.resize(img, (0, 0), fx=s, fy=s) if s < 1 else img


def side_by_side(feed, panel):
    h = max(feed.shape[0], 560)
    if feed.shape[0] != h:
        feed = cv2.resize(feed, (int(feed.shape[1] * h / feed.shape[0]), h))
    if panel.shape[0] != h:
        panel = cv2.resize(panel, (panel.shape[1], h))
    return np.hstack([feed, panel])


# =========================================================================================
# Calibration
# =========================================================================================
def snapshot_reference(dets_list: list[dict[str, Det]], step: int) -> dict | str:
    """Average several frames of detections for one calibration step. Returns ref piece or an error text."""
    need = [p for p, _ in STEPS[:step + 1]]
    good = [d for d in dets_list if all(p in d for p in need) and all(on_plate(d[p], d[PLATE]) for p in need[1:])]
    if len(good) < max(2, len(dets_list) // 3):
        missing = [PART_NAME[p] for p in need if not any(p in d for d in dets_list)]
        return ("Could not see " + ", ".join(missing)) if missing else \
            "Parts not clearly on the plate. Keep hands away and try again."
    out = {"plate_landscape": sum(landscape(d[PLATE]) for d in good) > len(good) / 2, "parts": {}}
    for p in need[1:]:
        rels = [relative(d[p], d[PLATE]) for d in good]
        out["parts"][p] = {k: float(np.median([r[k] for r in rels])) for k in ("x", "y", "w", "h")}
    return out


def calibrate(args):
    det, cap = Detector(), open_source(args)
    ref = {"parts": {}}
    step, buf = 0, []
    msg = "Place the white plate, move hands away, press SPACE"
    print("Calibration: build it CORRECTLY, one step at a time. After each step move your hands away and press SPACE.")
    while step < len(STEPS):
        frame = read(cap, args)
        if frame is None:
            break
        dets = det(frame)
        buf = (buf + [dets])[-10:]
        feed = draw_feed(frame, dets, None, Cycle(done=step))
        cv2.rectangle(feed, (0, 0), (feed.shape[1], 44), (0, 0, 0), -1)
        cv2.putText(feed, f"CALIBRATION step {step + 1}/{len(STEPS)}: {msg}", (12, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, WHITE, 1, cv2.LINE_AA)
        cv2.imshow("LEGO station - calibration", fit_window(feed))
        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            sys.exit("Calibration cancelled.")
        if key == ord(" "):
            got = snapshot_reference(buf, step)
            if isinstance(got, str):
                msg = got
                beep("review")
                continue
            ref["plate_landscape"] = got["plate_landscape"]
            ref["parts"].update(got["parts"])
            beep("verified")
            step += 1
            if step < len(STEPS):
                msg = f"Now: {STEPS[step][1].lower()}, move hands away, press SPACE"
    cap.release()
    cv2.destroyAllWindows()
    if step < len(STEPS):
        sys.exit("Calibration not finished.")
    save_reference(ref)


def save_reference(ref):
    CALIBRATION.parent.mkdir(parents=True, exist_ok=True)
    ref["saved"] = datetime.now().isoformat(timespec="seconds")
    CALIBRATION.write_text(json.dumps(ref, indent=2))
    print(f"Saved correct build to {CALIBRATION}")


# =========================================================================================
# Live loop
# =========================================================================================
class Checker:
    """Turns a stream of frames into verdicts. Separate from the UI so it can be tested on videos."""

    def __init__(self, ref, use_hands=True, log=True):
        self.ref = ref
        self.view = ClearView(use_hands)
        self.cycle, self.cycle_no = Cycle(), 1
        self.verdict: Verdict | None = None
        self.checked_this_clear = False
        self.last_check = -1e9
        self.recent: list[dict] = []
        self.log = Log() if log else None
        self.events: list[tuple[float, Verdict]] = []

    def restart(self):
        self.cycle, self.verdict = Cycle(), None
        self.cycle_no += 1

    def step(self, frame, dets, now):
        clear, hands = self.view.update(frame, now)
        if hands or not clear:
            if self.cycle.started is None:   # operator started working
                self.cycle.started = self.cycle.step_started = now
            if not clear:
                self.checked_this_clear = False
                self.recent = []
            return
        self.recent = (self.recent + [dets])[-3:]
        if len(self.recent) < 3:
            return
        stuck = self.verdict is not None and self.verdict.kind in ("error", "review")
        if self.checked_this_clear and not (stuck and now - self.last_check >= RECHECK_SECONDS):
            return
        self.checked_this_clear, self.last_check = True, now
        votes = [check(d, self.ref, self.cycle) for d in self.recent]
        kinds = [v.kind for v in votes]
        v = max(votes, key=lambda x: kinds.count(x.kind))
        if kinds.count(v.kind) < 2:
            v = Verdict("review", "Results flickered between checks. Hold still and clear the view again.",
                        self.cycle.done)
        self.apply(v, now)

    def apply(self, v: Verdict, now):
        old = self.verdict
        if v.kind == "waiting":
            if old is not None and old.kind in ("error", "review"):   # the problem part was taken away
                self.verdict = Verdict("waiting", f"Mistake cleared. Continue with step {self.cycle.done + 1}.",
                                       self.cycle.done)
            return
        if old is not None and old.kind == v.kind and old.message == v.message and v.kind in ("error", "review"):
            return  # same problem still there: keep showing it, don't buzz again
        if v.kind == "idle":
            if self.cycle.done == len(STEPS):  # finished build was taken away -> next cycle
                self.restart()
            self.verdict = v
            return
        if self.cycle.done == len(STEPS) and v.kind in ("complete",):
            return  # already reported
        self.verdict = v
        self.events.append((now, v))
        step_s = cycle_s = ""
        if v.kind in ("verified", "complete"):
            if self.cycle.started is None:
                self.cycle.started = self.cycle.step_started = now
            step_s = round(now - (self.cycle.step_started or now), 1)
            self.cycle.step_times.append(step_s)
            self.cycle.done = v.step + 1
            self.cycle.step_started = now
            if v.kind == "complete":
                cycle_s = round(now - self.cycle.started, 1)
                v.message = f"Assembly complete in {cycle_s:.1f} s. Remove the build to start the next one."
            beep("verified")
        elif v.kind == "error":
            self.cycle.errors += 1
            beep("error")
        elif v.kind == "review":
            beep("review")
        if self.log:
            self.log.write(self.cycle_no, v, step_s, cycle_s)


def live(args):
    if not CALIBRATION.exists():
        sys.exit("No calibration yet. Run:  python vision/live_check.py --calibrate --camera N")
    ref = json.loads(CALIBRATION.read_text())
    det, cap = Detector(), open_source(args)
    chk = Checker(ref, use_hands=not args.no_hands)
    print(f"Running. Log: {chk.log.path}\nPress Q in the window to quit, R to restart the cycle.")
    fps_t, start = time.monotonic(), time.monotonic()
    while True:
        frame = read(cap, args)
        if frame is None:
            break
        now = time.monotonic() - start
        dets = det(frame)
        chk.step(frame, dets, now)
        status = "Hands in view - working..." if chk.view.clear_since is None else "Checking..."
        flash = int(now * 4) % 2 == 0
        view = side_by_side(draw_feed(frame, dets, chk.verdict, chk.cycle, ref if args.debug else None),
                            draw_panel(max(frame.shape[0], 560), chk.cycle, chk.verdict, status, chk.view.mode, flash))
        cv2.imshow("LEGO station - live check", fit_window(view))
        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            break
        if key == ord("r"):
            chk.restart()
    cap.release()
    cv2.destroyAllWindows()
    print(f"Saved log: {chk.log.path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", type=int, default=0, help="camera number (see --list-cameras)")
    ap.add_argument("--video", help="use a recorded video instead of a camera (for testing)")
    ap.add_argument("--rotate", type=int, default=0, choices=[0, 90, 180, 270], help="rotate the image")
    ap.add_argument("--calibrate", action="store_true", help="record the correct build")
    ap.add_argument("--list-cameras", action="store_true")
    ap.add_argument("--no-hands", action="store_true", help="skip MediaPipe; use motion only")
    ap.add_argument("--debug", action="store_true", help="show position numbers on screen (for tuning)")
    args = ap.parse_args()
    if args.list_cameras:
        list_cameras()
    elif args.calibrate:
        calibrate(args)
    else:
        live(args)


if __name__ == "__main__":
    main()
