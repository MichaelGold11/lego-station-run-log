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

## Mistake alerts (step checker)

Each station runs the step checker from Ruza's `vision/live_check.py` (branch
`vision-step-checker`) on top of the substep tracking. It runs no inference of its own: it reads
the tracker's events, the station's latest model result, the hands and the zone motion the page
already has. The verdict shows on the station's tile (a card and a box) and sounds once.

| Verdict | When | Message |
|---|---|---|
| `verified` | a substep confirmed by its zones rule (at once, no confidence), or by its model rule at 0.60 or more (at the next clear-view check) | "Step N verified: <label>"; the closing substep says "Cycle complete" |
| `review` | a substep confirmed by its model rule under 0.60 | "<label> looks done but I'm not sure" |
| `mistake` | a jump past a substep the camera could see (the "skipped" flag), also when a cycle starts past one | "Wrong order: <label> before <skipped label> (step N skipped)" |
| `mistake` | `mustStay`: a verified substep's class is gone from its zone before the cycle ends | "<Class> is missing (step N)" |
| `mistake` | `positionCheck`: a listed class is off its saved spot by more than the tolerance, or turned | "<Class> is in the wrong position", "<Class> is turned the wrong way" |
| `review` | the last 3 checks do not agree | "Results flickered between checks, take a look" |
| `cleared` | a check finds nothing wrong while a mistake or review shows | "Mistake cleared. Continue with <next substep>" |

