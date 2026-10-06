---
description: Analyze queued runs (or one run, or a video file) in the LEGO Station Run Log
argument-hint: "[run id | path/to/video.mov | compare <run> with <run>]"
---

Follow the "Analyze runs" section of AGENTS.md exactly.

What to analyze: $ARGUMENTS

- Empty: every run that `node scripts/runlog.mjs list` shows as QUEUED, oldest first.
- A run id: that run.
- A path to a video file: `add` it first, then analyze the new run.
- "compare <run> with <run>": compare mode against that reference.

Use `--agent "Claude Code"` with `finish`. View every contact sheet and frame with the Read
tool before you time anything. Finish with one line per run: run id, reference, cycle time,
status, main difference.
