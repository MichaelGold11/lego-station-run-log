"""Compare a new S2 model against the live one.

Usage: python compare_s2.py <new.onnx> [old.onnx]

Test A: the 5 held-out photos (photos-2026-11-19/check). All show a finished unit, levers flat.
Test B: frames from the held-out check videos, inside the ranges labeled open or closed.
        Counts how often each model calls the connector open / closed (confidence 0.4 and up).
        Caution: the live model may have trained on these videos (Ruza's 52 are probably the same footage).
"""
import glob, json, os, sys
import numpy as np, onnxruntime as ort
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
C = ["red", "white", "black", "open", "closed"]
VAL = ["k_IMG_8942", "k_IMG_8949", "k_IMG_8958", "m_IMG_3306", "m_IMG_3313", "m_IMG_3320"]
CONF = 0.4


def letterbox(im, size=640):
    # Same as the app (app/line.html, live-detect.js) and ultralytics: scale to fit, center, gray (114) padding.
    w, h = im.size; r = min(size / w, size / h); nw, nh = round(w * r), round(h * r)
    out = Image.new("RGB", (size, size), (114, 114, 114))
    out.paste(im.resize((nw, nh), Image.BILINEAR), ((size - nw) // 2, (size - nh) // 2))
    return out


def detect(sess, f):
    x = np.asarray(letterbox(Image.open(f).convert("RGB")), np.float32).transpose(2, 0, 1)[None] / 255
    o = sess.run(None, {sess.get_inputs()[0].name: x})[0][0].T   # (8400, 4 + classes)
    sc = o[:, 4:]; cl = sc.argmax(1); cf = sc.max(1); d = {}
    for c, v in zip(cl[cf > CONF], cf[cf > CONF]):
        d[C[int(c)]] = max(d.get(C[int(c)], 0), round(float(v), 2))
    return d


def main():
    new = sys.argv[1]
    old = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "../../app/models/s2-connector.onnx")
    models = {"OLD": ort.InferenceSession(old), "NEW": ort.InferenceSession(new)}

    print("Test A: held-out photos (want: closed + red + white on each)")
    photos = sorted(glob.glob(os.path.join(HERE, "photos-2026-11-19/check/*.jpg")))
    for name, s in models.items():
        hits = 0
        for f in photos:
            d = detect(s, f); ok = all(k in d for k in ("closed", "red", "white")); hits += ok
            print(f"  {name} {os.path.basename(f)[-8:-4]} {'OK ' if ok else 'MISS'} {d}")
        print(f"  {name}: {hits}/{len(photos)} photos fully right\n")

    print("Test B: check-video frames (share of frames where the model says open / closed)")
    states = json.load(open(os.path.join(HERE, "states-colab-2fps.json")))
    frames = {"open": [], "closed": []}
    for v in VAL:
        for a, b, st in states.get(v, []):
            frames[st] += [f for i in range(a, b + 1) if os.path.exists(f := os.path.join(HERE, f"frames-2fps/{v}_{i:04d}.jpg"))]
    for name, s in models.items():
        for truth, fs in frames.items():
            said = [detect(s, f) for f in fs]
            other = "closed" if truth == "open" else "open"
            right = sum(truth in d for d in said); wrong = sum(other in d for d in said)
            none = sum(truth not in d and other not in d for d in said)   # a frame can show both, so the three need not add to 100
            print(f"  {name} truth={truth:6s} n={len(fs):3d}  right {right/len(fs):.0%}  wrong {wrong/len(fs):.0%}  none {none/len(fs):.0%}")


if __name__ == "__main__":
    main()
