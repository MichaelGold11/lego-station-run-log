# Wire line: process, run day and data

The wire line page (`/line`) watches the line's stations, one overhead camera each, all on one laptop.
The stations sit on a floor plan you can arrange ([The floor](#the-floor-layouts-and-stations)): the built-in
Class test layout has the config's four stations, and a layout can have any number.
Right now its job is to **collect data** with nothing pressed during a run: cycle and substep times,
QA pass or fail (with a cause when the cameras are being scored), step detections with a confidence,
and the raw video from every camera so the model team can label and train. Start it with `npm start` and open http://localhost:4173/line in Chrome.

The process lives in `data/meta/wire-line.json` (draft v2). Edit that file, not the code. The page
shows a red banner if the file has a problem (for example a rule that names a zone the station does
not have). The engine and server tests run against a frozen copy of the v1 process
(`scripts/fixtures/wire-line-v1.json`), so editing the real process does not break them; they also
check that the shipped file has no problems.

## The product and the stations

Three wires (red, white, black) cut to length against a ruler, laid in color order (red top, white
middle, black bottom) and closed in a 3-port lever connector. A second lever connector joins the
other end of the red wire to a separate black wire. QA is a pull test: no wire may come out of either
connector. There are no trays, bins or hand-off zones: the wires or the unit slide straight into the next
station's view, and that arrival is the next station's first substep. Each station's last substep ends
its cycle.

"Camera today" means the substep is seen with zones alone (motion in a drawn box). "With the model"
is the rule that takes over once that station's trained model is loaded.

| Station | Substep | Camera today | With the model |
|---|---|---|---|
| S1 Cut (one cycle = one wire, `perUnit` 3) | Cut the wire | activity in Cut area | `cutter` in Cut area |
| | Check for correct length against the ruler (ends the cycle) | activity in Ruler | same |
| S2 Arrange and clamp | Wires arrive from S1 (`arrival`) | activity in Cut wires | `red_wire`, `white_wire` or `black_wire` in Cut wires |
| | Open the lever connector | activity in Lever connectors | `connector_open` in Work area |
| | Arrange the wires: red top, white middle, black bottom | activity in Cut wires | same; the color order is the position check |
| | Close the levers on the wires (ends the cycle) | activity in Work area | `connector_closed` in Work area |
| S3 Second connector | Unit arrives from S2 (`arrival`) | activity in Work area | `red_wire` in Work area |
| | Add a new lever connector to the other end of the red wire | activity in Lever connectors | `connector_open` in Work area |
| | Get a black wire | activity in Black wires | same |
| | Insert the black wire into the new connector (ends the cycle) | activity in Work area | same (zones only: the unit arrives with connector 1 closed, so `connector_closed` cannot tell this step apart) |
| S4 QA pull test | Unit arrives from S3 (`arrival`) | activity in Test area | `connector_closed` in Test area |
| | Pull test, then Pass or Fail (ends the cycle) | the P or F key | same |

Two substeps in a row never use the same zone's activity, or the second would fire while the first is
still going on.

S2 has a `positionCheck` on `red_wire`, `white_wire` and `black_wire` in its Work area: with S2's model
on and its correct state saved, a wire off its spot (for example red and black swapped) is a
mistake at S2, not a QA fail. S4 has an empty `qa` block, so it gets the Pass and Fail buttons; with
no bulb and no bins the result is the P or F press (else `unknown`), and S4's cycle count comes from
those presses.

### Units, linked by order

There is no marker on the wires, so a unit is followed across the stations by order: unit k is
cycles `(k-1)*perUnit + 1` to `k*perUnit` of every station (S1 has `"perUnit": 3`, the others 1), using
each station's detected cycles if it has any, else its manual presses (as **Auto**). This holds as long
as nobody reorders or sets aside wires or units.

- `perUnit` on a station: cycles per unit, a whole number, default 1. WIP between two stations counts
  units (S1's cycles divided by 3), and the bottleneck is the station with the longest time per unit
  (average cycle times `perUnit`).
- `arrival` on a station: the substep that marks the unit arriving (S2 `s2_arrive`, S3 `s3_arrive`,
  S4 `s4_arrive`). Being the first substep, an arrival starts a cycle instead of raising a "skipped"
  flag. The k-th detection of it is unit k's arrival time.
- `units.csv` (`/api/sessions/<id>/units.csv`): one row per unit. Columns: `session_id, crew, shift, unit,
  status` (`done` or `at sN`), then per station `sN_basis, sN_cycles, sN_start_ts, sN_end_ts, sN_work_s,
  sN_wait_s, sN_mistakes, sN_reviews, sN_video_file, sN_video_t`, then `result, reason, cause_station,
  defect, lead_s`. `sN_wait_s` is from the previous station finishing the unit to this station's
  arrival (else its first cycle start); `lead_s` is from S1's start to the last station's end.
  Mistakes and reviews are counted for stations on detected cycles.

How the page counts:

- A substep counts after its signal holds for 3 frames in a row (`holdFrames`, about 0.4 s).
- Going back to an earlier substep inside a cycle is a **repeat**, not an error.
  The one exception is a station's arrival substep (the `arrival` field): it counts at most once per cycle, so its rule
  flickering back on later in the cycle does not send the state back to it.
- Jumping forward past a substep the camera could have seen raises a **flag**: "skipped <substep>".
- A substep whose zones are all undrawn when the session starts can never fire. The page raises one **flag** per such
  substep at the start: "no data: <zone label> not drawn" (it carries the substep id and no cycle number, so it is in
  `events.jsonl` and not in the per-cycle counts of `cycles.csv`). In the summary that substep has `substepAvg` `null`
  (never 0) and its id is in the station's `unobserved` list. Start session asks for a confirm when any step has no data.
- A cycle runs from its first detected substep to the moment the closing substep starts. The time
  between cycles is idle time.
- QA: the engine can also read a bulb and bins (`qa.lightSubstep`, `qa.sortSubstep`, `qa.bins`, as in
  the v1 fixture); the v2 process uses neither. **light** = the bulb zone went bright during the cycle. **Bin** = which bin got the
  activity at the sort. **Result** = the manual Pass or Fail if someone keyed it (Score the cameras
  on; during the cycle
  or up to `qaGraceSec` = 5 s after the sort), else the bin. If light and bin disagree, a flag says
  "quality mismatch, review the video". No light and no bin seen = result `unknown`.
- Signal thresholds are in `defaults` (activity 0.1, bright 0.5, model class 0.4). Any rule can
  set its own `min`.

## The floor: layouts and stations

`/line` shows the stations as cards on a floor plan, where they really stand, with arrows for the
flow (1 to 2 to 3 ...). The floor is bigger than the window: drag it (or a card outside its
buttons) to pan, scroll with two fingers to pan, pinch or ctrl+scroll to zoom. The cluster at the
bottom right zooms out, shows the zoom (click it for 100%), zooms in, and **Fit** shows every
station. Zoom runs from 25% to 200%. Each browser remembers its view of each layout. Video, zones,
Calibrate, the models, Rec and the mistake alerts work the same at any zoom, and a station keeps
counting when its card is off screen.

**Roles and stations.** The stations in `data/meta/wire-line.json` (S1 Cut and strip, S2 Crimp
side A, S3 Crimp side B, S4 QA test) are the **roles**: the trained jobs, each with its substeps,
zones and model. A floor station picks one role and runs it, so two stations can run the same role
(two QA testers), and the models never change. A station has an id (`s1`, `s5` ...), a name and
a position.

**Layouts.** **Class test** is built in and read only: the config's stations in the L of our
tables (S1 at the top, S2 below it, S3 to the right of S2, S4 to the right of S3). Changing it
saves a copy, "Class test copy", and switches to it. Saved layouts and the one in use are kept on
the laptop in `data/meta/wire-line-layouts.json` (git-ignored), so a browser reset keeps them.
**Edit layout** opens a bar to pick a layout, rename it, start a **New blank** one, **Duplicate**
it or **Delete** it (two clicks; not Class test), and gives each card a strip: name, role, its
place in the flow (earlier, later) and **Remove** (two clicks). Drag a card to move it; it snaps
to the 40-unit grid. Nothing in the layout can change while a session records ("Stop the session
to change the layout.").

**Add station (+ Station)** asks for the role (default: the last station's) and a name (prefilled, like
"S5 QA test"), puts the station in the middle of the view (or the nearest free spot), and opens
its **Connect a camera** sheet.

**A station id is a camera spot on this laptop.** A new station gets the lowest free `s<n>`. The
browser keeps each id's camera, Record video and Mute, and phone links are keyed by id, so a copied
layout keeps its cameras and phones, and a station removed and added again finds its camera. Zones
and calibration are kept per station and role in `wire-line-setup.json`: under `s2` for station
s2 running its own role, under `s5:s4` for station s5 running role s4. A station given another role
needs that role's boxes; giving it its old role back finds the old ones.

**Two stations with one role.** The line numbers follow these rules:

- Units, passes, fails and yield add up over every QA station.
- Stations next to each other in the flow with the same role work side by side: one stage. The flow
  row shows a **+** between them instead of a WIP number; WIP is counted between stages (each
  stage's cycles added up). The bottleneck and the takt check use a station's average cycle divided
  by the number of stations in its stage.
- A fail reason's cause is a role; the fail is charged to the first station in flow order running
  that role (the cameras cannot tell which of two crimpers made the unit).
- The answer key (Score the cameras on): the number keys **1** to **9** are the stations in flow
  order (a station past the ninth has its button on the bar, no key). **P** and **F** score the first
  QA station in flow order; another QA station has its own Pass and Fail buttons on the bar.

With one station per role (Class test) every number is the same as before the floor.

**Operator and training level.** Each card's **Op** chip takes the operator's anonymous number
(shown as Op-07) and level: **new**, **in training** or **certified** (ids `new`, `training`,
`certified`, as in `docs/dashboard-plan.md`). It can change during a run, and **No operator**
clears it. Each change logs an `operator` event; at session start every station with an operator
logs one, so `events.jsonl` alone says who was where. The server refuses an operator event or a
session whose code is not `Op-<digits>` or whose level is not one of the three, and keeps only
station, code and level of the event. No names.

## Mistake alerts (step checker)

Each station runs the step checker from Ruza's `vision/live_check.py` (branch
`vision-step-checker`) on top of the substep tracking. It runs no inference of its own: it reads
the tracker's events, the station's latest model result, the hands and the zone motion the page
already has. The verdict shows on the station's card (an alert box on its video and a box around the spot) and sounds once.

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
  view is clear: no hand in its video (when Hand tracking is on; a hand result counts for 5 s) and every
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
  **Sound** at the top switches all stations, each station has **Mute sounds** in Setup, and the audio starts after
  the first click on the page.

Config (all optional):

- `mustStay` in a substep's model rule, default off:
  `"model": { "zone": "work", "class": "connector_closed", "mustStay": true }`. Once that substep
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
  is turned the wrong way. Redrawing the anchor zone or **Clear zones** drops the saved state. S2 has
  one (the color order); the other stations have none.
- `sounds` at the top level: `{ "verified": false }` silences the chirp on verified steps;
  mistakes and reviews still sound. Default `true`.

## Fail reasons

QA is only the pull test, so the reasons are about which connector let go. Wrong length, wrong color
order and skipped steps are caught live at their own station, not here.

| Id | Reason | Cause station | Counts as a defect |
|---|---|---|---|
| `pulled_c1` | Wire pulled out of connector 1 (the 3-wire connector) | S2 | yes |
| `pulled_c2` | Wire pulled out of connector 2 (red to black) | S3 | yes |
| `other` | Other | none | yes |

The cause station is a role. On a floor with two stations of one role, the fail is charged to the first of them in flow
order (`cause_station` in cycles.csv is that station's id).

First-pass yield = passes / (passes + defect fails). A reason with `"defect": false` (none in v2) is left out. A reason, and so a
cause, only comes from the answer key (F with **Score the cameras** on). Without it a fail from the
bin has no reason, and the yield tile says "Turn on Score the cameras to log reasons".

## Run day: cameras and zones

1. Mount each camera straight above its station so every parts pile, the ruler (S1) and the work
   area are in view. Plug
   them all into the laptop, spread over different USB ports (a powered hub helps). Close any other
   app that uses a camera. Any camera Chrome lists works: webcams, capture cards, Continuity Camera,
   OBS Virtual Camera.
2. `npm start`, open http://localhost:4173/line in Chrome. A station with no camera shows **Connect
   a camera**: pick **USB camera** (the first time this asks for camera access). One free camera is
   taken at once; with several, pick one (a camera can only serve one station). Once access is
   given the page finds the cameras by itself, at load and whenever one is plugged in or out. To tell
   them apart, cover one lens and see which card goes dark. The page asks for 640x480 at 15 fps. The
   choice is saved per laptop; **Setup** has each station's full Camera list to change it.
3. Press **Setup** (top right, or a station's **Setup needed**). Setup opens every station at once,
   plus a bar with the line's switches (Models, Hand tracking, Count by, Reset counts, New pairing
   code). Pick a zone and drag a box on the video around that parts pile, ruler or work area. The next zone
   is picked for you. Zones save to the laptop (`data/meta/wire-line-setup.json`) and come back after
   a reload. During a session, Setup warns that changes count from then on.
   A station with no saved zones starts from the **standard setup** of its role: the zones for the
   camera mount the models were trained on, kept in `data/meta/wire-line-standard.json` and committed
   to git ("Standard setup applied"). Draw the zones once on the trained mount, press **Save as
   standard** in Setup and commit that file; **Use standard setup** puts it back on a station, and
   editing then pressing **Save as standard** updates it when the mount changes. The standard is the
   zones only: calibration depends on the light that day, so each laptop calibrates itself. It is read
   and written through `GET` and `PUT /api/line/standard`.
4. With the work area empty and still, press **Calibrate empty** (2 seconds).
5. Press **Done**. Each station's head says **Ready**, or what is missing ("Setup needed", which opens
   Setup). Recording is on for cameras and phones (Setup's **Record video**, per station, off by
   default for replayed clips); a recording station shows **REC** and its size in its head. Press
   **Start session**, then **Enter**: the title is filled in with the date, time and shift (Morning
   from 5:00, Afternoon from 12:00, Evening from 17:00, Night from 22:00), and it follows the Shift
   field until someone edits it. **More details** holds the crew / training group, the shift and
   notes. The line under the title lists what is not ready (no camera, Setup needed, nothing
   recording). Counts start from zero.
6. A normal run needs nothing pressed: the cameras log cycles, substeps, QA arrivals and
   mistakes. To score the cameras, turn on **Score the cameras** in Setup (saved per laptop). Then a
   bar at the bottom holds the answer key and one person keys it: a station's number (its place in
   the flow; **1** to **3** on Class test) when a unit leaves that station (on S1 after each wire, so three per unit), **P** or **F** at QA (F
   opens the reason chips just above the bar; pick one). Pass or Fail also closes the QA station's
   manual cycle, so its number key only shows "S4 closes its cycle with P or F". Each key shows its count, and the station's card flashes. With scoring off the bar
   is gone and the keys only say how to turn it on. Manual presses are stored separately from what
   the cameras detect; they are how we score the detection.
7. Press **Stop session**. The banner links the four CSVs (with units.csv); `events.jsonl` and `session.json` fold
   under **raw**. Copy the session folder off the laptop: video is about 1 GB per hour for four
   cameras.

No camera handy? **Connect a camera** > **Recorded clip** offers the **demo clips** (the LEGO run
videos); clips loop at
normal speed. Each station's list also has its own 10 newest session recordings (S1 lists only
`s1` files), which is how a new model re-scores old footage.

## Phones and tablets as station cameras

Any station can use a phone or tablet instead of a USB camera (an iPhone, an iPad, an Android phone,
or another laptop's browser), so phones can run the whole line with nothing plugged into the laptop.
Press **Connect a camera** on the station and pick **Phone or tablet (scan a QR code)**: the card
shows a QR code. Scan it with that station's phone (its camera app), open the link in Safari or
Chrome, allow the camera, and within a few seconds the card shows the phone's video. The phone page is
plain WebRTC in the browser: nothing in it is iPhone only. From then on the phone is
the station's camera like any other: zones, Calibrate, the model, mistake alerts and Rec all work
the same.

How it works:

- `npm start` runs a second, HTTPS listener for the phones on port **4174** (`PHONE_PORT`; set
  `PHONE_PORT=off` to turn it off). Phone browsers only open the camera on a secure page, so it has
  its own certificate. It answers on every network address (IPv6 and IPv4) but serves only the
  phone page, its certificate download and the phone half of the connection setup. The app, the
  data, the sessions and the models stay on http://localhost:4173, which the network cannot reach.
- The video goes straight from the phone to the laptop's browser over the local network (WebRTC).
  It never leaves the network; the server only passes one offer and one answer per connection.
- The phone sends its back camera at 640x480 and 15 fps, the same as the USB cameras. The chip on
  the video and the station's diagnostics row in Setup show what it actually sends ("Phone sends
  640x480 at 15 fps"). **Show QR** in Setup brings a live phone's QR code back, to swap phones.
- **Each station has its own link and key** (`k=` in the link), so S1's link cannot be edited into
  S2's. The keys come from a secret saved in `data/phone-cert/pairing-secret`, so links and QR codes
  keep working when `npm start` restarts: phones only scan again after **New pairing code** (in
  Setup; two clicks). That makes new keys for every station, cuts off every phone, and the old
  links stop working. Only the stations on the floor layout in use get keys: a link for a station
  that is not on that layout is refused, even with its correct key.
- If a phone drops (the browser closed, the phone locked, the network hiccups), its card says "Phone
  lost" after about 10 to 15 seconds and shows the QR code again. The station counts as no video
  (a `source_change` to `none` with the note "Phone lost"), its open cycle is dropped, and Rec
  stops that part. The phone page reconnects by itself as soon as it can; Rec then starts a new part
  (`s1-2.mp4`). Reloading the phone page or `/line` also reconnects by itself.
- Another phone that opens the same station's link takes over that station; the first one stops
  and offers "Use this phone instead".

The link: the QR code uses the laptop's Bonjour name, like
`https://michaels-macbook-pro.local:4174/phone?s=s1&k=...`. That name keeps working when the
laptop's address changes. The **Address** list under the QR code also offers the laptop's raw
addresses (an IPv6 address shows in brackets) in case a phone cannot find the name.

**The certificate warning.** The first time, the browser says the connection is not private. Safari:
tap **Show Details**, then **visit this website**, and confirm. Chrome (Android, a laptop): tap
**Advanced**, then **Proceed**. That is the normal path; a page opened past the warning is still a
secure page and gets the camera (checked in desktop Chrome, which shares this with Chrome on Android). Optionally, a phone
can trust the laptop's certificate once instead (the phone page explains how: download it, install
the profile, turn it on in Certificate Trust Settings on an iPhone or iPad; install it as a CA certificate in
Settings on Android). Trusting it only lets this laptop vouch for
its own `.local` name and private network addresses, never for any other website. It only stops the
warning on the `.local` link; links by a public address (like a hotspot's IPv6 address) always warn.
The certificate files are in `data/phone-cert/` (git-ignored; `ca.key` never leaves the laptop).
`node scripts/phone-cert.mjs` checks them and prints what they cover. The server certificate is
remade by itself when the laptop's addresses change.

**Phone setup.** On each iPhone or iPad: Settings > Display & Brightness > Auto-Lock: **Never**;
keep it plugged in; keep Safari in front on the camera page (the camera stops when Safari goes to the
background or the screen locks); and if it is mounted flat over the table, turn on **Orientation
Lock** in Control Center first so the picture does not turn. On Android: Settings > Display > Screen
timeout at its longest, Chrome in front, and **Auto-rotate** off. If an Android phone cannot open the
`.local` link (older Android versions do not look up `.local` names), pick the laptop's IP address
in the **Address** list under the QR code.

**The network.** The phones and the laptop must be on the same network, and that network must let
devices reach each other. Campus Wi-Fi often blocks that: the phone then says "The video cannot get
through". Free fallbacks: a home router, or a phone's Personal Hotspot that the laptop and the other
phones join. Michael's carrier gives an IPv6-only hotspot, so use the `.local` link there (the
laptop's IPv4 address on it is a placeholder that phones cannot reach). The hotspot phone can also
be one of the cameras; it reaches the laptop the same way. Test the network the day before.
On a Mac, allow incoming connections for `node` if the firewall asks.

## What a session produces

Folder `data/sessions/<id>/` (git-ignored), id like `20261015-233956-7509`:

| File | What it holds |
|---|---|
| `session.json` | title, crew, shift, notes, start and end, the page's switches at the start (`client`: `model`, `hands`, `score` = Score the cameras), which source each station had (`camera`, `clip`, `phone` or `none`), a copy of the config and of the zones, `layout` (the floor at the start: its id and name, and per station `id`, `name`, `role`, `x`, `y`, `order`, `input` and `operator`), `operators` (the current operator per station, kept up to date from the `operator` events), per-station recordings (start time, chunks, bytes, any gaps), and a summary at the end. `config` is the file as written; the summary and the CSVs apply the layout to it (`LineEngine.applyLayout`). Sessions from before the floor have no `layout` |
| `events.jsonl` | one event per line, appended as they happen (sort by `t`) |
| `captures.jsonl`, `captures/<id>.jpg` | one line per captured frame and its full-frame JPEG (at most 400 KB). A line holds `id` (`c0001`...), `station`, `role`, `stationName`, `t` (ms), `videoT` and `videoFile` (where in the recording), `reason`, `substep`, `cycle`, `claim` (what the system believed, as text), `boxes` (`cls`, `conf`, normalized box), `zones`, `standard`, `model` (`file` and `version`), `operator` (code and level only), and the server's `receivedAt` and `bytes`. Unreviewed frames are swept after `capture.reviewDays` |
| `review.jsonl` | one line per review (`captureId`, `verdict`, final `boxes`, `note`, `reviewedAt`); append-only, the latest line per capture wins |
| `clips/<id>.mp4` | a 7 second clip cut on demand around a capture (3 s before `videoT`, 4 s after, 480 px high, no sound) and cached; needs ffmpeg |
| `s1.mp4`, `s2.mp4`, ... `s5.mp4` | each station's video, named by station id (`.webm` on browsers without MP4 recording). `s1-2.mp4` is a second part if the source changed or Rec was switched off and on |

Exports: `/api/sessions/<id>/substeps.csv`, `/cycles.csv`, `/verdicts.csv`, `/units.csv` and `/events.jsonl`
(also linked from **Sessions**, which updates by itself every 10 seconds while open;
the last two under **raw**). The whole run in one file is `/api/sessions/<id>/export.zip`
(see "Capture, review and the shared pool" below).

### Event fields

| Field | Meaning |
|---|---|
| `t` | time, epoch milliseconds (for a substep: when its signal started, not when it was confirmed) |
| `ts` | seconds since the session started |
| `station` | a station id of the session's layout (`s1`, `s2`, ... `s5`) |
| `type` | `substep`, `cycle_end`, `qa_result`, `flag`, `manual`, `session_start`, `session_end`, `source_change`, `verdict`, `operator` |
| `substep`, `from` | the substep entered, and the one before it |
| `move` | `start` (first of a cycle), `next`, `jump` (skipped a visible substep), `repeat` |
| `source` | `zones`, `model` or `manual` |
| `conf` | mean signal over the 3 confirming frames, 0 to 1. On a verdict: the model confidence it rests on (empty for zones) |
| `cycle` | cycle number at that station (manual presses keep their own count) |
| `dur` | cycle length in seconds (on `cycle_end`) |
| `result`, `reason` | QA result (`pass`, `fail`, `unknown`) and fail reason id |
| `light`, `bin` | bulb seen lit (`true`, `false`, `null` = bulb zone not usable), bin seen (`pass`, `fail`, `null`) |
| `action` | answer key press (Score the cameras on): `cycle_done`, `pass`, `fail` |
| `input` | on `source_change`: `camera`, `clip`, `phone` or `none`. A phone counts as `phone` only while it is connected: picking it, losing it or cutting it off is `none` (the note says "Phone (waiting for the phone)", "Phone lost" or "Phone cut off: new pairing code") |
| `code`, `level` | on `operator`: the operator's anonymous code (`Op-07`) and training level (`new`, `training`, `certified`); both `null` when nobody is set |
| `note` | flag text ("skipped ...", "no data: <zone> not drawn", "quality mismatch, review the video"), or the source label |
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

`basis` is `detected` (from the cameras) or `manual` (from the answer key; `cycle_s` is the time
since the previous press). With **Score the cameras** off the line numbers use detected counts. With
it on, the **Count by** switch in Setup picks which one they use; **Auto** (the default) uses
detected counts where a station has any, else manual.

### verdicts.csv (one row per verdict, in time order)

`session_id, station, time, ts, cycle, step, event, message, confidence, step_seconds,
cycle_seconds, video_file, video_t`

The columns of live_check.py's session log, plus the session, the station, `ts` and the video
position. `time` is UTC, `step` is the substep's number at its station, `event` is the verdict
kind. A verdict from a check between cycles counts toward the next cycle.

## Capture, review and the shared pool

The model loop: the page saves still frames while a session records, a person says right or wrong
at `/review`, the reviewed frames become a YOLO training set, and a new model is scored against
the current one before anyone promotes it. This replaces the Phase 2 model loop of the dashboard plan
(`docs/dashboard-plan.md`, dashboard branch). Retraining stays a Colab step (`training/`); the app
prepares the set and scores the result. Plan and decisions: `docs/canvas-plan.md`.

### Capture on the page

The page saves a full-frame JPEG (native camera size, no crop) of a station's live video, while a
session records and that station has video. Each frame carries a reason:

| Reason | When |
|---|---|
| `claim` | a substep transition (model or zones); at most one per step per cycle |
| `unsure` | a `review` or `mistake` verdict |
| `cycle_end`, `cycle_start` | the frame at a cycle's end and at its start (where `connector_closed` should show) |
| `stalled` | a cycle has run `capture.stallSec` with no step change, then one frame every 10 s |
| `sample` | one random frame per `capture.sampleSec` window per station: the baseline of "nothing happening" and false positives |
| `manual` | the **X** key (every station) or the **Capture frame** button on a card |
| `home` | frames from `scripts/ingest-footage.mjs` (intake path A) |

Priority when several are due: manual, unsure, cycle_end, cycle_start, claim, stalled, sample
(`LineEngine.captureWanted`, a pure function with tests). A station gets no second frame within 1.5 s,
except a manual one. Caps per session: `capture.maxPerSession` in total and `capture.maxPerStation`
per station; the server refuses over the cap with `capture_limit`.

**Setup switch and privacy.** Setup has a **Capture frames** checkbox. This laptop remembers it
(`wire-line:capture` in the browser); until someone touches it, `capture.enabled` in the config
decides (default on). Capture only happens while a session records. Frames are full camera pictures
and can show hands, arms or people near the table. Rules: operators appear only as a code and level
(never a name), no face-targeting, frames stay on the laptop and are git-ignored, and unreviewed frames are deleted
after `capture.reviewDays`. The note next to the switch says this. A failed upload shows a banner and never stops the run.

### Config: `capture`, `pool`, `classConf`, `version`

All in `data/meta/wire-line.json`. The `capture` block is optional; each missing or invalid key falls back to its default.
`checkConfig` validates it (booleans and numbers above 0; the two caps must be whole numbers).

    "capture": { "enabled": true, "stallSec": 12, "sampleSec": 25, "maxPerSession": 120, "maxPerStation": 40, "reviewDays": 7, "mediaCapMB": 1024 }

| Key | Meaning |
|---|---|
| `enabled` | the default for the Setup switch |
| `stallSec` | seconds without a step change before a `stalled` frame |
| `sampleSec` | the random `sample` window per station |
| `maxPerSession`, `maxPerStation` | caps, enforced by the page and by the server |
| `reviewDays` | unreviewed captures older than this are deleted |
| `mediaCapMB` | while all capture media is over this, the oldest unreviewed go first |

The sweeper runs at server start and hourly. A reviewed frame (any verdict but `unsure`) is never swept.

- `models.<role>.version` (optional, a short text or a number such as `"2026-11-02"` or `3`) names the trained model. The page stamps it into every capture (`model.version`) so each reviewed frame knows which model made it.
- `models.<role>.classConf` (optional, `{ "<class>": 0.3 }`) is a per-class confidence threshold. Only `scripts/eval-model.mjs` reads it; it falls back to `defaults.class`, then 0.4. The live page does not use it and `checkConfig` does not validate it yet.
- `pool` (optional) is `{ "dir": "<folder>" }`. The default is `data/pool` (git-ignored). Point `dir` at a synced shared Drive folder (`~` is expanded). Any other key is refused.

### Review page (`/review`)

Lists sessions with a coverage line and a hit rate per class, opens one as a grid by station and
step. Each card shows the frame with the model's boxes, the claim, the reason, a **Play** link to
the recording at `videoT`, and an inline 7 second clip. Keys: **C** right, **W** wrong, **U** not sure,
**F** fix boxes (accept or reject a box, change its class from the role's class list, draw a missing box),
**N** next unreviewed. Verdicts:

| Verdict | Meaning | In the training set |
|---|---|---|
| `confirmed` | the model's boxes are right | the capture's own boxes |
| `corrected` | boxes were edited | the edited boxes |
| `rejected` | nothing valid on this frame | a negative image with an empty label file |
| `unsure` | skip | removed (deleted at export) |

**Hold out as test** pins a whole session to `test`; it is never used for training. The review
page also has **Download run**, **Copy for Claude** and **Publish to pool** (below).
A class list that changed since a role's training set began makes a review fail with `classes_changed`: move `data/training/<role>` aside first.

### Training set and split

Reviewed frames are copied into `data/training/<role>/` (git-ignored): `images/*.jpg`, `labels/*.txt`
(YOLO: class index from `models.<role>.classes`, else `suggestedClasses`; normalized `cx cy w h`), and `manifest.json`
(per image: session, capture, reason, verdict, model, standard, label counts). The split is by
session, never by frame: a stable hash puts about 20% of sessions in `val`, sessions pinned in
`data/training/splits.json` go to `test`. `export.zip` has `train/`, `val/` and `test/` folders (each with `images/` and `labels/`),
`data.yaml` and `manifest.json`.

### Endpoints

All on the localhost server, with the same Host and Origin checks as the rest of `/api`.

| Endpoint | What |
|---|---|
| `POST /api/sessions/<id>/captures` | one capture: JSON with the metadata and `image` as a `data:image/jpeg;base64,` string (body up to 600 KB, JPEG up to 400 KB). Returns `{ id }` |
| `GET /api/sessions/<id>/captures` | all captures, each with its latest `review`, and the session's `split` |
| `GET /api/sessions/<id>/captures/<cid>.jpg` | the frame |
| `GET /api/sessions/<id>/captures/<cid>.mp4` | the 7 s clip (cut with ffmpeg and cached in `clips/`; 404 `no_video` with no recording, 503 without ffmpeg) |
| `POST /api/sessions/<id>/review` | `{ captureId, verdict, boxes?, note? }`; updates the training set and returns its counts |
| `POST /api/sessions/<id>/split` | `{ "split": "test" }` holds the session out, `{ "split": null }` releases it |
| `GET /api/training` | per role: images, negatives, sessions, boxes per class, split counts, classes |
| `GET /api/training/<role>/export.zip` | the role's YOLO set for the Colab notebooks |
| `GET /api/sessions/<id>/export.zip` | the whole run (below); add `?video=1` for the recordings |
| `GET /api/sessions/<id>/digest.txt` | a short plain-text summary of the run |
| `POST /api/sessions/<id>/pool` | publish reviewed frames to the shared pool |
| `GET /api/pool` | counts per station, class, contributor and mode |
| `GET /api/pool/<role>/snapshot.zip` | the trainer's YOLO set from the pool; `?holdout=<code>` |

### One export per run

`export.zip` holds `run.json` (all text: session, config, summary, events, cycles, substeps, verdicts, units, and
every capture with its review), the four CSVs, `captures/*.jpg`, and `video/*` only with `?video=1`.
`digest.txt` is under about 6000 characters: duration, stations and models, cycles per station, verdicts, and capture
and review counts per class. The review page's **Copy for Claude** copies it so it can be pasted into a chat.

### Shared pool: two intake paths, one pool

Two ways of collecting feed one shared pool, which one person trains from.

- **Path A, home collection.** Varied footage filmed at home. `node scripts/ingest-footage.mjs --role s2 --video clip.mp4 [--contributor Mg-07] [--frames 150] [--data-dir <dir>]`
  samples the video at 2 fps, pre-labels with the role's current model, picks about 150 frames (balanced across classes, with a fixed
  share of low-confidence and empty frames), and writes a pseudo-session (`reason: "home"`, `mode: "home"`) that opens in `/review`. Needs ffmpeg, ffprobe and the role's model.
  Shot list for a home video (each about a minute): different lighting (bright, dim, a lamp from the side); different angles and heights; the connector open and the connector closed, slowly, more than once; a hand covering the part; an empty table.
- **Path B, group run-throughs.** Ordinary sessions with capture on, reviewed at `/review`.

Both end the same way: review, then **Publish to pool** on the review page (or `POST /api/sessions/<id>/pool`
with `{ contributor, mode: "home"|"group", station? }`). Publishing writes one folder per role that
has reviewed frames (`unsure` does not count): `<pool.dir>/<role>/<contributor>-<sessionId>/` with `captures/`,
`captures.jsonl`, `review.jsonl` and `session.json` (role, mode, contributor, session id, times, classes; no title,
crew, notes or operator codes). A published folder is never changed or replaced (`exists` if it is already there); the
write goes to a temporary folder and is renamed into place. A **contributor code** is letters, a dash and digits
(`^[A-Za-z]{1,4}-\d{1,3}$`, for example `Mg-07`), never a name.

`/pool` shows counts per station, class and contributor. **Snapshot** builds the YOLO set from every contribution of
a role. The split is by contribution (a whole published folder), never by frame. **Hold-out by contributor**
(`?holdout=Mg-07`, the dropdown on `/pool`) puts everything that person published in `test`, for a fair check on
footage the model never saw. Frames whose class is not in the role's list are dropped from the labels and counted in `droppedBoxes`.

### Scoring a candidate model

`node scripts/eval-model.mjs <role> <candidate.onnx> [--baseline current] [--split val|test|both] [--data-dir <dir>]`
runs both models over the `val` and `test` images of `data/training/<role>` and prints per-class precision, recall (IoU 0.5) and F1, and the
change against the baseline (default: the file in `models.<role>.file`). It needs ffmpeg and refuses a set whose classes differ from the config.
It never changes the config. To promote: copy the `.onnx` to `app/models/`, set `models.<role>.file` and a new `version`.
Tests: `npm run test:eval`, `npm run test:ingest`, and `npm run test:line`.

## For the model team

**One model per station.** Each station gets its own model, trained from that station's footage and
labeled with that station's SOP substeps (the substep table above). The four trainers work
separately and do not need to agree on a class list.

**Record the arrivals.** For S2, S3 and S4 keep the wires or the unit sliding in inside each clip; the
arrival is a substep the model has to see.

**What to label.** States and tools you can see in one still frame, never motions. "Closing the
levers" is not a class; a `connector_closed` in the work area is. Suggested classes per station
(`suggestedClasses` in `data/meta/wire-line.json`):

| Station | Classes |
|---|---|
| S1 Cut | `red_wire, white_wire, black_wire, cutter, ruler` |
| S2 Arrange and clamp | `red_wire, white_wire, black_wire, connector_open, connector_closed` |
| S3 Second connector | `red_wire, black_wire, connector_open, connector_closed` |
| S4 QA pull test | `connector_closed, wire_out` |

**Where the data is.** Every session folder has one video per station and `events.jsonl`. Use
`s1.mp4` for the S1 trainer, `s2.mp4` for S2, and so on. On a floor with more stations, `session.json`'s
`layout` says which role each station ran: a second QA station `s5` films QA work, so `s5.mp4` is
QA footage. Use `videoT` to jump to detected moments,
and, in sessions recorded with **Score the cameras** on, the key presses (1 to 3, P, F) as the
answer key. Split training and test data by
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
`models` in `data/meta/wire-line.json`, keyed by the role (the config's station id, `s1` to `s4`;
every floor station running that role uses it):

    "models": {
      "s1": { "file": "/models/s1-cut.onnx", "classes": ["red_wire", "white_wire", "black_wire", "cutter", "ruler"], "imgsz": 640 }
    }

List the classes in training order. Only add your own station's entry, so four people can edit the
file without clashing. A station with no entry uses the top-level `"model"` if there is one (a
shared fallback, `null` by default), else it stays on zones. Two stations can point at the same
file; the page loads it once. Reload `/line`: every station that has a model runs it by itself,
and each station's diagnostics row in Setup shows the file name it runs (or `zones`). **Models: off** in Setup stops them on a slow
laptop, and the laptop remembers that until someone turns it back on. Each substep whose
model rule uses only classes that station's model knows switches to the model; the rest keep their
zones rule.

**Class-count check.** When the model loads, the page runs it once on a blank image and compares the
output to your class list. For a raw head, the number of classes in the file must equal the number in
your list. If not, a red banner says for example "lego-parts.onnx outputs 3 classes but the config
lists 10 for S2", and that station stays on its zones rules (other stations keep their models). An
end-to-end head does not show its class count, so there the page checks while it runs: a detection
with a class number beyond your list drops that station back to zones with the same kind of banner.

## Known limits

- **Capture, export and pool.** The run `export.zip` and the training and snapshot zips are built in memory, and a zip over 4 GB is refused; a run export with `?video=1` is refused above 1.5 GB of recordings (download without video and copy the files from the session folder). A pool publish is not atomic across roles: each role's folder is renamed into place on its own, so a failure partway can leave some roles published and others not (publish again for the rest; a folder that exists is never replaced). Immutability of a published contribution is by convention, not enforced: the server never rewrites it, but anyone with the shared folder can. Clips need ffmpeg. Hold-out by contributor only helps once at least two people have published.
- **Performance with more stations.** Each 30 ms tick works through every station that is due, up to
  8 ms of work, so a station keeps its rate however many there are (about 6.7 frames a second: 125 ms
  rounded up to the tick). Measured with Chrome's fake cameras on an Apple M5 Pro: 4 stations 6.7
  frames a second each, the page's main thread 10% busy; 6 stations 6.7 each, 12%; 6 stations
  recording 6.7 each, 13% (all of Chrome about a third of one core); 12 stations 6.7 each, 23%.
  Before the floor the loop took one station per tick, which capped the whole line at about 33
  frames a second (5.6 per station with six, 2.8 with twelve). Not measured on the i7 laptop yet.
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
- Activity is motion. A hand resting still is not activity unless **Hand tracking** is on (Setup); a person walking
  through a zone is. Zones should cover the parts pile or work area, not the walkway.
- MP4 chunks arrive every 2 to 5 seconds (on keyframes). A `.webm` file has no duration header; fix
  it with `ffmpeg -i s1.webm -c copy s1-fixed.webm` if a player cannot seek.
- WIP counts start at zero, so units already sitting in the work areas when the session starts are not
  counted, and a missed detection shows up as a negative WIP.
- The floor: tested in Chrome with fake cameras (Class test, adding a USB station and a phone
  station, dragging, reloading, removing, an 8 second session); not yet on the run-day laptop or a
  touch screen. Safari's own trackpad pinch (gesture events) is not handled: use Chrome, the buttons,
  or ctrl+scroll.
- Android phones, iPads and a second laptop as a camera are not tested on real devices. Chrome's
  certificate click-through was checked in desktop Chrome.
- iPhones: tested with Chrome's fake cameras as four phones (two by the `.local` name, two by the
  IPv6 address), including reloads, a lost phone and an 8 second recording. A real iPhone has been
  tested up to the camera page (over the IPv6-only hotspot, by the `.local` name); a real iPhone
  streaming into `/line`, four at once, and the picture's orientation when a phone lies flat are
  not tested yet.
- A lost phone takes about 10 to 15 seconds to show as lost (WebRTC waits that long before giving up).
