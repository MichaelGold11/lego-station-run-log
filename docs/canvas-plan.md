# Floor canvas: the run screen as a plant floor

The plan of record for branch `canvas` (off `lean` at `cd3284c`). It turns `/line`'s fixed four-tile grid into a floor
you can pan and zoom, with each station's card placed where the station really stands, a layout builder, any number of
stations, and an operator code with a training level on every station.

Michael asked for it on 2026-10-23: "a prebuilt configuration for our test, but there is a configuration builder where we
can have as little or as many stations set up and also positioned how they would be positioned on the plant floor",
"the canvas can extend past what the computer sees", "a + button to add another camera", "the ability to mark the
training level of the operator", "the trained models would probably not change". His photo of the real setup: station 1
at the top of a long table, flowing down to station 2, then right to station 3 on the next table (an L).

The lean rules in [lean-plan.md](lean-plan.md) still hold: run controls only on the run screen, everything else behind
a mode switch, the config decides, nothing is lost, the phone connection does not change, same storage keys.

---

## 1. Decisions (already made, built to these)

1. **The canvas is the run screen at `/line`.** It replaces the fixed grid. A floor with a light grid, larger than the
   window. Drag empty floor (or a card's non-control area) to pan in any direction; trackpad two-finger scroll pans;
   pinch or ctrl+wheel zooms; two fingers pinch on a touch screen. A floating cluster at the bottom right: zoom out, the
   zoom percent (click: 100%), zoom in, Fit (every station in view). Zoom 25% to 200%. The view is remembered per browser
   and per layout in localStorage (every access in try/catch).
2. **Each station is a card at its floor position** (x, y in floor units, snapped to the grid). The card is today's
   tile, unchanged inside: name and role, live video with the zone overlay and the mistake alert box, Ready or Setup
   needed, REC, the now box, cycle, last, average and done, the QA line, the checklist, and the operator chip. Flow
   arrows connect the stations in order (1 to 2 to 3 ...), like the arrows in the photo. Detection, zones, Calibrate,
   models, Rec and the step checker work as before at any zoom; the video keeps playing when zoomed out or off screen.
3. **Lean.** The canvas adds only the zoom cluster, **Edit layout** and **+ Station** (Add station). Moving, renaming,
   re-roling, reordering and removing stations happen only in Edit layout mode. Layout edits and adding stations are
   blocked while a session records ("Stop the session to change the layout.").
4. **Add station (+ Station)** puts a new station in the middle of the current view, asks for its role (one of the trained
   station roles in the config; the models do not change, a station picks which one it runs) and a name (prefilled, like
   "S5 QA test"), then opens the same **Connect a camera** sheet: **Phone or tablet (scan a QR code)**, **USB camera**
   (anything Chrome lists: webcams, capture cards, Continuity Camera, OBS Virtual Camera), **Recorded clip**. IP / RTSP
   network cameras are out of scope (browsers cannot play RTSP; it needs a converter): parked in the backlog.
5. **Layouts.** A built-in, read-only **Class test** plus saved layouts. Pick one, New blank, Duplicate, Rename,
   Delete (not the built-in). Editing the built-in saves a copy and switches to it. Saved layouts live on the server in
   `data/meta/wire-line-layouts.json`, next to the zones file, git-ignored. Class test: the config's stations in order,
   S1 at the top, S2 below it, S3 to the right of S2 (the L from the photo), S4 to the right of S3. Four stations by
   default because the line has four trained roles; deleting one takes two clicks.
6. **Operator and training level per station**, as in `docs/dashboard-plan.md` (dashboard branch, decision 1): an
   anonymous code (Op-07) and a level, **new**, **in training** or **certified** (ids `new`, `training`, `certified`,
   the ids the dashboard mockup uses). No names, no rankings, never red on a person. A chip on each card; click it to set
   the code and level, allowed during a run. Each change logs the event `operator {station, code, level}` (in
   `EVENT_TYPES`, so the server accepts it); clearing logs code and level `null`. session.json keeps the current operator
   per station. The dashboard's other parts and the role-based views come with the dashboard (section 7).
7. **Any number of stations.** Ids beyond s1..s4 work everywhere: engine, session.json, CSVs, recordings, Rec, phone
   pairing, `/api/phone/info`, the answer key. Two stations may share a role. No hard cap (the server refuses more than
   100 in one layout as a sanity limit on the request, not a design cap). CPU is measured with six stations, not guessed.
8. **session.json records the layout at session start**: layout id and name, and per station id, name, role, x, y,
   order, input and operator.

## 2. Data model

**Role**: a station of `data/meta/wire-line.json` (`s1` Cut and strip, `s2` Crimp side A, `s3` Crimp side B, `s4` QA
test): its substeps, zones, QA block, and its model under `models.<role>`. The config is not changed.

**Layout** (one entry in `wire-line-layouts.json`):

```json
{ "id": "l-3fa9c2d1", "name": "Class test copy", "updatedAt": "2026-10-23T21:04:00.000Z",
  "stations": [ { "id": "s1", "name": "S1 Cut and strip", "role": "s1", "x": 0, "y": 0 }, ... ] }
```

- The file: `{ "active": "<layout id>", "layouts": [ ... ] }`. The built-in Class test is not stored; it is built from
  the config (`LineEngine.classTestLayout`) with id `class-test`. No file means Class test is active.
- Flow order is the array order. x and y are floor units (1 unit = 1 CSS pixel at 100%), snapped to the 40-unit grid.
  A card is 640 units wide. Class test: S1 (0, 0), S2 (0, 560), S3 (760, 560), S4 (1520, 560).
- **Station id = a camera spot on this laptop.** A new station gets the lowest free `s<n>` in its layout. The browser
  keeps each id's camera, Rec and Mute (the same `wire-line:source:<id>` keys as today), and phone links are keyed by id,
  so a copied layout keeps its cameras and phones, and a station removed and added again gets its camera back.
- **Zones and calibration belong to a station id and its role**: key `s2` when the role is the station's own id (so
  every laptop's existing setup keeps working), else `s5:s4` (station s5 running role s4). Giving a station another role
  asks for its boxes again; switching it back finds the old ones.
- **Effective config** (`LineEngine.applyLayout(config, layout)`): one station per layout entry, a copy of its role with
  `id`, `role`, `name`, `x`, `y`, `order`; `models` re-keyed by station id (a station runs its role's model); fail
  reasons' `cause` re-pointed from the role to the first station in flow order with that role. The page, the summary and
  the CSV exports all run on it. `checkConfig` still checks the file as written (a shared role repeats substep ids, which
  is fine per station).

**session.json** gains `layout` (`{ id, name, builtIn, stations: [{ id, name, role, x, y, order, input, operator }] }`)
and `operators` (the current operator per station, `{ s2: { code, level, at } }`, updated as `operator` events
arrive). `config` stays the file as it was; exports and the summary apply the layout to it. Sessions from before the
canvas have no `layout` and export exactly as before.

**Events**: `operator` `{ station, code, level }` with code `Op-<digits>` or null and level `new`, `training`,
`certified` or null. The server refuses anything else in those two fields (no names can slip in). At session start the
page logs one `operator` event per station that has an operator, so `events.jsonl` alone tells who was where.

### Rules for shared roles (line-level numbers)

- **Units and QA**: every station with a QA role counts: units, pass, fail and yield add up over all of them.
- **Side by side**: stations next to each other in flow order with the same role work in parallel and form one stage.
  WIP is counted between stages (the stage's cycles added up); between two stations of one stage the flow row shows
  them as side by side, not a WIP number. The bottleneck and the takt check use a station's average cycle divided by
  the number of stations in its stage. With one station per role (Class test) every number is the same as before.
- **Fail causes**: a fail reason's cause is a role; it is charged to the first station in flow order that runs that
  role (the cameras cannot tell which of two crimpers made the bad crimp). No station with that role: "no cause".
- **Answer key** (Score the cameras on): number keys **1 to 9** are the stations in flow order (the bar shows each
  station's number next to its id). Stations past the ninth have a button on the bar but no key. **P** and **F** score
  the first QA station in flow order; any other QA station gets its own Pass and Fail buttons on the bar, without keys.
  A QA station's number key still only says "S4 closes its cycle with P or F".

## 3. Screens

**Run screen**: header (Sound, Start or Stop, Sessions, Setup), summary strip, then the floor fills the rest of the
window. On the floor: top left **Edit layout** and **+ Station**, with the layout's name as a label; bottom right the zoom
cluster. Station cards with **Connect a camera** or **Setup needed** only when something is missing (as today).

**Edit layout mode** (the **Edit layout** button; Setup mode closes): a bar on top with the layout picker, its name
(editable for saved layouts: that is Rename), **New blank**, **Duplicate**, **Delete** (two clicks, not for Class test)
and **Done**. Each card gets a strip with its name, its role, Earlier / Later in the flow, and **Remove** (two clicks).
Drag a card to move it; it snaps to the grid. Any change to Class test first makes "Class test copy" and switches to it.

**Add station**: a small panel by the + Station button: Role, Name (prefilled "S5 QA test", following the role until edited),
**Add station**, **Cancel**. Default role: the last station's role (the first role on an empty floor).

**Operator chip**: "Op --" or "Op-07, in training" in each card's head (the slot the lean plan reserved). Click: a panel
on the card with the code (digits, shown as Op-07), the three levels, **Save**, **No operator**, **Cancel**.

## 4. Files

| File | Change |
|---|---|
| `app/line-engine.js` | `operator` in `EVENT_TYPES`; `LEVELS`, `operatorCode`, `FLOOR`, `classTestLayout`, `applyLayout`, `setupKey`, `nextStationId`, `freeSpot`, `saveScheduler`, `defaultName`, `shortName`; `summarize` counts every QA station and groups side-by-side stations into stages |
| `server.mjs` | `/api/line/layouts` (GET, POST, PUT, DELETE, `<id>/use`); setup keys per station and role; sessions take and store the layout, accept its station ids and the operator event; exports and the summary apply the layout; the phone listener and `/api/phone/info` use the active layout's station ids; phone copy for any phone or tablet |
| `app/line.html` | The floor (pan, zoom, Fit, view memory, grid, arrows); cards at their positions; Edit layout mode and the layout bar; Add station; stations built and torn down from the layout (`reconcile`); the operator chip; the answer key and the flow row for any number of stations; copy for any phone or tablet |
| `app/phone.html` | Copy for iPhone, iPad, Android and laptop browsers (no code path is iPhone only) |
| `scripts/test-line-engine.mjs`, `scripts/test-line-server.mjs` | The checks in section 6 |
| `.gitignore` | `data/meta/wire-line-layouts.json` |
| `docs/wire-line-process.md`, `docs/team-guide.md`, `README.md`, `AGENTS.md`, `docs/backlog.md` | Where they describe the grid, the iPhone flow, events and session.json |

## 5. Phases (one commit or two each, `npm run test:line` green before every commit)

1. **Engine**: layout helpers, `applyLayout`, the operator event, `summarize` for shared roles. Tests in
   `test-line-engine.mjs`.
2. **Server**: layouts API, setup keys, sessions with a layout, phone ids from the active layout, the operator event,
   phone copy. Tests in `test-line-server.mjs`.
3. **Floor**: the canvas, cards at positions, arrows, pan, zoom, Fit, view memory. Checked in the browser.
4. **Layouts**: Edit layout mode, the layout bar, copy-on-write, Add station, remove, re-role, reorder, `reconcile`.
5. **Operators**: the chip, the panel, the event, session start.
6. **Browser walk and measurements** (Playwright in the scratchpad, not in the repo): section 6.
7. **Docs.**

## 6. How it is tested

`npm run test:line` (engine and server):

- Engine: Class test positions (the L) and names; `applyLayout` (ids, roles, re-keyed models, fail causes); the next
  free id; setup keys; operator code normalizing (7, 07, op-7 to Op-07; names refused); `summarize` with two QA stations
  (units add up), side-by-side stations (no WIP between them, WIP between stages, bottleneck divided by the stage size),
  and Class test numbers unchanged.
- Server: layout save, load, rename, delete, built-in protected (PUT and DELETE refused), bad role, duplicate id and
  bad name refused, active layout; a session with stations s5 and s6 end to end (layout and operators in session.json,
  events and a video chunk for s5, an event for a station not in the layout refused, an operator event with a name
  refused, CSVs with s5 and s6 rows, units from both QA stations); setup under `s5:s4`; the phone key for s5 works, a
  station not in the active layout (s3 with a correct key) and an unknown one are refused.

Browser walk (Chrome with fake cameras, `--use-fake-device-for-media-stream`, PORT 4373, PHONE_PORT 4374, a scratch
DATA_DIR): Class test renders four cards in the L with three arrows; pan, zoom and Fit; add S5 with a fake USB camera and
S6 with a simulated phone page (`/phone?s=s6&k=<key>` over HTTPS); drag a card in Edit layout, reload, the position
stays; remove a station; set an operator level; layout edits refused during a session; an 8 second session with
session.json checked (layout, operator event, recordings). Screenshots at 1280x800 and 1920x1080. The run screen's
visible controls are counted. Six live stations: frame rate per station and the browser's CPU.

## 7. Later, and where it plugs in

- **Role-based views** (operator, manager, plant manager) come with the dashboard. They plug in at the operator chip
  (an operator signs in there; the card could show "you" detail), at the floor (a manager view could tint cards by drift,
  a plant manager view could show several layouts), and at `G.view` in `line.html`, which does not exist yet.
- **Dashboard Phase 1** adds `operator` and `level` columns to the CSVs from the `operator` events, and reads
  `session.json`'s `layout` (apply it with `LineEngine.applyLayout`) to know which station ran which role.
- **IP / RTSP cameras**, **floor shapes** (tables, walls, walkways drawn on the floor): in `docs/backlog.md`.

## 8. As built (2026-10-23)

Built as planned, with these calls made along the way:

- **A new station goes to the nearest free spot.** The middle of the view is often another card. Add station puts the
  new card in the middle when that is free, else at the nearest spot that leaves room for its Setup panel (640 by 520
  units), and pans the floor to show it.
- **The frame loop keeps each station's rate.** The browser walk with six fake cameras showed the old loop (one station
  per 30 ms tick) capped the whole line at about 33 frames a second: 5.6 per station with six, 2.8 with twelve, with the
  main thread only 12% busy. Each tick now works through every station that is due, within 8 ms. Measured on an Apple
  M5 Pro: 4, 6 and 12 stations all at 6.7 frames a second each (main thread 10%, 12%, 23% busy); 6 stations recording,
  13% (all of Chrome about a third of one core). One or four stations behave as before.
- **A shorter header.** The header note is "Wire splice line, 4 stations, one overhead camera each" (the product
  sentence moved to its tooltip) and the summary's flow row sits beside the tiles when there is room, so the floor
  gets more of a laptop screen. No control was added or removed there.
- **The card's name and badge.** The badge shows the station id (S5, the name of its files); the title is the name
  without a leading id ("S5 QA test" shows as QA test), and the role follows in grey when the name does not say it.
- **Operator events are trimmed.** The server keeps only station, code and level of an `operator` event, so nothing
  about the person can ride along in an extra field.
- **Copy for any phone.** The phone page, the gate page, the server's log lines and `/line` say phone or tablet. The
  event notes changed with them ("Phone lost", "Phone (waiting for the phone)"). A phone whose station left the floor
  layout hears "This link does not work any more".
- **Checked in Chrome:** a page opened past the certificate warning (Advanced, Proceed) is still a secure page and gets
  the camera, so Chrome on Android is not blocked by the self-made certificate. Android, iPad and a second laptop are
  not tested on real devices.

Tests: `npm run test:line` 190 engine checks and 113 server checks. Browser walk: 47 checks in Chrome with fake cameras
(scratchpad script, not in the repo), screenshots at 1280x800 and 1920x1080.
