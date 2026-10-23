# Team guide: using the wire line platform

Everything runs in one page on a laptop, http://localhost:4173/line. It records all four stations
at once, keeps the answer key, exports the data, runs each station's own trained model once you
add it, and alerts the operator to mistakes. This guide is the step-by-step for the team. The technical reference (event fields,
CSV columns, config rules, known limits) is [wire-line-process.md](wire-line-process.md). The
"why" behind each stage is the Station Vision Playbook doc.

Agents: when someone asks how to set up, record, train, add a model or test, walk them through
the matching section here.

## 1. Setup (once per laptop)

1. Install three tools.

   | Tool | Windows | Mac |
   |---|---|---|
   | Node.js | `winget install OpenJS.NodeJS.LTS` | `brew install node` |
   | ffmpeg | `winget install Gyan.FFmpeg` | `brew install ffmpeg` |
   | Git | `winget install Git.Git` | `xcode-select --install` |

2. Download the platform. The repo is public, so no GitHub account is needed to download it.

       git clone https://github.com/MichaelGold11/lego-station-run-log.git
       cd lego-station-run-log
       npm install

3. Run `npm start`, then open http://localhost:4173/line in **Chrome**. Leave the terminal open;
   closing it stops the page.
4. To get updates later: Ctrl+C, `git pull`, then `npm start` again.

## 2. The process (v2: lever connectors)

Three wires (red, white, black) are cut to length, laid in color order and closed in a 3-port lever
connector; a second lever connector joins the other end of the red wire to a separate black wire. QA
is a pull test. The steps are in `data/meta/wire-line.json`; the table is in
[wire-line-process.md](wire-line-process.md).

| Station | Steps | Work areas (zones) |
|---|---|---|
| S1 Cut | 1. Cut the wire 2. Check for correct length against the ruler. One cycle is one wire, so a unit is three S1 cycles (red, white, black) | Cut area, Ruler |
| S2 Arrange and clamp | 1. Wires arrive from S1 2. Open the lever connector 3. Arrange the wires: red top, white middle, black bottom 4. Close the levers on the wires | Lever connectors, Cut wires (where the wires from S1 land), Work area |
| S3 Second connector | 1. Unit arrives from S2 2. Add a new lever connector to the other end of the red wire 3. Get a black wire 4. Insert the black wire into the new connector | Lever connectors, Black wires, Work area |
| S4 QA pull test | 1. Unit arrives from S3 2. Pull test: no wire comes out of either connector, then P or F | Test area |

There are no trays, bins or hand-off zones: the wires or the unit slide straight into the next
station's view, and that arrival is the station's first step (not a skipped step). Each station's last
step ends its cycle. Mistakes are caught at the station where they happen (wrong order, skipped step,
wrong color order at S2); QA only does the pull test.

**Units are linked by order.** Unit 1 is S1's first three wires, then S2's first cycle, S3's first
cycle and S4's first Pass or Fail; unit 2 is the next of each, and so on. This holds as long as nobody
reorders or sets aside wires or units. The dashboard's WIP shows the units waiting between stations,
and **units.csv** (under **Sessions and exports**) has one row per unit: each station's time, the wait
before it (from the previous station finishing to the arrival), its mistakes, and the QA result.

## 3. Roles

| Role | What they do |
|---|---|
| Run-day lead | Brings the laptop, mounts the four cameras, sets up zones, starts and stops the session, uploads the footage |
| Operators (S1 to S4) | Build at their station following its SOP, including the planned mistakes for the run |
| Answer-key keeper | Presses the keys as units leave each station and at QA. This is the ground truth every model is scored against |
| Station trainer (one per station) | Labels that station's footage, trains its model, adds it to the platform, tests it |

## 4. Run day (recording)

1. **Mount the cameras.** One camera straight above each station, with every parts pile, the ruler
   (S1) and the work area in view. Plug all four into the laptop, spread over different USB ports (a powered hub
   helps). Close any other app that uses a camera.
2. **Connect them.** Open `/line`, press **Find cameras** and allow access. Pick one camera per
   station. To tell them apart, cover one lens and see which tile goes dark.
