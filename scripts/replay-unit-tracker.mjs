#!/usr/bin/env node
// Replay the S2 unit tracker (S2 only: no S3 recording exists in this repo; S3 is covered by synthetic tests) over recorded sessions: decode the video, run the S2 model with the page's letterbox, then feed
// the real engine, checker and unit tracker in the page's order (engine update, checker update, tracker update, reset on a
// departed unit). Hands are not run here (the page's hand model is a browser worker), so the tracker sees presence only.
//   node scripts/replay-unit-tracker.mjs <session dir> [more dirs] [--fps 4] [--json out.json] [--model other.onnx]
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
let fps = 4, jsonOut = '', modelPath = '';
for (let i = 0; i < argv.length; i++) { if (argv[i] === '--fps') fps = +argv[++i]; else if (argv[i] === '--json') jsonOut = argv[++i]; else if (argv[i] === '--model') modelPath = argv[++i]; else dirs.push(argv[i]); }
if (!dirs.length) { console.error('Usage: node scripts/replay-unit-tracker.mjs <session dir> [...] [--fps 4] [--json out.json]'); process.exit(2); }

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/meta/wire-line.json'), 'utf8'));
const stn = cfg.stations.find(s => s.id === 's2'), mcfg = cfg.models.s2, S = mcfg.imgsz || 640;
const m = await openOnnx(modelPath ? path.resolve(modelPath) : path.join(ROOT, 'app', mcfg.file.replace(/^\//, '')), mcfg.classes, S);
const inName = m.sess.inputNames[0], outName = m.sess.outputNames[0];
const track = LE.trackedClasses(stn, mcfg.classes.slice());

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

async function infer(rgb, sw, sh) {
  const lb = LD.letterbox(sw, sh, S), img = new Uint8Array(S * S * 3).fill(114);
  for (let y = 0; y < lb.nh; y++) img.set(rgb.subarray(y * lb.nw * 3, (y + 1) * lb.nw * 3), ((y + lb.padY) * S + lb.padX) * 3);
  const n = S * S, input = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 3) { input[i] = img[j] / 255; input[n + i] = img[j + 1] / 255; input[2 * n + i] = img[j + 2] / 255; }
  const out = await m.sess.run({ [inName]: new m.ort.Tensor('float32', input, [1, 3, S, S]) });
  const o = out[outName];
  const dets = LD.decodeOutput(o.data, o.dims, lb, sw, sh, MIN_BOX, IOU, m.classes);
  const px = (x, y) => { if (x < 0 || y < 0 || x >= sw || y >= sh) return null; const i = (Math.round(y * lb.scale + lb.padY) * S + Math.round(x * lb.scale + lb.padX)) * 3; return [img[i], img[i + 1], img[i + 2]]; };
  const done = LE.unitCheck(dets, px, sw, sh, stn.assembly);
  if (done) dets.push(done);
  return dets;
}

// Small RGBA for the zone signals (the page processes a few thousand pixels per frame).
function smallRgba(rgb, w, h) {
  const sw = Math.max(16, Math.round(w / 4)), sh = Math.max(12, Math.round(h / 4)), out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const i = ((y * 4) * w + x * 4) * 3, o = (y * sw + x) * 4; out[o] = rgb[i]; out[o + 1] = rgb[i + 1]; out[o + 2] = rgb[i + 2]; out[o + 3] = 255; }
  return { data: out, w: sw, h: sh };
}

function liveFacts(dir) {
  const f = path.join(dir, 'events.jsonl'), out = { cycleEnd: 0, manual: 0, arrive: 0, mistakes: 0 };
  if (!fs.existsSync(f)) return out;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(l); } catch (x) { continue; }
    if (e.station !== 's2') continue;
    if (e.type === 'cycle_end') out.cycleEnd++;
    if (e.type === 'manual') out.manual++;
    if (e.type === 'substep' && e.substep === stn.arrival && e.move !== 'repeat') out.arrive++;
    if (e.type === 'verdict' && e.kind === 'mistake') out.mistakes++;
  }
  return out;
}

