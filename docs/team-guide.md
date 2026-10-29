# Team guide: using the wire line platform

Everything runs in one page on a laptop, http://localhost:4173/line. Each station has one camera:
a USB camera, a phone or a tablet (or a mix). The stations sit on a floor plan arranged like our
tables (four in the Class test layout; add or remove any). It records every station at once, counts by itself, keeps an answer key when you score the cameras, exports the data, runs each station's own trained model once you
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
| Run-day lead | Brings the laptop, mounts the cameras, arranges the floor if the tables changed, sets up zones, starts and stops the session, uploads the footage |
| Operators (one per station) | Set their code and level on their station's **Op** chip, then build at their station following its SOP, including the planned mistakes for the run |
| Answer-key keeper | Only when the cameras are being scored (**Score the cameras** on in Setup): presses the keys as units leave each station and at QA. This is the ground truth every model is scored against |
| Station trainer (one per station) | Labels that station's footage, trains its model, adds it to the platform, tests it |

## 4. Run day (recording)

1. **Mount the cameras.** One camera straight above each station, with every parts pile, the ruler (S1)
   and the work area in view. Plug them all into the laptop, spread over different USB ports (a powered hub
   helps). Close any other app that uses a camera.
2. **Connect them.** Open `/line`. Each station shows **Connect a camera**: press it and pick
   **USB camera** (the first time, allow camera access). With several cameras plugged in, pick one
   per station; cameras plugged in later are found by themselves. To tell them apart, cover one
   lens and see which card goes dark. The laptop remembers each station's camera. Any camera Chrome
   lists works (webcams, capture cards, Continuity Camera, OBS Virtual Camera).
3. **Draw the zones.** Press **Setup** at the top (or a station's **Setup needed**). Every station
   opens its setup panel. Drag a box on each station's video around each parts pile or work area it
   asks for; the next zone is picked for you. Keep boxes off walkways, because a hand passing
   through counts as activity. Zones are saved on the laptop and come back after a reload.

   **Standard setup.** Each role (S1 to S4) has a standard setup: the zones for the camera mount
   the models were trained on. It is the file `data/meta/wire-line-standard.json`, committed to
   git. The first time, draw the zones once on the trained mount, press **Save as standard** in
   that station's Setup panel, and commit that file. After that every laptop gets the zones
   automatically when a station has none saved ("Standard setup applied"), so nobody redraws them.
   **Use standard setup** puts the standard back on a station that was edited. When the mount or
   the environment changes, edit the boxes and press **Save as standard** again. A station uses the
   standard of its role, whatever its own id. Saving keeps the role's existing note. If the standard was drawn on a different shape of view than the live one, the warning names both ratios (for example 3:4 and 9:16). The standard holds only the zones: **Calibrate**
   (next step) is never part of it, because the brightness and motion baselines depend on the
   light that day.
4. **Calibrate.** With each work area empty and still, press **Calibrate empty** (2 seconds). Press
   **Done**. Each station's head now says **Ready**.
5. **Recording is on.** Every camera and phone records its video during a session (Setup has
   **Record video** per station, on by default). Each recording station shows **REC** and its size
   in its head. Without video there is nothing to train on.
6. **Start.** Clear the work areas (counts start from zero), press **Start session**, then **Enter**.
   The title is filled in with the date, time and shift. **More details** holds the crew or
   training group, the shift and notes. The line under the title says what is not ready yet.
7. **Run.** Nothing to press. The cameras log every cycle, step, QA arrival and every mistake. To **score the cameras**, turn on **Score the cameras** in Setup (the
   laptop remembers it). The answer-key bar appears at the bottom and one person keys:
   - A station's number key when a unit leaves it: the stations in flow order, so **1** to **3** on
     Class test (the bar shows each key). On S1 that is after each wire, so three presses per unit.
   - At QA, **P** for pass or **F** for fail, then pick the fail reason. P or F also closes the QA
     station's unit, so its number key only says so. A second QA station has its own Pass and Fail
     buttons on the bar.
   Fail reasons (and fails by cause) only come from the answer key.
8. **Stop.** Press **Stop session**. The banner links the session's four CSV files (with units.csv) (the raw
   event log and session record fold under **raw**).