3. **Draw the zones.** On each station press **Setup**. Drag a box around each parts pile or work
   area it asks for; the next zone is picked for you. Keep boxes off walkways, because a hand
   passing through counts as activity. Zones are saved on the laptop and come back after a reload.
4. **Calibrate.** With each work area empty and still, press **Calibrate empty** (2 seconds).
5. **Check Rec.** Leave **Rec** ticked on every station (on by default for cameras). Without video
   there is nothing to train on. The start form warns you if no station is recording.
6. **Start.** Clear the work areas (counts start from zero), press **Start session**, and fill in the
   title, the crew or training group, and the shift.
7. **Keep the answer key** while the line runs:
   - Keys **1** to **3** when that station finishes a cycle. On S1 that is after each wire, so three
     presses per unit.
   - At QA, **P** for pass or **F** for fail, then pick the fail reason. P or F also counts as
     S4's unit done, so do not press 4 as well.
8. **Stop.** Press **Stop session**. The banner links the session's two CSV files.

Keep the page in the front tab the whole time; a background tab slows to about one check per
second.

## 5. Mistake alerts

Each station checks the steps as they happen (Ruza's step checker, built into the page) and says
so with a sound and on its tile.

| You hear | You see | What it means |
|---|---|---|
| One short high chirp | A green box for 2 seconds | A step was seen done right. At the end of a unit: "Cycle complete" |
| Three beeps | A red box and a flashing **MISTAKE** card | A step was skipped or done out of order, a part that must stay went missing, or a part is in the wrong spot or turned |
| One low beep | An amber box and a **NEEDS REVIEW** card | The model is not sure (under 60%), or its last checks disagreed. Take a look |
| Nothing | A green **CLEARED** card for about 3 seconds | The problem is gone: "Mistake cleared. Continue with" the next step |

On a MISTAKE:

1. Fix it: do the skipped step, put the part back, or move or turn it.
2. Move your hands out of the camera view and hold still for a moment. The station checks again
   once its view is clear (no hand in view when Hands is on, nothing moving in its zones), and
   every second while the card shows. The checklist row it is about says "Mistake - fix and clear
   the view".
3. The card stays until a check finds it fixed (CLEARED) or the next step replaces it. The same
   mistake does not beep twice.

Sound: **Sound** in the toolbar turns every station's sounds on or off (on by default). **Mute** on
a station silences only that station. Sound starts after the first click on the page, because
browsers block it before that. To keep the beeps but drop the chirp on every correct step, set
`"sounds": { "verified": false }` in `data/meta/wire-line.json`.

S2 checks the color order this way: its position check covers `red_wire`, `white_wire` and
`black_wire` in the Work area, so build one unit correctly there and press **Save correct state**
on S2.

Without its model a station only catches skipped steps. "Looks done but I'm not sure", a missing
part and a part in the wrong spot need **Model: on** and that station's model, and only a station
whose config has a position check gets the **Save correct state** button:

1. Build one unit correctly and turn the model on.
2. Take your hands away, open **Setup** on that station and press **Save correct state**. It
   saves where each listed part sits in the station's anchor zone, on this laptop, like the zones.
3. Live, a part more than 14% of the zone away from its saved spot is "in the wrong position", and
   one that turned from lying wide to standing tall (or the reverse) is "turned the wrong way".
   Redrawing the anchor zone drops the saved state: press Save correct state again.

Every alert goes into the session's **verdicts.csv** (under **Sessions and exports**),
**cycles.csv** counts the mistakes and reviews of each cycle, and **units.csv** adds them up per unit.

## 6. Share the footage

- Each session saves a folder `data/sessions/<id>/`: one video per station (`s1.mp4` to `s4.mp4`),
  `events.jsonl` (every detected step and key press, with the time into each video) and
  `session.json`. The CSVs are under **Sessions and exports**.
- Upload the whole folder to the team's shared Drive folder. It is about 1 GB per hour. Never
  commit it to git (the folder is git-ignored).
- Each trainer takes their own station's video: `s1.mp4` for S1, `s2.mp4` for S2, and so on.

## 7. Train your station's model

1. **Use your station's classes.** Label states and tools you can see in one still frame, never
   motions: `connector_closed` is a class, "closing the levers" is not. Hands are not labeled.

   | Station | Classes |
   |---|---|
   | S1 Cut | `red_wire, white_wire, black_wire, cutter, ruler` |
   | S2 Arrange and clamp | `red_wire, white_wire, black_wire, connector_open, connector_closed` |
   | S3 Second connector | `red_wire, black_wire, connector_open, connector_closed` |
   | S4 QA pull test | `connector_closed, wire_out` |

   `connector_open` is a lever connector with its levers up; `connector_closed` has them pressed
   down. `wire_out` is a wire end that came out of a connector during the pull test.

2. **Pull frames**, about 3 per second:

       ffmpeg -i s1.mp4 -vf fps=3 frames/s1_%05d.jpg

   Ruza's `vision/extract_frames.py` on the `vision-step-checker` branch does the same and zips
   the frames for Colab.
3. **Label.** Auto-label with Ruza's Colab notebook (`vision/train_colab.ipynb` on the same
   branch) after changing its class names to your station's, then check every box by hand.
   For S2, S3 and S4, keep the arrival in every clip: the wires or the unit sliding in is a step the
   model has to see.
