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

## Result of the 2026-11-19 run (22:43)

By the swap rule below this was "do not swap". Michael chose to swap anyway (2026-11-19): the 2 fps model
is `app/models/s2-connector.onnx`, the old one is kept as `s2-connector-2026-11-05.onnx`. Its weak class is
white (mAP50 0.615): on real S2 recordings of finished units it scores white 0.06 to 0.31, so the done
check no longer requires white (docs/wire-line-process.md, "When a unit counts as done").

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

Test B split by view (check videos; "right" = lever state, then share of frames with red / white found):

| View | Truth | n | Live model | 2 fps model |
|---|---|---|---|---|
| Wide, top-down (k_ 8942, 8949, 8958) | open | 45 | 89%, red 62%, white 62% | 98%, red 73%, white 64% |
| Wide, top-down | closed | 35 | 80%, red 74%, white 43% | 91%, red 83%, white 46% |
| Tall, close-up (m_ 3306, 3313, 3320) | open | 74 | 38%, red 73%, white 72% | 86%, red 74%, white 54% |
| Tall, close-up | closed | 15 | 100%, red 100%, white 67% | 100%, red 93%, white 60% |

Why A fails: unknown. Not picture shape: 28 of the 45 videos are wide (all k_ plus m_ 3323 to 3327),
and the new model does well on the wide check videos, which look much like the photos. It misses even
the photos it trained on, which suggests their auto-labels were empty or wrong, so they trained as
"nothing here". Cell 4a (label review) was skipped, so this is unchecked.

Next: look at the boxes Grounding DINO drew on the 14 training photos. If they are empty or wrong,
drop the photos (or box them by hand) and retrain. Do not swap until Test A passes.

## Open question that decides which test matters

What does the live S2 camera actually see: a whole unit from above on the table (like the photos, Test A)
or hands holding the connector close up (like the videos, Test B)? A one-minute recording from the real
camera, cut into frames and added as a Test C, would settle it.