Rules (the thresholds are live_check.py's):

- Model boxes under 0.35 are ignored. A mistake that rests on a model box under 0.60 becomes a
  review, and so does a wrong-order jump confirmed by a model rule under 0.60. A missing part is
  always a mistake.
- Model checks (confidence, missing, position) only use model results taken while the station's
  view is clear: no hand in its tile (when Hands is on; a hand result counts for 5 s) and every
  drawn zone's activity under 0.05, for 0.3 s. The last 3 such results vote, and the kind 2 of
  them agree on wins. A check runs once per clear spell, again when the tracker confirms a new
  model substep, and every 1.0 s while a mistake or review shows. A station without a model checks
  the clear view alone, so for it a clear view clears a wrong-order mistake.
- If several model substeps are confirmed before a check, only the newest gets a verdict; the
  older ones count as done (as in live_check.py).
- The same mistake or review again keeps showing and does not sound again. A less sure look at a
  showing mistake (the same message as a review) does not turn it back into a review; a review
  that becomes sure is a new mistake and sounds.
- The box: red (mistake) or amber (review), 5 px, around the model box it rests on, else around
  the zone; green for 2 s after a verified step. The card: MISTAKE (flashing at 4 Hz) or NEEDS
  REVIEW, the station and the message (up to 3 lines); CLEARED shows for about 3 s. The checklist
  row the verdict is about says "Mistake - fix and clear the view" or "Needs review".
- Sounds (Web Audio, live_check.py's tones): mistake 3 beeps of 880 Hz for 220 ms each, review
  600 Hz for 300 ms, verified 1320 Hz for 120 ms. One per new verdict, none for cleared. The
  toolbar's **Sound** switches all stations, each tile has **Mute**, and the audio starts after
  the first click on the page.

Config (all optional):

- `mustStay` in a substep's model rule, default off:
  `"model": { "zone": "crimp", "class": "crimped_splice", "mustStay": true }`. Once that substep
  is verified, its class must stay visible in its zone until the cycle ends. Off on every wire
  substep for now.
- `positionCheck` on a station, default none:
  `"positionCheck": { "anchor": "<zone id>", "classes": ["<class>", ...], "tolerance": 0.14 }`.
  It needs the station's model. **Save correct state** in that station's Setup panel takes the
  last 10 clear-view model results (at least 3) and stores, for each listed class, its median box
  relative to the anchor zone (center x and y, width and height, as shares of the zone; plus
  landscape or portrait) in `data/meta/wire-line-setup.json` under that station as `ref`, next to
  the zones. Live, a listed class inside the anchor zone that is off by more than `tolerance` of
  the zone in x or y is in the wrong position, and one that turned between landscape and portrait
  is turned the wrong way. Redrawing the anchor zone or **Clear zones** drops the saved state. No
  wire station has a `positionCheck` yet.
- `sounds` at the top level: `{ "verified": false }` silences the chirp on verified steps;
  mistakes and reviews still sound. Default `true`.

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
2. `npm start`, open http://localhost:4173/line in Chrome and pick one camera per station in its
   camera list (a camera can only serve one station). The first time, pick **USB camera: allow
   access**; once access is given the page finds the cameras by itself, at load and whenever one is
   plugged in or out. To tell them apart, cover one lens and see which tile goes dark. The page asks
   for 640x480 at 15 fps.
3. On each station press **Setup**. Pick a zone and drag a box on the video around that tray, bin or
   work area. The next zone is picked for you. Zones save to the laptop
   (`data/meta/wire-line-setup.json`) and come back after a reload.
4. With the work area empty and still, press **Calibrate empty** (2 seconds). It also records every
   zone's dark brightness, so on S4 keep the bulb dark for it; then light the bulb in the fixture
   and press **Bulb on**.
5. Leave **Rec** on (it is on by default for cameras). Press **Start session** and fill in the title,
   the crew / training group and the shift. Counts start from zero.
6. While the line runs, one person keeps the answer key: keys **1** to **3** when a unit leaves that
   station, **P** or **F** at QA (F opens the reason chips; pick one). Pass or Fail also closes S4's
   manual cycle, so S4 has no number key (4 only shows "S4 closes its cycle with P or F"). Manual
   presses are stored separately from what the cameras detect; they are how we score the detection.
7. Press **Stop session**. The banner links the three CSVs; `events.jsonl` and `session.json` fold
   under **raw**. Copy the session folder off the laptop: video is about 1 GB per hour for four
   cameras.

No camera handy? Pick a **demo clip** (the LEGO run videos) as a station's source; clips loop at
normal speed. Each station's list also has its own 10 newest session recordings (S1 lists only
`s1` files), which is how a new model re-scores old footage.

## iPhones as station cameras

Any station can use an iPhone instead of a USB camera, so four iPhones can run the whole line with
nothing plugged into the laptop. Pick **iPhone (scan a QR code)** as the station's source: the tile
shows a QR code. Scan it with that station's iPhone (the Camera app), open the link in Safari, allow
the camera, and within a few seconds the tile shows the phone's video. From then on the phone is
the station's camera like any other: zones, Calibrate, the model, mistake alerts and Rec all work
the same.

How it works:

- `npm start` runs a second, HTTPS listener for the phones on port **4174** (`PHONE_PORT`; set
  `PHONE_PORT=off` to turn it off). iPhone Safari only opens the camera on a secure page, so it has
  its own certificate. It answers on every network address (IPv6 and IPv4) but serves only the
  phone page, its certificate download and the phone half of the connection setup. The app, the
  data, the sessions and the models stay on http://localhost:4173, which the network cannot reach.
- The video goes straight from the phone to the laptop's browser over the local network (WebRTC).
  It never leaves the network; the server only passes one offer and one answer per connection.
- The phone sends its back camera at 640x480 and 15 fps, the same as the USB cameras. The tile's
  chip and footer show what it actually sends ("iPhone sends 640x480 at 15 fps").
- **Each station has its own link and key** (`k=` in the link), so S1's link cannot be edited into
  S2's. The keys come from a secret saved in `data/phone-cert/pairing-secret`, so links and QR codes
  keep working when `npm start` restarts: phones only scan again after **New pairing code** (the
  toolbar; two clicks). That makes new keys for every station, cuts off every phone, and the old
  links stop working.
- If a phone drops (Safari closed, the phone locked, the network hiccups), its tile says "Phone
  lost" after about 10 to 15 seconds and shows the QR code again. The station counts as no video
  (a `source_change` to `none` with the note "iPhone lost"), its open cycle is dropped, and Rec
  stops that part. The phone page reconnects by itself as soon as it can; Rec then starts a new part
  (`s1-2.mp4`). Reloading the phone page or `/line` also reconnects by itself.
- Another phone that opens the same station's link takes over that station; the first one stops
  and offers "Use this phone instead".

The link: the QR code uses the laptop's Bonjour name, like
`https://michaels-macbook-pro.local:4174/phone?s=s1&k=...`. That name keeps working when the
laptop's address changes. The **Address** list under the QR code also offers the laptop's raw
addresses (an IPv6 address shows in brackets) in case a phone cannot find the name.

**The certificate warning.** The first time, Safari says the connection is not private: tap **Show
Details**, then **visit this website**, and confirm. That is the normal path. Optionally, a phone
can trust the laptop's certificate once instead (the phone page explains how: download it, install
the profile, turn it on in Certificate Trust Settings). Trusting it only lets this laptop vouch for
its own `.local` name and private network addresses, never for any other website. It only stops the
warning on the `.local` link; links by a public address (like a hotspot's IPv6 address) always warn.
The certificate files are in `data/phone-cert/` (git-ignored; `ca.key` never leaves the laptop).
`node scripts/phone-cert.mjs` checks them and prints what they cover. The server certificate is
remade by itself when the laptop's addresses change.

**Phone setup.** On each iPhone: Settings > Display & Brightness > Auto-Lock: **Never**; keep it
plugged in; keep Safari in front on the camera page (iPhone stops the camera when Safari goes to the
background or the screen locks); and if it is mounted flat over the table, turn on **Portrait
Orientation Lock** in Control Center first so the picture does not turn.

**The network.** The phones and the laptop must be on the same network, and that network must let
devices reach each other. Campus Wi-Fi often blocks that: the phone then says "The video cannot get
through". Free fallbacks: a home router, or a phone's Personal Hotspot that the laptop and the other
phones join. Michael's carrier gives an IPv6-only hotspot, so use the `.local` link there (the
laptop's IPv4 address on it is a placeholder that phones cannot reach). The hotspot iPhone can also
be one of the four cameras; it reaches the laptop the same way. Test the network the day before.
On a Mac, allow incoming connections for `node` if the firewall asks.

## What a session produces

Folder `data/sessions/<id>/` (git-ignored), id like `20261015-233956-7509`:

| File | What it holds |
|---|---|
| `session.json` | title, crew, shift, notes, start and end, which source each station had (`camera`, `clip`, `phone` or `none`), a copy of the config and of the zones, per-station recordings (start time, chunks, bytes, any gaps), and a summary at the end |
| `events.jsonl` | one event per line, appended as they happen (sort by `t`) |
| `s1.mp4` ... `s4.mp4` | each station's video (`.webm` on browsers without MP4 recording). `s1-2.mp4` is a second part if the source changed or Rec was switched off and on |

Exports: `/api/sessions/<id>/substeps.csv`, `/cycles.csv`, `/verdicts.csv` and `/events.jsonl`
(also linked from **Sessions and exports**, which updates by itself every 10 seconds while open;
the last two under **raw**).

### Event fields

| Field | Meaning |
|---|---|
| `t` | time, epoch milliseconds (for a substep: when its signal started, not when it was confirmed) |
| `ts` | seconds since the session started |
| `station` | `s1` to `s4` |
| `type` | `substep`, `cycle_end`, `qa_result`, `flag`, `manual`, `session_start`, `session_end`, `source_change`, `verdict` |
| `substep`, `from` | the substep entered, and the one before it |
| `move` | `start` (first of a cycle), `next`, `jump` (skipped a visible substep), `repeat` |
| `source` | `zones`, `model` or `manual` |
| `conf` | mean signal over the 3 confirming frames, 0 to 1. On a verdict: the model confidence it rests on (empty for zones) |
| `cycle` | cycle number at that station (manual presses keep their own count) |
| `dur` | cycle length in seconds (on `cycle_end`) |
| `result`, `reason` | QA result (`pass`, `fail`, `unknown`) and fail reason id |
| `light`, `bin` | bulb seen lit (`true`, `false`, `null` = bulb zone not usable), bin seen (`pass`, `fail`, `null`) |
| `action` | manual button: `cycle_done`, `pass`, `fail` |
| `input` | on `source_change`: `camera`, `clip`, `phone` or `none`. An iPhone counts as `phone` only while it is connected: picking it, losing it or cutting it off is `none` (the note says "iPhone (waiting for the phone)", "iPhone lost" or "iPhone cut off: new pairing code") |
| `note` | flag text ("skipped ...", "quality mismatch, review the video"), or the source label |
| `kind` | on a verdict: `verified`, `mistake`, `review` or `cleared` |
| `reason` | on a verdict: `progress`, `complete`, `low_confidence`, `wrong_order`, `missing`, `wrong_position`, `turned`, `flicker` or `cleared` |
| `message` | on a verdict: what the card said |
| `step_s` | on a verified verdict: seconds since that station's previous verified step (or the cycle start) |
| `cycle_s` | on "Cycle complete": the cycle time in seconds |
| `videoT`, `videoFile` | seconds into that station's recording, and which file: jump there to see the moment |

### substeps.csv (one row per detected substep, repeats are separate rows)

`session_id, crew, shift, station, cycle, seq, substep, label, move, source, start_ts, end_ts,
dur_s, conf, closes_cycle, video_file, video_t`

### cycles.csv (one row per finished cycle)

`session_id, crew, shift, station, basis, cycle, source, start_ts, end_ts, cycle_s, substeps,
repeats, flags, mistakes, reviews, result, reason, cause_station, defect, light, bin, mismatch,
video_file, video_start_t, video_end_t, notes`

`mistakes` and `reviews` count the cycle's mistake and review verdicts (an alert that stays on screen counts once).

`basis` is `detected` (from the cameras) or `manual` (from the buttons; `cycle_s` is the time since
the previous press). The dashboard's **Count** switch picks which one the line numbers use; **Auto**
uses detected counts where a station has any, else manual.

### verdicts.csv (one row per verdict, in time order)

`session_id, station, time, ts, cycle, step, event, message, confidence, step_seconds,
cycle_seconds, video_file, video_t`

The columns of live_check.py's session log, plus the session, the station, `ts` and the video
position. `time` is UTC, `step` is the substep's number at its station, `event` is the verdict
kind. A verdict from a check between cycles counts toward the next cycle.

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
file; the page loads it once. Reload `/line`: every station that has a model runs it by itself,
and each station tile shows the file name it runs (or `zones`). **Model: off** stops them on a slow
laptop, and the laptop remembers that until someone turns it back on. Each substep whose
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
- Mistake alerts that need the model wait for 3 model results in a clear view: about 6 to 12 s with
  four stations on models (one result per station every 2 to 4 s), well under 1 s with one. A
  cycle whose first substep the zones missed starts with a wrong-order mistake, the same moment
  that raises the "skipped" flag.
- Activity is motion. A hand resting still is not activity unless **Hands** is on; a person walking
  through a zone is. Zones should cover the tray or bin, not the walkway.
- MP4 chunks arrive every 2 to 5 seconds (on keyframes). A `.webm` file has no duration header; fix
  it with `ffmpeg -i s1.webm -c copy s1-fixed.webm` if a player cannot seek.
- WIP counts start at zero, so units already sitting in trays when the session starts are not
  counted, and a missed detection shows up as a negative WIP.
- iPhones: tested with Chrome's fake cameras as four phones (two by the `.local` name, two by the
  IPv6 address), including reloads, a lost phone and an 8 second recording. A real iPhone has been
  tested up to the camera page (over the IPv6-only hotspot, by the `.local` name); a real iPhone
  streaming into `/line`, four at once, and the picture's orientation when a phone lies flat are
  not tested yet.
- A lost iPhone takes about 10 to 15 seconds to show as lost (WebRTC waits that long before giving up).
