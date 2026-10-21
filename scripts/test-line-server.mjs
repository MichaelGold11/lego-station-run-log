// Session API tests: starts server.mjs on a spare port with a temporary data folder, then stops it.
// Run: npm run test:line
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.TEST_PORT) || 4199;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'line-test-'));
let fails = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log('  pass  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); }
}

// Raw requests (no URL normalizing), so path tricks reach the server as typed.
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

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA }), stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (/localhost:\d+/.test(log)) return true;
    if (server.exitCode != null) return false;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

try {
  check('server starts on a spare port with DATA_DIR', await ready(), log);

  console.log('config and setup');
  const cfg = await req('GET', '/api/line/config');
  check('GET /api/line/config falls back to the repo config (4 stations)', cfg.status === 200 && cfg.json.stations.length === 4);
  const page = await req('GET', '/line');
  check('GET /line serves the page with cross-origin isolation headers', page.status === 200 && page.headers['cross-origin-embedder-policy'] === 'credentialless' && /<title>/.test(page.text));
  const setup = { s1: { zones: { supply: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, ghost: { x: 0, y: 0, w: 0.1, h: 0.1 } }, calib: { motion: { supply: 0.02 }, bright: { supply: { off: 80 } } } } };
  const put = await req('PUT', '/api/line/setup', setup, jsonHdr);
  check('PUT /api/line/setup saves zones and calibration', put.status === 200, put.text);
  const got = await req('GET', '/api/line/setup');
  check('GET returns them; zones the config does not have are dropped', got.json.s1 && got.json.s1.zones.supply.w === 0.2 && !got.json.s1.zones.ghost && got.json.s1.calib.bright.supply.off === 80, got.text);
  check('setup is written to meta/wire-line-setup.json in the data folder', fs.existsSync(path.join(DATA, 'meta', 'wire-line-setup.json')));
  const badSt = await req('PUT', '/api/line/setup', { '../evil': { zones: {} } }, jsonHdr);
  check('setup with an unknown station name is refused', badSt.status === 400);
  const badZone = await req('PUT', '/api/line/setup', { s1: { zones: { supply: { x: 2, y: 0, w: 0.1, h: 0.1 } } } }, jsonHdr);
  check('setup with a zone outside 0..1 is refused', badZone.status === 400);

  console.log('session lifecycle');
  const created = await req('POST', '/api/sessions', { title: 'Dry run', crew: 'Group B', shift: 'Morning', notes: 'test', stations: { s1: { input: 'clip', label: 'Run 1', record: true }, s4: { input: 'none' } } }, jsonHdr);
  const id = created.json && created.json.id;
  check('POST /api/sessions creates a session id', created.status === 200 && /^\d{8}-\d{6}-[a-f0-9]{4}$/.test(id || ''), created.text);
  const dir = path.join(DATA, 'sessions', id || 'x');
  const sj = () => JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  check('session.json holds the config and setup snapshots, crew and shift', fs.existsSync(path.join(dir, 'session.json')) && sj().config.stations.length === 4 && sj().setup.s1 && sj().crew === 'Group B' && sj().shift === 'Morning');
  const badStation = await req('POST', '/api/sessions', { stations: { s9: { input: 'clip' } } }, jsonHdr);
  check('a session with an unknown station is refused', badStation.status === 400);

  const t0 = created.json.startedAtMs;
  const events = [
    { type: 'session_start', t: t0, ts: 0, source: 'page' },
    { type: 'substep', station: 's1', substep: 's1_pick_wire', move: 'start', source: 'zones', conf: 0.4, t: t0 + 1000, cycle: 1, videoT: 1 },
    { type: 'substep', station: 's1', substep: 's1_measure_cut', move: 'next', source: 'zones', conf: 0.5, t: t0 + 3000, cycle: 1, videoT: 3 },
    { type: 'substep', station: 's1', substep: 's1_handoff', move: 'next', source: 'zones', conf: 0.6, t: t0 + 9000, cycle: 1, videoT: 9 },
    { type: 'cycle_end', station: 's1', substep: 's1_handoff', source: 'zones', conf: 0.6, t: t0 + 9000, cycle: 1, dur: 8, videoT: 9 },
    { type: 'manual', station: 's1', action: 'cycle_done', source: 'manual', t: t0 + 9500 },
    { type: 'manual', station: 's4', action: 'fail', reason: 'crimp_a', source: 'manual', t: t0 + 12000 }
  ];
  const ev1 = await req('POST', `/api/sessions/${id}/events`, { events: events.slice(0, 4) }, jsonHdr);
  const ev2 = await req('POST', `/api/sessions/${id}/events`, { events: events.slice(4) }, jsonHdr);
  check('events append in batches', ev1.status === 200 && ev2.status === 200 && ev2.json.appended === 3);
  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  check('events.jsonl has one line per event', lines.length === 7 && JSON.parse(lines[6]).reason === 'crimp_a');
  check('ts is filled in when the page leaves it out', JSON.parse(lines[1]).ts === 1);
  const badEv = await req('POST', `/api/sessions/${id}/events`, { events: [{ type: 'substep', station: '../x', t: 1 }] }, jsonHdr);
  check('an event with an unknown station is refused, nothing written', badEv.status === 400 && fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').length === 7);
  const badType = await req('POST', `/api/sessions/${id}/events`, { events: [{ type: 'rm -rf', t: 1 }] }, jsonHdr);
  check('an event with an unknown type is refused', badType.status === 400);

  console.log('video chunks');
  const A = Buffer.alloc(1000, 1), B = Buffer.alloc(2000, 2), C = Buffer.alloc(500, 3), D = Buffer.alloc(700, 4);
  const vh = { 'Content-Type': 'video/webm;codecs=vp8' };
  const c0 = await req('POST', `/api/sessions/${id}/video/s1?seq=0&t0=${t0 + 200}`, A, vh);
  const c1 = await req('POST', `/api/sessions/${id}/video/s1?seq=1`, B, vh);
  check('two chunks in order are appended', c0.status === 200 && c1.status === 200 && c1.json.bytes === 3000, c1.text);
  const vfile = path.join(dir, 's1.webm');
  check('the station file is <station>.webm and has both chunks', fs.existsSync(vfile) && fs.statSync(vfile).size === 3000);
  const late = await req('POST', `/api/sessions/${id}/video/s1?seq=0`, C, vh);
  check('a chunk that arrives out of order (behind) is refused with 409 and not written', late.status === 409 && late.json.expected === 2 && fs.statSync(vfile).size === 3000, late.text);
  const ahead = await req('POST', `/api/sessions/${id}/video/s1?seq=3`, D, vh);
  check('a chunk ahead of the expected one is kept and the gap is logged', ahead.status === 200 && fs.statSync(vfile).size === 3700, ahead.text);
  const rec = sj().recordings.s1[0];
  check('session.json records the recorder start time, chunk count and the gap', rec.startedAt === t0 + 200 && rec.chunks === 3 && rec.gaps.length === 1 && rec.gaps[0].expected === 2 && rec.gaps[0].got === 3, JSON.stringify(rec));
  const mp4 = await req('POST', `/api/sessions/${id}/video/s2?seq=0&part=2`, A, { 'Content-Type': 'video/mp4' });
  check('a second recording part gets its own file (s2-2.mp4)', mp4.status === 200 && fs.existsSync(path.join(dir, 's2-2.mp4')));
  const wrongType = await req('POST', `/api/sessions/${id}/video/s1?seq=4`, A, { 'Content-Type': 'text/plain' });
  check('a chunk that is not video is refused', wrongType.status === 415);
  const vget = await req('GET', `/api/sessions/${id}/video/s1`, null, { Range: 'bytes=0-99' });
  check('a recording can be played back with byte ranges', vget.status === 206 && vget.raw.length === 100);

  console.log('end and exports');
  const end = await req('POST', `/api/sessions/${id}/end`, {}, jsonHdr);
  check('POST end stamps the end time and a summary', end.status === 200 && end.json.endedAt && end.json.summary && end.json.summary.line.cycleEnds.s1.detected === 1, end.text.slice(0, 300));
  check('session.json on disk is ended', !!sj().endedAt);
  const subCsv = await req('GET', `/api/sessions/${id}/substeps.csv`);
  const subLines = subCsv.text.trim().split('\n');
  check('substeps.csv downloads as CSV with a row per detected substep', subCsv.status === 200 && /text\/csv/.test(subCsv.headers['content-type']) && /attachment/.test(subCsv.headers['content-disposition']) && subLines.length === 4 && subLines[0].startsWith('session_id,crew,shift,station'), subCsv.text);
  const cycCsv = await req('GET', `/api/sessions/${id}/cycles.csv`);
  const cycLines = cycCsv.text.trim().split('\n');
  check('cycles.csv has the detected cycle and the manual presses', cycCsv.status === 200 && cycLines.length === 4 && cycLines.some(l => l.includes(',s1,detected,1,zones,1,9,8,')) && cycLines.some(l => l.includes(',s4,manual,1,manual,') && l.includes('crimp_a,s2')), cycCsv.text);
  const jl = await req('GET', `/api/sessions/${id}/events.jsonl`);
  check('events.jsonl downloads', jl.status === 200 && jl.text.trim().split('\n').length === 7);
  const list = await req('GET', '/api/sessions');
  check('GET /api/sessions lists it with its videos', list.status === 200 && list.json.sessions.some(s => s.id === id && s.videos.length === 2));
  const one = await req('GET', `/api/sessions/${id}`);
  check('GET /api/sessions/:id returns the session with an event count', one.status === 200 && one.json.eventCount === 7);
  const clips = await req('GET', '/api/line/clips');
  check('the clip list offers the recorded session videos', clips.status === 200 && clips.json.clips.some(c => c.key === 'session:' + id + ':s1.webm'));

  console.log('path tricks are refused');
  const outside = path.join(DATA, 'evil.webm');
  const trav = [
    ['GET', '/api/sessions/%2e%2e%2f%2e%2e%2fpackage.json'],
    ['GET', '/api/sessions/..%2F..%2Fpackage.json'],
    ['GET', `/api/sessions/${id}/video/..%2F..%2Fevil`],
    ['POST', `/api/sessions/${id}/video/..%2F..%2Fevil?seq=0`],
    ['POST', `/api/sessions/${id}/video/s1%2F..%2F..%2Fevil?seq=0`],
    ['GET', `/api/sessions/${id}/..%2Fsession.json`],
    ['GET', '/api/sessions/20261015-120000-zzzz']
  ];
  const codes = [];
  for (const [m, p] of trav) codes.push((await req(m, p, m === 'POST' ? A : null, m === 'POST' ? vh : null)).status);
  check('ids and station names with dots or slashes get 400, nothing is read or written outside', codes.every(c => c === 400) && !fs.existsSync(outside) && !fs.existsSync(path.join(ROOT, 'evil.webm')), codes.join(','));
  const missing = await req('GET', '/api/sessions/20261015-120000-abcd');
  check('a well-formed id that does not exist is a 404', missing.status === 404);
  console.log('local-only guard');
  const sessBefore = fs.existsSync(path.join(DATA, 'sessions')) ? fs.readdirSync(path.join(DATA, 'sessions')).length : 0;
  const badHost = await req('POST', '/api/sessions', { title: 'x' }, Object.assign({ Host: 'evil.example:' + PORT }, jsonHdr));
  const badHostGet = await req('GET', '/api/sessions', null, { Host: 'evil.example' });
  const badOrigin = await req('POST', '/api/sessions', { title: 'x' }, Object.assign({ Origin: 'http://evil.example' }, jsonHdr));
  const sessAfter = fs.existsSync(path.join(DATA, 'sessions')) ? fs.readdirSync(path.join(DATA, 'sessions')).length : 0;
  check('a foreign Host gets 403 (GET and POST) and nothing is written', badHost.status === 403 && badHostGet.status === 403 && sessAfter === sessBefore);
  check('a POST with a foreign Origin gets 403 and nothing is written', badOrigin.status === 403 && sessAfter === sessBefore);
  const okOrigin = await req('POST', '/api/sessions', { title: 'origin ok', stations: { s4: { input: 'none' } } }, Object.assign({ Origin: 'http://localhost:' + PORT }, jsonHdr));
  check('a POST with the matching Origin still works', okOrigin.status < 300 && okOrigin.json && okOrigin.json.id, okOrigin.text);

} catch (e) {
  fails++;
  console.log('  FAIL  ' + (e && e.stack || e));
} finally {
  server.kill();
  await new Promise(r => setTimeout(r, 300));
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* temp folder */ }
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
