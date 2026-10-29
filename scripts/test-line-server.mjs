// Session API tests: starts server.mjs on a spare port with a temporary data folder, then stops it.
// Also the iPhone camera listener (HTTPS on a second spare port): certificate, per-station keys, signaling, isolation.
// Run: npm run test:line
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePhoneCert, findOpenssl, lanAddresses, localNames, ipAllowed } from './phone-cert.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.TEST_PORT) || 4199;
const PHONE_PORT = Number(process.env.TEST_PHONE_PORT) || 4198;
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

let server, log = '';
function startServer() {
  log = '';
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: Object.assign({}, process.env, { PORT: String(PORT), PHONE_PORT: String(PHONE_PORT), DATA_DIR: DATA }), stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
}
async function stopServer() {
  if (!server || server.exitCode != null) return;
  const gone = new Promise(r => server.once('exit', r));
  server.kill();
  await gone;
}
// Ready when both listeners have spoken (the phone one makes its certificate first: about a second).
async function ready() {
  for (let i = 0; i < 300; i++) {
    if (/localhost:\d+/.test(log) && /Phone cameras:/.test(log)) return true;
    if (server.exitCode != null) return false;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
startServer();

try {
  check('server starts on a spare port with DATA_DIR', await ready(), log);

  console.log('pages');
  const root = await req('GET', '/'), rootQ = await req('GET', '/?gpu'), idx = await req('GET', '/index.html');
  check('GET / sends you to the wire line (/line), keeping the query', root.status === 302 && root.headers.location === '/line' && rootQ.headers.location === '/line?gpu' && idx.status === 302 && idx.headers.location === '/line', [root.status, root.headers.location, rootQ.headers.location, idx.status].join());
  const runs = await req('GET', '/runs');
  check('GET /runs serves the LEGO run log with its local runtime', runs.status === 200 && /<title>LEGO Station Run Log<\/title>/.test(runs.text) && /\/local-runtime\.js/.test(runs.text));
  check('npm start prints the wire line first and the run log second', /Wire line: http:\/\/localhost:\d+\/line\n[^]*LEGO run log \(archived\): http:\/\/localhost:\d+\/runs/.test(log), log.split('\n').slice(0, 2).join(' | '));

  console.log('config and setup');
  const cfg = await req('GET', '/api/line/config');
  check('GET /api/line/config falls back to the repo config (4 stations)', cfg.status === 200 && cfg.json.stations.length === 4);
  // The rest runs against a frozen copy of the v1 process (data folder's own config wins over the repo's), so these
  // tests do not change every time the team edits data/meta/wire-line.json.
  fs.mkdirSync(path.join(DATA, 'meta'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'fixtures', 'wire-line-v1.json'), path.join(DATA, 'meta', 'wire-line.json'));
  const own = await req('GET', '/api/line/config');
  check('a wire-line.json in the data folder wins over the repo config', own.status === 200 && own.json.draft === 'v1' && own.json.stations[1].substeps[1].id === 's2_get_splice', own.text.slice(0, 120));
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
  const ref = { anchor: 'work', classes: { cutter: { x: 0.5, y: 0.4, w: 0.3, h: 0.1, landscape: true } }, frames: 10, saved: '2026-10-21T12:00:00.000Z' };
  const withRef = await req('PUT', '/api/line/setup', Object.assign({}, setup, { s1: Object.assign({}, setup.s1, { ref }) }), jsonHdr);
  const gotRef = (await req('GET', '/api/line/setup')).json;
  check('setup keeps a station\'s saved correct state (ref) for positionCheck', withRef.status === 200 && gotRef.s1.ref && gotRef.s1.ref.anchor === 'work' && gotRef.s1.ref.classes.cutter.y === 0.4 && gotRef.s1.zones.supply, JSON.stringify(gotRef));
  const badRef = await req('PUT', '/api/line/setup', { s1: { zones: {}, ref: { anchor: 'work', classes: { cutter: { x: 'left' } } } } }, jsonHdr);
  check('a ref with a box that is not numbers is refused', badRef.status === 400, badRef.text);
  const oldRef = await req('PUT', '/api/line/setup', Object.assign({}, setup, { s1: Object.assign({}, setup.s1, { ref: Object.assign({}, ref, { anchor: 'gone' }) }) }), jsonHdr);
  check('a ref on an anchor zone the config no longer has is dropped', oldRef.status === 200 && !oldRef.json.setup.s1.ref, oldRef.text);

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
  const unitsCsv = await req('GET', `/api/sessions/${id}/units.csv`);
  const uLines = unitsCsv.text.trim().split('\n');
  check('units.csv downloads: one row per unit linked by order', unitsCsv.status === 200 && /text\/csv/.test(unitsCsv.headers['content-type']) && /units\.csv/.test(unitsCsv.headers['content-disposition']) && uLines[0].startsWith('session_id,crew,shift,unit,status,s1_basis,') && uLines.length >= 2, unitsCsv.text);
  const jl = await req('GET', `/api/sessions/${id}/events.jsonl`);
  check('events.jsonl downloads', jl.status === 200 && jl.text.trim().split('\n').length === 7);
  const list = await req('GET', '/api/sessions');
  check('GET /api/sessions lists it with its videos', list.status === 200 && list.json.sessions.some(s => s.id === id && s.videos.length === 2));
  const one = await req('GET', `/api/sessions/${id}`);
  check('GET /api/sessions/:id returns the session with an event count', one.status === 200 && one.json.eventCount === 7);
  const clips = await req('GET', '/api/line/clips');
  check('the clip list offers the recorded session videos', clips.status === 200 && clips.json.clips.some(c => c.key === 'session:' + id + ':s1.webm'));

  console.log('mistake alerts (verdicts)');
  const v2 = await req('POST', '/api/sessions', { title: 'Checker', stations: { s2: { input: 'clip', label: 'Run 2' } } }, jsonHdr);
  const vid = v2.json.id, v0 = v2.json.startedAtMs;
  const vEvents = [
    { type: 'session_start', t: v0, source: 'page' },
    { type: 'substep', station: 's2', substep: 's2_pick', move: 'start', source: 'zones', conf: 0.5, t: v0 + 1000, cycle: 1 },
    { type: 'verdict', station: 's2', t: v0 + 1250, cycle: 1, substep: 's2_pick', kind: 'verified', reason: 'progress', message: 'Step 1 verified: Take a wire pair from the in tray', conf: null, step_s: 0.25, cycle_s: null, videoT: 1.25, videoFile: 's2.mp4' },
    { type: 'substep', station: 's2', substep: 's2_insert', from: 's2_pick', move: 'jump', source: 'zones', conf: 0.5, t: v0 + 3000, cycle: 1 },
    { type: 'flag', station: 's2', substep: 's2_get_splice', note: 'skipped Take a splice', source: 'zones', t: v0 + 3000, cycle: 1 },
    { type: 'verdict', station: 's2', t: v0 + 3250, cycle: 1, substep: 's2_get_splice', kind: 'mistake', reason: 'wrong_order', message: 'Wrong order: Push wire A into the splice before Take a splice (step 2 skipped)', conf: null, step_s: null, cycle_s: null, videoT: 3.25, videoFile: 's2.mp4' },
    { type: 'verdict', station: 's2', t: v0 + 5000, cycle: 1, substep: 's2_crimp', kind: 'cleared', reason: 'cleared', message: 'Mistake cleared. Continue with Crimp side A', conf: null, step_s: null, cycle_s: null },
    { type: 'substep', station: 's2', substep: 's2_handoff', from: 's2_insert', move: 'next', source: 'zones', conf: 0.5, t: v0 + 7000, cycle: 1 },
    { type: 'cycle_end', station: 's2', substep: 's2_handoff', source: 'zones', conf: 0.5, t: v0 + 7000, cycle: 1, dur: 6 },
    { type: 'verdict', station: 's2', t: v0 + 7250, cycle: 1, substep: 's2_handoff', kind: 'verified', reason: 'complete', message: 'Cycle complete', conf: null, step_s: 6, cycle_s: 6 }
  ];
  const vPost = await req('POST', `/api/sessions/${vid}/events`, { events: vEvents }, jsonHdr);
  check('verdict events are accepted and appended to events.jsonl', vPost.status === 200 && vPost.json.appended === vEvents.length && fs.readFileSync(path.join(DATA, 'sessions', vid, 'events.jsonl'), 'utf8').includes('"type":"verdict"'), vPost.text);
  const badV = await req('POST', `/api/sessions/${vid}/events`, { events: [{ type: 'verdict', station: 's9', t: v0 + 8000, kind: 'mistake' }] }, jsonHdr);
  check('a verdict for an unknown station is refused', badV.status === 400);
  await req('POST', `/api/sessions/${vid}/end`, {}, jsonHdr);
  const vCsv = await req('GET', `/api/sessions/${vid}/verdicts.csv`);
  const vLines = vCsv.text.trim().split('\n');
  check('verdicts.csv downloads with live_check.py\'s columns plus session, station, ts and video', vCsv.status === 200 && /text\/csv/.test(vCsv.headers['content-type']) && /verdicts\.csv/.test(vCsv.headers['content-disposition']) && vLines[0] === 'session_id,station,time,ts,cycle,step,event,message,confidence,step_seconds,cycle_seconds,video_file,video_t', vLines[0]);
  check('one row per verdict: verified, mistake, cleared, verified', vLines.length === 5 && vLines.slice(1).map(l => l.split(',')[6]).join() === 'verified,mistake,cleared,verified', vCsv.text);
  check('the mistake row has its step number, message and video position', vLines[2] === `${vid},s2,${new Date(v0 + 3250).toISOString().slice(0, 19)}Z,3.25,1,2,mistake,Wrong order: Push wire A into the splice before Take a splice (step 2 skipped),,,,s2.mp4,3.25`, vLines[2]);
  const vCyc = (await req('GET', `/api/sessions/${vid}/cycles.csv`)).text.trim().split('\n'), vHead = vCyc[0].split(','), vRow = vCyc[1].split(',');
  check('cycles.csv counts the cycle\'s mistakes and reviews', vHead.includes('mistakes') && vRow[vHead.indexOf('mistakes')] === '1' && vRow[vHead.indexOf('reviews')] === '0', vCyc.join(' / '));
  const noV = await req('GET', `/api/sessions/${id}/verdicts.csv`);
  check('a session without verdicts gives just the header', noV.status === 200 && noV.text.trim().split('\n').length === 1);

  console.log('floor layouts');
  const lfile = path.join(DATA, 'meta', 'wire-line-layouts.json');
  const L0 = await req('GET', '/api/line/layouts');
  check('GET /api/line/layouts: Class test is built in and active, the L of the config\'s four stations, plus the roles', L0.status === 200 && L0.json.active === 'class-test' && L0.json.layouts.length === 1 && L0.json.layouts[0].builtIn && L0.json.layouts[0].stations.map(s => s.x + ',' + s.y).join(' ') === '0,0 0,560 760,560 1520,560' && L0.json.roles.map(r => r.id).join() === 's1,s2,s3,s4', L0.text.slice(0, 300));
  const six = { name: 'Six stations', stations: [
    { id: 's1', name: 'S1 Cut and strip', role: 's1', x: 0, y: 0 }, { id: 's2', name: 'S2 Crimp side A', role: 's2', x: 0, y: 560 },
    { id: 's3', name: 'S3 Crimp side B', role: 's3', x: 760, y: 560 }, { id: 's4', name: 'S4 QA test', role: 's4', x: 1520, y: 560 },
    { id: 's5', name: 'S5 QA test', role: 's4', x: 2280.4, y: 560 }, { id: 's6', name: 'S6 Crimp side A', role: 's2', x: 760, y: 0 }] };
  const cr = await req('POST', '/api/line/layouts', six, jsonHdr);
  const lid = cr.json && cr.json.layout && cr.json.layout.id;
  check('POST saves a layout with a new id; positions are rounded to floor units', cr.status === 200 && /^l-[a-f0-9]{8}$/.test(lid || '') && cr.json.layout.stations[4].x === 2280, cr.text.slice(0, 300));
  check('saved layouts live in meta/wire-line-layouts.json in the data folder (not the built-in)', fs.existsSync(lfile) && JSON.parse(fs.readFileSync(lfile, 'utf8')).layouts.map(l => l.id).join() === lid);
  const ren = await req('PUT', `/api/line/layouts/${lid}`, Object.assign({}, six, { name: 'Six stations, renamed' }), jsonHdr);
  const L1 = (await req('GET', '/api/line/layouts')).json;
  check('PUT renames it; GET lists the built-in first, then the saved ones, and loads them back', ren.status === 200 && L1.layouts.length === 2 && L1.layouts[0].id === 'class-test' && L1.layouts[1].name === 'Six stations, renamed' && L1.layouts[1].stations.length === 6 && L1.layouts[1].stations[5].id === 's6');
  const bi = [await req('PUT', '/api/line/layouts/class-test', six, jsonHdr), await req('DELETE', '/api/line/layouts/class-test')];
  check('Class test is protected: PUT and DELETE get 409 built_in', bi.every(r => r.status === 409 && r.json.code === 'built_in'), bi.map(r => r.status).join());
  const st0 = six.stations[0], badL = [
    { name: 'x', stations: [Object.assign({}, st0, { role: 's9' })] }, { name: 'x', stations: [st0, st0] }, { name: 'x', stations: [Object.assign({}, st0, { id: '../x' })] },
    { name: 'x', stations: [Object.assign({}, st0, { name: '  ' })] }, { name: ' ', stations: [] }, { name: 'x', stations: [Object.assign({}, st0, { x: 'left' })] }, { name: 'x' }];
  const badR = [];
  for (const b of badL) badR.push((await req('POST', '/api/line/layouts', b, jsonHdr)).status);
  check('a bad layout is refused: an unknown role, a station twice, a bad id, no station name, no layout name, a position that is not a number, no list', badR.every(c => c === 400), badR.join());
  const nf = [await req('PUT', '/api/line/layouts/l-00000000', six, jsonHdr), await req('DELETE', '/api/line/layouts/l-00000000'), await req('POST', '/api/line/layouts/l-00000000/use', {}, jsonHdr)];
  const mal = await req('DELETE', '/api/line/layouts/..%2Fx');
  check('a layout that does not exist gets 404, a malformed id 400', nf.every(r => r.status === 404) && mal.status === 400, nf.map(r => r.status).join() + ',' + mal.status);
  const tmpL = await req('POST', '/api/line/layouts', { name: 'Scratch', stations: [] }, jsonHdr);
  const useT = await req('POST', `/api/line/layouts/${tmpL.json.layout.id}/use`, {}, jsonHdr);
  const delT = await req('DELETE', `/api/line/layouts/${tmpL.json.layout.id}`);
  check('an empty layout can be saved and used; deleting the active one goes back to Class test', tmpL.status === 200 && useT.status === 200 && delT.status === 200 && delT.json.active === 'class-test' && !(await req('GET', '/api/line/layouts')).json.layouts.some(l => l.id === tmpL.json.layout.id));
  const useL = await req('POST', `/api/line/layouts/${lid}/use`, {}, jsonHdr);
  check('use makes a saved layout the active one', useL.status === 200 && (await req('GET', '/api/line/layouts')).json.active === lid);
  await req('POST', '/api/line/layouts/class-test/use', {}, jsonHdr);

  console.log('setup per station and role');
  const s5set = await req('PUT', '/api/line/setup', { s1: setup.s1, 's5:s4': { zones: { bulb: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, supply: { x: 0, y: 0, w: 0.1, h: 0.1 } }, calib: { motion: { bulb: 0.01 }, bright: { bulb: { off: 40, on: 200 } } } } }, jsonHdr);
  const got5 = (await req('GET', '/api/line/setup')).json;
  check('station s5 running role s4 keeps its zones under "s5:s4", with role s4\'s zones only', s5set.status === 200 && got5['s5:s4'] && got5['s5:s4'].zones.bulb.w === 0.1 && !got5['s5:s4'].zones.supply && got5['s5:s4'].calib.bright.bulb.on === 200 && got5.s1.zones.supply, JSON.stringify(got5));
  const badSet = [await req('PUT', '/api/line/setup', { 's5:s9': { zones: {} } }, jsonHdr), await req('PUT', '/api/line/setup', { s5: { zones: {} } }, jsonHdr), await req('PUT', '/api/line/setup', { 's5:s4:x': { zones: {} } }, jsonHdr)];
  check('a setup key with an unknown role, a new station without its role, or a bad key is refused', badSet.every(r => r.status === 400), badSet.map(r => r.status).join());

  console.log('standard setup per role');
  const std0 = await req('GET', '/api/line/standard');
  check('GET /api/line/standard returns the committed file (roles with no zones yet)', std0.status === 200 && std0.json.version === 1 && std0.json.roles && std0.json.roles.s1 && Object.keys(std0.json.roles.s1.zones).length === 0, std0.text.slice(0, 200));
  const stdPut = await req('PUT', '/api/line/standard', { roles: { s1: { zones: { supply: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, ghost: { x: 0, y: 0, w: 0.1, h: 0.1 } }, note: 'trained mount' } } }, jsonHdr);
  const stdGot = (await req('GET', '/api/line/standard')).json;
  check('PUT /api/line/standard saves a role\'s zones; zones the role does not have are dropped', stdPut.status === 200 && stdGot.roles.s1.zones.supply.h === 0.4 && !stdGot.roles.s1.zones.ghost && stdGot.roles.s1.note === 'trained mount', JSON.stringify(stdGot));
  check('the standard is written to meta/wire-line-standard.json in the data folder', fs.existsSync(path.join(DATA, 'meta', 'wire-line-standard.json')));
  const stdAs = await req('PUT', '/api/line/standard', { roles: { s1: { zones: {}, aspect: 0.75, source: 'phone' } } }, jsonHdr);
  const stdAsGot = (await req('GET', '/api/line/standard')).json;
  check('a standard role keeps aspect and source when given', stdAs.status === 200 && stdAsGot.roles.s1.aspect === 0.75 && stdAsGot.roles.s1.source === 'phone', JSON.stringify(stdAsGot.roles.s1));
  const stdAsBad = [
    await req('PUT', '/api/line/standard', { roles: { s1: { zones: {}, aspect: 0 } } }, jsonHdr),
    await req('PUT', '/api/line/standard', { roles: { s1: { zones: {}, aspect: 9 } } }, jsonHdr),
    await req('PUT', '/api/line/standard', { roles: { s1: { zones: {}, aspect: '1.3' } } }, jsonHdr),
    await req('PUT', '/api/line/standard', { roles: { s1: { zones: {}, source: 'drone' } } }, jsonHdr)
  ];
  check('an aspect outside 0.2 to 5, a non-number aspect or an unknown source is refused', stdAsBad.every(r => r.status === 400), stdAsBad.map(r => r.status).join());
  const stdBad = [
    await req('PUT', '/api/line/standard', { roles: { s9: { zones: {} } } }, jsonHdr),
    await req('PUT', '/api/line/standard', { roles: { 's5:s4': { zones: {} } } }, jsonHdr),
    await req('PUT', '/api/line/standard', { roles: { s1: { zones: { supply: { x: 2, y: 0, w: 0.1, h: 0.1 } } } } }, jsonHdr),
    await req('PUT', '/api/line/standard', { roles: { s1: { zones: { supply: { x: 0, y: 0, w: 0, h: 0.1 } } } } }, jsonHdr),
    await req('PUT', '/api/line/standard', { s1: { zones: {} } }, jsonHdr),
    await req('PUT', '/api/line/standard', Buffer.from('not json'), jsonHdr)
  ];
  check('a standard with an unknown role, a station key, a bad rectangle, a zero size or a wrong shape is refused', stdBad.every(r => r.status === 400), stdBad.map(r => r.status).join());
  const stdBig = await req('PUT', '/api/line/standard', { roles: { s1: { zones: {}, note: 'x'.repeat(600 * 1024) } } }, jsonHdr).catch(e => ({ status: 'closed', text: String(e) }));
  check('an oversized standard body is refused (an error or a closed connection)', stdBig.status === 'closed' || stdBig.status >= 400, String(stdBig.status));
  const stdOrigin = await req('PUT', '/api/line/standard', { roles: {} }, Object.assign({ Origin: 'http://evil.example' }, jsonHdr));
  check('PUT /api/line/standard from a foreign origin is refused', stdOrigin.status === 403, String(stdOrigin.status));

  console.log('six stations end to end (s5, s6)');
  const lay6 = (await req('GET', '/api/line/layouts')).json.layouts.find(l => l.id === lid);
  const sLayout = { id: lid, name: lay6.name, builtIn: false, stations: lay6.stations.map(s => Object.assign({}, s, { input: s.id === 's5' ? 'camera' : s.id === 's6' ? 'phone' : 'clip', operator: s.id === 's5' ? { code: 'Op-07', level: 'training' } : null })) };
  const c6 = await req('POST', '/api/sessions', { title: 'Six', layout: sLayout, stations: { s5: { input: 'camera', label: 'FaceTime HD Camera', record: true }, s6: { input: 'phone', label: 'Phone', record: true } } }, jsonHdr);
  const sid6 = c6.json && c6.json.id, d6 = path.join(DATA, 'sessions', sid6 || 'x'), sj6 = () => JSON.parse(fs.readFileSync(path.join(d6, 'session.json'), 'utf8'));
  check('a session takes stations s5 and s6 from its layout', c6.status === 200 && sj6().stations.s5.input === 'camera' && sj6().stations.s6.input === 'phone', c6.text);
  const lj = sj6().layout || {};
  check('session.json records the layout at the start: per station id, name, role, x, y, order, input and operator', lj.id === lid && lj.name === 'Six stations, renamed' && lj.builtIn === false && lj.stations.length === 6 &&
    JSON.stringify(lj.stations[4]) === JSON.stringify({ id: 's5', name: 'S5 QA test', role: 's4', x: 2280, y: 560, order: 5, input: 'camera', operator: { code: 'Op-07', level: 'training' } }) && lj.stations[0].operator === null, JSON.stringify(lj).slice(0, 400));
  check('session.json keeps the config as written (4 roles) and the current operator per station', sj6().config.stations.length === 4 && sj6().operators.s5.code === 'Op-07' && sj6().operators.s5.level === 'training');
  const noSt = await req('POST', '/api/sessions', { layout: sLayout, stations: { s7: { input: 'clip' } } }, jsonHdr);
  const named = await req('POST', '/api/sessions', { layout: Object.assign({}, sLayout, { stations: [Object.assign({}, sLayout.stations[0], { operator: { code: 'Michael', level: 'new' } })] }) }, jsonHdr);
  check('at the start, a station not in the layout or an operator with a name is refused', noSt.status === 400 && named.status === 400, noSt.status + ',' + named.status);
  const t6 = c6.json.startedAtMs;
  const ev6 = [
    { type: 'session_start', t: t6, source: 'page' },
    { type: 'operator', station: 's5', code: 'Op-07', level: 'training', t: t6 },
    { type: 'substep', station: 's5', substep: 's4_pick', move: 'start', source: 'zones', conf: 0.5, t: t6 + 1000, cycle: 1, videoT: 0.8, videoFile: 's5.webm' },
    { type: 'substep', station: 's5', substep: 's4_sort', move: 'next', source: 'zones', conf: 0.5, t: t6 + 7000, cycle: 1, videoT: 6.8, videoFile: 's5.webm' },
    { type: 'cycle_end', station: 's5', substep: 's4_sort', source: 'zones', conf: 0.5, t: t6 + 7000, cycle: 1, dur: 6 },
    { type: 'qa_result', station: 's5', cycle: 1, t: t6 + 7000, result: 'pass', reason: null, light: true, bin: 'pass', source: 'zones' },
    { type: 'substep', station: 's6', substep: 's2_pick', move: 'start', source: 'zones', conf: 0.5, t: t6 + 2000, cycle: 1 },
    { type: 'substep', station: 's6', substep: 's2_handoff', move: 'next', source: 'zones', conf: 0.5, t: t6 + 9000, cycle: 1 },
    { type: 'cycle_end', station: 's6', substep: 's2_handoff', source: 'zones', conf: 0.5, t: t6 + 9000, cycle: 1, dur: 7 },
    { type: 'operator', station: 's6', code: 'Op-11', level: 'certified', t: t6 + 9500, name: 'should not be kept' },
    { type: 'operator', station: 's5', code: null, level: null, t: t6 + 9600 }
  ];
  const p6 = await req('POST', `/api/sessions/${sid6}/events`, { events: ev6 }, jsonHdr);
  check('events for s5 and s6, operator events included, are accepted', p6.status === 200 && p6.json.appended === ev6.length, p6.text);
  const opLine = fs.readFileSync(path.join(d6, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.type === 'operator' && e.station === 's6');
  check('an operator event keeps only station, code and level (an extra field about the person is dropped)', opLine && opLine.code === 'Op-11' && opLine.level === 'certified' && !('name' in opLine), JSON.stringify(opLine));
  const badOps = [
    { type: 'operator', station: 's5', code: 'Michael', level: 'new', t: t6 + 9700 }, { type: 'operator', station: 's5', code: 'Op-07', level: 'expert', t: t6 + 9700 },
    { type: 'operator', code: 'Op-07', level: 'new', t: t6 + 9700 }, { type: 'substep', station: 's7', substep: 's2_pick', t: t6 + 9700 }];
  const badOpR = [];
  for (const e of badOps) badOpR.push((await req('POST', `/api/sessions/${sid6}/events`, { events: [e] }, jsonHdr)).status);
  check('refused: an operator with a name, a level that does not exist, no station; an event for a station not in the layout', badOpR.every(c => c === 400), badOpR.join());
  const v5 = await req('POST', `/api/sessions/${sid6}/video/s5?seq=0&t0=${t6 + 200}`, A, vh), v7 = await req('POST', `/api/sessions/${sid6}/video/s7?seq=0`, A, vh);
  check('Rec: s5 records into s5.webm; a station not in the layout gets 400', v5.status === 200 && fs.existsSync(path.join(d6, 's5.webm')) && v7.status === 400 && !fs.existsSync(path.join(d6, 's7.webm')), v5.status + ',' + v7.status);
  const clips6 = (await req('GET', '/api/line/clips')).json.clips.filter(c => c.key.startsWith('session:' + sid6 + ':'));
  check('a clip list entry carries the role its session layout gave that station (s5 ran s4); a session with no layout has none', clips6.length === 1 && clips6[0].key.endsWith(':s5.webm') && clips6[0].role === 's4' && clips.json.clips.filter(c => c.key.startsWith('session:' + id + ':')).every(c => c.role === null), JSON.stringify(clips6));
  const end6 = await req('POST', `/api/sessions/${sid6}/end`, {}, jsonHdr);
  const sum6 = end6.json.summary;
  check('the summary covers the layout\'s stations: s5 is a QA station, so its unit counts', sum6 && sum6.stations.s5 && sum6.stations.s6 && sum6.stations.s5.cycles === 1 && sum6.line.units === 1 && sum6.line.passed === 1, JSON.stringify(sum6 && sum6.line).slice(0, 300));
  check('after the operator events, session.json says s6 is Op-11 (certified) and s5 has nobody', sj6().operators.s6.code === 'Op-11' && sj6().operators.s6.level === 'certified' && sj6().operators.s5 === null, JSON.stringify(sj6().operators));
  const sc6 = (await req('GET', `/api/sessions/${sid6}/substeps.csv`)).text.trim().split('\n'), cc6 = (await req('GET', `/api/sessions/${sid6}/cycles.csv`)).text.trim().split('\n');
  check('substeps.csv carries s5 and s6 with their role\'s substep labels and the video position', sc6.some(l => l.startsWith(sid6 + ',,,s5,1,1,s4_pick,Take unit from the in tray,start,zones,1,') && l.endsWith(',s5.webm,0.8')) && sc6.some(l => l.includes(',s6,1,2,s2_handoff,Pass to station 3,')), sc6.join(' / '));
  check('cycles.csv has an s5 QA row (pass) and an s6 row', cc6.some(l => l.includes(',s5,detected,1,zones,') && l.includes(',pass,')) && cc6.some(l => l.includes(',s6,detected,1,zones,2,9,7,')), cc6.join(' / '));
  check('a session from before the canvas (no layout) still exports as before', !sj().layout && (await req('GET', `/api/sessions/${id}/cycles.csv`)).text.trim().split('\n').length === 4);

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

  console.log('phone cameras: certificate');
  const info = (await req('GET', '/api/phone/info')).json;
  const CD = path.join(DATA, 'phone-cert'), OSSL = findOpenssl();
  if (!info.on) {
    console.log('  skip  the iPhone listener is off here (' + info.error + '): no openssl?');
  } else {
    const caPem = fs.readFileSync(path.join(CD, 'ca.crt')), ca = new crypto.X509Certificate(caPem), leaf = new crypto.X509Certificate(fs.readFileSync(path.join(CD, 'server.crt')));
    check('the certificate files and the pairing secret are in <data>/phone-cert', ['ca.crt', 'ca.key', 'server.crt', 'server.key', 'pairing-secret'].every(n => fs.existsSync(path.join(CD, n))));
    if (process.platform !== 'win32') check('ca.key, server.key and the secret are readable by this user only', ['ca.key', 'server.key', 'pairing-secret'].every(n => (fs.statSync(path.join(CD, n)).mode & 0o077) === 0));
    const days = (new Date(leaf.validTo) - new Date(leaf.validFrom)) / 86400000;
    check('the server certificate follows Apple\'s rules: signed by the CA, serverAuth, at most 397 days', ca.ca && !leaf.ca && leaf.verify(ca.publicKey) && (leaf.keyUsage || []).includes('1.3.6.1.5.5.7.3.1') && days <= 397, days + ' days');
    const lan = lanAddresses(), inside = lan.filter(a => ipAllowed(a.address)), outside = lan.filter(a => !ipAllowed(a.address));
    check('it names localhost, the .local name, 127.0.0.1, ::1 and every private LAN address', leaf.checkHost('localhost') && localNames().every(n => leaf.checkHost(n)) && leaf.checkIP('127.0.0.1') && leaf.checkIP('::1') && inside.every(a => leaf.checkIP(a.address)), leaf.subjectAltName);
    check('it leaves out public addresses (the CA may not vouch for them, and one would break the whole certificate)', outside.every(a => !leaf.checkIP(a.address)) && !/IP Address:(?!127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0:0:0:0:0:0:0:1\b|f[cd])/i.test(leaf.subjectAltName), leaf.subjectAltName);
    if (OSSL) {
      const nc = spawnSync(OSSL, ['x509', '-in', path.join(CD, 'ca.crt'), '-noout', '-ext', 'nameConstraints'], { encoding: 'utf8' }).stdout || '';
      check('the CA has critical name constraints: .local, localhost, loopback and private addresses only', /critical/.test(nc) && ['DNS:.local', 'DNS:localhost', 'IP:127.0.0.0/255.0.0.0', 'IP:10.0.0.0/255.0.0.0', 'IP:172.16.0.0/255.240.0.0', 'IP:192.168.0.0/255.255.0.0', 'IP:0:0:0:0:0:0:0:1/FFFF', 'IP:FC00:0:0:0:0:0:0:0/FE00'].every(x => nc.includes(x)), nc);
      // A certificate for a real website, signed with this laptop's CA key: anyone holding ca.key could make one. It must fail.
      const T = fs.mkdtempSync(path.join(os.tmpdir(), 'line-foreign-')), tf = n => path.join(T, n);
      fs.writeFileSync(tf('f.cnf'), '[req]\nprompt = no\ndistinguished_name = dn\n[dn]\nCN = www.google.com\n[e]\nbasicConstraints = critical, CA:FALSE\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:www.google.com\n');
      spawnSync(OSSL, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', tf('f.key'), '-config', tf('f.cnf'), '-out', tf('f.csr')]);
      spawnSync(OSSL, ['x509', '-req', '-in', tf('f.csr'), '-CA', path.join(CD, 'ca.crt'), '-CAkey', path.join(CD, 'ca.key'), '-set_serial', '0x4242', '-sha256', '-days', '30', '-extfile', tf('f.cnf'), '-extensions', 'e', '-out', tf('f.crt')]);
      const vf = spawnSync(OSSL, ['verify', '-CAfile', path.join(CD, 'ca.crt'), tf('f.crt')], { encoding: 'utf8' }), vo = spawnSync(OSSL, ['verify', '-CAfile', path.join(CD, 'ca.crt'), path.join(CD, 'server.crt')], { encoding: 'utf8' });
      check('a www.google.com certificate signed with the CA key is refused (permitted subtree violation); ours passes', fs.existsSync(tf('f.crt')) && vf.status !== 0 && /subtree/.test(vf.stdout + vf.stderr) && vo.status === 0, vf.stdout + vf.stderr + vo.stderr);
      if (process.platform === 'darwin') {
        const sv = (c, h) => spawnSync('/usr/bin/security', ['verify-cert', '-c', c, '-r', path.join(CD, 'ca.crt'), '-p', 'ssl', '-s', h, '-L', '-q'], { encoding: 'utf8' }).status === 0;
        check('Apple\'s trust check (security verify-cert -p ssl) takes ours for the .local name and refuses the foreign one', sv(path.join(CD, 'server.crt'), localNames()[0] || 'localhost') && sv(path.join(CD, 'server.crt'), 'localhost') && !sv(tf('f.crt'), 'www.google.com') && !sv(path.join(CD, 'server.crt'), 'www.google.com'));
      }
      fs.rmSync(T, { recursive: true, force: true });
      // An older CA without the constraints (what the first version made) is replaced, and the server certificate with it.
      const O = fs.mkdtempSync(path.join(os.tmpdir(), 'line-oldca-')), of = n => path.join(O, n);
      fs.writeFileSync(of('ca.cnf'), '[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = v\n[dn]\nCN = old\n[v]\nbasicConstraints = critical, CA:TRUE\nkeyUsage = critical, keyCertSign\n');
      spawnSync(OSSL, ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', of('ca.key'), '-config', of('ca.cnf'), '-days', '3650', '-out', of('ca.crt')]);
      const oldFp = new crypto.X509Certificate(fs.readFileSync(of('ca.crt'))).fingerprint256;
      const m1 = ensurePhoneCert(O, { names: ['test-mac.local'], ips: ['192.168.1.20'] });
      check('an existing CA without name constraints is replaced (created), with a new server certificate', m1.created && m1.reissued && m1.caFingerprint !== oldFp);
      const m2 = ensurePhoneCert(O, { names: ['test-mac.local'], ips: ['192.168.1.20', '10.1.2.3'] });
      const m3 = ensurePhoneCert(O, { names: ['test-mac.local'], ips: ['192.168.1.20', '10.1.2.3', '2607:fb90::5', '8.8.8.8'] });
      const l3 = new crypto.X509Certificate(m3.cert);
      check('a new private address reissues the server certificate with the same CA; public ones are left out and change nothing', !m2.created && m2.reissued && m2.caFingerprint === m1.caFingerprint && !m3.reissued && m3.outside.join() === '2607:fb90::5,8.8.8.8' && l3.checkIP('10.1.2.3') && !l3.checkIP('8.8.8.8'), JSON.stringify(m3.outside));
      fs.rmSync(O, { recursive: true, force: true });
    } else console.log('  skip  openssl checks (no openssl found)');

    // HTTPS with this laptop's CA as the only trust anchor. host: the address to connect to; name: the name to check.
    const sreq = (method, p, body, o) => new Promise((resolve, reject) => {
      const x = o || {}, buf = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const ro = { host: x.host || '127.0.0.1', port: PHONE_PORT, method, path: p, ca: caPem, timeout: 5000, headers: Object.assign(buf ? { 'Content-Type': 'application/json', 'Content-Length': buf.length } : {}, x.headers || {}) };
      if (x.name) { ro.checkServerIdentity = (h, c) => tls.checkServerIdentity(x.name, c); if (!net.isIP(x.name)) ro.servername = x.name; }
      const r = https.request(ro, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => { const raw = Buffer.concat(chunks), t = raw.toString('utf8'); let json = null; try { json = JSON.parse(t); } catch (e) { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, text: t, json, raw }); });
      });
      r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
      if (buf) r.write(buf);
      r.end();
    });
    const caGet = await sreq('GET', '/ca.crt');
    check('TLS checks out against the CA alone, and /ca.crt is the CA (DER) for the phone to install', caGet.status === 200 && /x509-ca-cert/.test(caGet.headers['content-type']) && caGet.raw.equals(ca.raw));
    if (localNames()[0]) check('the certificate is good for the .local name', (await sreq('GET', '/ca.crt', null, { name: localNames()[0] })).status === 200);
    for (const a of lan.slice(0, 2)) {
      const g = await sreq('GET', '/ca.crt', null, { host: a.address, name: ipAllowed(a.address) ? a.address : localNames()[0] }).catch(e => ({ status: String(e.code || e.message) }));
      check('the phone listener answers on the LAN address ' + a.address + ' (' + a.kind + ')', g.status === 200, g.status);
      const plain = await new Promise(res => { const c = net.connect({ host: a.address, port: PORT, timeout: 2000 }, () => { c.destroy(); res('connected'); }); c.on('error', e => res(e.code)); c.on('timeout', () => { c.destroy(); res('timeout'); }); });
      check('the data server (HTTP ' + PORT + ') is not reachable on ' + a.address, plain !== 'connected', plain);
    }

    console.log('phone cameras: per-station keys');
    const keys = info.keys || {}, ids = ['s1', 's2', 's3', 's4'];
    check('/api/phone/info gives each station its own 16-character key, and no shared token', ids.every(id => /^[A-Za-z0-9_-]{16}$/.test(keys[id] || '')) && new Set(ids.map(id => keys[id])).size === 4 && info.token === undefined && info.hosts.length >= 1, JSON.stringify(info));
    const pg = await sreq('GET', `/phone?s=s1&k=${keys.s1}`);
    check('the phone page opens with its station\'s key, with a strict CSP', pg.status === 200 && /Wire line camera/.test(pg.text) && /default-src 'none'/.test(pg.headers['content-security-policy'] || ''));
    const wrong = [await sreq('GET', `/phone?s=s2&k=${keys.s1}`), await sreq('GET', `/phone/hello?s=s2&k=${keys.s1}`), await sreq('GET', `/phone/poll?s=s2&k=${keys.s1}&id=x&c=y`),
      await sreq('POST', `/phone/offer?s=s2&k=${keys.s1}`, { client: 'attacker01', sdp: 'v=0\r\n' }), await sreq('GET', `/phone/hello?s=s9&k=${keys.s1}`), await sreq('GET', '/phone/hello?s=s1'), await sreq('GET', '/phone?s=s1')];
    check('S1\'s key does not open S2 (page, hello, poll, offer), an unknown station or a missing key: all 403', wrong.every(r => r.status === 403), wrong.map(r => r.status).join());
    const hello = await sreq('GET', `/phone/hello?s=s2&k=${keys.s2}`);
    check('S2\'s own key works and says no /line page is open', hello.status === 200 && hello.json.station === 's2' && hello.json.laptop === 'closed', hello.text);
    const iso = [];
    for (const p of ['/line', '/api/line/config', '/api/sessions', '/api/db/runs', '/_blob/' + 'a'.repeat(32), '/api/phone/info', '/line-engine.js', '/vendor/qrcode.js', '/models/lego-parts.onnx', '/local-runtime.js', '/live', '/runs'])
      iso.push((await sreq('GET', p + `?s=s1&k=${keys.s1}`)).status);
    iso.push((await sreq('POST', '/api/phone/rotate', { client: 'abcdefgh12' })).status, (await sreq('POST', '/api/sessions', { title: 'x' })).status);
    check('the phone port serves nothing else, even with a key: the app, data, sessions, models and /line\'s signaling all 404', iso.every(c => c === 404), iso.join());

    console.log('phone cameras: signaling');
    const A = 'laptopAAAA1', B = 'laptopBBBB2', P1 = 'phone11111', P2 = 'phone22222', SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
    const lpoll = (client, want) => req('POST', '/api/phone/poll', { client, want }, jsonHdr);
    const pp = (id, c) => sreq('GET', `/phone/poll?s=s1&k=${keys.s1}&id=${id}&c=${c}`);
    let a1 = await lpoll(A, ['s1', 's9']);
    check('/line says which stations want a phone (unknown ones ignored); none has one yet', a1.status === 200 && a1.json.phones.s1.state === 'none' && !a1.json.phones.s9 && !a1.json.offers.length, a1.text);
    const badOffer = await sreq('POST', `/phone/offer?s=s1&k=${keys.s1}`, { client: P1, sdp: 'not sdp' });
    const o1 = await sreq('POST', `/phone/offer?s=s1&k=${keys.s1}`, { client: P1, sdp: SDP, camera: 'Back Camera', settings: { width: 640, height: 480, frameRate: 15 } });
    check('an offer that is not a session description is refused; a good one is taken and the phone hears /line is open', badOffer.status === 400 && o1.status === 200 && /^[a-f0-9]{16}$/.test(o1.json.id) && o1.json.laptop === 'open', o1.text);
    a1 = await lpoll(A, ['s1']);
    const off = a1.json.offers[0];
    check('/line gets the offer with the camera name and size', a1.json.offers.length === 1 && off.station === 's1' && off.id === o1.json.id && off.sdp === SDP && off.camera === 'Back Camera' && off.settings.width === 640, a1.text);
    let p1 = await pp(o1.json.id, P1);
    check('the phone waits for the answer', p1.json.state === 'waiting' && p1.json.answer === null && p1.json.laptop === 'open', p1.text);
    const ansWrong = await req('POST', '/api/phone/answer', { client: A, station: 's1', id: 'ffffffffffffffff', sdp: SDP }, jsonHdr);
    const ans = await req('POST', '/api/phone/answer', { client: A, station: 's1', id: o1.json.id, sdp: SDP + 'a=answer\r\n' }, jsonHdr);
    p1 = await pp(o1.json.id, P1);
    check('an answer for an old offer gets 409; the right one reaches the phone', ansWrong.status === 409 && ans.status === 200 && p1.json.state === 'answered' && p1.json.answer.endsWith('a=answer\r\n'), p1.text);
    const b1 = await lpoll(B, ['s1']);
    const ansB = await req('POST', '/api/phone/answer', { client: B, station: 's1', id: o1.json.id, sdp: SDP }, jsonHdr);
    check('a second /line page sees the phone as busy, gets no offer, and cannot answer it (409)', b1.json.phones.s1.busy === true && !b1.json.offers.length && ansB.status === 409 && ansB.json.code === 'busy', b1.text + ansB.text);
    await req('POST', '/api/phone/bye', { client: B }, jsonHdr);
    const o2 = await sreq('POST', `/phone/offer?s=s1&k=${keys.s1}`, { client: P2, sdp: SDP });
    p1 = await pp(o1.json.id, P1);
    check('another phone on the same station link takes over; the first one hears "replaced"', o2.status === 200 && p1.json.state === 'replaced', p1.text);
    a1 = await lpoll(A, ['s1']);
    await req('POST', '/api/phone/answer', { client: A, station: 's1', id: o2.json.id, sdp: SDP }, jsonHdr);
    await lpoll(A, []);
    let p2 = await pp(o2.json.id, P2);
    check('when /line picks another source the phone hears "dropped" and "not picked" (it sends a new offer)', p2.json.state === 'dropped' && p2.json.laptop === 'not_picked', p2.text);
    const o3 = await sreq('POST', `/phone/offer?s=s1&k=${keys.s1}`, { client: P2, sdp: SDP });
    await lpoll(A, ['s1']);
    await req('POST', '/api/phone/drop', { client: A, station: 's1', id: o3.json.id }, jsonHdr);
    p2 = await pp(o3.json.id, P2);
    check('/line can drop a connection that did not start; the phone hears "dropped"', p2.json.state === 'dropped', p2.text);
    await req('POST', '/api/phone/bye', { client: A }, jsonHdr);
    p2 = await pp(o3.json.id, P2);
    check('after /line says goodbye (a reload or a closed tab) the phone hears no /line page is open', p2.json.laptop === 'closed', p2.text);
    const fh = await req('GET', '/api/phone/info', null, { Host: 'evil.example:' + PORT });
    const fo = await req('POST', '/api/phone/poll', { client: A, want: ['s1'] }, Object.assign({ Origin: 'http://evil.example' }, jsonHdr));
    const fr = await req('POST', '/api/phone/rotate', { client: A }, Object.assign({ Origin: 'http://evil.example' }, jsonHdr));
    check('/api/phone/* refuses a foreign Host or Origin (403)', fh.status === 403 && fo.status === 403 && fr.status === 403);
    const ps = await req('POST', '/api/sessions', { title: 'phones', stations: { s1: { input: 'phone', label: 'iPhone', record: true } } }, jsonHdr);
    check('a session keeps "phone" as a station\'s input', ps.status === 200 && JSON.parse(fs.readFileSync(path.join(DATA, 'sessions', ps.json.id, 'session.json'), 'utf8')).stations.s1.input === 'phone');

    console.log('phones on a floor layout');
    await req('POST', `/api/line/layouts/${lid}/use`, {}, jsonHdr);
    const i6 = (await req('GET', '/api/phone/info')).json;
    check('/api/phone/info gives a key to each station of the active layout, s5 and s6 included', Object.keys(i6.keys).sort().join() === 's1,s2,s3,s4,s5,s6' && /^[A-Za-z0-9_-]{16}$/.test(i6.keys.s5) && i6.keys.s1 === keys.s1, JSON.stringify(i6.keys));
    const h5 = await sreq('GET', `/phone/hello?s=s5&k=${i6.keys.s5}`), pg5 = await sreq('GET', `/phone?s=s5&k=${i6.keys.s5}`);
    check('the phone link for s5 opens the phone page, which names the station and its role', pg5.status === 200 && h5.status === 200 && h5.json.station === 's5' && h5.json.label === 'QA test' && h5.json.role === 'QA test', h5.text);
    const no3 = await req('POST', '/api/line/layouts', { name: 'No S3', stations: six.stations.filter(x => x.id !== 's3') }, jsonHdr);
    await req('POST', `/api/line/layouts/${no3.json.layout.id}/use`, {}, jsonHdr);
    const secret = fs.readFileSync(path.join(CD, 'pairing-secret'), 'utf8').trim(), hkey = sid => crypto.createHmac('sha256', secret).update(sid).digest('base64url').slice(0, 16);
    const offL = [await sreq('GET', `/phone/hello?s=s3&k=${keys.s3}`), await sreq('GET', `/phone?s=s3&k=${keys.s3}`), await sreq('POST', `/phone/offer?s=s3&k=${keys.s3}`, { client: P1, sdp: SDP }), await sreq('GET', `/phone/hello?s=s9&k=${hkey('s9')}`)];
    const k3 = (await req('GET', '/api/phone/info')).json.keys, pl3 = await lpoll(A, ['s3', 's5']);
    check('a station not on the active layout is refused even with its correct key (s3 removed, s9 never there)', hkey('s3') === keys.s3 && offL.every(r => r.status === 403) && !k3.s3 && k3.s5, offL.map(r => r.status).join());
    check('/line\'s signaling ignores a station not on the layout', pl3.status === 200 && !pl3.json.phones.s3 && pl3.json.phones.s5, pl3.text);
    await req('POST', '/api/phone/bye', { client: A }, jsonHdr);
    await req('POST', '/api/line/layouts/class-test/use', {}, jsonHdr);

    console.log('phone cameras: pairing code');
    const secret0 = fs.readFileSync(path.join(CD, 'pairing-secret'), 'utf8');
    const rot = await req('POST', '/api/phone/rotate', { client: A }, jsonHdr);
    const keys2 = (await req('GET', '/api/phone/info')).json.keys;
    const oldK = await sreq('GET', `/phone/hello?s=s1&k=${keys.s1}`), newK = await sreq('GET', `/phone/hello?s=s1&k=${keys2.s1}`);
    check('New pairing code changes every station\'s key and the saved secret; old links get 403, new ones work', rot.status === 200 && ids.every(id => keys2[id] !== keys[id]) && fs.readFileSync(path.join(CD, 'pairing-secret'), 'utf8') !== secret0 && oldK.status === 403 && newK.status === 200);
    const ppOld = await sreq('GET', `/phone/poll?s=s1&k=${keys2.s1}&id=${o3.json.id}&c=${P2}`);
    check('it also forgets the offers waiting from before', ppOld.json.state === 'unknown', ppOld.text);
    await stopServer();
    startServer();
    check('the server starts again with the same data folder', await ready(), log);
    const keys3 = (await req('GET', '/api/phone/info')).json.keys;
    check('the keys survive a restart (phones do not need to scan again), and the certificate is not remade', ids.every(id => keys3[id] === keys2[id]) && !/new local CA|new certificate/.test(log), log);
  }

} catch (e) {
  fails++;
  console.log('  FAIL  ' + (e && e.stack || e));
} finally {
  await stopServer();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* temp folder */ }
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
