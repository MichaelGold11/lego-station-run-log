"""Phase 1 check: confirms Python, the libraries and your camera all work.

Run from the repo folder:   python vision/check_setup.py
"""
import sys

ok = True

def report(name, passed, detail=""):
    global ok
    ok = ok and passed
    mark = "OK  " if passed else "FAIL"
    print(f"[{mark}] {name}{(' - ' + detail) if detail else ''}")

v = sys.version_info
report("Python version", (3, 10) <= (v.major, v.minor) <= (3, 12), f"{v.major}.{v.minor}.{v.micro}")

for mod, label in [("cv2", "OpenCV"), ("ultralytics", "YOLO (ultralytics)"), ("mediapipe", "MediaPipe"), ("numpy", "NumPy")]:
    try:
        m = __import__(mod)
        report(label, True, getattr(m, "__version__", ""))
    except Exception as e:  # noqa: BLE001
        report(label, False, f"not installed ({e.__class__.__name__})")

try:
    import cv2
    cam = cv2.VideoCapture(0, cv2.CAP_DSHOW) if sys.platform == "win32" else cv2.VideoCapture(0)
    got, frame = cam.read()
    cam.release()
    if got:
        h, w = frame.shape[:2]
        report("Camera", True, f"{w}x{h} ({'landscape' if w >= h else 'portrait'})")
    else:
        report("Camera", False, "no image; close other apps using the camera (Zoom, Teams, Camera app)")
except Exception as e:  # noqa: BLE001
    report("Camera", False, str(e))

print()
print("All good. Phase 1 is done." if ok else "Something failed above. Send a screenshot of this output.")
