# Wire line dashboard: Training, Throughput, Quality, and a review loop that learns

Approved 2026-10-22. This is the plan for `/dashboard`, the page operators and managers use after
(and between) runs on the wire line. `/line` stays the live page; the dashboard reads what it
records.

## Why

`/line` already detects substeps, cycles, verdicts (verified, mistake, review) and QA results per
station, and writes `events.jsonl` and CSVs per session. It does not know who is building, does
not compare sessions, does not flag slow steps, keeps no photo of an unsure moment, and nothing
it learns flows back into the station models.

The dashboard has to:
- time every step, find the steps that run slow, and say why: a training gap, a step that is
  badly designed, or a better technique some people use;
- clip slow steps and photograph low-confidence moments so a person or a smarter AI can review them;
- feed reviewed results back into the model so the camera needs a human less often over time;
- let operators set up drift alerts, trials and scheduled reviews.

Everything is tracked and tagged. The screen shows only what each person needs, and the detail
sits behind dropdowns.

Case fit: the challenge asks for a system that makes manual work visible enough to improve
quality, training, staffing and flow without turning into individual surveillance, and "done" is
a running line, something that notices when things go wrong, and messy cases reaching a human
with enough context to judge.

## Decisions (2026-10-22)

1. **Anonymous operator code plus training level.** At each station tile the operator taps a code
   (Op-07) and a level (new, in training, certified). Operators see their own detail; managers see
   patterns, never a ranking. AGENTS.md's privacy rule was updated to match.
2. **AI reviewer: Claude API, still frames only, behind a switch.** Live inference stays in the
   browser. Only flagged frames go out: a few JPEGs of hands and parts, cropped to the work zone.
   `docs/live-camera-plan.md` notes the exception.
3. **Clips are temporary, their findings are permanent.** A clip is deleted as soon as it is
   reviewed; its reason tags stay. A photo is kept only if a person confirmed or corrected it,
   because that photo is training data. Review media is capped at 1 GB, and anything not reviewed
   expires after 7 days.
4. **Rules are three templates:** drift alerts, trials and scheduled reviews. Thresholds and
   standard times stay in `wire-line.json`, not in the operator UI.

## Built-in recommendations

1. **Diagnose the "why" before anyone watches a clip.** Each slow step gets a tag with its evidence:
   - **Process:** at least half the operators are slow on it. Look at the step, fixture or SOP.
   - **Training:** the slow operators are new or in training. "Still learning" if their times are
     falling, "needs coaching" if flat after 20 cycles.
   - **Technique:** certified operators differ by more than 30%. Compare methods.
   - **Inconsistent:** one operator's own spread is wide. Check the clips.
   - **Drift:** the step got slower for everyone since a date.
2. **Show the bottleneck, not just step times.** The slowest station sets the line's output, so
   Throughput leads with "S3 sets the pace".
3. **Ready to certify.** Suggest certification after 20 cycles within standard and no mistakes; a
   manager confirms. This links training status to quality.
4. **Standard time without a stopwatch study:** the median of certified operators, unless the
   substep sets `standardSec`.
5. **The agent earns autonomy.** It starts by suggesting only. Once its last 50 suggestions on a
   station match people 95% of the time, a manager may turn on auto-accept for that station.
6. **Model version on every event, and a "camera trust" trend:** the share of cycles that needed a
   person, per model version. A new model is promoted only if it beats the current one on the
   answer-key sessions.
7. **One pinned reference clip per step (optional):** the best technique, kept as training
   material. It is the only clip kept, about 40 MB for the whole line.

## What each person sees

Header: period (Session, Today, Week, Month), station (All, S1 to S4), and "View as" (Operator with
their code, or Manager). "View as" is framing, not security; the page is localhost only, like `/line`.

Tabs: **Today, Training, Throughput, Quality, Inbox, Rules.**

- **Today:** three cards, one per section, each with one sentence, one number and one status
  chip. Below them, "Needs you": the top three Inbox items.
- **Training:** steps grouped by station: Step, Standard, Median, spread bar, tag (On pace, Slow,
  Varies, Still learning). Each row opens to the diagnosis sentence and its evidence, a breakdown
  by operator code (Manager) or "you vs team" (Operator), a learning curve, clips waiting, and the
  pinned reference clip. Below: operator readiness (code, level, cycles, ready to certify).
- **Throughput:** "41 units/h, S3 sets the pace (14.2 s vs 12 s takt)". A line-balance chart (one
  bar per station and a takt line), units per hour over time, and waiting time between cycles.
  Each station opens to its substeps as a stacked bar: that is where to cut.
- **Quality:** first-pass yield, fails by cause station (`failReasons`), mistakes by step and kind
  (wrong order, missing, position), QA mismatches, and camera trust by model version.
- **Inbox:** one queue for everything that needs a person, one big card at a time (keys Y, N, S).
  - Photo check: "Camera thinks: Crimp A done (58%)", the AI suggestion, then Correct, Wrong (pick
    the real step) or Can't tell.
  - Slow step: a short clip that jumps to the slow step, "19 s vs 12 s standard", and reason chips:
    dropped part, searched for part, tool problem, redid step, interruption, other.
  - Suggestion: the AI recommendation and its evidence. Accept turns it into a trial or a coaching
    note; Dismiss asks why, and the reason feeds the next review.
  - A storage meter: "Review media 340 MB of 1 GB".
