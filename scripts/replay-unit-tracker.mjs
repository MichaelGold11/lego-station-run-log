#!/usr/bin/env node
// Replay the unit tracker of S2 (default) or S3 over recorded sessions: decode the video, run the station's model with the page's letterbox, then feed
// the real engine, checker and unit tracker in the page's order (engine update, checker update, tracker update, reset on a
// departed unit). Hands are not run here (the page's hand model is a browser worker), so the tracker sees presence only.
//   node scripts/replay-unit-tracker.mjs <session dir> [more dirs] [--station s2|s3] [--fps 4] [--json out.json] [--model other.onnx]
//   node scripts/replay-unit-tracker.mjs --chain <s2 session dir> <s3 session dir> [--fps 4] [--json out.json]
// --station s3 replays s3.mp4 of each folder through the S3 model and S3 rules (an S3 unit with no S2 unit before it is ?01).
// --chain replays the S2 session, then the S3 session with its clock shifted to start 3 s after the S2 recording ends, sharing one
// createUnitLink (the line's hand-off), and prints each unit's number at both stations.
// Prints, per recording: the tracker's units, and what the live session recorded (cycle_end events, manual presses) to compare.
// Needs ffmpeg and ffprobe on PATH. Frames are placed at t = i / fps.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openOnnx } from './lib-onnx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = f => { const mod = { exports: {} }; new Function('module', fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'))(mod); return mod.exports; };
const LD = load('live-detect.js'), LE = load('line-engine.js');
const MIN_BOX = 0.25, IOU = 0.7;

const argv = process.argv.slice(2), dirs = [];
let fps = 4, jsonOut = '', modelPath = '', station = '', chain = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--fps') fps = +argv[++i]; else if (argv[i] === '--json') jsonOut = argv[++i]; else if (argv[i] === '--model') modelPath = argv[++i];
  else if (argv[i] === '--station') station = argv[++i];
  else if (argv[i] === '--chain') { chain = [argv[++i], argv[++i]]; }
  else dirs.push(argv[i]);
}
const USAGE = 'Usage: node scripts/replay-unit-tracker.mjs <session dir> [...] [--station s2|s3] [--fps 4] [--json out.json]\n       node scripts/replay-unit-tracker.mjs --chain <s2 session dir> <s3 session dir>';
if (chain ? (!chain[0] || !chain[1] || dirs.length || station) : !dirs.length) { console.error(USAGE); process.exit(2); }
if (station && !['s2', 's3'].includes(station)) { console.error('--station must be s2 or s3 (got "' + station + '").\n' + USAGE); process.exit(2); }
const GAP_MS = 3000;    // chain: the S3 recording starts this long after the S2 recording ends (the carry)

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/meta/wire-line.json'), 'utf8'));
const ctxs = {};
async function ctxOf(id) {
  if (ctxs[id]) return ctxs[id];
  const stn = cfg.stations.find(s => s.id === id), mcfg = cfg.models[id];
  if (!stn || !mcfg) { console.error('wire-line.json has no station/model "' + id + '"'); process.exit(2); }
  const S = mcfg.imgsz || 640;
  const m = await openOnnx(modelPath && !chain ? path.resolve(modelPath) : path.join(ROOT, 'app', mcfg.file.replace(/^\//, '')), mcfg.classes, S);
  return (ctxs[id] = { id, stn, mcfg, S, m, inName: m.sess.inputNames[0], outName: m.sess.outputNames[0], track: LE.trackedClasses(stn, mcfg.classes.slice()) });
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation:stream_tags=rotate:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout), s = j.streams[0];
  let rot = 0;
  for (const sd of s.side_data_list || []) if (sd.rotation != null) rot = +sd.rotation;
  if (s.tags && s.tags.rotate != null) rot = +s.tags.rotate;
  const swap = Math.abs(rot) % 180 === 90;
  return { w: swap ? s.height : s.width, h: swap ? s.width : s.height, dur: +(j.format && j.format.duration) || 0 };
}
const even = v => Math.max(2, Math.round(v / 2) * 2);
function fitLong(w, h, L) { const s = L / Math.max(w, h); return { w: even(w * s), h: even(h * s) }; }

async function infer(cx, rgb, sw, sh) {
  const { stn, S, m, inName, outName } = cx;
  const lb = LD.letterbox(sw, sh, S), img = new Uint8Array(S * S * 3).fill(114);
  for (let y = 0; y < lb.nh; y++) img.set(rgb.subarray(y * lb.nw * 3, (y + 1) * lb.nw * 3), ((y + lb.padY) * S + lb.padX) * 3);
  const n = S * S, input = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 3) { input[i] = img[j] / 255; input[n + i] = img[j + 1] / 255; input[2 * n + i] = img[j + 2] / 255; }
  const out = await m.sess.run({ [inName]: new m.ort.Tensor('float32', input, [1, 3, S, S]) });
  const o = out[outName];
  const dets = LD.decodeOutput(o.data, o.dims, lb, sw, sh, MIN_BOX, IOU, m.classes);
  const px = (x, y) => { if (x < 0 || y < 0 || x >= sw || y >= sh) return null; const i = (Math.round(y * lb.scale + lb.padY) * S + Math.round(x * lb.scale + lb.padX)) * 3; return [img[i], img[i + 1], img[i + 2]]; };
  const done = stn.assembly ? LE.unitCheck(dets, px, sw, sh, stn.assembly) : null;
  if (done) dets.push(done);
  return dets;
}

// Small RGBA for the zone signals (the page processes a few thousand pixels per frame).
function smallRgba(rgb, w, h) {
  const sw = Math.max(16, Math.round(w / 4)), sh = Math.max(12, Math.round(h / 4)), out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const i = ((y * 4) * w + x * 4) * 3, o = (y * sw + x) * 4; out[o] = rgb[i]; out[o + 1] = rgb[i + 1]; out[o + 2] = rgb[i + 2]; out[o + 3] = 255; }
  return { data: out, w: sw, h: sh };
}

