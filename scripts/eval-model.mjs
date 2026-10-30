#!/usr/bin/env node
// Is the new model better? Scores a candidate .onnx and the current model on the val and test images of a role's training set.
//   node scripts/eval-model.mjs <role> <candidate.onnx> [--baseline current] [--data-dir <dir>] [--split val|test|both]
// Reads <data-dir>/training/<role> (images/, labels/ YOLO, manifest.json; written by the review page). The split is the same
// one the export uses: by session, a stable hash, plus sessions pinned to test in training/splits.json. Per class it prints
// precision, recall (IoU 0.5) and F1 at the class's confidence threshold, and the change versus the baseline (the model file
// named in wire-line.json models.<role>.file). It never changes the config; promotion is a human edit. Needs ffmpeg on PATH.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openOnnx } from './lib-onnx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = f => { const mod = { exports: {} }; new Function('module', fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'))(mod); return mod.exports; };
const CaptureLib = load('capture-lib.js');
const LiveDetect = load('live-detect.js');

export const IOU_MATCH = 0.5, DEFAULT_CONF = 0.4, NMS_IOU = 0.7;

// ---------- pure scoring ----------
// Boxes are [x1, y1, x2, y2] in any one coordinate system.
export function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy, ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

// One image. gts: [{ cls, box }], dets: [{ cls, conf, box }], conf: number or { cls: number } (else defaultConf).
// Detections below the class threshold are ignored; the rest, most confident first, each take the unmatched same-class
// ground truth with the best IoU at or above minIou. Returns { cls: { tp, fp, fn } } for every class seen on either side.
export function matchImage(gts, dets, conf, minIou, defaultConf) {
  const thr = c => (typeof conf === 'number' ? conf : (conf && conf[c] != null ? conf[c] : (defaultConf == null ? DEFAULT_CONF : defaultConf)));
  const mi = minIou == null ? IOU_MATCH : minIou, out = {};
  const row = c => out[c] || (out[c] = { tp: 0, fp: 0, fn: 0 });
  const used = new Set();
  for (const g of gts) row(g.cls);
  for (const d of dets.filter(x => x.conf >= thr(x.cls)).sort((a, b) => b.conf - a.conf)) {
    let best = -1, bi = 0;
    gts.forEach((g, i) => { if (g.cls !== d.cls || used.has(i)) return; const v = iou(g.box, d.box); if (v >= mi && v > bi) { bi = v; best = i; } });
    if (best >= 0) { used.add(best); row(d.cls).tp++; } else row(d.cls).fp++;
  }
  gts.forEach((g, i) => { if (!used.has(i)) row(g.cls).fn++; });
  return out;
}

export function addCounts(total, one) {
  for (const c of Object.keys(one)) {
    const t = total[c] || (total[c] = { tp: 0, fp: 0, fn: 0 });
    t.tp += one[c].tp; t.fp += one[c].fp; t.fn += one[c].fn;
  }
  return total;
}

// { tp, fp, fn } -> { precision, recall, f1 }; a ratio with nothing under it is null (not 0).
export function prf({ tp, fp, fn }) {
  const precision = tp + fp ? tp / (tp + fp) : null, recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision != null && recall != null && precision + recall > 0 ? 2 * precision * recall / (precision + recall) : (tp + fp + fn ? 0 : null);
  return { precision, recall, f1 };
}

// Rows for the report, one per class (config order first), with a final "all" row summed over classes (micro average).
export function summarize(counts, classes) {
  const names = [...classes, ...Object.keys(counts).filter(c => !classes.includes(c)).sort()].filter(c => counts[c]);
  const rows = names.map(c => Object.assign({ cls: c }, counts[c], prf(counts[c])));
  const all = { tp: 0, fp: 0, fn: 0 };
  for (const r of rows) { all.tp += r.tp; all.fp += r.fp; all.fn += r.fn; }
  rows.push(Object.assign({ cls: 'all' }, all, prf(all)));
  return rows;
}

// YOLO label text -> [{ cls, box }] in normalized corners.
export function parseLabels(text, classes) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const p = line.trim().split(/\s+/).map(Number);
    if (p.length < 5 || p.some(v => !Number.isFinite(v))) continue;
    const [i, cx, cy, w, h] = p;
    out.push({ cls: classes[i] || ('class_' + i), box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] });
  }
  return out;
}

