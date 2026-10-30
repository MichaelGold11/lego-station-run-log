# Wire line platform

Stations on a floor plan, one overhead camera each (USB cameras, phones or tablets), one laptop. The
page counts every cycle and step by itself, reads each unit's QA result from the bulb and the bin,
flags mistakes as they happen, and records every camera's video so the team can train one model per
station. Nobody presses anything during a normal run. The stations sit where they stand on the floor
(the Class test layout is the L of our tables); add, move or remove them, as many as you need.

Innovation Studio 2, "The Invisible Assembly Line." The repo started as a LEGO time study of one
station; that tool is archived at `/runs` ([docs/lego-run-log.md](docs/lego-run-log.md)).

## Quick start

You need **Git**, **Node.js 18 or newer** and **ffmpeg**. Check with `git --version`,
`node --version` and `ffmpeg -version`. To install what's missing:

| | Windows | Mac |
|---|---|---|
| Node.js | `winget install OpenJS.NodeJS.LTS` | `brew install node` |
| ffmpeg | `winget install Gyan.FFmpeg` | `brew install ffmpeg` |
| Git | `winget install Git.Git` | `xcode-select --install` |

Then:

```bash
git clone https://github.com/MichaelGold11/lego-station-run-log.git
cd lego-station-run-log
npm install
npm start
```

Open http://localhost:4173 in **Chrome**. It opens the wire line (`/line`):

1. Each station shows **Connect a camera**. Pick **Phone or tablet** and scan the QR code with that
   station's phone, or pick a **USB camera** or a **Recorded clip**. The laptop remembers it.
2. Once per laptop, press **Setup**: the boxes come from the committed standard setup (`data/meta/wire-line-standard.json`; draw them and press **Save as standard** if a role has none), press **Calibrate**, then **Done**.
3. Press **Start session**, then **Enter**. Press **Stop session** at the end: the banner links the
   CSVs.

The floor pans (drag it, or scroll with two fingers) and zooms (pinch, or the buttons at the bottom
right; **Fit** shows every station). **+ Station** adds a station; **Edit layout** moves, renames,
reorders or removes them and switches between saved layouts. Each station's **Op** chip takes the
operator's code and training level.

`npm start` also runs an HTTPS page for the phones on port 4174 (needs `openssl`, which macOS and
Git for Windows include). `npm install` fetches the two browser libraries for the models
(onnxruntime-web and MediaPipe); without `node_modules` the pages fall back to the same pinned
libraries on the jsdelivr CDN.

**Team step-by-step** (run day, the floor, phones, training your station's model, adding it,
testing it): [docs/team-guide.md](docs/team-guide.md). Technical reference (config, layouts,
events, CSV columns, model export): [docs/wire-line-process.md](docs/wire-line-process.md). Why
the screen looks the way it does: [docs/lean-plan.md](docs/lean-plan.md) and
[docs/canvas-plan.md](docs/canvas-plan.md).

**Or let your agent do it.** Paste this into Claude Code or Codex:

> Clone https://github.com/MichaelGold11/lego-station-run-log, install anything its README
> says I'm missing, start the app with `npm start`, and give me the link.

## Pages

| Page | What it is |
|---|---|
| http://localhost:4173/line | The wire line: the run-day page (`/` opens it) |
| `https://<laptop>.local:4174/phone` | A station's phone or tablet camera page; its QR code on `/line` opens it |
| http://localhost:4173/review | Check the frames a run captured (right, wrong, fix boxes), play clips, download the run, publish to the shared pool |
| http://localhost:4173/pool | The shared pool: counts per station, class and contributor, and the trainer's snapshot |
| http://localhost:4173/runs | Archived: the LEGO run log ([docs/lego-run-log.md](docs/lego-run-log.md)) |
| http://localhost:4173/live | Archived: the LEGO single-station live prototype |

## What's in the repo

| Path | |
|---|---|
| `app/line.html`, `app/line-engine.js` | The wire line (`/line`, the floor) and its config-driven engine. The process is `data/meta/wire-line.json`: its stations are the roles a floor station can run, and it lists one ONNX model per role under `models`. Saved floor layouts are in `data/meta/wire-line-layouts.json` (not committed). The standard zones per role are in `data/meta/wire-line-standard.json` (committed). |
| `server.mjs` | Local server (`npm start`). |
| `app/live-detect.js`, `app/models/` | YOLO pre and post processing (shared by `/line` and `/live`) and the models (see `app/models/README.md`). |
| `app/phone.html`, `scripts/phone-cert.mjs` | Phone and tablet camera page (HTTPS, port 4174) and its local certificate. The certificate and pairing secret live in `data/phone-cert/` (not committed). |
| `data/sessions/` | Wire line sessions: events, CSVs, one video per station, and the captured frames with their reviews (`captures/`, `captures.jsonl`, `review.jsonl`, `clips/`). Not committed (about 1 GB per hour). |
| `app/review.html`, `app/pool.html`, `app/capture-lib.js` | The review and pool pages and the code they share with the server. Reviewed frames become YOLO sets in `data/training/<role>/`; the pool is a folder (`pool.dir` in `data/meta/wire-line.json`, default `data/pool`). Both git-ignored. |
| `scripts/ingest-footage.mjs`, `scripts/eval-model.mjs` | Home footage into a reviewable session; score a candidate model against the current one. See [docs/wire-line-process.md](docs/wire-line-process.md) and the team guide (sections 6a and 6b). |
| `app/lego-station-run-log.html`, `app/live-mock.html` | Archived LEGO pages (`/runs`, `/live`). The run log is the same page that runs as a claude.ai artifact. |
| `scripts/runlog.mjs`, `data/runs/`, `data/assets/` | The LEGO run log's helper (`npm run runlog -- help`), its runs and its videos (also the demo clips on `/line`). |
| `AGENTS.md`, `CLAUDE.md` | Instructions for coding agents. |

## Troubleshooting

- **Port 4173 is busy:** `PORT=5000 npm start` (PowerShell: `$env:PORT=5000; npm start`).
- **Port 4174 (phone cameras) is busy:** `PHONE_PORT=4175 npm start`, or `PHONE_PORT=off npm start` without phones.
- **"ffmpeg is not installed or not on PATH":** install it (table above), then open a new
  terminal.
- **The page says the local server isn't answering:** `npm start` stopped; start it again.
