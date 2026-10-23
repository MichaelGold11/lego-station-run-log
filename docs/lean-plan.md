# Wire line platform: the lean version

The plan of record for branch `lean`. Michael's decisions are in section 5; where they differ from
sections 1 to 4, the decisions win.

Audit and design, 2026-10-22. Source: branch
`phone-cameras` at `75ad1cf` (`~/Code/lego-station-run-log`), plus the `dashboard` worktree
(`~/Code/lego-station-run-log-dashboard`, branch `dashboard`).

Read: `AGENTS.md`, `README.md`, `docs/team-guide.md`, `docs/wire-line-process.md`,
`docs/dashboard-plan.md` (dashboard branch), `app/line.html` (all 1551 lines), `app/phone.html`,
`app/live-mock.html` (controls and keys), `app/lego-station-run-log.html` (controls),
`server.mjs` (routes), `data/meta/wire-line.json`, `scripts/test-line-server.mjs` (what it checks).
Live server read with GET only: `/api/phone/info`, `/api/sessions`, `/api/line/clips`.

One fact from the live server: the only session so far (`20261022-185058-de45`) has an empty
title, crew and shift. The start form's fields are already being skipped.

---

## 1. Inventory

### 1.1 `/line` (app/line.html): the run-day page

**Always visible on load (4 stations, S4 is QA): 33 controls**

| Where | Control | Count | Flag |
|---|---|---|---|
| Header | Start session (Stop session during a session) | 1 | |
| Header | Sessions and exports | 1 | |
| Toolbar | Model: on/off | 1 | Expert. A teammate should not decide this: the config already says which station has a model |
| Toolbar | Hands: on/off | 1 | Expert. Trades model speed for better clear-view checks |
| Toolbar | Sound: on/off (all stations) | 1 | |
| Toolbar | Find cameras | 1 | Duplicated: the page already finds cameras by itself once permission was given |
| Toolbar | New pairing code (two clicks) | 1 | Rare: a security reset |
| Toolbar | Count: Auto / Detected / Manual | 3 | Expert. CSVs keep both bases anyway (`basis` column) |
| Toolbar | Reset counts | 1 | Rare and duplicated: Start session and Stop session already reset counts |
| Each tile header | Source picker | 4 | A decision per station (USB, iPhone, clip, none). Picked once per laptop, then remembered |
| Each tile header | Rec checkbox | 4 | A decision nobody should make: it must be on for training footage |
| Each tile header | Mute checkbox | 4 | Rare. Duplicates the global Sound at a second level |
| Each tile header | Setup button | 4 | Needed once per laptop, visible forever |
| Each tile footer | Cycle done (S1 to S4) | 4 | S4's is a trap: the docs say "do not press 4", because P or F already closes S4's cycle |
| S4 footer | Pass, Fail | 2 | |