- **Rules:** a list with on and off switches. "New rule" fills in one of three sentences:
  - Drift: "When [step] median over the last [10] cycles is over [standard x1.3], flag it on
    `/line` and clip the next [5] cycles."
  - Trial: "From [date], [change] on [station]: compare [step] before and after." The result shows
    once both sides have 20 cycles: "Faster by 2.1 s (12%), likely real."
  - Review: "Every [end of session, Friday 4 pm, 1st of the month], run the AI review for [the
    session, week, month]."

### Design

Same look as `/line` and the run log: Saira for words, IBM Plex Mono for numbers, the copper
accent and the good, warn and crit tokens, light and dark. No framework, hash routing.

- **Headline first.** Every view opens with one sentence: is anything wrong, and where.
- **At most three numbers per card.** Everything else is behind a labeled dropdown ("Why?", "By
  operator", "All cycles"). The deepest level is always the raw rows and a CSV link.
- **Words, not statistics.** "Slow", not "z > 2".
- **Never red on a person.** Red is for process and quality problems. Rows about a person stay neutral.
- **44 px tap targets.** Works on a tablet at the station, a laptop, and a phone.

## Data: everything tagged

- New event `operator {station, code, level}` in `EVENT_TYPES` (`app/line-engine.js`) and the
  server allowlist.
- Substep and cycle rows gain `operator`, `level`, `model` (version), `slow`, `standard_s`, and
  later `reasons`, as new CSV columns.
- No new dependencies. Operators, rules, trials, recommendations and review items use the existing
  JSON doc store (`/api/db/<coll>/<id>`). On session end the server caches a per-session step
  digest in `session.json` next to `summary`; week and month views add those up.
- Media lives in `data/review/` (temporary) and `data/training/<station>/` (kept, YOLO layout).
  Both are git-ignored.
- Settings live in `wire-line.json` under `dashboard`: `slowFactor` (1.3), `photoConf` (0.6),
  `reviewDays` (7), `mediaCapMB` (1024). `taktSec` sets the throughput target.

## The two learning loops

**Model loop.** A `review` verdict (low confidence or flicker) captures the current frame (640x480
JPEG) with the model's boxes, at most one photo per step per cycle. An optional Claude pre-check
suggests an answer; a person decides. Correct: the model's boxes become YOLO labels and the photo
moves to `data/training/<station>/`. Wrong: the photo goes to `needs-boxes/` for Roboflow. Can't
tell: deleted. "Export training set" feeds the Colab notebook, which produces the next ONNX for
`models.<station>` with a `version`. A promotion gate replays the answer-key clips through the new
model and compares it with the current one.

**Process loop.** Each station runs a second low-bitrate recorder, restarted at each cycle start
and capped at 90 s. At cycle end, if a step was slow or a drift rule asked for clips, the clip and a
few 320x240 keyframes become a review item; otherwise they are dropped in memory. Reason tags come
from a person or from Claude. A review (scheduled, or "Run review now") sends Claude the aggregate
numbers, the reason tags and keyframes, and gets back recommendations as JSON: title, category,
evidence, action, confidence. An accepted recommendation becomes a trial, and the trial measures
whether it helped.

Claude is called with `fetch` from `server.mjs` (no SDK), with the key in `ANTHROPIC_API_KEY`. The
scheduler is a one-minute ticker in `server.mjs`: it runs only while the server runs and catches up
on missed reviews at startup.

## Phases

| Phase | When | Ships |
|---|---|---|
| 0 Design | week of Oct 22 | This plan, the privacy rule update, the `dashboard` config block, and a clickable mockup with sample data for team feedback. |
| 1 Numbers | by Nov 12 (Sprint 3) | Operator chip on each `/line` tile and tagged events; `stepTable`, `standards`, `diagnose`, `readiness` in the engine; the per-session digest; `GET /api/dash`; `/dashboard` with Today, Training, Throughput and Quality on real sessions; drift flag on the `/line` tile. |
| 2 Inbox | Nov 12 to 26 | Photo capture and per-cycle clips, the Inbox with reason tags, the retention sweeper and storage meter, training-set export, the pinned reference clip. |
| 3 Agent | by Dec 10 | Claude photo pre-check and reviews, recommendations into trials, scheduled reviews, model versions, the promotion gate, the camera-trust trend, auto-accept. |
| Demo | December | Model v1 needs a person on 11% of cycles; reviews build the training set; v2 needs a person on 4%; a trial shows a fixture saved 2 s at the bottleneck. |

## How we check it

- `npm run test:line` covers each diagnosis tag, standards and readiness, operator tags in the
  CSVs, the review routes, the sweeper deleting decided clips, and the Host guard on new routes.
- `scripts/fake-sessions.mjs` builds a week of sessions with six operator codes and three planted
  cases (a process-slow step, a training-slow operator, a technique gap); the dashboard must tag
  each one correctly.
- Live walk: one iPhone camera through `/phone`, sign in an operator, run cycles, force a
  low-confidence frame (a photo appears in the Inbox), stall on a step (a clip appears), review
  both, and `data/review/` is empty afterwards while the tags remain.
- Browser walk at tablet and phone widths, light and dark.
