# Vision: live step checker

Watches the LEGO station through a camera, checks each assembly step with a YOLO model
trained on our own parts, and buzzes with a red box when something is wrong. Everything is
open source and runs on your laptop: no API, no tokens, works offline once trained.

Build: Step 1 place the white 4x6 plate, Step 2 pink 1x6 brick on the plate,
Step 3 light-blue 2x2 slope on the plate, left of the pink brick (exact spot comes from calibration).

## Folders

| Path | What goes there |
|---|---|
| `videos/` | Your training videos (Phase 2). Not pushed to GitHub. |
| `models/` | The trained model `best.pt` (Phase 3). |
| `calibration/` | The saved "correct build" reference (Phase 4). |
| `logs/` | Event log from each live session. |

## Phases

1. **Setup.** `python -m pip install -r vision/requirements.txt`, then `python vision/check_setup.py`.
2. **Record videos.** 4-5 clips, 30-60 s each, camera looking straight down. Portrait or landscape, but the same way you will mount the phone live. Send originals, not via WhatsApp (it shrinks them). Move the
   three parts around: different spots, angles, partly built, fully built. Change the lighting
   between clips (lamp, ceiling, window). Put them in `videos/`.
3. **Train.** `python vision/extract_frames.py` turns the videos into frames and makes
   `vision/frames.zip`. Open `train_colab.ipynb` in Google Colab (free, T4 GPU), upload
   `frames.zip`, run all cells. It auto-labels the parts with Grounding DINO, trains YOLO and
   downloads `best.pt`; put it in `vision/models/`.
4. **Live check.** `python vision/live_check.py --calibrate` once (build it correctly), then
   `python vision/live_check.py`.
5. **Tune and demo.**

## What counts as a mistake

Anything that doesn't match the calibrated correct build: a missing part, a part in the wrong
spot or turned, a skipped step, or parts in the wrong order. Errors get a red box, a message
and a buzz. If the system can't tell, it says "Needs review" instead of guessing.
