# Wire line: process, run day and data

The wire line page (`/line`) watches four stations with one overhead camera each, all on one laptop.
Right now its job is to **collect data**: cycle and substep times, QA pass or fail with a cause,
step detections with a confidence, and the raw video from every camera so the model team can label
and train. Start it with `npm start` and open http://localhost:4173/line in Chrome.

The process lives in `data/meta/wire-line.json` (draft v1). Edit that file, not the code. The page
shows a red banner if the file has a problem (for example a rule that names a zone the station does
not have).

## The product and the stations

Two wires joined by one crimped butt splice, then tested by lighting a bulb from a battery.

"Camera today" means the substep is seen with zones alone (motion in a drawn box, or the bulb
zone going bright). "Needs the model" means it is greyed out until that station's trained model is
loaded; its time is added to the substep before it.

| Station | Substep | Camera today | With the model |
|---|---|---|---|
| S1 Cut and strip (one cycle = a pair of wires) | Pull wire from supply | activity in Wire supply | same |
| | Measure to the mark and cut | activity in Cut and strip area | `cutter` in Cut and strip area |
| | Strip both ends | needs the model | `stripper` in Cut and strip area |
| | Check strands and strip length | needs the model | `stripped_end` in Cut and strip area |
| | Place the pair in the out tray (ends the cycle) | activity in Out tray | same |
| S2 Crimp side A | Take a wire pair from the in tray | activity in In tray | same |
| | Take a splice | activity in Splice bin | `splice` in Splice bin |
| | Push wire A into the splice | activity in Crimp area | `splice` in Crimp area |
| | Crimp side A | needs the model | `crimp_tool` in Crimp area |
| | Tug test side A | needs the model | `crimped_splice` in Crimp area |
| | Pass to station 3 (ends the cycle) | activity in Out tray | same |
| S3 Crimp side B (join) | Take the half-done unit | activity in In tray | same |
| | Push wire B into the splice | activity in Crimp area | `splice` in Crimp area |
| | Crimp side B | needs the model | `crimp_tool` in Crimp area |
| | Tug test both sides | needs the model | `crimped_splice` in Crimp area |
| | Pass to QA (ends the cycle) | activity in Out tray | same |
| S4 QA test | Take unit from the in tray | activity in In tray | same |
| | Clip the ends to the battery and bulb | activity in Test fixture | same |
| | Bulb test | Bulb zone goes bright | `bulb_on` in Bulb |
| | Unclip | needs a model rule (no class picked yet) | to be defined |
| | Sort into pass or fail bin (ends the cycle) | activity in Pass bin or Fail bin | same |

How the page counts:

- A substep counts after its signal holds for 3 frames in a row (`holdFrames`, about 0.4 s).
- Going back to an earlier substep inside a cycle is a **repeat**, not an error (S1 does pick, cut
  and strip twice per cycle).
- Jumping forward past a substep the camera could have seen raises a **flag**: "skipped <substep>".
- A cycle runs from its first detected substep to the moment the closing substep starts. The time
  between cycles is idle time.
- QA (S4): **light** = the bulb zone went bright during the cycle. **Bin** = which bin got the
  activity at the sort. **Result** = the manual Pass or Fail if someone pressed it (during the cycle
  or up to `qaGraceSec` = 5 s after the sort), else the bin. If light and bin disagree, a flag says
  "quality mismatch, review the video". No light and no bin seen = result `unknown`.
- Signal thresholds are in `defaults` (activity 0.1, bright 0.5, model class 0.4). Any rule can
  set its own `min`.

## Fail reasons

| Id | Reason | Cause station | Counts as a defect |
|---|---|---|---|
| `strip` | Strip too short or long, or cut strands | S1 | yes |
| `crimp_a` | Side A crimp loose or off | S2 | yes |
| `crimp_b` | Side B crimp loose or off | S3 | yes |
| `wire_damage` | Wire damaged | S1 | yes |
| `test_setup` | Test setup problem (battery, bulb, clips) | S4 | no, retest |
| `other` | Other | none | yes |

First-pass yield = passes / (passes + defect fails). Test setup fails are left out.

## Run day: cameras and zones

1. Mount each camera straight above its station so every tray, bin and work area is in view. Plug
   all four into the laptop, spread over different USB ports (a powered hub helps). Close any other
   app that uses a camera.
