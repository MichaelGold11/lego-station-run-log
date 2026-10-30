#!/usr/bin/env node
// Intake path A (home collection): turn one home video into a pseudo-session that opens in /review.
//   node scripts/ingest-footage.mjs --role s2 --video clip.mp4 [--contributor Op-07] [--frames 150] [--data-dir <dir>]
// ffmpeg samples candidate frames at 2 fps, the current model for the role pre-labels them (onnxruntime-web in node),
// selectFrames() picks about 150 balanced across classes (plus a fixed share of low-confidence and empty frames), and the
// chosen frames are written full frame as data/sessions/<id>/captures/<cid>.jpg plus captures.jsonl, reason "home", mode
// "home", the contributor code and no operator names. Review them at /review. Needs ffmpeg and ffprobe on PATH.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = f => { const mod = { exports: {} }; new Function('module', fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'))(mod); return mod.exports; };
const CaptureLib = load('capture-lib.js');
const LiveDetect = load('live-detect.js');

export const DEFAULTS = { frames: 150, candidateFps: 2, minConf: 0.25, lowConf: 0.5, lowShare: 0.15, emptyShare: 0.10, maxJpegBytes: 400 * 1024 };

// ---------- pure selection ----------
// frames: [{ idx, dets: [{ cls, conf }] }] in time order. Returns the chosen idx values, ascending, at most opts.n.
//  - empty frames (no detection at or above minConf): a fixed share (emptyShare), evenly spread through the video
//  - low-confidence frames (a detection between minConf and lowConf, none of the frame's detections counted twice): a fixed
//    share (lowShare), the least sure first, spread out
//  - the rest: balanced across classes, round robin, each class taking the frame where it is most confident, skipping
//    neighbours of frames already taken until nothing else is left
// If there are fewer frames of a kind than its share, the leftover goes to the class-balanced part.
export function selectFrames(frames, o) {
  const opt = Object.assign({ n: DEFAULTS.frames, minConf: DEFAULTS.minConf, lowConf: DEFAULTS.lowConf, lowShare: DEFAULTS.lowShare, emptyShare: DEFAULTS.emptyShare, classes: null }, o || {});
  const n = Math.max(0, Math.floor(opt.n));
  const chosen = new Set();
  if (!n || !frames.length) return [];
  const strong = f => f.dets.filter(d => d.conf >= opt.minConf);
  const spread = (list, k) => { // k items evenly spaced through a time-ordered list
    if (k >= list.length) return list.slice();
    const out = [];
    for (let i = 0; i < k; i++) out.push(list[Math.floor((i + 0.5) * list.length / k)]);
    return out;
  };
  const nEmpty = Math.round(n * opt.emptyShare), nLow = Math.round(n * opt.lowShare);

  const empties = frames.filter(f => strong(f).length === 0);
  for (const f of spread(empties, nEmpty)) chosen.add(f.idx);

  const lows = frames.filter(f => !chosen.has(f.idx) && strong(f).some(d => d.conf < opt.lowConf))
    .map(f => ({ f, low: Math.min(...strong(f).map(d => d.conf)) }))
    .sort((a, b) => a.low - b.low || a.f.idx - b.f.idx);
  // the least sure half of the pool, then spread by time so they are not all from one moment
  const lowPool = lows.slice(0, Math.max(nLow, Math.ceil(lows.length / 2))).map(x => x.f).sort((a, b) => a.idx - b.idx);
  for (const f of spread(lowPool, nLow)) chosen.add(f.idx);

  // class balanced part
  const classes = opt.classes || [...new Set(frames.flatMap(f => strong(f).map(d => d.cls)))].sort();
  const queues = classes.map(c => frames
    .map(f => ({ idx: f.idx, conf: Math.max(0, ...strong(f).filter(d => d.cls === c).map(d => d.conf)) }))
    .filter(x => x.conf > 0)
    .sort((a, b) => b.conf - a.conf || a.idx - b.idx));
  const near = i => chosen.has(i - 1) || chosen.has(i + 1);
  for (const gap of [true, false]) {
    let progressed = true;
    while (chosen.size < n && progressed) {
      progressed = false;
      for (const q of queues) {
        if (chosen.size >= n) break;
        // a class with few frames left takes any of them: rare classes must not lose to the neighbour rule
        const scarce = q.length <= Math.ceil((n - chosen.size) / queues.length);
        const at = q.findIndex(x => !chosen.has(x.idx) && !(gap && !scarce && near(x.idx)));
        if (at >= 0) { chosen.add(q[at].idx); q.splice(at, 1); progressed = true; }
      }
    }
  }
  // still short (few classes, tiny video): fill with whatever is left, evenly
  if (chosen.size < n) {
    const rest = frames.filter(f => !chosen.has(f.idx));
    for (const f of spread(rest, n - chosen.size)) chosen.add(f.idx);
  }
  return [...chosen].sort((a, b) => a - b).slice(0, n);
}

