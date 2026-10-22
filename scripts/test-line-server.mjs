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
    if (/localhost:\d+/.test(log) && /iPhone cameras:/.test(log)) return true;
    if (server.exitCode != null) return false;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
startServer();

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

  console.log('iPhone cameras: certificate');
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

    console.log('iPhone cameras: per-station keys');
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
    for (const p of ['/line', '/api/line/config', '/api/sessions', '/api/db/runs', '/_blob/' + 'a'.repeat(32), '/api/phone/info', '/line-engine.js', '/vendor/qrcode.js', '/models/lego-parts.onnx', '/local-runtime.js', '/live'])
      iso.push((await sreq('GET', p + `?s=s1&k=${keys.s1}`)).status);
    iso.push((await sreq('POST', '/api/phone/rotate', { client: 'abcdefgh12' })).status, (await sreq('POST', '/api/sessions', { title: 'x' })).status);
    check('the phone port serves nothing else, even with a key: the app, data, sessions, models and /line\'s signaling all 404', iso.every(c => c === 404), iso.join());

    console.log('iPhone cameras: signaling');
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

    console.log('iPhone cameras: pairing code');
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
