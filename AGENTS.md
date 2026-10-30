# AGENTS.md: LEGO Station Run Log

Instructions for any coding agent (Claude Code, Codex, Cursor, others) working in this repo.
People: start with `README.md`.

| Page | What it is |
|---|---|
| `/line` (`/` opens it) | The wire line, the team's main tool (section "Wire line platform" below) |
| `/phone` on port 4174 | A station's phone or tablet camera page (HTTPS) |
| `/runs` | Archived: the LEGO run log this section and "Analyze runs" are about ([docs/lego-run-log.md](docs/lego-run-log.md)) |
| `/live` | Archived: the LEGO single-station live prototype |

## What this is

A time-study tool for one simulated manual assembly station: a LEGO build (white 4×6 plate,
pink 1×6 brick, light-blue 2×2 slope) that stands in for a manual manufacturing step. Each
**run** is one assembly cycle filmed top-down. An agent turns the video into a structured event
log (cycle time, work elements, flags, finished state) and compares it with a **reference run**
(the baseline unless someone picks another). The point is to test whether ordinary video can
become process data without the operator entering anything.

## Layout

| Path | What it is |
|---|---|
| `app/lego-station-run-log.html` | The run log's web app (`/runs`). The same file runs as a claude.ai artifact. |
| `app/local-runtime.js` | Stands in for the claude.ai runtime when the app runs locally. |
| `server.mjs` | Local server: the app, a JSON document store, stored files. No dependencies. |
| `scripts/runlog.mjs` | Command-line helper for everything below. `node scripts/runlog.mjs help` |
| `data/runs/<run-id>.json` | One file per run. The source of truth. |
| `data/meta/settings.json` | `baselineRunId`: the default reference run. |
| `data/assets/<id>.<ext>` | Videos (H.264 mp4) and frames (jpg). Runs point at them by `<id>`. |
| `work/` | Scratch space for contact sheets and frames. Git-ignored. |

Requirements: Node 18+ and ffmpeg/ffprobe on PATH. Do not add npm dependencies.

## Wire line platform (`/line`)

The team's main tool now: stations on a floor plan (the built-in Class test layout has four, in
the L of our tables; a layout can have any number), one overhead camera each, one laptop, and one
trained model per station role ([docs/canvas-plan.md](docs/canvas-plan.md)). The person's workflow (setup, run day, sharing footage, training, adding a
model, testing) is [docs/team-guide.md](docs/team-guide.md); walk them through the matching
section when they ask how to do any of it. The technical reference (config rules, event fields,
CSV columns, model export contract) is [docs/wire-line-process.md](docs/wire-line-process.md).

| Path | What it is |
|---|---|
| `app/line.html`, `app/line-engine.js` | The floor page (stations as cards you pan, zoom and arrange) and its config-driven engine. The screen is lean on purpose ([docs/lean-plan.md](docs/lean-plan.md)): run controls only, everything else in Setup or Edit layout |
| `data/meta/wire-line.json` | The process: the station roles (zones, substeps, QA), fail reasons, and `models` (one entry per role) |
| `data/meta/wire-line-layouts.json` | Saved floor layouts and the active one (station id, name, role, position). Git-ignored |
| `app/models/` | Model files (`.onnx`) the page loads |
| `data/sessions/<id>/` | Recorded sessions (video per station, `events.jsonl`). Git-ignored, about 1 GB per hour |
| `app/phone.html` | Phone and tablet camera page (iPhone, iPad, Android, a laptop browser), served over HTTPS on port 4174 (`PHONE_PORT`) by `server.mjs`; streams to `/line` over WebRTC |
| `scripts/phone-cert.mjs` | Local name-constrained CA and HTTPS certificate for the phone page (`node scripts/phone-cert.mjs` checks them) |
| `app/review.html`, `app/pool.html` | `/review`: check captured frames, clips, Download run and Copy for Claude (`export.zip`, `digest.txt`), Publish to pool. `/pool`: counts per station, class and contributor, and the trainer snapshot (`pool` in `data/meta/wire-line.json` is `{ "dir": "<folder>" }`, default `data/pool`; contributors are codes like `Mg-07`, never names; a published folder is never replaced) |
| `data/phone-cert/` | This laptop's CA key, certificate and phone pairing secret. Git-ignored |

Rules for the wire line:

- A station trainer adds or changes only their own station's entry under `models` (keyed by role,
  `s1` to `s4`; every floor station running that role uses it) and their own file in
  `app/models/`. Never edit another station's entry.
- `classes` lists the model's classes in training order. The page refuses a list whose length
  does not match the model's output.
