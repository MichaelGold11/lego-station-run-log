// Tests for npm run setup (scripts/team-setup.mjs). Uses a temp data folder. No npm install, no certificate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = { exports: {} };
new Function('module', fs.readFileSync(path.join(ROOT, 'app', 'line-engine.js'), 'utf8'))(mod);
const LE = mod.exports;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'meta', 'wire-line.json'), 'utf8'));
let passes = 0, fails = 0;
const check = (n, c, d) => { if (c) passes++; else { fails++; console.log('  FAIL  ' + n + (d ? ' (' + d + ')' : '')); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-setup-'));
const file = path.join(tmp, 'meta', 'wire-line-layouts.json');
const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'team-setup.mjs'), '--skip-install', '--skip-cert', ...a], { env: { ...process.env, DATA_DIR: tmp }, encoding: 'utf8' });

try {
  let r = run('--station', 's2');
  check('first run exits 0', r.status === 0, r.stderr || r.stdout);
  const a = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('one layout, one station', a.layouts.length === 1 && a.layouts[0].stations.length === 1);
  const L = a.layouts[0], st = L.stations[0];
  check('layout id matches the server pattern', /^l-[a-f0-9]{8}$/.test(L.id));
  check('active is that layout', a.active === L.id);
  check('station has id, name, role, x, y', st.id === 's2' && st.role === 's2' && typeof st.name === 'string' && st.name && st.x === 0 && st.y === 0);
  check('name comes from defaultName', st.name === LE.defaultName('s2', cfg.stations.find(s => s.id === 's2').label));
  let ok = true; try { LE.applyLayout(cfg, L); } catch (e) { ok = false; }
  check('layout passes applyLayout', ok);

  const before = fs.readFileSync(file, 'utf8');
  r = run('--station', 's2');
  check('second run exits 0', r.status === 0);
  check('second run changes nothing', fs.readFileSync(file, 'utf8') === before);
  r = run('--station', 's3');
  check('another station without --force keeps the file', r.status === 0 && fs.readFileSync(file, 'utf8') === before);
  r = run('--station', 's3', '--force');
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('--force replaces it', r.status === 0 && c.layouts[0].stations[0].id === 's3' && fs.readFileSync(file, 'utf8') !== before);

  const bad = path.join(tmp, 'bad');
  r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'team-setup.mjs'), '--skip-install', '--skip-cert', '--station', 's9'], { env: { ...process.env, DATA_DIR: bad }, encoding: 'utf8' });
  check('a bad station is refused', r.status !== 0 && /s9/.test(r.stderr));
  check('a bad station writes no layout', !fs.existsSync(path.join(bad, 'meta', 'wire-line-layouts.json')));

  // A missing ffmpeg is a warning, not a failure. Hide it by giving the script a PATH with only git in it.
  const findOnPath = n => { for (const d of (process.env.PATH || '').split(path.delimiter)) for (const f of [n, n + '.exe']) { const p = path.join(d, f); if (d && fs.existsSync(p)) return p; } return null; };
  const gitBin = findOnPath('git'), stub = path.join(tmp, 'bin');
  let stubbed = false;
  if (gitBin) { try { fs.mkdirSync(stub); fs.symlinkSync(gitBin, path.join(stub, path.basename(gitBin))); stubbed = true; } catch (e) { console.log('  SKIP  ffmpeg-missing check: cannot make a symlink here.'); } }
  if (stubbed) {
    r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'team-setup.mjs'), '--skip-install', '--skip-cert', '--station', 's2', '--force'], { env: { ...process.env, DATA_DIR: tmp, PATH: stub }, encoding: 'utf8' });
    check('missing ffmpeg warns and still exits 0', r.status === 0 && /check\s+ffmpeg is not on PATH/.test(r.stdout) && !/MISSING\s+ffmpeg/.test(r.stdout), r.stdout + r.stderr);
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

console.log('team setup: ' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