Keep the page in the front tab the whole time; a background tab slows to about one check per
second.

### The floor: arranging the stations

`/line` shows each station as a card where it stands, with arrows for the flow. It opens on
**Class test**, the L of our tables: S1 at the top, S2 below it, S3 to the right of S2, S4 to the
right of S3.

- **Look around.** Drag the floor (or a card outside its buttons), or scroll with two fingers, to
  move it. Pinch or ctrl+scroll to zoom. Bottom right: zoom out, the zoom (click it for 100%), zoom
  in, and **Fit** (every station in view). The browser remembers where you were.
- **Add a station.** Press **+ Station**, pick its role (which trained station it is: Cut, Arrange and clamp,
  Second connector or QA pull test) and a name, then **Add station**. It appears in the middle of the
  screen with **Connect a camera** open. The models do not change: the new station runs its role's.
- **Move, rename, reorder or remove.** Press **Edit layout**. Drag a card to its spot on the floor.
  Each card's strip has its name, its role, Earlier and Later (its place in the flow, which the
  arrows follow) and **Remove** (two clicks). The bar on top picks a layout, renames it, makes a
  **New blank** one, **Duplicates** it or **Deletes** it. Press **Done**.
- **Class test stays as it is.** The first change to it saves "Class test copy" and switches to it.
  Layouts are saved on the laptop, so they survive a browser reset.
- **Not during a session.** Adding and editing wait until the session stops (the page says so).
- A station's camera, boxes and phone link go with its id (S5): a copied layout keeps them, and a
  station removed and added again finds its camera. Give a station another role and it needs that
  role's boxes (Setup).

### Operators

Each card has an **Op** chip. The operator at that station taps it, types their number (7 becomes
**Op-07**), picks their level (**New**, **In training** or **Certified**) and presses **Save**.
Change it whenever someone else takes over, also during a session; **No operator** clears it. It is
an anonymous number, never a name, and the cycles are tagged with it for coaching, never for
ranking people.

### Phones and tablets instead of USB cameras

Any phone or tablet with a camera works: iPhone, iPad, Android, or another laptop's browser. Steps
1 and 2 change; everything after them is the same.

1. **Get each phone ready.** Turn the screen timeout off (iPhone and iPad: Settings > Display &
   Brightness > Auto-Lock: **Never**; Android: Settings > Display > Screen timeout, the longest).
   Plug it in. If it will lie flat over the table, lock the rotation (iPhone and iPad:
   **Orientation Lock** in Control Center; Android: **Auto-rotate** off).
2. **Same network.** The laptop and all the phones join the same Wi-Fi. If that is campus Wi-Fi
   and the phones say "The video cannot get through", use a home router or one phone's Personal
   Hotspot instead (that phone can be one of the cameras).
3. **Connect.** On `/line`, press **Connect a camera** on the station, then **Phone or tablet
   (scan a QR code)**. The card shows a QR code for that station.
4. **Scan.** Point the station's phone camera at its card's QR code and open the link. The browser
   warns that the connection is not private: in Safari tap **Show Details**, then **visit this
   website**; in Chrome tap **Advanced**, then **Proceed**. Allow the camera. The phone says
   **LIVE** in green and the card shows its video.
5. **Mount it** straight above the station and keep the browser open on that page. Then draw the
   zones and go on with step 3 above.

Each station has its own QR code, and the codes keep working after a restart, so you scan once.
**New pairing code** (in Setup, two clicks) makes new ones and cuts off every phone; use it if a
link got out. A phone that drops reconnects by itself; its card says "Phone lost" until it is back.
Trusting the laptop's certificate on a phone is optional (the phone page shows how); it stops the
warning, and it only lets this laptop vouch for itself, never for other websites.

## 5. Mistake alerts