The toolbar also shows a keys legend (1-4, P, F, Esc) and a backend note ("WASM x1 in a worker
(add ?gpu for WebGPU)"). The legend duplicates the buttons; the backend note is expert-only.

**Shown on demand: 67 controls**

| Where | Controls | Count | Flag |
|---|---|---|---|
| Start form | Title, Crew / training group, Shift, Notes, Start recording, Cancel | 6 | Crew and shift have no agreed format; left blank in the only real session |
| Fail reasons (after F) | 6 reasons, No reason, Cancel | 8 | |
| Sessions panel | Refresh, plus per row: substeps.csv, cycles.csv, verdicts.csv, events, json | 1 + 5 per row | Refresh duplicated (the panel loads on open and after Stop). events and json are for the model team only |
| Stop banner | substeps.csv, cycles.csv, verdicts.csv, events.jsonl, session.json | 5 | |
| Setup panels | Zone buttons (S1 3, S2 4, S3 4, S4 5) | 16 | |
| Setup panels | Calibrate empty | 4 | |
| S4 setup | Bulb off, Bulb on | 2 | Bulb off is duplicated: Calibrate empty already records every zone's dark brightness, and the help text already says "calibrate with the bulb off" |
| Setup panels | Clear zones (two clicks) | 4 | Rare |
| Setup panels | Save correct state | 0 today | Only appears for a station with `positionCheck`; none has one yet |
| iPhone panel (station waiting) | Address list, Copy link | 2 per phone station (8) | The iPhone connection. Michael: keep |
| Live iPhone | QR button on the live chip, Hide | 2 per phone station (8) | Rare: only to swap a working phone for another |

Also: drawing a zone box on the video (a drag gesture).

**Keyboard: 7 keys.** 1, 2, 3, 4 (cycle done), P (pass), F (fail), Esc (close the fail chips).
Key 4 is the same trap as S4's Cycle done.

**Hidden knobs: 8.** The `?gpu` URL flag, and 7 settings the browser remembers per laptop: count
basis, sound, mute per station, source per station, Rec per station, Rec for clips per station,
and the chosen phone address.

**Readouts per tile today: about 20.** Now box (label, step, timer), Cycle, Last, Avg with a
spread, Done with a manual count, the S4 QA line (result, light, bin, source, mismatch), the
checklist (5 to 6 rows with tags and times), and a footer of fps, model file, model rate,
confidence and REC size.

**Summary strip: 6 blocks.** Units done, Units per hour, First-pass yield, Takt (shows "--, not
set in the config" because `taktSec` is null), Fails by cause, and the Flow row (WIP and the
bottleneck).

**Source picker contents.** None, USB cameras (or "Press Find cameras"), iPhone, 6 LEGO run clips,
and up to 30 sessions times 4 stations of session recordings. That list will reach 100+ entries
as sessions pile up, and every station sees every station's footage.

**Total on `/line`: about 108 controls** (33 visible, 67 on demand, 7 keys, 1 URL flag).

### 1.2 `/phone` (app/phone.html on port 4174): the iPhone page

| Control | When | Flag |
|---|---|---|
| Camera list (which lens) | Always | Rarely needed (the back wide camera is the default) but harmless |
| "Optional: stop the certificate warning" (expander and certificate link) | Always, folded | Already optional and folded |
| Start the camera | Only after a camera error | |
| Use this phone instead | Only after another phone took the station | |

**Total: 5, of which 2 visible.** Already lean. Keep as is.

The phone gate page (a bad or old link) has no controls. Keep.

### 1.3 `/live` (app/live-mock.html): the LEGO single-station prototype

Visible: Source, Detector (YOLO or Color + motion mock), Pause, Arm, Setup, Show matched pixels,
Save correct build, Forget it, Auto / Manual mode, Clear cycles, Export CSV (12). Setup panel: up
to 5 draw/pick tools, Pink tolerance, Blue tolerance, Reset setup (8). Keys: Space, Z, R, A (4).

**Total: 24.** The whole page is superseded by `/line` for the wire line. Its scripts are not:
`/line` loads `live-detect.js`, and `npm run test:live` tests `live-engine.js` and `live-detect.js`.

### 1.4 `/` (app/lego-station-run-log.html): the original LEGO run log

About 47 distinct controls over five views (runs list, run page, new run, edit times, analyzing):
Baseline, Compare with, Re-check, Queue for my agent, Analyze with my Claude, Time by hand, Edit
times (nudges, speed, per-element key, flag, times, notes), Make baseline, Export CSV, Delete with
confirm, and more.

It is a separate tool for a separate study (one LEGO station, agent analysis of recorded videos).
It is not part of the wire line run day, but it is the first thing a teammate sees: `npm start`
prints "LEGO Station Run Log: http://localhost:4173", and the README says "Open
http://localhost:4173". Its six runs appear in `/line`'s source picker as "Recorded clips".

### 1.5 `/dashboard` (dashboard branch, clickable mockup on sample data)

Header: period (4), station, view as (2), operator code; 6 tabs; Inbox and Rules add about 25
more. Not in scope here: it has its own approved plan (2026-10-22). Collision points are in
section 4.6.

### 1.6 Config: `data/meta/wire-line.json`

About 34 knobs: `version`, `name`, `draft`, `product`, `taktSec`, `holdFrames`, `qaGraceSec`,
`defaults` (activity, bright, class), `model`, `models.<station>` (file, classes, imgsz),
`suggestedClasses`, `failReasons` (id, label, cause, defect), `sounds.verified`; per station `id`,
`label`, `output`, `note`, `zones`, `cycleEnds`, `qa` (lightSubstep, sortSubstep, bins),
`positionCheck` (anchor, classes, tolerance); per substep `zones` and `model` rules (zone, signal,
class, min, mustStay), `note`. The dashboard branch adds `dashboard` (4) and `standardSec`.

None of these is on screen. A teammate touches exactly one: their own `models.sN` line. **Keep the
config as it is.** Changing it would ripple into `line-engine.js` checks and both test suites, and
the dashboard branch is editing the same `checkConfig` function.

Environment: `PORT`, `PHONE_PORT` (or `off`), `DATA_DIR`. Keep.

### 1.7 Counts at a glance

| Page | Visible on load | Total | Verdict |
|---|---|---|---|
| `/line` | 33 | about 108 | Keep. Cut the surface (section 3) |
| `/phone` | 2 | 5 | Keep unchanged |
| `/live` | 12 | 24 | Archive |
| `/` run log | about 10 on the list view | about 47 | Moves to `/runs` (Decision 1) |
| `/dashboard` | (mockup) | about 40 | Keep; own plan |

---

## 2. The job and the run-day flow

**The job in one sentence:** film the four stations while one person keys the true unit count,
so every step, cycle, mistake and QA result lands in CSVs next to each station's video, and the
cameras can be scored against that answer key.

### Today (team guide section 3, plus the iPhone variant)

1. Mount the cameras (or get each iPhone ready: Auto-Lock Never, plugged in, orientation lock).
2. Open `/line`. Press Find cameras and allow, or set each station's source to iPhone (4 picks).
   Scan each QR code.
3. Press Setup on each station (4), draw its boxes.
4. Press Calibrate empty on each station (4). On S4: Bulb off, then light it, Bulb on.
5. Check Rec on every station.
6. Clear the trays, press Start session, fill in title, crew and shift, press Start recording.
7. Keys 1 to 4 as units leave; P or F at QA (and do not press 4 as well).
8. Press Stop session; the banner links the CSVs.

On a fresh laptop that is about 40 laptop actions plus 4 scans before the first unit, and the
teammate sees 33 controls the whole time. On a repeat day the flow is already short (sources,
zones and calibration are remembered); the cost there is the screen, not the steps.

### Lean (the target)

1. **Open** http://localhost:4173. It lands on the wire line. Each tile shows **Connect a camera**.
2. **Connect** each station once per laptop: Connect a camera, then iPhone, and scan the QR code with
   that station's iPhone (or pick a USB camera or a clip). The tile turns live. Codes keep working on
   later days.
3. **Once per laptop:** if a tile says "Setup needed", press **Setup**, draw its boxes, press
   **Calibrate** with the area empty and the bulb dark (S4: then light it and press **Bulb on**),
   press **Done**.
4. **Start:** clear the trays, press **Start session**, press Enter (the title is filled in).
5. **Run.** Nothing to press: the cameras log cycles, steps, QA and mistakes. Only when the cameras
   are being scored (**Score the cameras** on in Setup), one person keys the answer key on the bar at
   the bottom: **1 2 3** as units leave S1 to S3, **P** or **F** at QA (pick the reason).
6. **Stop:** press **Stop session** and click the three CSVs in the banner (or later under
   Sessions).

Repeat day: steps 1, 4, 5, 6. Fresh laptop: about 25 laptop actions plus 4 scans.

---

## 3. The lean version

### 3.1 Principles

- **Two modes, one switch.** Run mode shows what the line is doing and only the controls a run
  needs. Setup mode (one header button) shows everything else, for every station at once.
- **The config decides, not the teammate.** A station with a model runs it. A live camera
  records. Takt shows only when it is set.
- **Nothing is lost.** Every capability is either still visible, a fixed default with its switch
  in Setup, merged into another control, or done automatically. Only two controls retire, and
  both are duplicates.
- **The iPhone connection does not change.** Same QR code per station, same link, same Address
  list, same Copy link, same phone page, same "Phone lost" recovery.
- **Same storage keys.** The browser's saved sources, Rec, mute and phone address keep their keys,
  so a laptop that is set up stays set up.

### 3.2 Every `/line` control, and what happens to it

| Control | Today | Lean | Why |
|---|---|---|---|
| Start / Stop session | Header | **Keep visible** | The run |
| Sessions and exports | Header | **Keep visible** ("Sessions") | The CSVs are the deliverable |
| Sound (all stations) | Toolbar | **Keep visible**, moves to the header | A fast mute matters in front of a panel |
| Setup ×4 | Each tile | **Merge** into one Setup button in the header | One place for everything that is not the run |
| Cycle done S1 to S3 | Each tile | **Merge** into the answer-key bar, shown only with Score the cameras on (Decision 3) | One place for the answer key, and it is also the legend |
| Pass, Fail | S4 tile | **Merge** into the answer-key bar | |
| Keys legend | Toolbar | **Merge** into the answer-key bar | The buttons show their keys |
| Cycle done S4, key 4 | S4 tile, keyboard | **Retire.** Pressing 4 shows "S4 closes with P or F" | P and F already close S4's cycle (`CYCLE_ACTIONS` in the engine). Removes the "do not press 4" trap |
| Fail reason chips | After F | **Keep**, open just above the bar | The cause data |
| Model on/off | Toolbar | **Auto:** runs at load when any station has a `models` entry. Off switch in Setup | The config already says it |
| Hands on/off | Toolbar | **Setup**, default off | Expert tuning; slows model results from 2-4 s to 4-5 s |
| Find cameras | Toolbar | **Auto-detect:** at load when allowed, again when a camera is plugged in (`devicechange`), and the picker's "USB camera: allow access" item asks the first time | No button to know about |
| New pairing code | Toolbar | **Setup** (two clicks, unchanged) | Rare security reset |
| Count Auto / Detected / Manual | Toolbar | **Setup**, fixed default Auto; detected counts while Score the cameras is off (Decision 3) | CSVs keep both |
| Reset counts | Toolbar | **Setup**, only outside a session | Start and Stop already reset |
| Source picker ×4 | Each tile | **Setup.** A fresh station has nothing picked (Decision 2). A tile with no video shows one **Connect a camera** button that offers iPhone, a USB camera or a recorded clip | Picked once per laptop, then remembered |
| Source picker contents | All clips for all stations | **Filter:** each station lists only its own recordings, newest 10; LEGO clips under "Demo clips" | 100+ entries become about 15 |
| Rec ×4 | Each tile | **Fixed default** on for live cameras and iPhones (off for replayed clips), switch in Setup. The tile keeps its REC readout | Without video there is nothing to train on |
| Mute ×4 | Each tile | **Setup** | Rare |
| Zone buttons, drawing | Setup panel | **Keep in Setup** (auto-advance as today) | |
| Calibrate empty ×4 | Setup panel | **Keep in Setup**; it lights up after the last box is drawn | |
| Bulb off | S4 setup | **Retire,** merged into Calibrate empty | It already records the dark bulb for every zone |
| Bulb on | S4 setup | **Keep in Setup** | |
| Clear zones ×4 | Setup panel | **Keep in Setup** (two clicks) | |
| Save correct state | Setup panel | **Keep in Setup** as is | Appears only with `positionCheck` |
| Address list, Copy link | iPhone panel | **Keep visible, unchanged** | The iPhone connection |
| QR button on a live phone, Hide | Live tile | **Setup** | Only to swap phones |
| fps, model rate, confidence, backend note | Tile footer, toolbar | **Setup** (diagnostics row per tile) | Expert-only |
| Takt tile | Summary | **Auto-hide** while `taktSec` is null | Today it shows a dead tile |
| Fails by cause | Summary | **Merge** into the yield tile's sub-line | |
| Start form: Title | Form | **Keep**, prefilled ("Dry run 3" after "Dry run 2", else date and time). Enter starts | |
| Crew, Shift, Notes | Form | **Behind "More details"** (Decision 4) | Kept, folded |
| Rec warning in the form | Form | **Merge** into a readiness line: "S3 has no video. S4 is not calibrated." | One check before start |
| Refresh | Sessions panel | **Auto:** loads on open, after Stop, every 10 s while open | |
| events, json links | Sessions panel, banner | **Behind "raw"** | Model team only |
| substeps, cycles, verdicts CSVs | Sessions panel, banner | **Keep visible** | |
| `?gpu` | URL | **Keep**, unlisted | |

### 3.3 Pages

| Page | Lean | Notes |
|---|---|---|
| `/line` | **Keep.** The only run-day page | Lean redesign (this document) |
| `/phone` (port 4174) | **Keep unchanged** | Already lean |
| Phone gate page | **Keep** | Copy tweak: "pick iPhone" becomes "Connect a camera, then iPhone" |
| `/dashboard` | **Keep** (own plan) | Lean `/line` reserves its operator chip slot on each tile |
| `/` run log | **Moves to `/runs`**, `/` opens the wire line (Decision 1) | Hash routing and absolute API paths, so it moves cleanly. The claude.ai artifact copy is unaffected |
| `/live` | **Archive in place.** Route and file stay; a banner on top says "Archived LEGO prototype. The wire line is /line" | Drop it from the README quick start. `live-engine.js`, `live-detect.js` and `test:live` stay |

Nothing is deleted.

### 3.4 Target counts

| | Today | Lean |
|---|---|---|
| Visible controls on the run-day screen | 33 | **4** (Sound, Start or Stop, Sessions, Setup). The answer-key bar (1, 2, 3, P, F) adds 5 only with Score the cameras on |
| Controls on a station tile in run mode | 4 to 6 | **0** (one "Connect a camera" or "Setup needed" button only when something is missing) |
| Toolbar | 9 controls | Gone |
| Keyboard keys | 7 | 6 (1, 2, 3, P, F, Esc), active only with Score the cameras on |
| Readouts per tile | about 20 | about 10 |
| Total `/line` controls | about 108 | about 98 (capabilities kept; the cut is in what is visible) |
| Pages in the team's path | 4 (`/`, `/live`, `/line`, `/phone`) | 2 (`/line`, `/phone`), plus `/dashboard` when it ships |
| Run-day decisions a teammate makes | about 8 (camera type ×4, Rec, Model, Hands, Count) | 0 on a set-up laptop |

### 3.5 Mockups

**Main screen, run mode, during a session**

```
+------------------------------------------------------------------------------------------+
| Wire line                                     (*) REC  Dry run 3   12:41   212 MB         |
| Wire splice line, 4 stations       [Sound: on]  [Stop session]  [Sessions]  [Setup]       |
+------------------------------------------------------------------------------------------+
|  UNITS 14         UNITS/H 42          FIRST-PASS YIELD 86%                                |
|  tested at S4     over 20:03          12 pass / 14 tested. Fails: S2 1, S3 1              |
|  FLOW  [S1 15 | 21.4 s] -> WIP 1 -> [S2 14 | 24.9 s  BOTTLENECK] -> WIP 0 ->             |
|        [S3 14 | 22.0 s] -> WIP 0 -> [S4 14 | 18.2 s]                                     |
+------------------------------------------------------------------------------------------+
| +--------------------------------------------+ +--------------------------------------------+ |
| | S1 tile (see below)                        | | S2 tile                                    | |
| +--------------------------------------------+ +--------------------------------------------+ |
| +--------------------------------------------+ +--------------------------------------------+ |
| | S3 tile                                    | | S4 tile                                    | |
| +--------------------------------------------+ +--------------------------------------------+ |
+------------------------------------------------------------------------------------------+
| ANSWER KEY   [1  S1 unit out]  [2  S2 unit out]  [3  S3 unit out]   [P  Pass]  [F  Fail]   |
+------------------------------------------------------------------------------------------+
   (sticky at the bottom, only with Score the cameras on; after F the reason chips open just above it)
```

**Station tile, run mode**

```
+--------------------------------------------------------------------+
| S2  Crimp side A           iPhone, live          [Op --]    Ready   |
+--------------------------------+-----------------------------------+
|                                | NOW, CYCLE 14             6.2 s   |
|      live video                | Push wire A into the splice       |
|      boxes and model           |                                   |
|      detections                | Last 23.1 s   Avg 24.9 s          |
|                                | Done 14   (keys 14)               |
|  +--------------------------+  |-----------------------------------|
|  | MISTAKE   S2             |  | (v) Take a wire pair       3.1 s  |
|  | Wrong order: Crimp side  |  | (v) Take a splice          2.4 s  |
|  | A before Push wire A     |  | (>) Push wire A    MISTAKE: fix   |
|  +--------------------------+  | ( ) Crimp side A          model   |
|                      REC 41 MB | ( ) Tug test side A       model   |
|                                | ( ) Pass to station 3   (ends)    |
+--------------------------------+-----------------------------------+
  [Op --] is the dashboard's Phase 1 operator chip (reserved slot).
  "Ready" becomes "Setup needed: draw the Crimp area" and opens Setup on this tile.
```

**S4 tile, run mode** (same layout; the QA line sits above the checklist)

```
| LAST UNIT  [PASS]  light on, bin pass        (or [sorted, waiting for P / F])  |
```

**A station waiting for its iPhone (unchanged panel)**

```
+--------------------------------------------------------------------+
| S3  Crimp side B (join)    iPhone, waiting                          |
+--------------------------------------------------------------------+
|  +-----------+   S3's iPhone                                        |
|  |  QR code  |   Waiting: scan the code with the iPhone's Camera app|
|  |           |   Address [michaels-macbook-pro.local (name)     v]  |
|  +-----------+   https://michaels-macbook-pro.local:4174/phone?...  |
|                  [Copy link]                                        |
|                  Certificate warning the first time: tap Show       |
|                  Details, then visit this website.                  |
+--------------------------------------------------------------------+
```

**Setup mode** (the header's Setup button; every tile at once)

```
+------------------------------------------------------------------------------------------+
| SETUP   Each station: pick its camera, draw its boxes, calibrate.                 [Done]  |
| Models: S1 s1-cut-strip.onnx, S2 to S4 zones  [Turn off]    Hand tracking [off]           |
| Count by [Auto | Detected | Manual]   [Reset counts]   [New pairing code]   WASM x1 worker |
+------------------------------------------------------------------------------------------+

Each tile in Setup mode:
+--------------------------------------------------------------------+
| S2  Crimp side A   Camera [iPhone (scan a QR code)     v]           |
|                    [x] Record video   [ ] Mute   [Show QR]          |
| Draw: [In tray  v] [Splice bin  v] [Crimp area] [Out tray]          |
| [Calibrate]  [Clear zones]      Calibrated 9:02 am                  |
| 7.8 fps | zones | conf 0.83 | iPhone sends 640x480 at 15 fps        |
+--------------------------------------------------------------------+
```

---

## 4. Build plan

Build in a new worktree (`~/Code/lego-station-run-log-lean`, branch `lean` off `phone-cameras`).
Another session commits on `phone-cameras` in the main checkout, and the server there is serving
Michael's live test. Each phase is one commit, shippable alone, with its docs updated in the same
commit. No new npm dependencies. No changes to `line-engine.js` or the config schema.

### Phase 1: free cuts (about 2 to 3 hours)

- Models run by themselves at load when a station has a `models` entry (the button stays for now
  as the override; it moves to Setup in Phase 2).
- Cameras found by themselves (at load when allowed, on `devicechange`, and from the picker's
  "allow access" item). Find cameras retires.
- Bulb off retires; the S4 help says "calibrate with the bulb dark, then light it and press Bulb on".
- S4 Cycle done and key 4 retire; key 4 shows the hint.
- Sessions panel loads by itself; Refresh retires; events and json go behind "raw" (panel and banner).
- Takt tile hides while `taktSec` is null; fails by cause becomes the yield tile's sub-line.
- Source picker: each station lists only its own recordings, newest 10.
- Files: `app/line.html`, `docs/team-guide.md` (sections 3, 7.3, 8, 9), `docs/wire-line-process.md`
  (run day, model team), `README.md` (one line).
- Tests: `npm run test:line` and `npm run test:live` stay green (no engine or server change).
  Add a browser walk by a subagent: two clips and one fake camera, keys 1 to 4, P, F, Stop, CSVs.
- Risks: model loading at page load slows a weak laptop (the override covers it); the answer-key
  keeper's key-4 habit (the hint covers it); trainers follow "press Model: on" in the guide (updated).

### Phase 2: one Setup mode (about 4 to 6 hours, the big one)

- One Setup button in the header. Setup mode shows the setup bar (Models off switch, Hand
  tracking, Count by, Reset counts, New pairing code, backend note) and, on every tile, the source
  picker, Record video, Mute, Show QR, zone buttons, Calibrate, Bulb on, Clear zones, Save correct
  state and the diagnostics row. Done returns to run mode.
- Run-mode tile: name, source status, readiness chip (Ready, Setup needed: the reason, Waiting for
  iPhone), REC readout, now box, three numbers, checklist. Reuse the engine's existing "missing"
  list (`missingText`) for the readiness reason.
- A tile with no video: one "Connect a camera" button that opens Setup on that tile.
- A fresh station (nothing saved) has no camera and shows Connect a camera: iPhone, USB camera or
  recorded clip (Decision 2).
- The iPhone panel shows by itself whenever a phone station waits, in either mode. Unchanged.
- Rec: on for live sources by default, switch in Setup. Toolbar removed; Sound moves to the header.
- Files: `app/line.html`, `docs/team-guide.md` (sections 3, iPhone steps, 4, 9),
  `docs/wire-line-process.md` (run day, iPhones, mistake alert sounds, Count), `server.mjs` (only the
  phone gate copy and the startup line: "Connect a camera, then iPhone").
- Tests: both suites green. Browser walk by a subagent at 1440 px and 1100 px, light and dark:
  fresh profile (four QR codes appear), Setup, draw, Calibrate, Done, Start, keys, Stop.
- Risks: a teammate looks for the source picker on the tile (the "Connect a camera" button and the
  readiness chip point to Setup); drawing zones mid-session still works but should say "this
  changes counts from now on".

### Phase 3: answer-key bar and short start form (about 2 to 3 hours)

- Sticky answer-key bar: 1, 2, 3, P, F with their keys; the fail chips open above it; the station
  tile flashes and its key count goes up on each press. Per-tile Cycle done, Pass and Fail go. The
  bar, the keys and the fail chips show only with **Score the cameras** on in Setup (Decision 3).
- Start form: Title (prefilled), Start, Cancel; Crew, Shift, Notes behind "More details". Enter
  starts. The readiness line replaces the Rec warning.
- Files: `app/line.html`, `docs/team-guide.md` (roles, 3.6 to 3.8, 8), `docs/wire-line-process.md`.
- Tests: both suites green (the session API still takes title, crew, shift, notes). Browser walk.
- Risks: the answer-key keeper's habit of looking at the tiles; more sessions with blank crew and
  shift (the dashboard's operator codes replace crew for training analysis).

### Phase 4: front door and archive (about 2 to 3 hours)

- Decision 1: `/` redirects to `/line`; the run log moves to `/runs`; `npm start` prints
  "Wire line: http://localhost:4173/line" first and "LEGO run log (archived): /runs" second.
- `/live`: an archive banner at the top; the route and file stay.
- README leads with the wire line; the run-log sections move to `docs/lego-run-log.md` (archive,
  not delete). AGENTS.md: page table rows and the "Analyze runs" step 8 URL (`/runs`).
- Files: `server.mjs`, `app/live-mock.html`, `README.md`, `AGENTS.md`, `docs/lego-run-log.md` (new,
  moved text), `scripts/test-line-server.mjs`.
- Tests: add to `test:line`: `/` sends you to `/line`; `/runs` serves the run log; `/runs` is 404 on
  the phone port (add it to the existing isolation list). `test:live` unaffected.
- Risks: bookmarks to `localhost:4173` for the run log; the `/analyze-runs` habit; README and
  AGENTS.md conflict with the dashboard branch (small, text only).

### 4.5 Total

About 10 to 15 hours, two working days with Claude Code. Phases 1 and 3 are small and safe;
Phase 2 is the one to review closely.

### 4.6 Collisions with the dashboard branch

- The dashboard's Phase 1 (due Nov 12) adds an operator chip and a drift flag to each `/line`
  tile. **Land lean Phases 1 to 3 first**, then rebase `dashboard` onto them so the chip goes into
  the reserved slot in the run-mode tile header. If the order flips, the chip work gets redone.
- The dashboard edits `checkConfig` in `line-engine.js` and adds a `dashboard` config block. The
  lean plan touches neither.
- Both branches edit README.md, AGENTS.md and the route block in `server.mjs` (the dashboard adds
  one `/dashboard` line next to `/line`). Text conflicts only; resolve at merge.
- The `/line` summary strip stays (units, units per hour, yield, flow). It is the live proof for the
  panel. Deeper analysis (by step, by operator, over weeks) belongs to `/dashboard`, so do not add
  analysis to `/line`.
- The dashboard plan already says "detail sits behind dropdowns". When its Phase 1 is built, apply
  the same rule: Setup-like controls (Rules, View as) out of the default view.

### 4.7 Things the docs and teammates depend on

| What | Depends on | Changes in phase |
|---|---|---|
| Team guide section 3 (run day, 8 steps) | Find cameras, Setup per tile, Bulb off, Rec, start form, key 4 | 1, 2, 3 |
| Team guide iPhone steps | "set each station's source to iPhone" | 2 (becomes "Connect a camera, then iPhone") |
| Team guide section 4 (alerts) | Sound in the toolbar, Mute on the tile, "Model: on" | 1, 2 |
| Team guide sections 7.3 and 8 (trainers) | "press Model: on", picking a past session as the source | 1, 2 |
| Team guide section 9 (troubleshooting) | Sound, Mute, Address list, New pairing code location | 2 |
| wire-line-process.md | Run day, iPhones (New pairing code "in the toolbar"), Count switch, sounds | 1, 2, 3 |
| README, AGENTS.md, analyze-runs | `localhost:4173` is the run log | 4 |
| The Station Vision Playbook doc (outside the repo) | May name toolbar buttons | Check after Phase 2 |
| The server's startup and phone gate text | "pick iPhone as a station's source" | 2, 4 |

---

## 5. Decisions (Michael, 2026-10-22)

These replace the open questions. Where they differ from sections 1 to 4, they win.

1. **Front door.** `localhost:4173` opens `/line`. The LEGO run log moves to `/runs` and keeps
   working. Route tests cover both.
2. **Default camera for a fresh station: nothing picked.** The station shows a **Connect a camera**
   button that offers iPhone (the QR panel), a USB camera or a recorded clip. iPhone is not the
   default. The iPhone QR flow stays exactly as easy as it is.
3. **Fully automatic run.** Nothing is pressed during a normal run. The cameras already give cycles,
   substeps, QA pass or fail (bulb light and bin) and mistake flags. The manual answer key (1, 2, 3,
   P, F and the fail reason chips) is hidden by default and appears only when the **Score the
   cameras** switch in Setup is on (saved per laptop). Key 4 and S4's Cycle done retire. With
   scoring off, the run screen has no answer-key bar and no fail reason popup, and the fails by cause
   line says "turn on Score the cameras to log reasons". Counts use the detected basis unless scoring
   is on; then the Auto, Detected, Manual switch applies (Auto's logic is kept, the switch lives only
   in Setup).
4. **Start session.** The title is prefilled with the date, time and shift, so Enter starts the
   session. Crew, shift and notes sit under **More details**.

The auditor's own calls, kept: models run by themselves when the
config names one; Hands, Count, Reset counts, Mute, Rec and New pairing code move to Setup; Bulb
off merges into Calibrate; `/live` is archived in place; the config file is not touched.