function liveFacts(dir, stn) {
  const f = path.join(dir, 'events.jsonl'), out = { cycleEnd: 0, manual: 0, arrive: 0, mistakes: 0 };
  if (!fs.existsSync(f)) return out;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(l); } catch (x) { continue; }
    if (e.station !== stn.id) continue;
    if (e.type === 'cycle_end') out.cycleEnd++;
    if (e.type === 'manual') out.manual++;
    if (e.type === 'substep' && e.substep === stn.arrival && e.move !== 'repeat') out.arrive++;
    if (e.type === 'verdict' && e.kind === 'mistake') out.mistakes++;
  }
  return out;
}

const results = [];
// Replay one session folder at one station. opts.link: the shared createUnitLink; opts.offset: ms added to every time (the chain's S3 clock);
// opts.gap: ms of empty view fed after the last frame (the unit carried away before the next station's recording starts).
async function replayDir(dir, id, opts) {
  const cx = await ctxOf(id), stn = cx.stn, S = cx.S, track = cx.track, off = (opts && opts.offset) || 0;
  const video = path.join(dir, id + '.mp4');
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  const setup = (sess.setup && sess.setup[id]) || {};
  const zones = setup.zones || {}, calib = setup.calib || { motion: {}, bright: {} };
  const vid = probe(video), main = fitLong(vid.w, vid.h, S);
  const eng = LE.createStation(stn, { holdFrames: cfg.holdFrames, defaults: cfg.defaults, qaGraceSec: cfg.qaGraceSec, modelClasses: track });
  const chk = LE.createChecker(stn); chk.setRef(setup.ref || null);
  const ut = LE.createUnitTracker(stn, { link: (opts && opts.link) || LE.createUnitLink(cfg) });
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', 'fps=' + fps + ',scale=' + main.w + ':' + main.h + ':flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const fb = main.w * main.h * 3;
  const events = [], emit = e => events.push(e);
  let buf = Buffer.alloc(0), i = 0, prevDets = null, prevGray = null, seq = 0, last = off;
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= fb) {
      const rgb = new Uint8Array(buf.subarray(0, fb)); buf = buf.subarray(fb);
      const t = off + Math.round(i / fps * 1000); i++; last = t;
      const dets = await infer(cx, rgb, main.w, main.h);
      const sm = smallRgba(rgb, main.w, main.h);
      const r = LE.zoneSignals(sm.data, sm.w, sm.h, prevGray, zones, calib); prevGray = r.gray;
      const cls = LE.steadyClasses(prevDets ? LE.classSignals(prevDets, zones, track) : null, LE.classSignals(dets, zones, track));
      prevDets = dets;
      const sig = LE.mergeSignals(r.signals, cls, null);
      const stp = LE.stepStation(eng, ut, sig, t), evs = stp.events; evs.forEach(emit);
      let motion = null; for (const zid of Object.keys(r.signals)) motion = Math.max(motion || 0, r.signals[zid].activity || 0);
      if (stp.held) chk.dismiss();
      const vds = stp.held ? [] : chk.update({ t, events: LE.checkerEvents(evs, ut), state: eng.state(), modelOn: true, frame: { id: ++seq, t, dets }, zones, hands: null, motion, idle: false });
      vds.forEach(emit);
      const out = ut.update({ t, present: LE.unitPresent(dets, stn.unitTracker), hand: false, events: evs.concat(vds) });
      for (const e of out) { emit(e); if (e.action === 'end' && e.reset) { eng.abandon(t).forEach(emit); chk.restart(); } }
    }
  }
  if (!i) { console.error('No frames decoded from ' + video + ' (is ffmpeg on PATH, and is the file a video?)'); process.exit(1); }
  // The unit carried away after the recording ended: empty view until the next station's recording starts, so it departs and is queued.
  const step = Math.round(1000 / fps), gap = (opts && opts.gap) || 0;
  for (let t = last + step; t <= last + gap; t += step) {
    ut.update({ t, present: false, hand: false, events: [] }).forEach(e => { emit(e); if (e.action === 'end' && e.reset) { eng.abandon(t).forEach(emit); chk.restart(); } });
  }
  ut.stop(last + (gap || step) + 1).forEach(emit); eng.flush().forEach(emit);
  const ends = events.filter(e => e.type === 'unit' && e.action === 'end');
  const live = liveFacts(dir, stn), complete = ends.filter(u => u.result === 'complete').length;
  const row = { session: path.basename(dir), station: id, sec: +((last - off) / 1000).toFixed(1), frames: i, units: ends.length, complete, incomplete: ends.length - complete,
    replayCycleEnds: events.filter(e => e.type === 'cycle_end').length, live,
    list: ends.map(u => ({ no: u.no, start: +(u.start / 1000).toFixed(1), end: +(u.end / 1000).toFixed(1), result: u.result, done: u.completeT == null ? null : +(u.completeT / 1000).toFixed(1), ended: u.ended, from: u.from || undefined, unlinked: u.unlinked || undefined, steps: u.steps.length, mistakes: u.mistakes })) };
  console.error(row.session + ' [' + id + ']: ' + row.sec + ' s, units ' + row.units + ' (' + complete + ' complete, ' + row.incomplete + ' incomplete), live cycle_end ' + live.cycleEnd + ', manual ' + live.manual);
  return { row, ends, last };
}
const needVideo = (dir, id) => { if (!fs.existsSync(path.join(dir, id + '.mp4'))) { console.error('No ' + id + '.mp4 in ' + dir + '. A replay at ' + id.toUpperCase() + ' needs a session folder recorded with the ' + id.toUpperCase() + ' camera.'); process.exit(1); } };

