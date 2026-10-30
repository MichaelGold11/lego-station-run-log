// Tests for POST /api/collect (intake path A in the app) and the /collect page. Starts server.mjs on spare ports with a
// scratch DATA_DIR, then stops it. Run: node scripts/test-collect.mjs (part of npm run test:line)
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.TEST_COLLECT_PORT) || 4197;
const PHONE_PORT = Number(process.env.TEST_COLLECT_PHONE_PORT) || 4196;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-test-'));
const DATA = path.join(TMP, 'data');
const SAMPLE = path.join(ROOT, 'data', 'sessions', '20261029-180407-23b0', 's1.mp4');
let fails = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log('  pass  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); }
}
// body: Buffer, or null. lie: send this Content-Length instead (for the oversize check; nothing more is sent).
function req(method, p, body, headers, lie) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers || {});
    if (lie != null) h['Content-Length'] = lie; else if (body) h['Content-Length'] = body.length;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(t); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: t, json });
      });
    });
    r.on('error', e => (lie != null ? resolve({ status: 0, text: String(e), json: null }) : reject(e)));
    if (body && lie == null) r.write(body);
    r.end();
  });
}

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
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const Q = (role, code) => `/api/collect?role=${role}&contributor=${code}`;
const tmpLeft = () => { try { return fs.readdirSync(path.join(DATA, 'tmp')).filter(f => f.startsWith('collect-')); } catch (e) { return []; } };
const sessionIds = () => { try { return fs.readdirSync(path.join(DATA, 'sessions')); } catch (e) { return []; } };

startServer();
try {
  check('server starts on spare ports with DATA_DIR', await ready(), log);
  const small = Buffer.alloc(2048, 1);

  console.log('page and links');
  {
    const r = await req('GET', '/collect');
    check('GET /collect serves the page', r.status === 200 && /Collect footage/.test(r.text) && /\/api\/collect/.test(r.text));
    check('the page has the shot list items', /Connector open/.test(r.text) && /An empty table/.test(r.text) && /localStorage/.test(r.text));
    check('/pool links to Collect', /href="\/collect"/.test((await req('GET', '/pool')).text));
    check('/review links to Collect', /href="\/collect"/.test((await req('GET', '/review')).text));
  }

  console.log('validation');
  {
    let r = await req('POST', Q('s9', 'Mg-07'), small);
    check('a bad role is refused (400)', r.status === 400 && r.json && r.json.code === 'invalid_argument', r.text);
    r = await req('POST', Q('s1', 'Michael'), small);
    check('a name instead of a code is refused (400)', r.status === 400, r.text);
    r = await req('POST', Q('s1', '..%2Fx'), small);
    check('a path-like contributor is refused (400)', r.status === 400, r.text);
    r = await req('POST', '/api/collect?role=s1', small);
    check('a missing contributor is refused (400)', r.status === 400, r.text);
    r = await req('POST', Q('s1', 'Mg-07'), null, {});
    check('a missing body is refused (411)', r.status === 411, r.status + ' ' + r.text);
    r = await req('POST', Q('s1', 'Mg-07'), null, { 'Content-Type': 'video/mp4' }, 600 * 1024 * 1024);
    check('a declared size over 500 MB is refused (413) before any upload', r.status === 413 && r.json && r.json.code === 'too_large', r.status + ' ' + r.text);
    r = await req('POST', Q('s1', 'Mg-07'), small, { Origin: 'http://evil.example' });
    check('a foreign Origin is refused (403)', r.status === 403 && r.json && r.json.code === 'bad_origin', r.text);
    r = await req('POST', Q('s1', 'Mg-07'), small, { Host: 'evil.example' });
    check('a foreign Host is refused (403)', r.status === 403, r.text);
    r = await req('GET', '/api/collect');
    check('GET is refused (405)', r.status === 405, r.text);
    check('refused requests leave no temp file or session', tmpLeft().length === 0 && sessionIds().length === 0);
  }

  if (!hasFfmpeg || !fs.existsSync(SAMPLE)) {
    check('ffmpeg and the sample video are present for the end to end run', false, 'ffmpeg ' + hasFfmpeg + ', sample ' + fs.existsSync(SAMPLE));
  } else {
    console.log('end to end');
    const video = fs.readFileSync(SAMPLE);
    const t0 = Date.now();
    const first = req('POST', Q('s1', 'Mg-07'), video, { 'Content-Type': 'video/mp4', Origin: `http://localhost:${PORT}` });
    await new Promise(r => setTimeout(r, 400));
    const second = await req('POST', Q('s1', 'Mg-08'), small, { 'Content-Type': 'video/mp4' });
    check('a second upload while one runs is refused (409 busy)', second.status === 409 && second.json && second.json.code === 'busy', second.status + ' ' + second.text);
    const r = await first;
    check('the real video is ingested (200) with a session id, frame count and review link', r.status === 200 && r.json && /^\d{8}-\d{6}-[0-9a-f]+$/.test(r.json.id) && r.json.frames > 0 && r.json.review === '/review#s=' + r.json.id, r.status + ' ' + r.text.slice(0, 300));
    console.log('        (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s, ' + (r.json && r.json.frames) + ' frames)');
    if (r.json && r.json.id) {
      const dir = path.join(DATA, 'sessions', r.json.id);
      const caps = fs.readFileSync(path.join(dir, 'captures.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      check('captures.jsonl has one line per frame, reason home, the contributor code and the role', caps.length === r.json.frames && caps.every(c => c.reason === 'home' && c.contributor === 'Mg-07' && c.role === 's1'));
      check('every frame has a jpg on disk', caps.every(c => fs.existsSync(path.join(dir, 'captures', c.id + '.jpg'))));
      const sj = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
      check('session.json is a home session with the contributor, and no upload name', sj.mode === 'home' && sj.contributor === 'Mg-07' && sj.source === 'phone upload');
      const list = await req('GET', '/api/sessions/' + r.json.id + '/captures');
      check('the new session opens through the sessions API (as /review reads it)', list.status === 200, list.status + ' ' + list.text.slice(0, 100));
    }
    check('the uploaded video is deleted afterwards (home footage is not kept)', tmpLeft().length === 0 && !fs.readdirSync(path.join(DATA, 'tmp')).some(f => /\.part$|\.upload$/.test(f)));
    const again = await req('POST', Q('s1', 'Mg-07'), small, { 'Content-Type': 'video/mp4' });
    check('the server is free again after a run (a bad file is a plain 422, not a crash)', again.status === 422 && again.json && /does not look like a video/.test(again.json.message), again.status + ' ' + again.text);
    check('a failed run leaves no temp file and no session', tmpLeft().length === 0 && sessionIds().length === 1);
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