- Change the process in `data/meta/wire-line.json`, not in code.
- Never commit `data/sessions/`, `data/meta/wire-line-setup.json` (this laptop's zones),
  `data/meta/wire-line-layouts.json` (this laptop's floor layouts) or `data/phone-cert/` (the CA
  key and the phone pairing secret).
- The floor layout is not the process: Class test is built from the config's stations
  (`LineEngine.classTestLayout`), saved layouts only place stations and pick their role. A session
  records its layout in `session.json`; apply it with `LineEngine.applyLayout` to read its stations.
- The phone port serves only the phone page, `/ca.crt` and `/phone/*`. Keep everything else
  (data, sessions, models, `/api/*`) on the localhost server.
- Run `npm run test:line` before committing; it must pass. Share changes on a branch with a pull
  request.

## Rules for agents

- Edit run data through `scripts/runlog.mjs` (`add`, `claim`, `stills`, `closeup`, `finish`,
  `fail`). It sets timestamps from the clock and validates the format. Never hand-edit
  timestamps, and never invent one.
- Never change another run's file while analyzing a run. Never change `data/meta/settings.json`
  unless the person asks for a new baseline.
- Describe hands and parts only. Never identify, describe or evaluate the person. No names
  or faces anywhere in the data. On the wire line, an anonymous operator code (Op-07) and a
  training level (new, in training, certified) may tag cycles for coaching: no rankings, no
  scores per person, and red is for process and quality problems only (2026-10-22, see
  `docs/dashboard-plan.md`).
- To share results, the person commits and pushes `data/`. Commit only when they ask; run
  `git pull` before adding a run so run numbers don't collide.

## Analyze runs

Use this when the person says "analyze queued runs", "analyze run <id>", "compare run <id>
with <id>", or adds a video and asks for an analysis. In Claude Code, `/analyze-runs` runs it.

### 0. Get the work

- A video file instead of a run id: `node scripts/runlog.mjs add <video> --label "<short name>"
  --condition "<what changed this run>"` (add `--compare-to <run-id>` if they name a
  reference). It prints the new run id. Ask for label and condition only if the person gave
  none and seems to want them; otherwise leave them blank.
- "Analyze queued runs": `node scripts/runlog.mjs list` and take every run marked QUEUED,
  oldest first (`next` prints the oldest).
- `node scripts/runlog.mjs claim <run>` before you start. It prints the mode, which decides the
  work (**full**: time the video; **compare**: re-judge an analyzed run against another
  reference), and the video's duration, size in pixels and file path.

### 1. Read the reference

`node scripts/runlog.mjs reference <run>` (add `--compare-to <id>` for an explicit reference).
It prints the reference's elements (key, kind, label, times, and what was observed), its cycle
and its finished state, plus the path of its finished-state image. Reuse its keys, labels and
kinds. Read its observations to know *how* each step was done there, so you can spot a step
done differently here. **The reference never supplies this run's times, observations or
flags.** Time this video from its own frames, even if it looks identical.

### 2. Look at the video (full mode)

1. Open the reference's finished-state image (its path is printed by `reference`) so you know
   the target layout.
2. `node scripts/runlog.mjs sheets <run>`: contact sheets, one frame every 0.1 s, each labeled
   with its video time (hh:mm:ss.mmm), read left to right, top to bottom. Open every sheet
   (in Claude Code, Read the jpg; in Codex, view the image).
3. `node scripts/runlog.mjs frames <run> <t> [<t> ...]` for full-size frames around each
   transition you need to time, and `--crop w:h:x:y` to zoom (for example on the finished
   assembly). `sheets <run> --from 2 --to 4 --step 0.05 --width 300` gives a finer look at
   one stretch.
4. For every step, check: which hand does it; where each part is (still on the table, or
   lifted in a hand); does the plate or half-built piece move, turn or leave the table; is
   anything picked up twice, dropped or pressed again. Compare each answer with the
   reference's observations. A part lifted where the reference left it on the table (or the
   reverse) is a visible method difference, not a detail. The part's shadow and its position
   against the table edge show whether it left the table.
5. Report only what is visibly observable. If hands hide something, say so and flag it
   `unclear`. Keep observation and inference apart: write inferences as "appears to" or
   "likely". You do not need to re-open the frames `finish` or `stills` save.

### 3. Break the cycle into elements

- **Cycle start**: the first hand moves toward the parts, or a part first moves. A hand
  resting still at the frame edge does not start the cycle (mention it in `idle_pre`).
  **Cycle end**: the finished assembly is set down and both hands have let go of it (out of
  frame or resting still).
- When hands hide the boundary between two steps, keep the reference's split, put the
  boundary at your best estimate, and flag both steps `unclear`. Overlap elements only when
  two hands really work at once (like `hold_plate`); one hand's steps follow each other.
- Elements in time order. Reuse a reference key (with its label and kind) for the same
  action. Anything new gets key `other` and your own short label: a repeat, a re-grip, a
  dropped part, an extra press, an interruption. A pause inside the cycle is kind `idle`, key
  `other`, label `Pause`. A repeated element gets its own row.
- Include `idle_pre` and `idle_post` when the video shows time before or after the cycle.
- Elements may overlap when two hands work at once (like `hold_plate`).
- Times in seconds, 2 decimals, read from the frame labels; they are approximate to ±0.1 s.
- Kinds: `reach`, `position`, `press`, `release`, `hold`, `idle`, `other`.

### 4. Frames for the app

