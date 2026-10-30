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
  console.log('single run export');
  const review = (id, o) => req('POST', `/api/sessions/${id}/review`, o, jsonHdr);
  const post = (id, o) => req('POST', `/api/sessions/${id}/captures`, capBody(o), jsonHdr);
  // A finished session with events, two stations of captures (s2, s3) and reviews: the fixture for the export and the pool.
  const makeRun = async (title, withReviews) => {
    const c = await req('POST', '/api/sessions', { title, crew: 'Group B', shift: 'Morning', stations: { s2: { input: 'clip', record: true }, s3: { input: 'clip' } } }, jsonHdr);
    const id = c.json.id, t0 = c.json.startedAtMs;
    await req('POST', `/api/sessions/${id}/events`, { events: [
      { type: 'session_start', t: t0, ts: 0, source: 'page' },
      { type: 'substep', station: 's2', substep: 's2_open', move: 'start', source: 'zones', conf: 0.4, t: t0 + 1000, cycle: 1, videoT: 1 },
      { type: 'cycle_end', station: 's2', substep: 's2_close', source: 'zones', conf: 0.6, t: t0 + 9000, cycle: 1, dur: 8, videoT: 9 },
      { type: 'manual', station: 's3', action: 'fail', reason: 'pulled_c2', source: 'manual', t: t0 + 12000 }
    ] }, jsonHdr);
    const a = (await post(id, { boxes: [box('connector_open', [0.1, 0.2, 0.5, 0.8]), box('red_wire', [0.5, 0.5, 0.9, 0.9])] })).json.id;
    const b = (await post(id, { reason: 'unsure', boxes: [box('connector_closed', [0.2, 0.2, 0.6, 0.6])], image: url(jpegBuf(300, 9)) })).json.id;
    const c3 = (await post(id, { reason: 'sample', boxes: [], image: url(jpegBuf(300, 3)) })).json.id;
    const d = (await post(id, { station: 's3', role: 's3', videoFile: 's3.webm', boxes: [box('black_wire', [0.1, 0.1, 0.4, 0.4])], image: url(jpegBuf(300, 5)) })).json.id;
    const e = (await post(id, { reason: 'manual', boxes: [box('connector_open', [0.3, 0.3, 0.7, 0.7])], image: url(jpegBuf(300, 6)) })).json.id;
    if (withReviews) {
      await review(id, { captureId: a, verdict: 'confirmed' });
      await review(id, { captureId: b, verdict: 'corrected', boxes: [{ cls: 'connector_open', nbox: [0.2, 0.2, 0.6, 0.6] }], note: 'it was open' });
      await review(id, { captureId: c3, verdict: 'rejected' });
      await review(id, { captureId: d, verdict: 'confirmed' });
      await review(id, { captureId: e, verdict: 'unsure' });
    }
    await req('POST', `/api/sessions/${id}/end`, {}, jsonHdr);
    return { id, a, b, c3, d, e };
  };
  const RUN = await makeRun('Export run', true);
  {
    const ex = await req('GET', `/api/sessions/${RUN.id}/export.zip`);
    check('export.zip is a zip with a download name', ex.status === 200 && ex.headers['content-type'] === 'application/zip' && new RegExp(RUN.id + '-run\\.zip').test(ex.headers['content-disposition']), ex.status + ' ' + ex.text.slice(0, 100));
    const z = readZip(ex.raw), names = z.files.map(f => f.name), get = n => z.files.find(f => f.name === n).data;
    check('the zip has run.json, the four CSVs and every capture JPEG, and no video by default', ['run.json', 'substeps.csv', 'cycles.csv', 'verdicts.csv', 'units.csv'].every(n => names.includes(n)) && [RUN.a, RUN.b, RUN.c3, RUN.d, RUN.e].every(i => names.includes('captures/' + i + '.jpg')) && !names.some(n => n.startsWith('video/')), names.join());
    const run = JSON.parse(get('run.json'));
    check('run.json holds the session, config snapshot, summary, events, cycles, verdicts, units and substeps', run.version === 1 && run.sessionId === RUN.id && run.session.crew === 'Group B' && run.session.title === 'Export run' && !('config' in run.session) && run.config.stations.length >= 4 && run.events.length === 4 && Array.isArray(run.cycles) && Array.isArray(run.verdicts) && Array.isArray(run.units) && Array.isArray(run.substeps) && run.summary && typeof run.summary === 'object', Object.keys(run).join());
    check('cycles in run.json are the parsed cycles.csv rows', run.cycles.length >= 1 && run.cycles[0].station === 's2' && Number(run.cycles[0].cycle_s) > 0, JSON.stringify(run.cycles[0]));
    const cp = run.captures;
    check('captures in run.json carry their latest review (verdict, boxes, note) and their image path', cp.length === 5 && cp.find(c => c.id === RUN.a).review.verdict === 'confirmed' && cp.find(c => c.id === RUN.b).review.note === 'it was open' && cp.find(c => c.id === RUN.b).review.boxes[0].cls === 'connector_open' && cp.find(c => c.id === RUN.c3).review.verdict === 'rejected' && cp[0].image === 'captures/' + RUN.a + '.jpg');
    check('zipped CSVs match the CSV routes and the JPEGs are the stored bytes', get('cycles.csv').toString() === (await req('GET', `/api/sessions/${RUN.id}/cycles.csv`)).text && get('captures/' + RUN.a + '.jpg').equals(jpegBuf(300)) && z.files.every(f => f.method === 0));
    const nov = await req('GET', `/api/sessions/${RUN.id}/export.zip?video=0`);
    check('?video=0 is the same as no video', readZip(nov.raw).files.every(f => !f.name.startsWith('video/')));
    check('an unknown session is 404 and a foreign Host is 403', (await req('GET', '/api/sessions/20261015-120000-abcd/export.zip')).status === 404 && (await req('GET', `/api/sessions/${RUN.id}/export.zip`, null, { Host: 'evil.example:' + PORT })).status === 403);
    if (hasFfmpeg && fs.existsSync(path.join(TMP, 'src.mp4'))) {
      const SVid = await mk({ s2: { input: 'clip', record: true } }, 'with video');
      const mp4 = fs.readFileSync(path.join(TMP, 'src.mp4'));
      await req('POST', `/api/sessions/${SVid}/video/s2?seq=0`, mp4, { 'Content-Type': 'video/mp4' });
      const wv = readZip((await req('GET', `/api/sessions/${SVid}/export.zip?video=1`)).raw), vf = wv.files.find(f => f.name === 'video/s2.mp4');
      const wo = readZip((await req('GET', `/api/sessions/${SVid}/export.zip`)).raw);
      check('?video=1 adds the recordings under video/, byte for byte; without it they are left out', vf && vf.data.equals(mp4) && !wo.files.some(f => f.name.startsWith('video/')));
    }

    const dg = await req('GET', `/api/sessions/${RUN.id}/digest.txt`);
    check('digest.txt is plain text, under 6 KB', dg.status === 200 && /^text\/plain/.test(dg.headers['content-type']) && dg.raw.length > 200 && dg.raw.length <= 6000, dg.status + ' ' + dg.raw.length);
    check('the digest names the run, the cycles, the verdicts and the reviews in words', new RegExp('WIRE LINE RUN ' + RUN.id).test(dg.text) && /CYCLES/.test(dg.text) && /s2: 1 cycles/.test(dg.text) && /VERDICTS/.test(dg.text) && /CAPTURES \(5\)/.test(dg.text) && /right 2, fixed 1, wrong 1, not sure 1, not reviewed 0/.test(dg.text) && /note c0002/.test(dg.text), dg.text);
    // A busy run: 120 verdict events and long notes must still fit in 6 KB.
    const BIG = await mk({ s2: { input: 'clip' } }, 'busy run'), t0 = (await req('GET', `/api/sessions/${BIG}`)).json.startedAtMs;
    const evs = [];
    for (let i = 0; i < 300; i++) evs.push({ type: 'verdict', station: 's2', kind: 'mistake', message: 'x'.repeat(200), t: t0 + 1000 + i * 100, cycle: i });
    await req('POST', `/api/sessions/${BIG}/events`, { events: evs }, jsonHdr);
    for (let i = 0; i < 20; i++) { const c = (await post(BIG, { image: url(jpegBuf(300, i + 1)) })).json.id; await review(BIG, { captureId: c, verdict: 'confirmed', note: 'n'.repeat(400) }); }
    const bd = await req('GET', `/api/sessions/${BIG}/digest.txt`);
    check('a busy run still gives a digest of 6 KB or less', bd.status === 200 && bd.raw.length <= 6000 && bd.raw.length > 500, String(bd.raw.length));
    check('the digest of an unknown session is 404', (await req('GET', '/api/sessions/20261015-120000-abcd/digest.txt')).status === 404);
  }

  console.log('shared pool');
  {
    const POOLDIR = path.join(TMP, 'drive', 'pool');
    const setPool = pool => { const c = Object.assign({}, JSON.parse(fs.readFileSync(CFGF, 'utf8'))); if (pool === undefined) delete c.pool; else c.pool = pool; fs.writeFileSync(CFGF, JSON.stringify(c)); };
    const pub = (id, o) => req('POST', `/api/sessions/${id}/pool`, o, jsonHdr);
    const lines = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

    const emptyDef = await req('GET', '/api/pool');
    check('with no pool setting the pool is data/pool and empty', emptyDef.status === 200 && emptyDef.json.dir === path.join(DATA, 'pool') && Object.keys(emptyDef.json.stations).length === 0 && emptyDef.json.contributions.length === 0, emptyDef.text);
    setPool({ dir: POOLDIR });
    check('GET /api/pool reports the configured folder (read from the config on every call)', (await req('GET', '/api/pool')).json.dir === POOLDIR);
    setPool({ dir: 5 });
    check('an invalid pool setting is a clear 500 naming the setting, and publishing refuses too', (await req('GET', '/api/pool')).status === 500 && /pool/.test((await req('GET', '/api/pool')).text) && (await pub(RUN.id, { contributor: 'Ab-01', mode: 'home' })).status === 500);
    setPool({ dir: POOLDIR, extra: 1 });
    check('an unknown pool key is refused too', (await req('GET', '/api/pool')).status === 500);
    setPool({ dir: POOLDIR });

    const bad = async (id, o, st, what) => { const r = await pub(id, o); check('publish refused: ' + what, r.status === st, r.status + ' ' + r.text.slice(0, 120)); };
    await bad(RUN.id, { contributor: 'Michael', mode: 'home' }, 400, 'a name instead of a code');
    await bad(RUN.id, { contributor: 'Ab-01', mode: 'both' }, 400, 'a mode that is not home or group');
    await bad(RUN.id, { contributor: 'Ab-01' }, 400, 'no mode');
    await bad(RUN.id, { contributor: 'Ab-01', mode: 'home', station: '../x' }, 400, 'a bad station');
    await bad('20261015-120000-abcd', { contributor: 'Ab-01', mode: 'home' }, 404, 'an unknown session');
    const forO = await req('POST', `/api/sessions/${RUN.id}/pool`, { contributor: 'Ab-01', mode: 'home' }, Object.assign({ Origin: 'http://evil.example' }, jsonHdr));
    check('publish refused: a foreign Origin', forO.status === 403);
    const NOREV = await makeRun('unreviewed', false);
    await bad(NOREV.id, { contributor: 'Ab-01', mode: 'home' }, 409, 'a session with nothing reviewed');
    check('none of the refusals created anything in the pool', !fs.existsSync(POOLDIR) || fs.readdirSync(POOLDIR).length === 0);

    const p1 = await pub(RUN.id, { contributor: 'Ab-01', mode: 'group' });
    check('publish writes one folder per station that has reviewed frames', p1.status === 200 && p1.json.published.map(x => x.station).sort().join() === 's2,s3', p1.text);
    const F = 'Ab-01-' + RUN.id, f2 = path.join(POOLDIR, 's2', F), f3 = path.join(POOLDIR, 's3', F);
    check('the folder holds captures, captures.jsonl, review.jsonl and session.json', ['captures.jsonl', 'review.jsonl', 'session.json', 'captures'].every(n => fs.existsSync(path.join(f2, n))));
    check('only reviewed frames (not "not sure", not unreviewed) of that station are in it', fs.readdirSync(path.join(f2, 'captures')).sort().join() === [RUN.a, RUN.b, RUN.c3].map(i => i + '.jpg').join() && lines(path.join(f2, 'captures.jsonl')).length === 3 && lines(path.join(f2, 'review.jsonl')).length === 3 && lines(path.join(f3, 'captures.jsonl')).length === 1, fs.readdirSync(path.join(f2, 'captures')).join());
    const sj = JSON.parse(fs.readFileSync(path.join(f2, 'session.json'), 'utf8'));
    check('session.json tags the station, mode and contributor code, and holds no title, crew or notes', sj.station === 's2' && sj.mode === 'group' && sj.contributor === 'Ab-01' && sj.sessionId === RUN.id && sj.classes.join() === shipped.models.s2.classes.join() && !/Export run|Group B|Morning/.test(JSON.stringify(sj)), JSON.stringify(sj));
    check('the copied JPEG is the stored one and the leftover temp folders are gone', fs.readFileSync(path.join(f2, 'captures', RUN.a + '.jpg')).equals(jpegBuf(300)) && !fs.readdirSync(path.join(POOLDIR, 's2')).some(n => n.startsWith('.')));
    {
      const allowCap = ['id', 'role', 'station', 'reason', 't', 'cycle', 'mode', 'contributor', 'boxes', 'model', 'standard'], allowRev = ['captureId', 'verdict', 'boxes', 'reviewedAt'];
      const pc = lines(path.join(f2, 'captures.jsonl')), pr = lines(path.join(f2, 'review.jsonl'));
      const raw = ['captures.jsonl', 'review.jsonl', 'session.json'].map(n => fs.readFileSync(path.join(f2, n), 'utf8')).join('\n');
      check('published captures.jsonl holds only allowlisted fields', pc.length === 3 && pc.every(c => Object.keys(c).every(k => allowCap.includes(k)) && c.contributor === 'Ab-01' && c.mode === 'group'), JSON.stringify(pc[0]));
      check('operator, stationName, claim, substep, videoFile, videoT and zones are absent from the published files', !/"(operator|stationName|claim|substep|videoFile|videoT|zones)":|Open the lever connector|s2\.mp4|Arrange|s2_open/.test(raw), raw.slice(0, 300));
      check('published review.jsonl holds only captureId, verdict, boxes, reviewedAt (no note)', pr.length === 3 && pr.every(r => Object.keys(r).every(k => allowRev.includes(k))) && !/it was open|"note"/.test(raw));
      check('session.json holds only known keys with no free text', Object.keys(sj).every(k => ['version', 'station', 'mode', 'contributor', 'sessionId', 'publishedAt', 'startedAt', 'endedAt', 'classes', 'captures'].includes(k)));
    }
    const before = fs.readFileSync(path.join(f2, 'review.jsonl'), 'utf8');
    await review(RUN.id, { captureId: RUN.a, verdict: 'rejected' });
    const p2 = await pub(RUN.id, { contributor: 'Ab-01', mode: 'group' });
    check('publishing the same session again as the same contributor is refused (409 exists) and changes nothing', p2.status === 409 && p2.json.code === 'exists' && fs.readFileSync(path.join(f2, 'review.jsonl'), 'utf8') === before, p2.text);
    const p3 = await pub(RUN.id, { contributor: 'Cd-02', mode: 'home', station: 's2' });
    check('another contributor can publish the same session; station limits it to one folder', p3.status === 200 && p3.json.published.length === 1 && fs.existsSync(path.join(POOLDIR, 's2', 'Cd-02-' + RUN.id)) && !fs.existsSync(path.join(POOLDIR, 's3', 'Cd-02-' + RUN.id)));
    // Make the review state of Cd-02 different from Ab-01: the first published copy keeps "confirmed" for RUN.a, Cd-02's has "rejected".
    const R2 = await makeRun('second run', true), R3 = await makeRun('third run', true);
    await pub(R2.id, { contributor: 'Ab-01', mode: 'home' });
    await pub(R3.id, { contributor: 'Ef-03', mode: 'group', station: 's2' });

    const pj = (await req('GET', '/api/pool')).json;
    check('GET /api/pool lists every contribution with counts', pj.contributions.length === 6 && pj.contributions.every(c => c.station && c.folder && c.contributor && c.mode && c.sessionId && c.publishedAt && typeof c.images === 'number'), String(pj.contributions.length));
    const s2 = pj.stations.s2;
    check('station s2 has four contributions and s3 two', s2.contributions === 4 && pj.stations.s3.contributions === 2);
    check('per station counts are consistent with the contributions listed', s2.images === pj.contributions.filter(c => c.station === 's2').reduce((a, c) => a + c.images, 0) && s2.contributions === pj.contributions.filter(c => c.station === 's2').length && s2.negatives >= 1);
    check('per class counts use the final boxes (confirmed: the model\'s, corrected: the person\'s, rejected: none)', s2.byClass.connector_open >= 1 && s2.byClass.red_wire >= 1 && !s2.byClass.connector_closed, JSON.stringify(s2.byClass));
    check('per contributor counts add up to the station\'s', Object.keys(s2.byContributor).sort().join() === 'Ab-01,Cd-02,Ef-03' && Object.values(s2.byContributor).reduce((a, c) => a + c.images, 0) === s2.images && s2.byContributor['Ab-01'].contributions === 2, JSON.stringify(Object.keys(s2.byContributor)));
    check('per way in (home, group) counts are given', s2.byMode.home && s2.byMode.group && s2.byMode.home.contributions === 2 && s2.byMode.group.contributions === 2);
    check('the pool listing says nothing about a person (no title, crew)', !/Export run|Group B|second run/.test(JSON.stringify(pj)));
    check('a stray folder, a temp folder or a folder with a bad session.json is ignored', (() => { fs.mkdirSync(path.join(POOLDIR, 's2', '.tmp-x')); fs.mkdirSync(path.join(POOLDIR, 's2', 'junk')); fs.mkdirSync(path.join(POOLDIR, 's2', 'Zz-09-x')); fs.writeFileSync(path.join(POOLDIR, 's2', 'Zz-09-x', 'session.json'), '{nope'); return true; })());
    check('...and the count did not change', (await req('GET', '/api/pool')).json.contributions.length === 6);

    // ---- the snapshot ----
    const sn = await req('GET', '/api/pool/s2/snapshot.zip');
    check('snapshot.zip is a zip with a download name', sn.status === 200 && sn.headers['content-type'] === 'application/zip' && /s2-pool-snapshot\.zip/.test(sn.headers['content-disposition']), sn.status + sn.text.slice(0, 100));
    const z = readZip(sn.raw), names = z.files.map(f => f.name), man = JSON.parse(z.files.find(f => f.name === 'manifest.json').data);
    check('it has data.yaml, manifest.json and the train, val and test folders', ['data.yaml', 'manifest.json', 'train/images/', 'val/labels/', 'test/images/'].every(n => names.includes(n)) && man.source === 'pool' && man.role === 's2' && man.holdout === null);
    const expSplit = folder => parseInt(crypto.createHash('sha1').update(folder).digest('hex').slice(0, 8), 16) % 5 === 0 ? 'val' : 'train';
    const bySession = {};
    for (const [name, x] of Object.entries(man.images)) (bySession[x.contribution] = bySession[x.contribution] || new Set()).add(x.split);
    check('every contribution is on one side only (split by session, never by frame)', Object.values(bySession).every(sp => sp.size === 1) && Object.keys(bySession).length === 4, JSON.stringify(Object.fromEntries(Object.entries(bySession).map(([k, v]) => [k, [...v]]))));
    check('the side is the stable hash of the contribution folder', Object.values(man.images).every(x => x.split === expSplit(x.contribution)));
    const total = pj.stations.s2.images;
    check('every reviewed frame is in the zip once, as image plus label', Object.keys(man.images).length === total && names.filter(n => /^(train|val|test)\/images\/.+\.jpg$/.test(n)).length === total && names.filter(n => /^(train|val|test)\/labels\/.+\.txt$/.test(n)).length === total);
    const nm = Object.keys(man.images).find(n => man.images[n].contribution === 'Ab-01-' + RUN.id && man.images[n].captureId === RUN.b), sp = man.images[nm].split;
    check('labels use the class index of the role list: the corrected frame has connector_open (3)', z.files.find(f => f.name === sp + '/labels/' + nm + '.txt').data.toString() === '3 0.400000 0.400000 0.400000 0.400000\n', z.files.find(f => f.name === sp + '/labels/' + nm + '.txt').data.toString());
    const rej = Object.keys(man.images).find(n => man.images[n].verdict === 'rejected');
    check('a rejected frame is a negative: its label file is empty', z.files.find(f => f.name === man.images[rej].split + '/labels/' + rej + '.txt').data.length === 0);
    check('data.yaml has nc 5 and the names in class order', /^nc: 5$/m.test(z.files.find(f => f.name === 'data.yaml').data.toString()) && /0: red_wire/.test(z.files.find(f => f.name === 'data.yaml').data.toString()));

    const ho = await req('GET', '/api/pool/s2/snapshot.zip?holdout=Cd-02');
    const hz = readZip(ho.raw), hm = JSON.parse(hz.files.find(f => f.name === 'manifest.json').data);
    const mine = Object.values(hm.images).filter(x => x.contributor === 'Cd-02'), others = Object.values(hm.images).filter(x => x.contributor !== 'Cd-02');
    check('?holdout=Cd-02 puts all of that contributor\'s frames in test, and none of anyone else\'s there', ho.status === 200 && hm.holdout === 'Cd-02' && mine.length === 3 && mine.every(x => x.split === 'test') && others.every(x => x.split !== 'test'), ho.status + ' ' + mine.length);
    check('...while the others keep the same sides as before (split by session, not shuffled)', others.every(x => x.split === expSplit(x.contribution)));
    check('holdout matches the code without caring about case', (await req('GET', '/api/pool/s2/snapshot.zip?holdout=cd-02')).status === 200);
    check('holdout of a code with no frames is 400; a name is 400', (await req('GET', '/api/pool/s2/snapshot.zip?holdout=Zz-99')).status === 400 && (await req('GET', '/api/pool/s2/snapshot.zip?holdout=Michael')).status === 400);
    const s3zip = await req('GET', '/api/pool/s3/snapshot.zip');
    check('station s3 has its own snapshot with its own class list (nc 4)', s3zip.status === 200 && /^nc: 4$/m.test(readZip(s3zip.raw).files.find(f => f.name === 'data.yaml').data.toString()));
    check('holding out the only contributor of a station is 409 (nothing left to train on)', (await req('GET', '/api/pool/s3/snapshot.zip?holdout=Ab-01')).status === 409);
    check('a station with nothing in the pool is 404; a bad role is 404; POST is 405', (await req('GET', '/api/pool/s1/snapshot.zip')).status === 404 && (await req('GET', '/api/pool/..%2Fx/snapshot.zip')).status === 404 && (await req('POST', '/api/pool/s2/snapshot.zip', {}, jsonHdr)).status === 405);
    check('GET /pool serves the pool page', (await req('GET', '/pool')).status === 200 && /<title>Shared pool<\/title>/.test((await req('GET', '/pool')).text));

    // ---- hostile pool: the shared folder is untrusted ----
    {
      const SID = '20261016-101010-abcd', OUT = path.join(TMP, 'outside');
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, 'secret.jpg'), jpegBuf(300, 1));
      fs.writeFileSync(path.join(OUT, 'SECRETFILE.txt'), 'SECRETOUT');
      const wr = (dirp, name, text) => { fs.mkdirSync(dirp, { recursive: true }); fs.writeFileSync(path.join(dirp, name), text); };
      const mkc = (folder, station, meta, caps, revs, jpgs) => {
        const d = path.join(POOLDIR, station, folder);
        wr(d, 'session.json', JSON.stringify(Object.assign({ version: 1, station, mode: 'home', sessionId: SID, publishedAt: new Date().toISOString() }, meta)));
        wr(d, 'captures.jsonl', caps.map(c => JSON.stringify(c)).join('\n') + '\n');
        wr(d, 'review.jsonl', revs.map(c => JSON.stringify(c)).join('\n') + '\n');
        fs.mkdirSync(path.join(d, 'captures'), { recursive: true });
        for (const j of jpgs || []) fs.writeFileSync(path.join(d, 'captures', j + '.jpg'), jpegBuf(300, 2));
        return d;
      };
      const good = { id: 'c0001', role: 's2', station: 's2', reason: 'claim', t: 1, boxes: [box('connector_open', [0.1, 0.1, 0.5, 0.5])], operator: { code: 'SECRETOP-07', level: 2 }, claim: 'SECRETCLAIM' };
      const rv = id => ({ captureId: id, verdict: 'confirmed', note: 'SECRETNOTE' });
      const before = (await req('GET', '/api/pool')).json;
      // 1. a valid-looking contribution with an extra operator field, an out-of-range box, a symlinked jpg, a traversal id, a newline class.
      const H = 'Hk-01-' + SID;
      const hd = mkc(H, 's2', { contributor: 'Hk-01', classes: ['evil\nnames: x', 'a: b'] }, [
        good,
        Object.assign({}, good, { id: 'c0002', boxes: [box('connector_open', [0, 0, 2, 2])] }),
        Object.assign({}, good, { id: 'c0003' }),
        Object.assign({}, good, { id: '../../x' }),
        Object.assign({}, good, { id: 'c0004', boxes: [box('red_wire\nnc: 99', [0.1, 0.1, 0.5, 0.5])] })
      ], ['c0001', 'c0002', 'c0003', '../../x', 'c0004'].map(rv), ['c0001', 'c0002', 'c0004']);
      fs.symlinkSync(path.join(OUT, 'secret.jpg'), path.join(hd, 'captures', 'c0003.jpg'));
      // 2. folder name that is not contributor-sessionId; contributor with a traversal; a session id that is not one.
      mkc('Hk-02-' + SID, 's2', { contributor: 'Zz-77' }, [good], [rv('c0001')], ['c0001']);
      mkc('Hk-03-..', 's2', { contributor: 'Hk-03', sessionId: '..' }, [good], [rv('c0001')], ['c0001']);
      // 3. a symlinked folder out of the pool
      fs.mkdirSync(path.join(OUT, 'folder'), { recursive: true });
      mkc('Hk-04-' + SID, 's2', { contributor: 'Hk-04' }, [good], [rv('c0001')], ['c0001']);
      fs.cpSync(path.join(POOLDIR, 's2', 'Hk-04-' + SID), path.join(OUT, 'folder'), { recursive: true });
      fs.rmSync(path.join(POOLDIR, 's2', 'Hk-04-' + SID), { recursive: true });
      fs.symlinkSync(path.join(OUT, 'folder'), path.join(POOLDIR, 's2', 'Hk-04-' + SID));
      // 4. a station that has no class list here, whose only classes come from the pool
      mkc('Hk-05-' + SID, 's8', { contributor: 'Hk-05', station: 's8', classes: ['pool_only_class', 'x\ny: z'] }, [Object.assign({}, good, { role: 's8', station: 's8', boxes: [box('pool_only_class', [0.1, 0.1, 0.5, 0.5])] })], [rv('c0001')], ['c0001']);
      // 5. session.json symlinked out of the pool
      const d6 = mkc('Hk-06-' + SID, 's2', { contributor: 'Hk-06' }, [good], [rv('c0001')], ['c0001']);
      fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify({ version: 1, station: 's2', mode: 'home', contributor: 'Hk-06', sessionId: SID }));
      fs.rmSync(path.join(d6, 'session.json')); fs.symlinkSync(path.join(OUT, 'session.json'), path.join(d6, 'session.json'));

      const ap = await req('GET', '/api/pool'), apj = ap.json;
      const hk = apj.contributions.filter(c => /^Hk-/.test(c.contributor));
      check('hostile pool: only the one well-formed contribution is listed; the traversal, mismatch and symlinked ones are not', hk.length === 2 && hk.map(c => c.folder).sort().join() === H + ',Hk-05-' + SID, JSON.stringify(hk.map(c => c.folder)));
      check('hostile pool: skipped is counted in the response', typeof apj.skipped === 'number' && apj.skipped >= (before.skipped || 0) + 4, String(apj.skipped));
      const hc = hk.find(c => c.folder === H);
      check('hostile pool: only the clean frame counts (out-of-range box, symlinked jpg, traversal id, newline class all refused)', hc.images === 1 && Object.keys(hc.byClass).join() === 'connector_open', JSON.stringify(hc));
      check('hostile pool: nothing from the extra fields leaks through /api/pool', !/SECRET/.test(ap.text));
      const sz = await req('GET', '/api/pool/s2/snapshot.zip');
      check('hostile pool: the snapshot still builds', sz.status === 200, sz.status + sz.text.slice(0, 120));
      const hz = readZip(sz.raw), hnames = hz.files.map(f => f.name);
      check('hostile pool: every zip entry name is clean (no .., backslash, absolute path, odd characters)', hnames.every(n => /^[A-Za-z0-9_\-.\/]+$/.test(n) && !n.includes('..') && !n.startsWith('/') && !n.includes('//')), hnames.filter(n => !/^[A-Za-z0-9_\-.\/]+$/.test(n) || n.includes('..')).join());
      const alltext = hz.files.map(f => f.data ? f.data.toString('latin1') : '').join('\n');
      check('hostile pool: no operator, claim, note, outside file or foreign class text is in the zip', !/SECRET|evil|nc: 99|pool_only_class/.test(alltext));
      const hy = hz.files.find(f => f.name === 'data.yaml').data.toString(), hman = JSON.parse(hz.files.find(f => f.name === 'manifest.json').data);
      check('hostile pool: data.yaml has exactly this machine\'s classes and no extra lines', hy.split('\n').filter(l => /^ {2}\d+:/.test(l)).length === hman.classes.length && !/names: x|a: b/.test(hy));
      check('hostile pool: the manifest reports skipped', typeof hman.skipped === 'number' && hman.skipped >= 4, String(hman.skipped));
      check('hostile pool: only the hostile contribution\'s one clean frame is taken from it', Object.values(hman.images).filter(x => x.contributor === 'Hk-01').length === 1);
      const s8 = await req('GET', '/api/pool/s8/snapshot.zip');
      check('hostile pool: a station with no class list here is refused (4xx) rather than using the pool\'s classes', s8.status >= 400 && s8.status < 500 && !/pool_only_class/.test(s8.text), s8.status + ' ' + s8.text.slice(0, 120));
      // a bad class name in this machine's own config is refused, not written to data.yaml
      const cfgBad = JSON.parse(fs.readFileSync(CFGF, 'utf8')); const keep = cfgBad.models.s2.classes.slice(); cfgBad.models.s2.classes = keep.concat(['x\nnames: y']);
      fs.writeFileSync(CFGF, JSON.stringify(cfgBad));
      const sb = await req('GET', '/api/pool/s2/snapshot.zip');
      check('a class name with a newline or colon in the config is refused with a 4xx', sb.status >= 400 && sb.status < 500, sb.status + ' ' + sb.text.slice(0, 120));
      cfgBad.models.s2.classes = keep; fs.writeFileSync(CFGF, JSON.stringify(cfgBad));
    }

    // A class list that changed since publishing: boxes with a class the list no longer has are dropped, and counted.
    const cfgNow = JSON.parse(fs.readFileSync(CFGF, 'utf8')); cfgNow.models.s2.classes = cfgNow.models.s2.classes.filter(c => c !== 'red_wire');
    fs.writeFileSync(CFGF, JSON.stringify(cfgNow));
    const dz = await req('GET', '/api/pool/s2/snapshot.zip'), dm = JSON.parse(readZip(dz.raw).files.find(f => f.name === 'manifest.json').data);
    check('boxes of a class the role no longer has are dropped (not written as a shifted index) and counted in the manifest', dz.status === 200 && dm.droppedBoxes >= 1 && dm.classes.join() === cfgNow.models.s2.classes.join(), String(dm.droppedBoxes));
    fs.writeFileSync(CFGF, JSON.stringify(Object.assign({}, shipped, { capture: { maxPerSession: 100, maxPerStation: 100, reviewDays: 7, mediaCapMB: 1024 }, pool: { dir: POOLDIR } })));

    // The default location: no pool key means data/pool.
    setPool(undefined);
    const RUN4 = await makeRun('default pool', true);
    const pd = await pub(RUN4.id, { contributor: 'Gh-04', mode: 'home', station: 's3' });
    check('with no pool setting, publish goes to data/pool/<station>/<contributor>-<sessionId>', pd.status === 200 && fs.existsSync(path.join(DATA, 'pool', 's3', 'Gh-04-' + RUN4.id, 'session.json')), pd.text);
    setPool('nope');
    check('a pool setting that is not an object is refused with a clear message', (await req('GET', '/api/pool')).status === 500);
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