// ---------- pure capture line ----------
export function claimText(boxes) {
  if (!boxes.length) return 'Home footage, pre-label: nothing found';
  const by = {};
  for (const b of boxes) (by[b.cls] = by[b.cls] || []).push(b.conf);
  return 'Home footage, pre-label: ' + Object.keys(by).sort().map(c => c + ' ' + Math.max(...by[c]).toFixed(2)).join(', ');
}
// One captures.jsonl line in the shape the server's capture route writes, plus mode and contributor.
export function captureLine(a) {
  const line = {
    id: a.id, station: a.role, role: a.role, stationName: a.stationName || undefined, t: a.t, videoT: a.videoT,
    reason: 'home', mode: 'home', contributor: a.contributor || undefined, claim: claimText(a.boxes), boxes: a.boxes,
    model: a.model || undefined, receivedAt: a.receivedAt, bytes: a.bytes
  };
  return line;
}
export function sessionId(now, rand) {
  const d = new Date(now), p = (v, w = 2) => String(v).padStart(w, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + rand;
}

// ---------- ffmpeg and model ----------
function need(cmd) {
  const r = spawnSync(cmd, ['-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    console.error(cmd + ' is not installed or not on PATH. Install ffmpeg (macOS: "brew install ffmpeg"; it includes ffprobe) and run this again.');
    process.exit(2);
  }
}
function probe(video) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation', '-show_entries', 'format=duration', '-of', 'json', video], { encoding: 'utf8' });
  const j = JSON.parse(out), s = (j.streams || [])[0];
  if (!s) throw new Error('No video stream in ' + video);
  let w = s.width, h = s.height;
  const rot = Math.abs(Number((s.tags && s.tags.rotate) || (s.side_data_list && s.side_data_list[0] && s.side_data_list[0].rotation) || 0));
  if (rot === 90 || rot === 270) [w, h] = [h, w]; // ffmpeg autorotates, so work in displayed size
  return { w, h, duration: Number(j.format && j.format.duration) || 0 };
}

async function openModel(cfg, role) {
  const m = cfg.models && cfg.models[role];
  if (!m || !m.file) throw new Error('No model is configured for role ' + role + ' in wire-line.json.');
  const file = path.join(ROOT, 'app', m.file.replace(/^\/+/, ''));
  if (!fs.existsSync(file)) throw new Error('Model file not found: ' + file);
  const ort = await import(pathToFileURL(path.join(ROOT, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs')).href);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = path.join(ROOT, 'node_modules/onnxruntime-web/dist/') ;
  const sess = await ort.InferenceSession.create(fs.readFileSync(file), { executionProviders: ['wasm'] });
  return { ort, sess, classes: m.classes, size: m.imgsz || 640, file: m.file, version: m.version };
}

// Runs the model over every candidate frame (2 fps), streaming raw frames out of ffmpeg.
async function scan(video, info, model, fps) {
  const size = model.size, lb = LiveDetect.letterbox(info.w, info.h, size);
  const vf = `fps=${fps},scale=${lb.nw}:${lb.nh},pad=${size}:${size}:${lb.padX}:${lb.padY}:color=0x727272`;
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const N = size * size * 3, frames = [];
  let pending = Buffer.alloc(0);
  const handle = async px => {
    const inp = new Float32Array(3 * size * size), plane = size * size;
    for (let i = 0; i < plane; i++) { inp[i] = px[i * 3] / 255; inp[plane + i] = px[i * 3 + 1] / 255; inp[2 * plane + i] = px[i * 3 + 2] / 255; }
    const res = await model.sess.run({ images: new model.ort.Tensor('float32', inp, [1, 3, size, size]) });
    const t = res[Object.keys(res)[0]];
    const dets = LiveDetect.decodeOutput(t.data, t.dims, lb, info.w, info.h, DEFAULTS.minConf, 0.7, model.classes);
    frames.push({ idx: frames.length, t: frames.length / fps, dets: dets.map(d => ({ cls: d.cls, conf: d.conf, nbox: d.nbox })) });
  };
  for await (const chunk of ff.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= N) { await handle(pending.subarray(0, N)); pending = pending.subarray(N); }
  }
  await new Promise(r => ff.on('close', r));
  return frames;
}

// Full frame JPEG at time t, kept at or under the size cap by raising the quality number (never cropping).
function grabFrame(video, t, out, maxBytes) {
  for (const q of [3, 5, 8, 12, 18, 25]) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-q:v', String(q), out], { stdio: 'ignore' });
    if (fs.statSync(out).size <= maxBytes) return fs.statSync(out).size;
  }
  throw new Error('Could not get a frame under ' + Math.round(maxBytes / 1024) + ' KB at ' + t.toFixed(1) + ' s.');
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) throw new Error('Unexpected argument ' + k);
    const key = k.slice(2);
    if (key === 'help') { a.help = true; continue; }
    if (i + 1 >= argv.length) throw new Error('--' + key + ' needs a value');
    a[key] = argv[++i];
  }
  return a;
}
const USAGE = 'Usage: node scripts/ingest-footage.mjs --role <s1|s2|s3|s4> --video <file> [--contributor <code>] [--frames 150] [--data-dir <dir>]';