const results = [];
for (const dir of dirs) {
  const video = path.join(dir, 's2.mp4');
  if (!fs.existsSync(video)) { console.error('skip (no s2.mp4): ' + dir); continue; }
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  const setup = (sess.setup && sess.setup.s2) || {};
  const zones = setup.zones || {}, calib = setup.calib || { motion: {}, bright: {} };
  const vid = probe(video), main = fitLong(vid.w, vid.h, S);
  const eng = LE.createStation(stn, { holdFrames: cfg.holdFrames, defaults: cfg.defaults, qaGraceSec: cfg.qaGraceSec, modelClasses: track });
  const chk = LE.createChecker(stn); chk.setRef(setup.ref || null);
  const ut = LE.createUnitTracker(stn, { link: LE.createUnitLink(cfg) });
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', 'fps=' + fps + ',scale=' + main.w + ':' + main.h + ':flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const fb = main.w * main.h * 3;
  const events = [], emit = e => events.push(e);
  let buf = Buffer.alloc(0), i = 0, prevDets = null, prevGray = null, seq = 0, last = 0;
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= fb) {
      const rgb = new Uint8Array(buf.subarray(0, fb)); buf = buf.subarray(fb);
      const t = Math.round(i / fps * 1000); i++; last = t;
      const dets = await infer(rgb, main.w, main.h);
      const sm = smallRgba(rgb, main.w, main.h);
      const r = LE.zoneSignals(sm.data, sm.w, sm.h, prevGray, zones, calib); prevGray = r.gray;
      const cls = LE.steadyClasses(prevDets ? LE.classSignals(prevDets, zones, track) : null, LE.classSignals(dets, zones, track));
      prevDets = dets;
      const sig = LE.mergeSignals(r.signals, cls, null);
      const stp = LE.stepStation(eng, ut, sig, t), evs = stp.events; evs.forEach(emit);
      let motion = null; for (const id of Object.keys(r.signals)) motion = Math.max(motion || 0, r.signals[id].activity || 0);
      const vds = stp.held ? [] : chk.update({ t, events: evs, state: eng.state(), modelOn: true, frame: { id: ++seq, t, dets }, zones, hands: null, motion, idle: false });
      vds.forEach(emit);
      const out = ut.update({ t, present: LE.unitPresent(dets, stn.unitTracker), hand: false, events: evs.concat(vds) });
      for (const e of out) { emit(e); if (e.action === 'end' && e.reset) { eng.abandon(t).forEach(emit); chk.restart(); } }
    }
  }
  ut.stop(last + 1 / fps * 1000).forEach(emit); eng.flush().forEach(emit);
  const ends = events.filter(e => e.type === 'unit' && e.action === 'end');
  const live = liveFacts(dir), complete = ends.filter(u => u.result === 'complete').length;
  results.push({ session: path.basename(dir), sec: +(last / 1000).toFixed(1), frames: i, units: ends.length, complete, incomplete: ends.length - complete,
    replayCycleEnds: events.filter(e => e.type === 'cycle_end').length, live,
    list: ends.map(u => ({ no: u.no, start: +(u.start / 1000).toFixed(1), end: +(u.end / 1000).toFixed(1), result: u.result, done: u.completeT == null ? null : +(u.completeT / 1000).toFixed(1), ended: u.ended, steps: u.steps.length, mistakes: u.mistakes })) });
  const r0 = results[results.length - 1];
  console.error(r0.session + ': ' + r0.sec + ' s, units ' + r0.units + ' (' + r0.complete + ' complete, ' + r0.incomplete + ' incomplete), live cycle_end ' + live.cycleEnd + ', manual ' + live.manual);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1));
else console.log(JSON.stringify(results, null, 1));
process.exit(0);
