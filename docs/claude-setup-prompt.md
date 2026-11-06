# Claude setup prompt

Paste the text in the box into Claude (Claude Code) on your laptop. It sets up the Wire line project and walks you through a first run. You do 5 things. Claude does the rest.

```
Set up the Wire line project (lego-station-run-log) on my laptop so I can test it with my own
iPhone on my own hotspot and tune it on my own branch. The team merges the best work later.

Do every technical step yourself. I only do 5 things, listed below: give me one at a time, in
plain words, and wait for me. Read AGENTS.md first and follow it. Never push to main. Never
commit data/sessions/ or the setup and layout files: the repo is public. If a step fails twice,
stop and tell me what you tried. Do not work around a failing test.

Ask me my first name and my station (s1 to s4; use s2 if I am not sure). Then do this yourself:
- Use my clone of https://github.com/MichaelGold11/lego-station-run-log.git, or make one. Update
  main, run git checkout -b <name>/<station>-tuning, and push the branch. If the push is refused,
  tell me to ask Michael for an invite and carry on.
- Run npm run setup -- --station <station>. Install what it reports missing, then run it again.
- Run npm run test:line and npm run test:live. All must pass.

MY STEP 2: tell me to turn on Personal Hotspot with Maximize Compatibility, set Auto-Lock to Never,
plug in the phone, and join that hotspot from this laptop. On Windows, do the firewall step in
docs/team-guide.md ("Your own laptop, phone and hotspot") yourself. Then run npm run go, which
starts the server and opens Chrome on the QR code. npm run stop stops it.

MY STEP 3: tell me to scan the QR code with my iPhone. On the warning tap Show Details, then visit
this website, then Allow the camera. The phone shows LIVE. If the link does not open, have me try
the next address in the Address list under the QR code.

MY STEP 4: tell me to mount the phone in landscape straight above the table, clear the table, then
press Start session, Calibrate in the Start form, and Enter. The boxes come from the standard
setup, so only move them if they miss my work area.

MY STEP 5: tell me to bring the parts in now and build 3 units, setting each finished one down for
2 seconds. On S2, build one good unit, one without the black wire and one with a lever left up:
only the good one should count. Then press Stop session and tell you "done".

Then read the run from data/sessions/ with /analyze-runs and tell me plainly: real units against
logged units, what went wrong, and what to try first. After that, help me tune on my branch by the
rules in docs/team-guide.md ("Branches and merging"): small commits, tests passing, proof from a
real run, and a pull request into main when something is better.
```