Each station checks the steps as they happen (Ruza's step checker, built into the page) and says
so with a sound and on its card.

| You hear | You see | What it means |
|---|---|---|
| One short high chirp | A green box for 2 seconds | A step was seen done right. At the end of a unit: "Cycle complete" |
| Three beeps | A red box and a flashing **MISTAKE** card | A step was skipped or done out of order, a part that must stay went missing, or a part is in the wrong spot or turned |
| One low beep | An amber box and a **NEEDS REVIEW** card | The model is not sure (under 60%), or its last checks disagreed. Take a look |
| Nothing | A green **CLEARED** card for about 3 seconds | The problem is gone: "Mistake cleared. Continue with" the next step |

On a MISTAKE:

1. Fix it: do the skipped step, put the part back, or move or turn it.
2. Move your hands out of the camera view and hold still for a moment. The station checks again
   once its view is clear (no hand in view when Hand tracking is on, nothing moving in its zones), and
   every second while the card shows. The checklist row it is about says "Mistake - fix and clear
   the view".
3. The card stays until a check finds it fixed (CLEARED) or the next step replaces it. The same
   mistake does not beep twice.

Sound: **Sound** at the top of the page turns every station's sounds on or off (on by default).
**Mute sounds** in a station's Setup panel silences only that station. Sound starts after the first click on the page, because
browsers block it before that. To keep the beeps but drop the chirp on every correct step, set
`"sounds": { "verified": false }` in `data/meta/wire-line.json`.

S2 checks the color order this way: its position check covers `red_wire`, `white_wire` and
`black_wire` in the Work area, so build one unit correctly there and press **Save correct state**
on S2.

Without its model a station only catches skipped steps. "Looks done but I'm not sure", a missing
part and a part in the wrong spot need that station's model (it runs by itself once it is added),
and only a station whose config has a position check gets the **Save correct state** button:

1. Build one unit correctly with the model running.
2. Take your hands away, open **Setup** and press that station's **Save correct state**. It
   saves where each listed part sits in the station's anchor zone, on this laptop, like the zones.
3. Live, a part more than 14% of the zone away from its saved spot is "in the wrong position", and
   one that turned from lying wide to standing tall (or the reverse) is "turned the wrong way".
   Redrawing the anchor zone drops the saved state: press Save correct state again.

Every alert goes into the session's **verdicts.csv** (under **Sessions**),
**cycles.csv** counts the mistakes and reviews of each cycle, and **units.csv** adds them up per unit.

## 6. Share the footage

- Each session saves a folder `data/sessions/<id>/`: one video per station, named `<station id>.mp4`
  (`s1.mp4`, `s2.mp4` and so on). A new station's id now defaults to its role id, so S2 footage is `s2.mp4`,
  `events.jsonl` (every detected step and key press, with the time into each video) and
  `session.json`. The CSVs are under **Sessions**. Older sessions may use another id for a role (a
  one-station layout for S2 saved `s1.mp4`): read `roles` in `session.json` (under **raw**), not the file name.
- Upload the whole folder to the team's shared Drive folder. It is about 1 GB per hour. Never
  commit it to git (the folder is git-ignored).
- Each trainer takes their own station's video: `s1.mp4` for S1, `s2.mp4` for S2, and so on. An
  added station films its role's work: `session.json` (under **raw**) lists each station's role, so
  `s5.mp4` from a second QA station is QA footage.

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
2. In `data/meta/wire-line.json`, add **only your own station's** entry under `"models"`, keyed by
   your station's role (`s1` to `s4`; every station on the floor running that role uses it):

       "models": {
         "s1": { "file": "/models/s1-cut.onnx", "classes": ["red_wire", "white_wire", "black_wire", "cutter", "ruler"], "imgsz": 640 }
       }

   List the classes in exactly the order you trained them.
3. Reload `/line`. Every station with a model runs it by itself: your station's row in Setup shows
   your file name, and each substep your model can see switches to it (its checklist row says
   **model**).
4. A red banner such as "s1-cut-strip.onnx outputs 3 classes but the config lists 4 for S1" means
   your class list does not match the model. Fix the list; the station stays on zones until then.
5. Run `npm run test:line` (it must pass), then commit the `.onnx` file and your config line on a
   branch and open a pull request. Anyone can do this from a fork; ask Michael for direct write
   access.

## 9. Test your model against the answer key

1. On your station, play a past session's video: **Connect a camera** > **Recorded clip** (or the
   Camera list in Setup). Each station lists its own 10 newest recordings, including older ones named for another station that ran the same role (an `s1.mp4` recorded by a station that ran S2 shows on S2). Pick a session that was
   recorded with **Score the cameras** on, so it has key presses to compare with.
