# Wire line platform

Four stations, one overhead camera each (USB cameras or iPhones), one laptop. The page counts every
cycle and step by itself, reads each unit's QA result from the bulb and the bin, flags mistakes as
they happen, and records every camera's video so the team can train one model per station. Nobody
presses anything during a normal run.

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

1. Each station shows **Connect a camera**. Pick **iPhone** and scan the QR code with that
   station's iPhone, or pick a **USB camera** or a **Recorded clip**. The laptop remembers it.
2. Once per laptop, press **Setup**: draw each station's boxes, press **Calibrate**, then **Done**.
3. Press **Start session**, then **Enter**. Press **Stop session** at the end: the banner links the
   CSVs.

`npm start` also runs an HTTPS page for the phones on port 4174 (needs `openssl`, which macOS and
Git for Windows include). `npm install` fetches the two browser libraries for the models
(onnxruntime-web and MediaPipe); without `node_modules` the pages fall back to the same pinned
libraries on the jsdelivr CDN.

**Team step-by-step** (run day, iPhones, training your station's model, adding it, testing it):
[docs/team-guide.md](docs/team-guide.md). Technical reference (config, events, CSV columns, model
export): [docs/wire-line-process.md](docs/wire-line-process.md). Why the screen looks the way it
does: [docs/lean-plan.md](docs/lean-plan.md).

**Or let your agent do it.** Paste this into Claude Code or Codex:

> Clone https://github.com/MichaelGold11/lego-station-run-log, install anything its README
> says I'm missing, start the app with `npm start`, and give me the link.

## Pages

| Page | What it is |
|---|---|
| http://localhost:4173/line | The wire line: the run-day page (`/` opens it) |
| `https://<laptop>.local:4174/phone` | A station's iPhone camera page; its QR code on `/line` opens it |
| http://localhost:4173/runs | Archived: the LEGO run log ([docs/lego-run-log.md](docs/lego-run-log.md)) |
| http://localhost:4173/live | Archived: the LEGO single-station live prototype |

## What's in the repo

| Path | |
|---|---|
| `app/line.html`, `app/line-engine.js` | The wire line (`/line`) and its config-driven engine. The process is `data/meta/wire-line.json`, which also lists one ONNX model per station under `models`. |
| `server.mjs` | Local server (`npm start`). |
| `app/live-detect.js`, `app/models/` | YOLO pre and post processing (shared by `/line` and `/live`) and the models (see `app/models/README.md`). |
| `app/phone.html`, `scripts/phone-cert.mjs` | iPhone camera page (HTTPS, port 4174) and its local certificate. The certificate and pairing secret live in `data/phone-cert/` (not committed). |
| `data/sessions/` | Wire line sessions: events, CSVs and one video per station. Not committed (about 1 GB per hour). |
| `app/lego-station-run-log.html`, `app/live-mock.html` | Archived LEGO pages (`/runs`, `/live`). The run log is the same page that runs as a claude.ai artifact. |
| `scripts/runlog.mjs`, `data/runs/`, `data/assets/` | The LEGO run log's helper (`npm run runlog -- help`), its runs and its videos (also the demo clips on `/line`). |
| `AGENTS.md`, `CLAUDE.md` | Instructions for coding agents. |

## Troubleshooting

- **Port 4173 is busy:** `PORT=5000 npm start` (PowerShell: `$env:PORT=5000; npm start`).
- **Port 4174 (iPhone cameras) is busy:** `PHONE_PORT=4175 npm start`, or `PHONE_PORT=off npm start` without iPhones.
- **"ffmpeg is not installed or not on PATH":** install it (table above), then open a new
  terminal.
- **The page says the local server isn't answering:** `npm start` stopped; start it again.
