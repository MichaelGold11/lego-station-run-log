"""Phase 2 -> 3: turn the videos in vision/videos into still frames and zip them for Colab.

Run from the repo folder:   python vision/extract_frames.py
Output: vision/frames/all/*.jpg  and  vision/frames.zip  (upload frames.zip to Colab)
"""
import sys
import zipfile
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
VIDEOS = HERE / "videos"
OUT = HERE / "frames" / "all"
ZIP = HERE / "frames.zip"
PER_SECOND = 3      # frames kept per second of video
LONG_SIDE = 1280    # resize so the longer side is this many pixels


def extract(video: Path) -> int:
    cap = cv2.VideoCapture(str(video))
    cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)  # respect phone rotation (portrait clips)
    if not cap.isOpened():
        print(f"  ! could not open {video.name}")
        return 0
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = max(1, round(fps / PER_SECOND))
    i = saved = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            h, w = frame.shape[:2]
            s = LONG_SIDE / max(h, w)
            if s < 1:
                frame = cv2.resize(frame, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
            saved += 1
            cv2.imwrite(str(OUT / f"{video.stem}_{saved:04d}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        i += 1
    cap.release()
    return saved


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    videos = sorted(p for p in VIDEOS.iterdir() if p.suffix.lower() in {".mov", ".mp4", ".m4v", ".avi"})
    if not videos:
        sys.exit(f"No videos found in {VIDEOS}")
    done = {p.name.rsplit("_", 1)[0] for p in OUT.glob("*.jpg")}
    for v in videos:
        if v.stem in done:
            print(f"{v.name}: already extracted, skipping")
            continue
        print(f"{v.name}: {extract(v)} frames")
    frames = sorted(OUT.glob("*.jpg"))
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_STORED) as z:
        for f in frames:
            z.write(f, f"frames/{f.name}")
    print(f"\n{len(frames)} frames total -> {ZIP} ({ZIP.stat().st_size / 1e6:.0f} MB). Upload this file to Colab.")


if __name__ == "__main__":
    main()