2. Press **Start session**, play the clip through, and **Stop session**.
3. Compare the detected cycles in the new `cycles.csv` (`basis` = `detected`) with the original
   session's key presses (`basis` = `manual`). The go-live targets are in Stage 5 of the Playbook:
   95% or more of steps confirmed, timing within 0.3 s.

### Test recipe for S2 (a live run with the answer key)

1. In **Setup**, turn **Score the cameras** on.
2. Start the session. One person stands by the keyboard and presses **1** each time a unit leaves S2.
3. Run 3 to 5 cycles, then stop the session.
4. The **Done** tile shows detected cycles next to keyed cycles, and `events.jsonl` has the key presses.
   This scores cycle counts and cycle times only, not individual steps. To review steps, use the saved
   video and the `events.jsonl` times.

The Start-session line says "Score is off; nothing to compare the cameras against" when a model is on and
Score is off.

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| A camera is missing | Close other camera apps, or move it to another USB port. The list updates by itself |
| Red banner on load | A typo in `wire-line.json`, or a rule that names a zone the station does not have |
| Red banner about a model | The class list does not match the model file, or the file is missing from `app/models/` |
| The page is slow | Keep it in the front tab; export your model at 416 or 320. **Models: off** in Setup stops every model on this laptop (it remembers that) |
| A `.webm` video will not seek | `ffmpeg -i s1.webm -c copy s1-fixed.webm` |
| Unit counts go negative | Units were already in the work areas when the session started |
| No alert sounds | Click anywhere on the page once, check that **Sound** is on (top of the page) and the station's **Mute sounds** is off (Setup) |
| A MISTAKE at the start of many units | The first step's zone missed the hand: make that zone cover where the hand goes |
| A MISTAKE card never clears | Take your hands fully out of view, and check that nothing moves in the zones (a fan, a screen, a shadow) |
| The phone cannot open the link | Phone and laptop on the same Wi-Fi? `npm start` running? On an iPhone hotspot use the `.local` link (the default). Try another address from the **Address** list under the QR code |
| The phone says "The video cannot get through" | The network blocks devices from reaching each other (common on campus Wi-Fi). Use a home router or a Personal Hotspot |
| The phone says "This link does not work any more" | Someone pressed **New pairing code**, or the station is not on the floor layout in use. Scan the station's QR code again |
| A card says "Phone lost" | Bring the browser back to the front on that phone and unlock it. It reconnects by itself |
| An Android phone cannot open the link | Older Android versions do not find `.local` names: pick the laptop's IP address in the **Address** list under the QR code |
| A station is off screen | Press **Fit** (bottom right) |
| A station will not move | Press **Edit layout** first; nothing moves while a session records |
| The Mac asks about incoming connections for `node` | Allow it, or the phones cannot reach the laptop |
| The phone picture turns sideways | Lock the phone's rotation (Orientation Lock, or Auto-rotate off), then reload its page |

## 11. Still open

- Which shared Drive folder the footage goes in.
- Who owns the run-day laptop.
- The wire length in cm: S1 only sees that the wire went to the ruler, it does not measure it yet.
- The QA process beyond the pull test.
- Four real USB cameras on one laptop have not been tested yet.
- iPhones: one real iPhone reached the camera page over a hotspot; a real iPhone streaming into
  `/line`, four at once, and campus Wi-Fi are not tested yet. Android phones, iPads and a laptop as
  a camera are not tested on real devices.
- The floor: tested in Chrome with fake cameras. Six cameras at once on the run-day laptop and a
  touch screen are not tested yet.
