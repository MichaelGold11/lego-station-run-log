# LEGO station: live camera step tracking, what we should do

## Context
Today the LEGO Station Run Log (`C:\Users\goldm\lego-station-run-log`) analyzes recorded videos after the fact. That means one video at a time, a 20 MB storage cap on the shared link, and step timing accurate to about ±0.3 s.

The new goal is an overhead iPhone camera feeding Michael's laptop live. A vision model sees the build, crosses off SOP steps with a confidence score, and times each step on a live dashboard, with no video upload.

The research and the frame check (Runs 1 and 6) settled four things:
- **No ready-made repo exists, but the parts do.**
- **The station as filmed today works against a camera.** The white plate sits on a white table, the parts are tiny in the frame, the build happens inside the hands, and the camera angle moves between runs.
- **The 11 substeps are already labeled** with start and end times in all six runs: idle_pre, pick_pink, hold_plate, place_pink, seat_pink, pick_blue, carry_blue, orient_blue, seat_blue, release, idle_post. They are the answer key.
- **The laptop** has an i7-1355U, Intel Iris Xe graphics and no NVIDIA card, so a nano-size model running locally is the realistic choice.

## The approach (one line)
Train a small detector on Colab, then run it live in the browser inside the existing local app. It detects parts and build states, not motions. Hand tracking plus simple rules turn those detections into substeps and SOP steps.

## Phases, each with a go/no-go gate

### Phase 0: two things Claude does now, before anyone labels anything
1. **SOP rules file:**
   - **What:** draft `data/meta/sop.json`. It groups the 11 substeps into 3 SOP steps, and gives each substep a camera-checkable "starts when / ends when" rule, drafted from the "observed" text in the six runs' analyses.
   - **Review:** Michael and the team edit the drafts. They decide whether "press" (seat_pink and seat_blue) merges into "place", since a camera above can barely see it.
   - **Names:** keep the existing 11 names so new runs stay comparable with Runs 1–6.
2. **Feasibility test on the six stored videos:**
   - **Where:** a new `tools/vision-test/` folder, with its Python environment git-ignored. The input is the H.264 run videos already in `data/assets/`, found through each run JSON's `video.assetId`.
   - **What it runs:** MediaPipe Hand Landmarker plus a text-prompted detector (YOLOE: "pink lego brick", "white lego plate", "blue lego slope"), frame by frame.
   - **What it measures:**
     - frames per second on this laptop
     - the share of frames with hands found
     - the share of frames where each part is detected
     - how much of each substep window has the parts hidden
     - how close simple rules get to the logged times for pick_pink, pick_blue, release and cycle time
   - **What it returns:** a results table plus a few annotated sample frames.
   - **Gate:** go if hands are found in about 90%+ of working frames and the rule-based pick/release/cycle times land within about 0.3 s of the log. Low part-detection on today's footage is expected; it confirms that the Phase 1 fixes are needed rather than killing the idea.

### Phase 1: the team changes the station
- **Dark mat:** so the white plate stands out.
- **Overhead mount:** fixed and closer, so the work area fills the frame.
- **Plate fixture:** holds the plate down, so the bricks go on where the camera can see them. This also removes Run 6's 15.9 s of holding the plate, a lean win worth its own slide.
- **Start spots:** marked spots where each part starts.
- **Phone to laptop:** connect the iPhone through Camo or Iriun Webcam (USB is steadier than Wi-Fi).
- **Gate:** re-run the Phase 0 test on a 2-minute recording. Comparing the before and after numbers decides whether to collect data.

### Phase 2: data (team, 1–2 days)
- **Recordings:** 30–50 cycles from the fixed camera, with 4–6 people and 2–3 lighting setups.
- **Deliberate mistakes:** wrong order, slope on backwards, a part dropped, a missing part, and placing then re-placing.
- **Idle footage:** a few minutes of nothing happening.
- **Labels:** 600–1,000 frames, about one every 0.3 s with near-duplicates dropped. Draw boxes in X-AnyLabeling for 5 labels: pink brick, white plate, blue slope, plate with pink, finished. Aim for 150–300 boxes per label.
- **Answer key:** 5–10 runs timed in the existing app's "Edit times" view. These are never used for training.
- **Split by run, never by frame.**

### Phase 3: train (about an hour)
- **Notebook:** the Roboflow Colab notebook (`roboflow/notebooks`), training YOLO11n or YOLO26n at 416 px.
- **Export:** ONNX at `opset=12`, as WebGPU in the browser requires.
- **License:** Ultralytics is AGPL, which is fine for class. RF-DETR (Apache 2.0) is the drop-in swap if this ever becomes a product.

### Phase 4: the Live page in the local app (Claude builds it, 1–2 days)
- **Detection loop:** a new page in `app/lego-station-run-log.html`, local runtime only (`LOCAL`), using getUserMedia. It adapts the inference loop from `nomi30701/yolo-object-detection-onnxruntime-web` (MIT): WebGPU with a CPU fallback.
- **Hands:** MediaPipe Hand Landmarker JS (`google-ai-edge/mediapipe-samples`, Apache 2.0), with each hand checked against the zones from `sop.json`.
- **Step logic:** borrows from IndustReal `PSR/psr_baseline.py` (Apache 2.0). A step is confirmed when confidence builds up over about 5 frames, with an expected next step and an out-of-order flag. Zone dwell timers are modeled on `roboflow/supervision`'s time-in-zone, rewritten in JavaScript.
- **Saving:** each finished cycle saves as a run in the existing run JSON format, with step frames captured at each completion. The existing cycle timelines, element times across runs, comparison against Run 1, and CSV export then work unchanged.
- **New live tiles:**
  - a cycle timer against the standard (Run 1's 5.5 s)
  - throughput and variation
  - a rework counter
  - hold and idle time per hand
  - a check of the finished build
  - flagged low-confidence moments, which feed the next training batch

### Phase 5: proof for the class
- **Accuracy:** score the live step times against the answer key, for example "mean error 0.2 s".
- **Validation write-up:** borrow the stopwatch-vs-computer-vision method from `skaramuk/automated-time-study-yolo`.
- **Citations:** IKEA ASM and Assembly101, plus the UW-Madison state-machine work.
- **Framing:** tie it to the M-24 thesis, a station with no data that now reports on itself.

## Not doing
- **Hosting the model on Colab:** it adds delay, breaks the no-upload goal, and sessions drop.
- **Training on substeps directly:** that's plan B, only if the rules approach fails.
- **Labeling before Phase 0 and 1:** the camera view will change.
- **The 20 MB / long-video fix:** on hold, unless teammates keep logging recorded clips.

## Open for Michael
- Can the team change the station (mat, fixture)? Phase 1 depends on it.
- What is the class deadline? It decides whether Phases 2–4 fit.
- Who records and labels?

## Verification (Phase 0)
- **Run:** `python tools/vision-test/run.py` over all six videos prints the table.
- **Spot-check:** look over the annotated frames by eye.
- **Compare:** set the rule-based pick/release/cycle times beside the `start` and `end` values in `data/runs/*.json` and report the error per run.
- **Setup:** first confirm Python exists (`python --version`) and install `mediapipe`, `ultralytics` and `opencv-python` into a local venv (about 1–2 GB).
- **Git:** nothing is committed without showing the diff, and nothing is pushed without Michael's yes.
