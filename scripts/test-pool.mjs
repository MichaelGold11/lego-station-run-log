// Tests for the clips, the single run export and the shared pool. Starts server.mjs on spare ports with a temporary
// data folder (and a temporary pool folder), then stops it. Run: node scripts/test-pool.mjs (part of npm run test:line)
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from './zip-read.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.TEST_POOL_PORT) || 4195;
const PHONE_PORT = Number(process.env.TEST_POOL_PHONE_PORT) || 4194;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-test-'));
const DATA = path.join(TMP, 'data');
let fails = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log('  pass  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); }
}
function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const buf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: Object.assign(buf ? { 'Content-Length': buf.length } : {}, headers || {}) }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks), t = raw.toString('utf8');
        let json = null; try { json = JSON.parse(t); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: t, json, raw });
      });
    });
    r.on('error', reject);
    if (buf) r.write(buf);
    r.end();
  });
}
const jsonHdr = { 'Content-Type': 'application/json' };

let server, log = '';
function startServer(env) {
  log = '';
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: Object.assign({}, process.env, { PORT: String(PORT), PHONE_PORT: String(PHONE_PORT), DATA_DIR: DATA }, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
}
async function stopServer() {
  if (!server || server.exitCode != null) return;
  const gone = new Promise(r => server.once('exit', r));
  server.kill();
  await gone;
}
async function ready() {
  for (let i = 0; i < 300; i++) {
    if (/localhost:\d+/.test(log) && /Phone cameras:/.test(log)) return true;
    if (server.exitCode != null) return false;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

const jpegBuf = (n, fill) => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(n, fill || 7)]);
const url = b => 'data:image/jpeg;base64,' + b.toString('base64');
const box = (cls, nbox, conf) => ({ cls, conf: conf == null ? 0.5 : conf, nbox });
const capBody = o => Object.assign({ station: 's2', role: 's2', stationName: 'Arrange', t: Date.now(), videoT: 5, videoFile: 's2.mp4', reason: 'claim', substep: 's2_open', cycle: 1, claim: 'Open the lever connector', boxes: [box('connector_open', [0.1, 0.2, 0.5, 0.8])], image: url(jpegBuf(300)) }, o || {});
const mk = async (stations, title) => (await req('POST', '/api/sessions', { title: title || 'pool test', stations }, jsonHdr)).json.id;
const sdir = id => path.join(DATA, 'sessions', id);
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

startServer();
try {
  check('server starts on spare ports with DATA_DIR', await ready(), log);
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'meta', 'wire-line.json'), 'utf8'));
  fs.mkdirSync(path.join(DATA, 'meta'), { recursive: true });
  const CFGF = path.join(DATA, 'meta', 'wire-line.json');
  fs.writeFileSync(CFGF, JSON.stringify(Object.assign({}, shipped, { capture: { maxPerSession: 100, maxPerStation: 100, reviewDays: 7, mediaCapMB: 1024 } })));

  console.log('clips');
  {
    const SV = await mk({ s2: { input: 'clip', record: true } });
    const mp4 = path.join(TMP, 'src.mp4');
    if (hasFfmpeg) spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', mp4]);
    const have = hasFfmpeg && fs.existsSync(mp4);
    check('ffmpeg can make the test recording', have, 'ffmpeg missing: clip cutting is not tested');
    if (have) {
      const up = await req('POST', `/api/sessions/${SV}/video/s2?seq=0`, fs.readFileSync(mp4), { 'Content-Type': 'video/mp4' });
      check('the test recording uploads', up.status === 200, up.text);
      const c1 = (await req('POST', `/api/sessions/${SV}/captures`, capBody({ videoT: 6 }), jsonHdr)).json.id;
      const cEarly = (await req('POST', `/api/sessions/${SV}/captures`, capBody({ videoT: 1 }), jsonHdr)).json.id;
      const cLate = (await req('POST', `/api/sessions/${SV}/captures`, capBody({ videoT: 100 }), jsonHdr)).json.id;
      const cNoT = (await req('POST', `/api/sessions/${SV}/captures`, capBody({ videoT: undefined, videoFile: undefined }), jsonHdr)).json.id;
      const cOther = (await req('POST', `/api/sessions/${SV}/captures`, capBody({ videoFile: 'gone.webm' }), jsonHdr)).json.id;
      const r = await req('GET', `/api/sessions/${SV}/captures/${c1}.mp4`);
      check('GET captures/<id>.mp4 returns an mp4 clip', r.status === 200 && r.headers['content-type'] === 'video/mp4' && r.raw.length > 1000 && r.raw.subarray(4, 8).toString() === 'ftyp', r.status + ' ' + r.text.slice(0, 100));
      const probe = f => { const o = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }); return Number(o.stdout); };
      const clipFile = path.join(sdir(SV), 'clips', c1 + '.mp4');
      const d1 = probe(clipFile);
      check('the clip is 6 to 8 seconds (videoT - 3 to videoT + 4)', d1 >= 6 && d1 <= 8, String(d1));
      check('the clip is cached under the session folder', fs.existsSync(clipFile));
      const m1 = fs.statSync(clipFile).mtimeMs;
      const r2 = await req('GET', `/api/sessions/${SV}/captures/${c1}.mp4`);
      check('a second request serves the cache without cutting again', r2.status === 200 && fs.statSync(clipFile).mtimeMs === m1);
      const rg = await req('GET', `/api/sessions/${SV}/captures/${c1}.mp4`, null, { Range: 'bytes=0-99' });
      check('range requests work (the browser seeks)', rg.status === 206 && rg.raw.length === 100);
      const re = await req('GET', `/api/sessions/${SV}/captures/${cEarly}.mp4`);
      const d2 = probe(path.join(sdir(SV), 'clips', cEarly + '.mp4'));
      check('a capture near the start is clamped to 0 and still gives about 7 seconds', re.status === 200 && d2 >= 6 && d2 <= 8, re.status + ' ' + d2);
      const rl = await req('GET', `/api/sessions/${SV}/captures/${cLate}.mp4`);
      check('a moment past the end of the recording is a clear error and leaves no file', rl.status >= 400 && rl.json && /ends before|could not cut/.test(rl.json.error ? rl.json.error.message : rl.json.message || '') && !fs.existsSync(path.join(sdir(SV), 'clips', cLate + '.mp4')), rl.text);
      const rn = await req('GET', `/api/sessions/${SV}/captures/${cNoT}.mp4`), ro = await req('GET', `/api/sessions/${SV}/captures/${cOther}.mp4`);
      check('no videoT, or a recording that is not stored, is 404 with a reason', rn.status === 404 && ro.status === 404 && /recording|video/i.test(ro.text), rn.status + ' ' + ro.status);
      check('unknown capture is 404, unknown session is 404, bad name is 400', (await req('GET', `/api/sessions/${SV}/captures/c0099.mp4`)).status === 404 && (await req('GET', '/api/sessions/20261015-120000-abcd/captures/c0001.mp4')).status === 404 && (await req('GET', `/api/sessions/${SV}/captures/..%2Fx.mp4`)).status === 400);
      const bh = await req('GET', `/api/sessions/${SV}/captures/${c1}.mp4`, null, { Host: 'evil.example:' + PORT });
      check('a foreign Host is 403 (same guard as every route)', bh.status === 403);
    }
  }
  if (hasFfmpeg && !fs.existsSync('/usr/bin/ffmpeg') && fs.existsSync('/usr/bin/openssl')) {
    await stopServer();
    startServer({ PATH: '/usr/bin:/bin' });
    if (await ready()) {
      const SN = (await req('GET', '/api/sessions')).json.sessions.find(s => s.title === 'pool test');
      const r = await req('GET', `/api/sessions/${SN.id}/captures/c0001.mp4`);
      check('without ffmpeg on the PATH the clip route says so (503) instead of failing silently', r.status === 503 && /ffmpeg/.test(r.text), r.status + ' ' + r.text.slice(0, 120));
    } else check('server restarts without ffmpeg on the PATH', false, log);
    await stopServer();
    startServer();
    check('server restarts normally', await ready(), log);
  }
} catch (e) {
  fails++;
  console.log('  FAIL  ' + (e && e.stack || e));
} finally {
  await stopServer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* temp folder */ }
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
