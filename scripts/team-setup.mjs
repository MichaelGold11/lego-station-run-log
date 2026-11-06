// One command to get a laptop ready: npm run setup -- --station s2
// It checks the tools, runs npm install, makes the phone certificate, and writes a one-station layout.
// Safe to run twice. It never replaces an existing layout unless you add --force.
//   --station s1..s4   which station this laptop runs (default s2)
//   --force            replace an existing layout
//   --skip-install     do not run npm install (also SETUP_SKIP_INSTALL=1)
//   --skip-cert        do not make the phone certificate (also SETUP_SKIP_CERT=1)
// DATA_DIR, PORT and PHONE_PORT work like they do for npm start.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 4173;
const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const skipInstall = flag('skip-install') || process.env.SETUP_SKIP_INSTALL === '1';
const skipCert = flag('skip-cert') || process.env.SETUP_SKIP_CERT === '1';

function loadEngine() {
  const mod = { exports: {} };
  new Function('module', fs.readFileSync(path.join(ROOT, 'app', 'line-engine.js'), 'utf8'))(mod);
  return mod.exports;
}

function say(s) { console.log(s); }
function fail(s) { console.error(s); process.exit(1); }

const plat = process.platform;
const INSTALL = {
  git: { darwin: 'brew install git', win32: 'winget install --id Git.Git -e', linux: 'sudo apt install git' },
  ffmpeg: { darwin: 'brew install ffmpeg', win32: 'winget install --id Gyan.FFmpeg -e', linux: 'sudo apt install ffmpeg' },
  openssl: { darwin: 'brew install openssl', win32: 'winget install --id Git.Git -e   (Git for Windows includes openssl)', linux: 'sudo apt install openssl' },
  node: { darwin: 'brew install node', win32: 'winget install --id OpenJS.NodeJS.LTS -e', linux: 'install Node 18 or newer from https://nodejs.org' },
};
const hint = k => (INSTALL[k] && INSTALL[k][plat]) || ('install ' + k);
const has = (cmd, a) => { const r = spawnSync(cmd, a || ['-version'], { encoding: 'utf8' }); return !r.error && r.status === 0; };

function buildLayout(LE, cfg, station) {
  const s = cfg.stations.find(x => x.id === station);
  return {
    active: null,
    layouts: [{
      id: 'l-' + crypto.randomBytes(4).toString('hex'),
      name: 'My station ' + station.toUpperCase(),
      stations: [{ id: s.id, name: LE.defaultName(s.id, s.label), role: s.id, x: 0, y: 0 }],
    }],
  };
}

function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'meta', 'wire-line.json'), 'utf8'));
  const ids = cfg.stations.map(s => s.id);
  const station = opt('station', 's2');
  if (!ids.includes(station)) fail('Station "' + station + '" is not one of ' + ids.join(', ') + '. Run: npm run setup -- --station s2');
  const LE = loadEngine();
  let missing = 0;

  say('Checking this laptop');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) say('  ok       Node ' + process.versions.node);
  else { say('  MISSING  Node 18 or newer (you have ' + process.versions.node + '). Fix: ' + hint('node')); missing++; }
  if (has('git', ['--version'])) say('  ok       git'); else { say('  MISSING  git. Fix: ' + hint('git')); missing++; }
  // A live run does not need ffmpeg; only Review clips and the Collect upload do.
  if (has('ffmpeg', ['-version'])) say('  ok       ffmpeg');
  else say('  check    ffmpeg is not on PATH. A live run works without it. Review clips and Collect need it. Fix: ' + hint('ffmpeg'));
  // phone-cert.mjs also looks in Homebrew and Git for Windows, so only a quick look here.
  if (has('openssl', ['version'])) say('  ok       openssl');
  else say('  check    openssl is not on PATH. The certificate step below tells you if it is really missing. Fix: ' + hint('openssl'));
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const st = fs.statfsSync(DATA);
    const freeGB = st.bavail * st.bsize / 1e9;
    if (freeGB >= 5) say('  ok       free disk ' + freeGB.toFixed(0) + ' GB');
    else { say('  LOW      free disk ' + freeGB.toFixed(1) + ' GB. Recordings need about 5 GB. Free some space.'); missing++; }
  } catch (e) { say('  check    free disk (could not read)'); }
  say('  info     RAM ' + (os.totalmem() / 2 ** 30).toFixed(1) + ' GB' + (os.totalmem() < 9 * 2 ** 30 ? '. Run one station, keep Hand tracking off, close other apps.' : ''));
  if (missing) fail('\nInstall what is marked MISSING, then run this again.');

  if (skipInstall) say('\nnpm install: skipped');
  else {
    say('\nRunning npm install');
    const r = spawnSync(plat === 'win32' ? 'npm.cmd' : 'npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: plat === 'win32' });
    if (r.status !== 0) fail('npm install failed. Fix the error above and run this again.');
  }

  if (skipCert) say('\nPhone certificate: skipped');
  else {
    say('\nMaking the phone certificate');
    return import('./phone-cert.mjs').then(m => {
      try {
        const c = m.ensurePhoneCert(path.join(DATA, 'phone-cert'));
        say('  ' + (c.created ? 'made a new certificate' : c.reissued ? 'reissued the server certificate' : 'certificate is up to date') + ' in ' + c.dir);
      } catch (e) { fail('  Certificate failed: ' + e.message + '\n  Fix: ' + hint('openssl')); }
      layoutStep(LE, cfg, station);
    });
  }
  layoutStep(LE, cfg, station);
}

function layoutStep(LE, cfg, station) {
  const file = path.join(DATA, 'meta', 'wire-line-layouts.json');
  say('\nStation layout');
  if (fs.existsSync(file) && !flag('force')) {
    say('  kept     ' + file + ' already exists. Add --force to replace it.');
  } else {
    const L = buildLayout(LE, cfg, station);
    // Check it loads before writing it.
    LE.applyLayout(cfg, L.layouts[0]);
    L.active = L.layouts[0].id;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(L, null, 2) + '\n');
    say('  wrote    one station (' + station.toUpperCase() + ') to ' + file);
  }
  say('\nDone. Next: join your phone hotspot from this laptop, then run: npm run go');
  say('That starts the server on port ' + PORT + ' and opens Chrome on the QR code.');
}

main();