export function confFor(cfg, role, cls) {
  const m = cfg && cfg.models && cfg.models[role];
  if (m && m.classConf && typeof m.classConf[cls] === 'number') return m.classConf[cls];
  const d = cfg && cfg.defaults && cfg.defaults.class;
  return typeof d === 'number' ? d : DEFAULT_CONF;
}

// ---------- set, model, run ----------
// Which images are in the chosen split(s): [{ name, session }].
export function pickImages(man, pinned, which) {
  const want = which === 'both' ? ['val', 'test'] : [which];
  return Object.keys(man.images).sort()
    .map(name => ({ name, session: man.images[name].session, split: CaptureLib.sessionSplit(man.images[name].session, pinned) }))
    .filter(x => want.includes(x.split));
}

function jpegSize(buf) { // width and height from the JPEG header (SOF marker)
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('Not a readable JPEG.');
}

// Decodes a JPEG with ffmpeg, letterboxed to size x size on the same gray the page uses. Returns { rgb, w, h, lb }.
function decodeLetterboxed(file, size) {
  const { w, h } = jpegSize(fs.readFileSync(file));
  const lb = LiveDetect.letterbox(w, h, size);
  const vf = `scale=${lb.nw}:${lb.nh},pad=${size}:${size}:${lb.padX}:${lb.padY}:color=0x727272`;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: size * size * 3 + 4096 });
  if (r.status !== 0 || r.stdout.length < size * size * 3) throw new Error('ffmpeg could not decode ' + file);
  return { rgb: r.stdout, w, h, lb };
}

async function detect(model, img) {
  const size = model.size, plane = size * size, inp = new Float32Array(3 * plane), px = img.rgb;
  for (let i = 0; i < plane; i++) { inp[i] = px[i * 3] / 255; inp[plane + i] = px[i * 3 + 1] / 255; inp[2 * plane + i] = px[i * 3 + 2] / 255; }
  const res = await model.sess.run({ images: new model.ort.Tensor('float32', inp, [1, 3, size, size]) });
  const t = res[Object.keys(res)[0]];
  // minConf 0.05 keeps everything any class threshold could want; matchImage applies the real threshold
  return LiveDetect.decodeOutput(t.data, t.dims, img.lb, img.w, img.h, 0.05, NMS_IOU, model.classes).map(d => ({ cls: d.cls, conf: d.conf, box: d.nbox }));
}

// Scores one model over decoded images. Returns { cls: { tp, fp, fn } }.
async function score(model, items, confOf) {
  const total = {};
  for (const it of items) {
    const dets = await detect(model, it.img);
    const conf = {};
    for (const c of new Set([...it.gts.map(g => g.cls), ...dets.map(d => d.cls)])) conf[c] = confOf(c);
    addCounts(total, matchImage(it.gts, dets, conf));
  }
  return total;
}

// ---------- report ----------
const pct = v => (v == null ? '  n/a' : (v * 100).toFixed(1).padStart(5));
const dlt = (a, b) => (a == null || b == null ? '  n/a' : ((a - b) * 100 >= 0 ? '+' : '') + ((a - b) * 100).toFixed(1));
export function report(role, candRows, baseRows, info) {
  const L = [];
  L.push(`Role ${role}: ${info.images} images (${info.split}), ${info.sessions} sessions, ${info.negatives} negatives. IoU ${IOU_MATCH}.`);
  L.push(`Candidate: ${info.candidate}` + (baseRows ? `   Baseline: ${info.baseline}` : ''));
  const head = 'class'.padEnd(18) + ' ' + ['gt', 'P%', 'R%', 'F1%'].map(h => h.padStart(6)).join(' ');
  L.push(baseRows ? head + '   |  baseline P/R/F1  |  delta P/R/F1 (points)' : head);
  for (const r of candRows) {
    const b = baseRows && baseRows.find(x => x.cls === r.cls);
    let line = r.cls.padEnd(18) + ' ' + String(r.tp + r.fn).padStart(6) + ' ' + [r.precision, r.recall, r.f1].map(v => pct(v).padStart(6)).join(' ');
    if (baseRows) line += '   |  ' + (b ? [b.precision, b.recall, b.f1].map(pct).join(' ') : '  n/a   n/a   n/a') + '  |  ' + (b ? [dlt(r.precision, b.precision), dlt(r.recall, b.recall), dlt(r.f1, b.f1)].map(s => s.padStart(6)).join(' ') : '');
    L.push(line);
  }
  return L.join('\n');
}