2. `npm start`, open http://localhost:4173/line in Chrome, press **Find cameras** and allow access.
   Pick one camera per station (a camera can only serve one station). To tell them apart, cover one
   lens and see which tile goes dark. The page asks for 640x480 at 15 fps.
3. On each station press **Setup**. Pick a zone and drag a box on the video around that tray, bin or
   work area. The next zone is picked for you. Zones save to the laptop
   (`data/meta/wire-line-setup.json`) and come back after a reload.
4. With the work area empty and still, press **Calibrate empty** (2 seconds). On S4, with the bulb
   dark press **Bulb off**, then light the bulb in the fixture and press **Bulb on**.
5. Leave **Rec** on (it is on by default for cameras). Press **Start session** and fill in the title,
   the crew / training group and the shift. Counts start from zero.
6. While the line runs, one person keeps the answer key: keys **1** to **4** when a unit leaves that
   station, **P** or **F** at QA (F opens the reason chips; pick one). On S4, Pass or Fail also counts
   as that station's cycle done, so do not press 4 as well. Manual presses are stored separately from
   what the cameras detect; they are how we score the detection.
7. Press **Stop session**. The banner links the two CSVs. Copy the session folder off the laptop:
   video is about 1 GB per hour for four cameras.

No camera handy? Pick a **recorded clip** as a station's source (they loop at normal speed). Past
session recordings are in the same list, which is also how a new model can re-score old footage.

## What a session produces

Folder `data/sessions/<id>/` (git-ignored), id like `20261015-233956-7509`:

| File | What it holds |
|---|---|
| `session.json` | title, crew, shift, notes, start and end, which source each station had, a copy of the config and of the zones, per-station recordings (start time, chunks, bytes, any gaps), and a summary at the end |
| `events.jsonl` | one event per line, appended as they happen (sort by `t`) |
| `s1.mp4` ... `s4.mp4` | each station's video (`.webm` on browsers without MP4 recording). `s1-2.mp4` is a second part if the source changed or Rec was switched off and on |

Exports: `/api/sessions/<id>/substeps.csv`, `/cycles.csv` and `/events.jsonl` (also linked from
**Sessions and exports**).

### Event fields

| Field | Meaning |
|---|---|
| `t` | time, epoch milliseconds (for a substep: when its signal started, not when it was confirmed) |
| `ts` | seconds since the session started |
| `station` | `s1` to `s4` |
| `type` | `substep`, `cycle_end`, `qa_result`, `flag`, `manual`, `session_start`, `session_end`, `source_change` |
| `substep`, `from` | the substep entered, and the one before it |
| `move` | `start` (first of a cycle), `next`, `jump` (skipped a visible substep), `repeat` |
| `source` | `zones`, `model` or `manual` |
| `conf` | mean signal over the 3 confirming frames, 0 to 1 |
| `cycle` | cycle number at that station (manual presses keep their own count) |
| `dur` | cycle length in seconds (on `cycle_end`) |
| `result`, `reason` | QA result (`pass`, `fail`, `unknown`) and fail reason id |
| `light`, `bin` | bulb seen lit (`true`, `false`, `null` = bulb zone not usable), bin seen (`pass`, `fail`, `null`) |
| `action` | manual button: `cycle_done`, `pass`, `fail` |
| `input` | on `source_change`: `camera`, `clip` or `none` |
| `note` | flag text ("skipped ...", "quality mismatch, review the video"), or the source label |
| `videoT`, `videoFile` | seconds into that station's recording, and which file: jump there to see the moment |

### substeps.csv (one row per detected substep, repeats are separate rows)

`session_id, crew, shift, station, cycle, seq, substep, label, move, source, start_ts, end_ts,
dur_s, conf, closes_cycle, video_file, video_t`

### cycles.csv (one row per finished cycle)

`session_id, crew, shift, station, basis, cycle, source, start_ts, end_ts, cycle_s, substeps,
repeats, flags, result, reason, cause_station, defect, light, bin, mismatch, video_file,
video_start_t, video_end_t, notes`

`basis` is `detected` (from the cameras) or `manual` (from the buttons; `cycle_s` is the time since
the previous press). The dashboard's **Count** switch picks which one the line numbers use; **Auto**
uses detected counts where a station has any, else manual.