if (chain) {
  needVideo(chain[0], 's2'); needVideo(chain[1], 's3');
  const link = LE.createUnitLink(cfg);
  const a = await replayDir(chain[0], 's2', { link, gap: GAP_MS });
  const b = await replayDir(chain[1], 's3', { link, offset: a.last + GAP_MS });
  const rows = [], byKey = {};
  const add = (id, ends) => { for (const u of ends) { const key = u.unlinked ? id + ':' + u.no : u.no; let r = byKey[key]; if (!r) { r = byKey[key] = { no: u.no, s2: null, s3: null }; rows.push(r); } r[id] = { start: +(u.start / 1000).toFixed(1), end: +(u.end / 1000).toFixed(1), result: u.result, ended: u.ended, mistakes: u.mistakes }; } };
  add('s2', a.ends); add('s3', b.ends);
  const fmt = x => x ? x.result + ' ' + x.start + '-' + x.end + ' s' + (x.mistakes ? ', ' + x.mistakes + ' mistake(s)' : '') : '-';
  console.error('\nunit   S2                       S3');
  for (const r of rows) console.error(r.no.padEnd(6) + ' ' + fmt(r.s2).padEnd(24) + ' ' + fmt(r.s3));
  results.push({ chain: true, s2: a.row, s3: b.row, units: rows });
} else {
  const id = station || 's2';
  for (const dir of dirs) {
    if (station) needVideo(dir, id);
    else if (!fs.existsSync(path.join(dir, 's2.mp4'))) { console.error('skip (no s2.mp4): ' + dir); continue; }
    results.push((await replayDir(dir, id, null)).row);
  }
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1));
else console.log(JSON.stringify(results, null, 1));
process.exit(0);