// ---------- cli ----------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--help') { a.help = true; continue; }
    if (!k.startsWith('--')) { a._.push(k); continue; }
    if (i + 1 >= argv.length) throw new Error(k + ' needs a value');
    a[k.slice(2)] = argv[++i];
  }
  return a;
}
const USAGE = 'Usage: node scripts/eval-model.mjs <role> <candidate.onnx> [--baseline current] [--data-dir <dir>] [--split val|test|both]';
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message + '\n' + USAGE); process.exit(1); }
  if (a.help) { console.log(USAGE); return; }
  const [role, cand] = a._;
  if (!/^s[1-4]$/.test(role || '') || !cand || a._.length > 2) { console.error(USAGE); process.exit(1); }
  const split = a.split || 'both';
  if (!['val', 'test', 'both'].includes(split)) { console.error('--split is val, test or both.\n' + USAGE); process.exit(1); }
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) { console.error('ffmpeg is not installed or not on PATH (macOS: brew install ffmpeg).'); process.exit(1); }
  if (!fs.existsSync(cand)) { console.error('Candidate model not found: ' + cand); process.exit(1); }

  const dataDir = path.resolve(a['data-dir'] || process.env.DATA_DIR || path.join(ROOT, 'data'));
  const cfgFile = [path.join(dataDir, 'meta', 'wire-line.json'), path.join(ROOT, 'data', 'meta', 'wire-line.json')].find(f => fs.existsSync(f));
  const cfg = readJson(cfgFile), mcfg = cfg.models && cfg.models[role];
  if (!mcfg || !Array.isArray(mcfg.classes)) { console.error('No models.' + role + ' entry with classes in wire-line.json.'); process.exit(1); }
  const tdir = path.join(dataDir, 'training', role);
  let man = null;
  try { man = readJson(path.join(tdir, 'manifest.json')); } catch (e) { /* none */ }
  if (!man || !man.images || !Object.keys(man.images).length) { console.error('The training set for ' + role + ' is empty (' + tdir + '). Review some captures at /review first.'); process.exit(1); }
  if (man.classes && man.classes.length && JSON.stringify(man.classes) !== JSON.stringify(mcfg.classes)) { console.error('The training set classes for ' + role + ' differ from wire-line.json models.' + role + '.classes. Scores would be wrong; fix the set or the config first.'); process.exit(1); }
  let pinned = {};
  try { pinned = readJson(path.join(dataDir, 'training', 'splits.json')).sessions || {}; } catch (e) { /* none */ }
  const picked = pickImages(man, pinned, split);
  if (!picked.length) { console.error(`No ${split} images yet for ${role} (${Object.keys(man.images).length} images are all in train). Review more sessions, or pin one to test.`); process.exit(1); }

  const baseArg = a.baseline || 'current';
  const baseFile = baseArg === 'current' ? (mcfg.file ? path.join(ROOT, 'app', mcfg.file.replace(/^\/+/, '')) : null) : baseArg;
  if (baseFile && !fs.existsSync(baseFile)) { console.error('Baseline model not found: ' + baseFile); process.exit(1); }

  const items = picked.map(p => {
    const imgFile = path.join(tdir, 'images', p.name + '.jpg');
    return { name: p.name, img: decodeLetterboxed(imgFile, mcfg.imgsz || 640), gts: parseLabels(fs.readFileSync(path.join(tdir, 'labels', p.name + '.txt'), 'utf8'), mcfg.classes) };
  });
  const confOf = c => confFor(cfg, role, c);
  const candModel = await openOnnx(path.resolve(cand), mcfg.classes, mcfg.imgsz);
  const candRows = summarize(await score(candModel, items, confOf), mcfg.classes);
  let baseRows = null;
  if (baseFile) {
    const bm = await openOnnx(baseFile, mcfg.classes, mcfg.imgsz);
    baseRows = summarize(await score(bm, items, confOf), mcfg.classes);
  } else console.log('No baseline model is configured for ' + role + '; showing the candidate alone.');
  const info = { images: picked.length, split, sessions: new Set(picked.map(p => p.session)).size, negatives: items.filter(i => !i.gts.length).length, candidate: path.resolve(cand), baseline: baseFile };
  const nSplit = s => picked.filter(p => p.split === s).length;
  console.log(report(role, candRows, baseRows, info));
  console.log(`Images: val ${nSplit('val')}, test ${nSplit('test')}. Thresholds: ${mcfg.classes.map(c => c + ' ' + confOf(c)).join(', ')}.`);
  console.log('Config was not changed. To promote: copy the .onnx to app/models/, set models.' + role + '.file and a new version.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
