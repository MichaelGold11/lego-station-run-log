# Set up the Wire line on your laptop

Follow this page to run the Wire line on your own laptop, with your own iPhone and hotspot. Every box has a copy button at its top right (on GitHub). About 20 minutes the first time.

The point: you do your own runs, your own Claude reviews each one, and you tune your setup on your own branch. When everyone's best changes are merged, the whole system gets stronger.

## Which path am I on?

| You use | Who runs the commands |
|---|---|
| Claude Desktop, **Code** tab, paid plan | Claude runs them after Step 1. Use Step 2A |
| Claude web, Desktop's Chat tab, or a free plan | You paste them. Use Step 2B |

Claude web cannot reach your laptop, your camera or your phone, so on that path Claude helps and you paste. Everyone needs Google Chrome installed.

Windows has not been tried on a real laptop yet. If a step fails there, send Michael what it said.

## Step 1. Install the tools and download the project (everyone, once)

### Mac

Press Cmd+Space, type `Terminal`, press Enter. Paste:

```
brew --version
```

If it says `command not found`, paste the line below. It asks for your laptop password, and nothing shows while you type. When it ends, it prints **Next steps** with a few lines: paste those too.

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Then paste:

```
brew install node ffmpeg
cd ~
git clone https://github.com/MichaelGold11/lego-station-run-log.git
```

### Windows

Press the Windows key, type `cmd`, press Enter. Use Command Prompt, not PowerShell. Paste this one line and click **Yes** on any popup:

```
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements & winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements & winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
```

Close that window and open a new Command Prompt. New tools only show up in a new window. Paste:

```
cd %USERPROFILE%
git clone https://github.com/MichaelGold11/lego-station-run-log.git
```

Now open the firewall for the phone. Press the Windows key, type `cmd`, right-click **Command Prompt**, choose **Run as administrator**, click **Yes**. Paste:

```
netsh advfirewall firewall add rule name="Wire line phone" dir=in action=allow protocol=TCP localport=4174 profile=any
netsh advfirewall firewall add rule name="Wire line Chrome" dir=in action=allow program="C:\Program Files\Google\Chrome\Application\chrome.exe" profile=any
```

Close that window.

## Step 2A. Claude Desktop

1. Download the app from https://code.claude.com/docs/en/desktop-quickstart and sign in. If it was already open during Step 1, quit and reopen it.
2. Click **Code** at the top of the sidebar. If it asks you to upgrade, use Step 2B.
3. Under the prompt box, click the first control and pick **Local**. Click the folder control next to it, then **Open folder…**, and pick `lego-station-run-log` in your home folder.
   - Mac: press Cmd+Shift+G and paste `~/lego-station-run-log`.
   - Windows: paste `%USERPROFILE%\lego-station-run-log` in the address bar.
4. Copy the prompt in the box at the bottom of this page, paste it, press Enter. Click **Allow** when Claude asks to run a command.
5. Claude sets up, then gives you Step 3 one piece at a time. It runs `npm run go` for you.

## Step 2B. Claude web

In the same Terminal or Command Prompt window, paste the two lines for your laptop.

Mac:

```
cd ~/lego-station-run-log
npm run setup -- --station s2
```

Windows:

```
cd %USERPROFILE%\lego-station-run-log
npm run setup -- --station s2
```

Use your own station if you have one (`s1` to `s4`). It ends with `Done. Next: join your phone hotspot`. If it stops with an error, paste the text into claude.ai and ask what to do.

## Step 3. Phone and first run (everyone)

1. iPhone: Settings > Personal Hotspot, turn it on, turn on **Maximize Compatibility**. Settings > Display & Brightness > Auto-Lock > **Never**. Plug the phone in.
2. Laptop: join the phone's hotspot from the Wi-Fi menu.
3. Step 2B only: paste `npm run go` in your window. It is the same on Mac and Windows, and Chrome opens on the QR code. On a Mac, if it asks about `node`, click **Allow**.
4. Scan the QR code with the iPhone camera. Tap **Show Details**, then **visit this website**, then allow the camera. The phone shows LIVE. If the link fails, try the next address in the **Address** list under the QR code.
5. Mount the phone in landscape straight above the table. Clear the table. Press **Start session**, **Calibrate** in the Start form, then **Enter**.
6. Bring the parts in. On S2, build one good unit, one without the black wire and one with a lever left up. Set each one down for 2 seconds. Press **Stop session**. Only the good one should count.

## Step 4. Read the run

- **Step 2A:** tell Claude `done`.
- **Step 2B:** press **Download run**. Open your Downloads folder and unzip it (Mac: double-click. Windows: right-click, **Extract All**). Go to claude.ai, attach the four CSV files and `run.json`, and paste:

```
These files are one Wire line run at station S2. I built 3 units: one good, one without the
black wire, one with a lever left up. Only the good one should count. Tell me in plain words:
real units against logged units, what went wrong, and what to try first.
```

On later runs, change the sentence about the units to match what you built.

## Step 5. Tune it and run again (everyone)

This is the main job. Repeat it until your counts are right:

1. Do a run and have your own Claude review it (Step 4).
2. Make the one change Claude says to try first.
3. Run again. Compare real units against logged units, before and after.
4. When you are happy with it, send a pull request, so your work can be merged.