async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message + '\n' + USAGE); process.exit(1); }
  if (a.help) { console.log(USAGE); return; }
  if (!/^s[1-4]$/.test(a.role || '') || !a.video) { console.error(USAGE); process.exit(1); }
  const frames = a.frames == null ? DEFAULTS.frames : Number(a.frames);
  if (!Number.isInteger(frames) || frames < 1 || frames > 120 * 4) { console.error('--frames must be a whole number from 1 to 480.'); process.exit(1); }
  if (a.contributor && !/^[A-Za-z0-9_-]{1,20}$/.test(a.contributor)) { console.error('--contributor is a short code (letters, digits, - and _), never a name.'); process.exit(1); }
  if (!fs.existsSync(a.video)) { console.error('Video not found: ' + a.video); process.exit(1); }
  need('ffmpeg'); need('ffprobe');

  const dataDir = path.resolve(a['data-dir'] || process.env.DATA_DIR || path.join(ROOT, 'data'));
  const cfgFile = [path.join(dataDir, 'meta', 'wire-line.json'), path.join(ROOT, 'data', 'meta', 'wire-line.json')].find(f => fs.existsSync(f));
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const info = probe(a.video);
  console.log(`Video ${info.w}x${info.h}, ${info.duration.toFixed(1)} s. Loading the ${a.role} model...`);
  const model = await openModel(cfg, a.role);
  const cands = await scan(a.video, info, model, DEFAULTS.candidateFps);
  console.log(`Scanned ${cands.length} candidate frames at ${DEFAULTS.candidateFps} fps.`);
  if (!cands.length) { console.error('No frames could be read from the video.'); process.exit(1); }
  const picked = selectFrames(cands, { n: frames, classes: model.classes });

  const now = Date.now(), sid = sessionId(now, crypto.randomBytes(2).toString('hex'));
  const dir = path.join(dataDir, 'sessions', sid), capDir = path.join(dir, 'captures');
  fs.mkdirSync(capDir, { recursive: true });
  const station = (cfg.stations || []).find(s => s.id === a.role);
  const lines = [];
  picked.forEach((idx, k) => {
    const c = cands[idx], id = CaptureLib.captureId(k + 1);
    const bytes = grabFrame(a.video, c.t, path.join(capDir, id + '.jpg'), DEFAULTS.maxJpegBytes);
    const cleaned = CaptureLib.cleanBoxes(c.dets.map(d => ({ cls: d.cls, conf: d.conf, nbox: d.nbox.map(v => Math.min(1, Math.max(0, v))) })).filter(d => d.nbox[2] > d.nbox[0] && d.nbox[3] > d.nbox[1]), { conf: true, classes: model.classes });
    if (cleaned.error) throw new Error('Pre-label for frame ' + idx + ' is not valid: ' + cleaned.error);
    lines.push(captureLine({ id, role: a.role, stationName: station && station.name, t: now + k, videoT: Math.round(c.t * 1000) / 1000, contributor: a.contributor, boxes: cleaned.boxes, model: { file: model.file, version: model.version == null ? undefined : model.version }, receivedAt: now, bytes }));
  });
  fs.writeFileSync(path.join(dir, 'captures.jsonl'), lines.map(l => JSON.stringify(l) + '\n').join(''));
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    id: sid, title: 'Home footage ' + a.role + (a.contributor ? ' (' + a.contributor + ')' : ''), mode: 'home', contributor: a.contributor || undefined,
    startedAt: new Date(now).toISOString(), startedAtMs: now, endedAt: new Date(now).toISOString(), source: path.basename(a.video),
    stations: { [a.role]: { input: 'clip', label: 'Home footage', record: false } }, config: cfg
  }, null, 2));
  const empty = lines.filter(l => !l.boxes.length).length;
  console.log(`Wrote session ${sid}: ${lines.length} frames (${empty} empty) in ${dir}\nOpen /review to check them.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e && e.message || e); process.exit(1); });
}
