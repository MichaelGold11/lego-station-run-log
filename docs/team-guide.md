# Team guide: using the wire line platform

Everything runs in one page on a laptop, http://localhost:4173/line. It records all four stations
at once, keeps the answer key, exports the data, and runs each station's own trained model once
you add it. This guide is the step-by-step for the team. The technical reference (event fields,
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

## 2. Roles

| Role | What they do |
|---|---|
| Run-day lead | Brings the laptop, mounts the four cameras, sets up zones, starts and stops the session, uploads the footage |
| Operators (S1 to S4) | Build at their station following its SOP, including the planned mistakes for the run |
| Answer-key keeper | Presses the keys as units leave each station and at QA. This is the ground truth every model is scored against |
| Station trainer (one per station) | Labels that station's footage, trains its model, adds it to the platform, tests it |

## 3. Run day (recording)

1. **Mount the cameras.** One camera straight above each station, with every tray, bin and work
   area in view. Plug all four into the laptop, spread over different USB ports (a powered hub
   helps). Close any other app that uses a camera.
2. **Connect them.** Open `/line`, press **Find cameras** and allow access. Pick one camera per
   station. To tell them apart, cover one lens and see which tile goes dark.
3. **Draw the zones.** On each station press **Setup**. Drag a box around each tray, bin or work
   area it asks for; the next zone is picked for you. Keep boxes off walkways, because a hand
   passing through counts as activity. Zones are saved on the laptop and come back after a reload.
4. **Calibrate.** With each work area empty and still, press **Calibrate empty** (2 seconds). On
   S4, press **Bulb off** with the bulb dark, then light the bulb in the fixture and press
   **Bulb on**.
5. **Check Rec.** Leave **Rec** ticked on every station (on by default for cameras). Without video
   there is nothing to train on. The start form warns you if no station is recording.
6. **Start.** Clear the trays (counts start from zero), press **Start session**, and fill in the
   title, the crew or training group, and the shift.
7. **Keep the answer key** while the line runs:
   - Keys **1** to **4** when a unit leaves that station.
   - At QA, **P** for pass or **F** for fail, then pick the fail reason. P or F also counts as
     S4's unit done, so do not press 4 as well.
8. **Stop.** Press **Stop session**. The banner links the session's two CSV files.

Keep the page in the front tab the whole time; a background tab slows to about one check per
second.

## 4. Share the footage

- Each session saves a folder `data/sessions/<id>/`: one video per station (`s1.mp4` to `s4.mp4`),
  `events.jsonl` (every detected step and key press, with the time into each video) and
  `session.json`. The CSVs are under **Sessions and exports**.
- Upload the whole folder to the team's shared Drive folder. It is about 1 GB per hour. Never
  commit it to git (the folder is git-ignored).
- Each trainer takes their own station's video: `s1.mp4` for S1, `s2.mp4` for S2, and so on.

## 5. Train your station's model

1. **Use your station's classes.** Label states and tools you can see in one still frame, never
   motions: `crimp_tool` is a class, "crimping" is not. Hands are not labeled.

   | Station | Classes |
   |---|---|
   | S1 Cut and strip | `wire, cutter, stripper, stripped_end` |
   | S2 Crimp side A | `wire, splice, crimp_tool, crimped_splice` |
   | S3 Crimp side B | `wire, splice, crimp_tool, crimped_splice` |
   | S4 QA test | `battery, bulb_on, bulb_off` |

2. **Pull frames**, about 3 per second:

       ffmpeg -i s1.mp4 -vf fps=3 frames/s1_%05d.jpg

   Ruza's `vision/extract_frames.py` on the `vision-step-checker` branch does the same and zips
   the frames for Colab.
3. **Label.** Auto-label with Ruza's Colab notebook (`vision/train_colab.ipynb` on the same
   branch) after changing its class names to your station's, then check every box by hand.
4. **Split by session, never by frame.** Whole sessions go to training or validation. Keep your
   test sessions out of training completely.
5. **Train** on Colab (free T4 GPU), then export to ONNX:

       python -c "from ultralytics import YOLO; YOLO('best.pt').export(format='onnx', opset=12, imgsz=640, simplify=False)"

   Use `imgsz=416` or `320` if the laptop runs slowly.

## 6. Add your model to the platform

1. Copy the file into `app/models/`, for example `app/models/s1-cut-strip.onnx` (letters,
   numbers, dots, dashes and underscores only).
2. In `data/meta/wire-line.json`, add **only your own station's** entry under `"models"`:

       "models": {
         "s1": { "file": "/models/s1-cut-strip.onnx", "classes": ["wire", "cutter", "stripper", "stripped_end"], "imgsz": 640 }
       }

   List the classes in exactly the order you trained them.
3. Reload `/line` and press **Model: on**. Your station's tile shows your file name, and each
   substep your model can see switches to it.
4. A red banner such as "s1-cut-strip.onnx outputs 3 classes but the config lists 4 for S1" means
   your class list does not match the model. Fix the list; the station stays on zones until then.
5. Run `npm run test:line` (it must pass), then commit the `.onnx` file and your config line on a
   branch and open a pull request. Anyone can do this from a fork; ask Michael for direct write
   access.

## 7. Test your model against the answer key

1. On your station, pick a past session's video as the source (past recordings are in the clip
   list).
2. Press **Model: on**, then **Start session**, play the clip through, and **Stop session**.
3. Compare the detected cycles in the new `cycles.csv` (`basis` = `detected`) with the original
   session's key presses (`basis` = `manual`). The go-live targets are in Stage 5 of the Playbook:
   95% or more of steps confirmed, timing within 0.3 s.

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| A camera is missing | Close other camera apps, or move it to another USB port |
| Red banner on load | A typo in `wire-line.json`, or a rule that names a zone the station does not have |
| Red banner after Model: on | The class list does not match the model file, or the file is missing from `app/models/` |
| The page is slow | Keep it in the front tab; export your model at 416 or 320 |
| A `.webm` video will not seek | `ffmpeg -i s1.webm -c copy s1-fixed.webm` |
| Unit counts go negative | Units were already in the trays when the session started |

## 9. Still open

- Which shared Drive folder the footage goes in.
- Who owns the run-day laptop.
- A model class for the S4 "Unclip" step.
- Four real USB cameras on one laptop have not been tested yet.