**Claude Desktop.** Claude reads each run straight from your laptop, so you do not need **Download run**. Ask it to make the change, and it commits to `<name>/<station>-tuning`. When you are happy, ask it to open a pull request. If the first push says you are not signed in, install GitHub's tool (`brew install gh` on Mac, `winget install --id GitHub.cli -e` on Windows), then paste `gh auth login` in your terminal. If GitHub refuses you, ask Michael for an invite.

**Claude web.** After each run, give your files to Claude in chat (Step 4). To make the change, open claude.ai/code and pick `MichaelGold11/lego-station-run-log`. Paste what the chat found, ask for the change, and add this line: `Use the branch <your name>/<station>-tuning.` Claude pushes your change to that branch. This needs a paid plan and write access: on a free plan, Claude can review your runs but cannot make the change. Then on your laptop, using your branch name (if Claude gave it another name, use that one):

```
npm run stop
git fetch
git checkout <your name>/<station>-tuning
npm run go
```

When you are happy, go back to that claude.ai/code session. Ask Claude to run the tests and put real units against logged units, before and after, in the description. Then click **Create PR**.

The rules for merging are in [team-guide.md](team-guide.md), "Branches and merging".

## Later runs

Open Terminal or Command Prompt and go to the folder.

Mac:

```
cd ~/lego-station-run-log
npm run go
```

Windows:

```
cd %USERPROFILE%\lego-station-run-log
npm run go
```

When you finish, paste `npm run stop`. To get the team's updates:

```
npm run stop
git pull
npm run setup -- --station s2
npm run go
```

## If something goes wrong

| You see | Do this |
|---|---|
| `npm` or `git` is not recognized, or not found | Close the window and open a new one. On Claude Desktop, quit and reopen the app |
| `running scripts is disabled` | You are in PowerShell. Open Command Prompt |
| `already exists` when you clone | You have it already. Go into that folder and run `git checkout main`, then `git pull` |
| The phone link does nothing | Try the next **Address**. Check the laptop is on the hotspot, not other Wi-Fi. On Windows, redo the firewall step |
| The phone says LIVE but no video reaches the laptop (Windows) | Open Windows Security > Firewall & network protection > Allow an app through firewall > Change settings. Tick Private and Public for Node.js and Google Chrome |
| Setup says `check ffmpeg` | A live run works without it. Review clips and Collect need it |

More fixes are in [team-guide.md](team-guide.md), "Troubleshooting". When the course ends, Windows laptops can remove the firewall rules in an Administrator Command Prompt:

```
netsh advfirewall firewall delete rule name="Wire line phone"
netsh advfirewall firewall delete rule name="Wire line Chrome"
```

## The prompt for Claude Desktop

Paste this in the Code tab (Step 2A).

```
Set up the Wire line project on this laptop so I can test it with my own iPhone on my own hotspot
and tune it on my own branch. The team merges the best work later. This folder is my clone of
https://github.com/MichaelGold11/lego-station-run-log and Node, Git and ffmpeg are installed.

Run the commands yourself. I only do the 4 steps listed below: give me one at a time, in plain
words, and wait for me. Read AGENTS.md first and follow it. Never push to main. Never commit
data/sessions/ or the setup and layout files: the repo is public. If a step fails twice, stop and
tell me what you tried. Do not work around a failing test. If a tool is not found, tell me to quit
and reopen this app. On Windows, if npm is blocked with "running scripts is disabled", use npm.cmd.

Ask me my first name and my station (s1 to s4; use s2 if I am not sure). Then do this yourself:
- Run git checkout main and git pull, then git checkout -b <name>/<station>-tuning. Do not push yet.
- Run npm run setup -- --station <station>.
- Run npm run test:line and npm run test:live. All must pass.

MY STEP 1: tell me to turn on Personal Hotspot with Maximize Compatibility, set Auto-Lock to Never,
plug in the phone, and join that hotspot from this laptop. Then run npm run go, which starts the
server and opens Chrome on the QR code. npm run stop stops it.

MY STEP 2: tell me to scan the QR code with my iPhone. On the warning tap Show Details, then visit
this website, then Allow the camera. The phone shows LIVE. If the link does not open, have me try
the next address in the Address list under the QR code.

MY STEP 3: tell me to mount the phone in landscape straight above the table, clear the table, then
press Start session, Calibrate in the Start form, and Enter. The boxes come from the standard
setup, so only move them if they miss my work area.

MY STEP 4: tell me to bring the parts in now and build 3 units, setting each finished one down for
2 seconds. On S2, build one good unit, one without the black wire and one with a lever left up:
only the good one should count. Then press Stop session and tell you "done".

Then read the newest folder in data/sessions/ (session.json and events.jsonl) and tell me plainly:
real units against logged units, what went wrong, and what to try first. Do not use /analyze-runs:
it is for the archived LEGO run log.

After that, help me tune on my branch by the rules in docs/team-guide.md ("Branches and merging").
After every run, review it the same way, suggest one change, and compare it with the last run. Use
small commits, tests passing and proof from a real run. Open a pull request into main when I say I
am happy with it. Push at the first real commit. If the push says I am not signed in, tell me to run
gh auth login in my own terminal (install gh first if it is missing). If GitHub refuses me access,
tell me to ask Michael for an invite and carry on locally.
```