## For the model team

**One model per station.** Each station gets its own model, trained from that station's footage and
labeled with that station's SOP substeps (the substep table above). The four trainers work
separately and do not need to agree on a class list.

**What to label.** States and tools you can see in one still frame, never motions. "Crimping" is
not a class; a `crimp_tool` in the crimp area is. Suggested classes per station
(`suggestedClasses` in `data/meta/wire-line.json`):

| Station | Classes |
|---|---|
| S1 Cut and strip | `wire, cutter, stripper, stripped_end` |
| S2 Crimp side A | `wire, splice, crimp_tool, crimped_splice` |
| S3 Crimp side B | `wire, splice, crimp_tool, crimped_splice` |
| S4 QA test | `battery, bulb_on, bulb_off` |

**Where the data is.** Every session folder has one video per station and `events.jsonl`. Use
`s1.mp4` for the S1 trainer, `s2.mp4` for S2, and so on. Use `videoT` to jump to detected moments,
and the manual Cycle done, Pass and Fail presses as the answer key. Split training and test data by
session, never by frame.

**Export the page expects.** ONNX, opset 12, square input (640 by default; 416 or 320 run faster on
this laptop):

    python -c "from ultralytics import YOLO; YOLO('best.pt').export(format='onnx', opset=12, imgsz=640, simplify=False)"

Input `[1, 3, S, S]`, RGB 0..1, letterboxed with gray 114 (the ultralytics default). Two output
shapes work:
- the raw head `[1, 4 + classes, N]` (boxes cx, cy, w, h, then one score per class; the page does
  the NMS), or
- an end-to-end head `[1, N, 6]` with rows x1, y1, x2, y2, score, class.

**Dropping it in.** Copy the file to `app/models/<name>.onnx` and add your station's entry under
`models` in `data/meta/wire-line.json`, keyed by the station id:

    "models": {
      "s1": { "file": "/models/s1-cut-strip.onnx", "classes": ["wire", "cutter", "stripper", "stripped_end"], "imgsz": 640 }
    }

List the classes in training order. Only add your own station's entry, so four people can edit the
file without clashing. A station with no entry uses the top-level `"model"` if there is one (a
shared fallback, `null` by default), else it stays on zones. Two stations can point at the same
file; the page loads it once. Reload `/line` and press **Model: on**: every station that has a
model runs it, and each station tile shows the file name it runs (or `zones`). Each substep whose
model rule uses only classes that station's model knows switches to the model; the rest keep their
zones rule. "Unclip" has no rule yet: pick a class and add `"model": { "zone": "fixture", "class": "<class>" }`
to `s4_disconnect`.

**Class-count check.** When the model loads, the page runs it once on a blank image and compares the
output to your class list. For a raw head, the number of classes in the file must equal the number in
your list. If not, a red banner says for example "lego-parts.onnx outputs 3 classes but the config
lists 10 for S2", and that station stays on its zones rules (other stations keep their models). An
end-to-end head does not show its class count, so there the page checks while it runs: a detection
with a class number beyond your list drops that station back to zones with the same kind of banner.

## Known limits

- **Performance (i7-1355U, Iris Xe).** With four 640x480 streams the zone signals run at about 6 to
  7 frames a second per station. With the models on (WASM, in a worker; one inference at a time for all stations) each station gets a model
  result only every 2 to 4 seconds (about 0.5 s per 640 px inference shared by four cameras); with
  hands on too, about every 4 to 5 seconds. The page stays responsive (short stalls under 0.25 s).
  `?gpu` tries WebGPU, which froze this laptop on `/live`.
- Keep the page in front: a background tab slows its timers to about 1 Hz.
- Activity is motion. A hand resting still is not activity unless **Hands** is on; a person walking
  through a zone is. Zones should cover the tray or bin, not the walkway.
- MP4 chunks arrive every 2 to 5 seconds (on keyframes). A `.webm` file has no duration header; fix
  it with `ffmpeg -i s1.webm -c copy s1-fixed.webm` if a player cannot seek.
- WIP counts start at zero, so units already sitting in trays when the session starts are not
  counted, and a missed detection shows up as a negative WIP.
