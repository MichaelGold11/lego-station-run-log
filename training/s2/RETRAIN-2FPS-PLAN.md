# S2 retrain at 2 fps: run plan

Written 2026-11-19. Goal: a Station 2 model that catches raised levers (the live model's gap)
without losing the wires and closed connectors it already finds. Station 3 footage stays out.

## What is already done (on the laptop, no Colab needed)

| Item | File |
|---|---|
| 45 usable S2 videos (Kate + Michael) cut at 2 frames per second: 2,347 frames | `frames-2fps/` (untracked) |
| Lever labels converted from 1 fps to 2 fps (frame n becomes 2n-1, inner span only) | `states-colab-2fps.json` |
| Training zip: 1,076 frames (682 open, 371 closed, 23 photos) | `frames-colab-2fps.zip` (115 MB, untracked) |
| Notebook: FPS 2, labels filled in, Drive mount, plot bug fixed, copies results to Drive | `train_s2_2fps.ipynb` |
| Head-to-head test script, checked on the 2026-11-19 model | `compare_s2.py` |

Ruza's 2026-11-05 run, for scale: 52 videos at 2 fps, 577 open and 569 closed frames.

## At home: the one thing Michael does

Laptop on home wifi, lid open (a closed lid freezes the run), Chrome signed in to Google. Paste to Claude:

> Run the S2 2 fps retrain: ~/Code/lego-station-run-log-canvas/training/s2/RETRAIN-2FPS-PLAN.md

Possible popups: Google asks to let Colab see Drive (Allow).

## What Claude runs, in order

| Step | Who | Time |
|---|---|---|
| 1. Copy `frames-colab-2fps.zip` and `train_s2_2fps.ipynb` to Drive `ID - Training Video File/s2-model-2fps/`; wait for the upload | Claude | 2 to 5 min |
| 2. Open the notebook in Colab, T4 GPU, run every cell in order; skip the 4a review pages, BAD = [] | browser worker | 3 min |
| 3. Auto-label (Grounding DINO) | Colab | 5 to 8 min |
| 4. Train, 80 rounds on about 950 frames | Colab | 15 to 25 min |
| 5. Score (mAP50), export ONNX, copy `s2-connector.onnx` and `s2-best.pt` to the same Drive folder | Colab | 2 min |
| 6. `compare_s2.py <new model>` against the live model | Claude | 2 min |
| 7. Swap or not (rule below), then report | Claude | 2 min |

**Total: about 35 to 50 minutes, almost all unattended.** The browser worker stops every 40 turns;
Claude resumes it. Brief it to wait with long gaps during training so it does not burn turns.

## Swap rule

Run `compare_s2.py` (Python with onnxruntime; Python 3.13 works, 3.15 has no onnxruntime build).

| Result | Action |
|---|---|
| Test A at least 4/5 photos fully right AND Test B open right at least 70% AND closed right within 10 points of the live model | Swap: keep the old file as `app/models/s2-connector-2026-11-05.onnx`, put the new one at `app/models/s2-connector.onnx`, commit on the canvas branch. No push without Michael's yes. |
| Test B passes, Test A fails | Do not swap. Bring Michael the choice: use the new model for lever state only (a code change), or add real frames from the live S2 camera and train again. |
| Test B fails | Keep the live model. Report the numbers. |

Baseline numbers (2026-11-19, live model vs the 1 fps model):

| | Live model | 1 fps model |
|---|---|---|
| Test A: photos fully right | 5/5 | 0/5 |
| Test B: open frames called open | 61% | 81% |
| Test B: open frames called closed | 32% | 10% |
| Test B: closed frames called closed | 86% | 80% |

Test B leans toward the live model: it probably trained on these same videos.

## Traps

- Do not add frames where the connector is visible but unlabeled (for example "wires only"): the model
  learns that a connector is background. That is why the 9 mid-insertion photos stay out.
- Class order is fixed: red_wire, white_wire, black_wire, connector_open, connector_closed.
- The Chrome upload tool takes files under 10 MB, so the zip goes through Drive, not the page.
- Colab runs on Michael's account; he already accepted the Colab terms (2026-11-19).

## Result of the 2026-11-19 run (22:43): not swapped

Colab: 1,076 frames, train 898 / check 169, mAP50 0.722, mAP50-95 0.55. Per class mAP50: red 0.841,
white 0.615, black 0.387, open 0.909, closed 0.859. Model in Drive `s2-model-2fps/` (not in the app).

`compare_s2.py` now letterboxes like the app (gray 114 padding, aspect kept); the earlier plain resize
squashed images. Numbers with the letterbox:

| | Live model | 2 fps model |
|---|---|---|
| Test A: held-out photos fully right | 5/5 | 0/5 (one closed at 0.60, nothing else) |
| Training photos 3468 to 3479 (it trained on these) | 12/12 found closed or open | 2/12 found anything |
| Test B: open frames called open | 57% | 91% |
| Test B: open frames called closed | 41% | 10% |
| Test B: closed frames called closed | 86% | 94% |

Swap rule: B passes, A fails, so no swap.

Why A fails: every video frame is portrait (1280 x 2276, a phone held upright, hands close up). The
photos are landscape 4:3 (1920 x 1440), and so is the live camera (`app/line.html` asks for 640 x 480).
The new model learned one shape of scene and sees nothing in the other, even photos it trained on.
The live model handles both; how Ruza cut her frames is unknown (her notebook starts from a frames zip).
Test A is the closer match to the live camera, so a model that fails it is not safe to wire in, not
even for lever state alone.

Next: footage in landscape, ideally from the demo setup's camera, then retrain. A cheaper test of the
shape theory: pad the portrait frames onto a 4:3 gray canvas before training, and retrain.

## Open question that decides which test matters

What does the live S2 camera actually see: a whole unit from above on the table (like the photos, Test A)
or hands holding the connector close up (like the videos, Test B)? A one-minute recording from the real
camera, cut into frames and added as a Test C, would settle it.
