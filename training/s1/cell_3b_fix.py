# 3b. Turn Grounding DINO's boxes into labels (several wires per frame are allowed)
import numpy as np, cv2

def text_to_class(text):
    t = text.lower()
    if "cutter" in t or "plier" in t: return "cutter"
    if "ruler" in t: return "ruler"
    if "wire" in t or "cable" in t:
        for c in ("red", "white", "black"):
            if c in t: return c + "_wire"
        return "wire?"                      # colour decided below
    return None

def red_share(img, box):
    x1, y1, x2, y2 = [int(v) for v in box]
    crop = img[max(0, y1):y2, max(0, x1):x2]
    if crop.size == 0: return 0.0
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    red = ((h <= 10) | (h >= 165)) & (s > 90) & (v > 60)
    return float(red.mean())

def dark_share(img, box):
    x1, y1, x2, y2 = [int(v) for v in box]
    crop = img[max(0, y1):y2, max(0, x1):x2]
    if crop.size == 0: return 0.0
    return float((cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)[..., 2] < 50).mean())

def wire_colour(img, box):
    # Fallback when the text gives no colour: red is easy to measure; dark vs light decides black vs white.
    if red_share(img, box) > 0.03: return "red_wire"
    x1, y1, x2, y2 = [int(v) for v in box]
    crop = cv2.cvtColor(img[max(0, y1):y2, max(0, x1):x2], cv2.COLOR_BGR2HSV)
    v = crop[..., 2].reshape(-1)
    return "black_wire" if (v < 50).mean() > 0.05 else "white_wire"

def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1]); x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    ua = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter
    return inter / ua if ua else 0

def inside(a, b):
    # share of box a that lies inside box b
    x1, y1 = max(a[0], b[0]), max(a[1], b[1]); x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    area = max(1e-6, (a[2]-a[0]) * (a[3]-a[1]))
    return max(0, x2 - x1) * max(0, y2 - y1) / area

def pick_boxes(img, boxes, scores, texts):
    H, W = img.shape[:2]
    cand = []
    for box, score, text in zip(boxes, scores, texts):
        x1, y1, x2, y2 = [float(v) for v in box]
        area = (x2 - x1) * (y2 - y1) / (W * H)
        if area > 0.6 or area < 0.0003:
            continue
        cls = text_to_class(text)
        if cls is None:
            continue
        if cls == "wire?":
            cls = wire_colour(img, box)
        elif cls.endswith("_wire"):
            r = red_share(img, box)
            if cls == "red_wire" and r < 0.005 and score < 0.5: cls = wire_colour(img, box)
            elif cls != "red_wire" and r > 0.08: cls = "red_wire"     # clearly red: fix the text
        if cls not in CLASSES:
            continue
        bw, bh = x2 - x1, y2 - y1
        if cls == "ruler" and max(bw, bh) < 3 * min(bw, bh):
            continue                        # a ruler is long and thin; this is the whole cutting board
        if cls == "red_wire" and red_share(img, box) < 0.01:
            continue                        # nothing red in it
        if cls == "black_wire" and dark_share(img, box) < 0.03:
            continue                        # nothing black in it (e.g. the board's metal rail)
        cand.append([cls, float(score), [x1, y1, x2, y2]])
    cand.sort(key=lambda c: -c[1])
    keep = []
    cutters = [c[2] for c in cand if c[0] == "cutter"]
    for c in cand:                          # one box per object: drop a box that mostly repeats a better one
        if any(iou(c[2], k[2]) > 0.6 for k in keep):
            continue
        if c[0].endswith("_wire") and any(inside(c[2], k) > 0.5 for k in cutters):
            continue                        # the cutter's red handles are not a red wire
        if c[0] in ONE_PER_IMAGE and any(k[0] == c[0] for k in keep):
            continue
        keep.append(c)
    return [(c[0], c[2]) for c in keep]

def to_yolo_lines(objs, W, H):
    out = []
    for cls, (x1, y1, x2, y2) in objs:
        x1, x2 = max(0, x1), min(W, x2); y1, y2 = max(0, y1), min(H, y2)
        out.append(f"{CLASSES.index(cls)} {(x1+x2)/2/W:.6f} {(y1+y2)/2/H:.6f} {(x2-x1)/W:.6f} {(y2-y1)/H:.6f}")
    return out