- **Step frames are automatic.** `finish` saves one frame per element at its midpoint (or at
  the `frameT` you give it) and a finished-state frame at cycle end + 0.2 s. Leave
  `frameAssetId` out of the result unless you want a specific frame: then `node
  scripts/runlog.mjs stills <run> <t1> <t2> ...` saves them and prints `{"t": "assetId"}`.
- **Close-up of the finished assembly (do this whenever you can see it):** find it with
  `frames <run> <t> --crop w:h:x:y`, then `node scripts/runlog.mjs closeup <run> <t> --crop
  w:h:x:y`. It prints one asset id; put it in `finalState.closeupAssetId`. Crop values are
  pixels of the stored video (`claim` prints its size): width, height, then the top-left
  corner. Make the crop about twice the assembly's width (an assembly 90 px wide
  gets a 180 to 200 px square) so the whole build shows with a margin; the close-up is
  scaled to 480 px wide.

### 5. Judge it against the reference

- **POSSIBLE_DEVIATION** when something visibly differs from the reference: an element
  missing, added, repeated or reordered; an element done a clearly different way (for
  example the plate lifted and held in the air instead of held on the table); or a visibly
  different finished state (a part on different studs, facing another way, or missing). Give
  every element behind it `flagType: "deviation"` with the reason in `flag`. When the finished
  state differs, set `finalState.matchesBaseline` to `"no"`.
- **INSUFFICIENT_INFORMATION** only when you cannot tell the order of the steps, or cannot
  tell whether all three parts ended up on the plate (cycle cut off, parts out of frame,
  the build hidden at the end).
- **NORMAL** otherwise. Hands hiding the pressing, or exact stud rows you can't confirm, are
  normal limits of this camera angle (the baseline has them too): flag those elements
  `unclear`, set `matchesBaseline` to `"unclear"` if the layout can't be confirmed, and keep
  the status NORMAL. Speed differences alone are not deviations; say them in `statusNote`.
- A difference you suspect but cannot confirm: flag it `unclear` and list it in
  `differences` ending with "(unconfirmed)". It does not make a deviation on its own.
- Do not treat an unusual action as an error or defect. Describe it; flag it `note` or
  `unclear` unless it is a visible difference from the reference.
- `statusNote`: one or two sentences that open with the main reason and name the reference
  ("Compared with Run 1: ...").
- `differences`: one short line per concrete difference, each with its evidence (times, stud
  rows, which hand). `[]` when there are none.

### 6. Write the result

Write `work/<run>/result.json`, then
`node scripts/runlog.mjs finish <run> work/<run>/result.json --agent "<your name, e.g. Claude Code or Codex>"`.
If it prints problems, fix the JSON and run `finish` again. It keeps the run's number, label,
condition, video and timestamps; you never write those.

Full mode:

```json
{
  "cycle": { "start": 0.70, "end": 6.30 },
  "status": "POSSIBLE_DEVIATION",
  "statusNote": "Compared with Run 1: the plate was lifted and held in the air instead of held on the table. Cycle 5.6 s vs 5.5 s.",
  "differences": ["Plate held in the air by the lower hand from 1.0 s to 6.0 s; Run 1 holds it on the table (0.6-0.9 s)."],
  "elements": [
    { "key": "pick_pink", "label": "Reach and grasp pink 1×6 brick", "kind": "reach",
      "start": 0.70, "end": 1.50, "observed": "One hand enters from the top, closes on the pink brick and lifts it.",
      "flagType": "none", "flag": "" }
  ],
  "finalState": { "matchesBaseline": "yes", "note": "What the finished assembly looks like versus the reference.",
                  "closeupAssetId": "<id printed by closeup>" },
  "processData": ["Data points this video could generate automatically"],
  "limitations": ["What cannot be determined from this video"]
}
```

Every element needs `key`, `label`, `kind`, `start`, `end`, `observed`, `flagType` and `flag`
(idle rows too). Optional: `frameT` (when to take its frame) or `frameAssetId` (a frame you
saved with `stills`). Keep `observed` under 200 characters and `flag` under 120. `flag` is
`""` when `flagType` is `none`. `idle_post` ends at the video's duration (`claim` prints it).

Compare mode (the run already has elements): view this run's and the reference's
finished-state images (paths from `reference`, and `data/assets/<finalState.closeupAssetId>.jpg`
in the run file), compare element lists, times and finished states, and write only
`status`, `statusNote`, `differences`, `finalState: {matchesBaseline, note}` and `elements` as a
list in the run's existing order with just `{flagType, flag}` each. Then
`finish <run> work/<run>/result.json --compare --compare-to <reference-id>`.

### 7. If it fails

Video unreadable, ffmpeg missing, anything you cannot recover from:
`node scripts/runlog.mjs fail <run> "<one short sentence a person can act on>"`. Never leave
a run marked running.

### 8. Report

One line per run: run id, reference, cycle time, status, and the main difference. Mention
that the run log (`npm start`, http://localhost:4173/runs) now shows it. Do not commit unless asked.