4. **Split by session, never by frame.** Whole sessions go to training or validation. Keep your
   test sessions out of training completely.
5. **Train** on Colab (free T4 GPU), then export to ONNX:

       python -c "from ultralytics import YOLO; YOLO('best.pt').export(format='onnx', opset=12, imgsz=640, simplify=False)"

   Use `imgsz=416` or `320` if the laptop runs slowly.

## 8. Add your model to the platform

1. Copy the file into `app/models/`, for example `app/models/s1-cut.onnx` (letters,
   numbers, dots, dashes and underscores only).
2. In `data/meta/wire-line.json`, add **only your own station's** entry under `"models"`:

       "models": {
         "s1": { "file": "/models/s1-cut.onnx", "classes": ["red_wire", "white_wire", "black_wire", "cutter", "ruler"], "imgsz": 640 }
       }

   List the classes in exactly the order you trained them.
3. Reload `/line` and press **Model: on**. Your station's tile shows your file name, and each
   substep your model can see switches to it.
4. A red banner such as "s1-cut.onnx outputs 4 classes but the config lists 5 for S1" means
   your class list does not match the model. Fix the list; the station stays on zones until then.
5. Run `npm run test:line` (it must pass), then commit the `.onnx` file and your config line on a
   branch and open a pull request. Anyone can do this from a fork; ask Michael for direct write
   access.

## 9. Test your model against the answer key

1. On your station, pick a past session's video as the source (past recordings are in the clip
   list).
2. Press **Model: on**, then **Start session**, play the clip through, and **Stop session**.
3. Compare the detected cycles in the new `cycles.csv` (`basis` = `detected`) with the original
   session's key presses (`basis` = `manual`). The go-live targets are in Stage 5 of the Playbook:
   95% or more of steps confirmed, timing within 0.3 s.

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| A camera is missing | Close other camera apps, or move it to another USB port |
| Red banner on load | A typo in `wire-line.json`, or a rule that names a zone the station does not have |
| Red banner after Model: on | The class list does not match the model file, or the file is missing from `app/models/` |
| The page is slow | Keep it in the front tab; export your model at 416 or 320 |
| A `.webm` video will not seek | `ffmpeg -i s1.webm -c copy s1-fixed.webm` |
| Unit counts go negative | Units were already in the work areas when the session started |
| No alert sounds | Click anywhere on the page once, check that **Sound** is on and the station is not on **Mute** |
| A MISTAKE at the start of many units | The first step's zone missed the hand: make that zone cover where the hand goes |
| A MISTAKE card never clears | Take your hands fully out of view, and check that nothing moves in the zones (a fan, a screen, a shadow) |

## 11. Still open

- Which shared Drive folder the footage goes in.
- Who owns the run-day laptop.
- The wire length in cm: S1 only sees that the wire went to the ruler, it does not measure it yet.
- The QA process beyond the pull test.
- Four real USB cameras on one laptop have not been tested yet.
