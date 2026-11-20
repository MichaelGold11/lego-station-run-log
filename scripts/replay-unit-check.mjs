#!/usr/bin/env node
// Replay harness for the Station 2 "unit complete" check (LineEngine.unitCheck).
//   node scripts/replay-unit-check.mjs <video> [--fps 3] [--long 640] [--out file.csv] [--zoom 4] [--src-long 1920]
// Decodes the video with one ffmpeg process (rgb24 pipe), runs the S2 model with the page's own letterbox and decoder
// (LiveDetect), then calls the real unitCheck with a pixel reader built the way app/line.html builds it: it reads the
// 640x640 letterboxed model canvas, at Math.round(y * scale + padY), Math.round(x * scale + padX), and returns null outside the frame.
// Per frame it also writes diagnostics from an instrumented copy of the gates and asserts the verdict equals the real one.
//   --long N     long side of "what the system sees" (0 = the video's own size). Default 640.
//   --zoom K     when a closed connector at 0.3+ exists, crop K times its larger side around it from the same frame, run the model, record zopen,zclosed.
//   --src-long M decode at long side M, downscale in JS (area average) to --long for the main pass; the zoom crop is also taken from the M frame (hopen,hclosed).
// Needs ffmpeg and ffprobe on PATH. Frames are placed at t = i / fps.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openOnnx } from './lib-onnx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = f => { const mod = { exports: {} }; new Function('module', fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'))(mod); return mod.exports; };
const LD = load('live-detect.js');
const LE = load('line-engine.js');
const O = LE.ASSEMBLY;
const FLOOR = 0.05, MIN_BOX = 0.25, IOU = 0.7, ZOOM_MIN = 0.3;

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = { fps: 3, long: 640, zoom: 0, srcLong: 0, out: '' };
let video = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--fps') opt.fps = +argv[++i];
  else if (a === '--long') opt.long = +argv[++i];
  else if (a === '--zoom') opt.zoom = +argv[++i];
  else if (a === '--src-long') opt.srcLong = +argv[++i];
  else if (a === '--out') opt.out = argv[++i];
  else if (!video) video = a;
}
if (!video) { console.error('Usage: node scripts/replay-unit-check.mjs <video> [--fps 3] [--long 640] [--out file.csv] [--zoom 4] [--src-long 1920]'); process.exit(2); }

// ---------- video geometry ----------
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation:stream_tags=rotate', '-of', 'json', file], { encoding: 'utf8' });
  const s = JSON.parse(r.stdout).streams[0];
  let rot = 0;
  for (const sd of s.side_data_list || []) if (sd.rotation != null) rot = +sd.rotation;
  if (s.tags && s.tags.rotate != null) rot = +s.tags.rotate;
  const swap = Math.abs(rot) % 180 === 90;
  return { w: swap ? s.height : s.width, h: swap ? s.width : s.height };
}
const even = v => Math.max(2, Math.round(v / 2) * 2);
function fitLong(w, h, L) { if (!L) return { w: even(w), h: even(h) }; const s = L / Math.max(w, h); return { w: even(w * s), h: even(h * s) }; }

// ---------- resampling (RGB, 3 bytes per pixel) ----------
// Copies the source rectangle (x0, y0, cw, ch) into a dw x dh image. Shrinking averages the covered source pixels
// (a close stand-in for the browser's drawImage), enlarging is bilinear.
function resize(src, sw, sh, x0, y0, cw, ch, dw, dh) {
  const out = new Uint8Array(dw * dh * 3), fx = cw / dw, fy = ch / dh;
  const clampX = v => (v < 0 ? 0 : v > sw - 1 ? sw - 1 : v), clampY = v => (v < 0 ? 0 : v > sh - 1 ? sh - 1 : v);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) * 3;
      if (fx > 1 || fy > 1) {
        const xa = Math.floor(clampX(x0 + x * fx)), xb = Math.max(xa + 1, Math.min(sw, Math.ceil(x0 + (x + 1) * fx)));
        const ya = Math.floor(clampY(y0 + y * fy)), yb = Math.max(ya + 1, Math.min(sh, Math.ceil(y0 + (y + 1) * fy)));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) { const i = (yy * sw + xx) * 3; r += src[i]; g += src[i + 1]; b += src[i + 2]; n++; }
        out[o] = r / n + 0.5; out[o + 1] = g / n + 0.5; out[o + 2] = b / n + 0.5;
      } else {
        const sx = clampX(x0 + (x + 0.5) * fx - 0.5), sy = clampY(y0 + (y + 0.5) * fy - 0.5);
        const xa = Math.floor(sx), ya = Math.floor(sy), xb = Math.min(sw - 1, xa + 1), yb = Math.min(sh - 1, ya + 1), tx = sx - xa, ty = sy - ya;
        for (let c = 0; c < 3; c++) {
          const v = (src[(ya * sw + xa) * 3 + c] * (1 - tx) + src[(ya * sw + xb) * 3 + c] * tx) * (1 - ty) + (src[(yb * sw + xa) * 3 + c] * (1 - tx) + src[(yb * sw + xb) * 3 + c] * tx) * ty;
          out[o + c] = v + 0.5;
        }
      }
    }
  }
  return out;
}

// ---------- model ----------
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/meta/wire-line.json'), 'utf8'));
const mcfg = cfg.models.s2, stn = cfg.stations.find(s => s.id === 's2'), spec = stn.assembly;
const S = mcfg.imgsz || 640;
const m = await openOnnx(path.join(ROOT, 'app', mcfg.file.replace(/^\//, '')), mcfg.classes, S);
const inName = m.sess.inputNames[0], outName = m.sess.outputNames[0];

// Letterboxes an RGB frame the way the page does (gray 114 canvas, frame drawn at padX, padY) and runs the model.
// Returns { dets (floor 0.05), img (S*S*3 letterboxed canvas), lb }.
async function infer(rgb, sw, sh) {
  const lb = LD.letterbox(sw, sh, S);
  const img = new Uint8Array(S * S * 3).fill(114);
  const fit = lb.nw === sw && lb.nh === sh ? rgb : resize(rgb, sw, sh, 0, 0, sw, sh, lb.nw, lb.nh);
  for (let y = 0; y < lb.nh; y++) img.set(fit.subarray(y * lb.nw * 3, (y + 1) * lb.nw * 3), ((y + lb.padY) * S + lb.padX) * 3);
  const n = S * S, input = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 3) { input[i] = img[j] / 255; input[n + i] = img[j + 1] / 255; input[2 * n + i] = img[j + 2] / 255; }
  const out = await m.sess.run({ [inName]: new m.ort.Tensor('float32', input, [1, 3, S, S]) });
  const o = out[outName];
  const dets = LD.decodeOutput(o.data, o.dims, lb, sw, sh, FLOOR, IOU, m.classes);
  return { dets, img, lb };
}
// The page's pixel reader, verbatim in meaning: reads the letterboxed canvas, null outside the source frame.
const makePx = (img, lb, sw, sh) => (x, y) => {
  if (x < 0 || y < 0 || x >= sw || y >= sh) return null;
  const i = (Math.round(y * lb.scale + lb.padY) * S + Math.round(x * lb.scale + lb.padX)) * 3;
  return [img[i], img[i + 1], img[i + 2]];
};

// ---------- instrumented gates (a copy of unitCheck, same order) ----------
const bestOf = (dets, cls, min) => dets.filter(d => d.cls === cls && d.conf >= min && d.nbox).sort((a, b) => b.conf - a.conf)[0] || null;
const bestConf = (dets, cls) => dets.reduce((a, d) => (d.cls === cls && d.conf > a ? d.conf : a), 0);
function geom(d, W, H) { const [a, b, c, e] = d.nbox; return { x0: a * W, y0: b * H, x1: c * W, y1: e * H, cx: (a + c) / 2 * W, cy: (b + e) / 2 * H, w: (c - a) * W, h: (e - b) * H }; }
function wireEnds(b) {
  if (b.w > 3 * b.h) return [[b.x0, b.cy], [b.x1, b.cy]];
  if (b.h > 3 * b.w) return [[b.cx, b.y0], [b.cx, b.y1]];
  return [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]];
}
// darkLine with per-ring detail: score, hit flags, and for each ring the angle (deg, relative to the wire direction) of the darkest hit.
function darkDetail(px, c, dir, o) {
  const R = Math.max(c.w, c.h) / 2, a0 = Math.atan2(dir[1], dir[0]), half = o.arc * Math.PI / 180;
  let hits = 0, flags = '';
  const angles = [];
  for (let k = 0; k < o.rings; k++) {
    const r = R * (o.ringIn + (o.ringOut - o.ringIn) * k / (o.rings - 1)), n = Math.max(24, Math.round(2 * half * r)), cols = [], as = [];
    for (let i = 0; i <= n; i++) { const a = a0 - half + 2 * half * i / n, p = px(c.cx + r * Math.cos(a), c.cy + r * Math.sin(a)); if (p) { cols.push(p); as.push(a); } }
    if (cols.length < 8) { flags += '0'; angles.push('-'); continue; }
    const med = cols.map(p => Math.max(p[0], p[1], p[2])).sort((x, y) => x - y)[cols.length >> 1];
    let bestV = Infinity, bestA = null;
    cols.forEach((p, i) => { const v = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]); if (v < med * o.dark && (v - mn) / (v || 1) < o.sat && v < bestV) { bestV = v; bestA = as[i]; } });
    if (bestA != null) { hits++; flags += '1'; angles.push(String(Math.round((bestA - a0) * 180 / Math.PI))); } else { flags += '0'; angles.push('-'); }
  }
  return { score: hits / o.rings, flags, angles: angles.join('|') };
}
// -> { gate, dark, rings, angles, closed (best >= 0.6 detection) }
function diagnose(dets, px, W, H) {
  const out = { gate: 'pass', dark: null, rings: '', angles: '', cbox: null };
  const closed = bestOf(dets, spec.closed, O.closed), openD = bestOf(dets, spec.open, O.open);
  const closedAny = bestOf(dets, spec.closed, ZOOM_MIN);
  if (closedAny) { const c = geom(closedAny, W, H); out.cbox = [c.cx / W, c.cy / H, c.w / W, c.h / H]; }
  // dark line whenever a closed connector and both wires exist
  const ws = spec.wires.map(cls => bestOf(dets, cls, O.wire));
  const cl = closed || null;
  if (cl && ws.every(Boolean) && spec.darkWire) {
    const c = geom(cl, W, H), far = ws.map(w => { const b = geom(w, W, H), dist = e => Math.hypot(e[0] - c.cx, e[1] - c.cy); return [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].sort((p, q) => dist(q) - dist(p))[0]; });
    const mx = far.reduce((a, p) => a + p[0], 0) / far.length, my = far.reduce((a, p) => a + p[1], 0) / far.length;
    const dd = darkDetail(px, c, [mx - c.cx, my - c.cy], O);
    out.dark = dd.score; out.rings = dd.flags; out.angles = dd.angles;
  }
  if (!closed) { out.gate = 'no_closed'; return out; }
  if (openD) { out.gate = 'open_present'; return out; }
  const c = geom(closed, W, H), R = Math.max(c.w, c.h) / 2;
  for (let i = 0; i < spec.wires.length; i++) {
    const w = ws[i];
    if (!w) { out.gate = i === 0 ? 'no_red' : 'no_white'; return out; }
    const b = geom(w, W, H), dist = e => Math.hypot(e[0] - c.cx, e[1] - c.cy);
    if (Math.min.apply(null, wireEnds(b).map(dist)) / R > O.endTol) { out.gate = 'end_far'; return out; }
  }
  if (spec.darkWire && out.dark < O.minDark) { out.gate = 'dark'; return out; }
  return out;
}

// ---------- decode loop ----------
const vid = probe(video);
const main = fitLong(vid.w, vid.h, opt.long);
const dec = opt.srcLong ? fitLong(vid.w, vid.h, opt.srcLong) : main;
const vf = 'fps=' + opt.fps + (dec.w !== vid.w || dec.h !== vid.h ? ',scale=' + dec.w + ':' + dec.h + ':flags=area' : '');
const ff = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
const frameBytes = dec.w * dec.h * 3;
async function* frames() {
  let buf = Buffer.alloc(0);
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= frameBytes) { yield new Uint8Array(buf.subarray(0, frameBytes)); buf = buf.subarray(frameBytes); }
  }
}

const f3 = v => (v == null ? '' : (Math.round(v * 1000) / 1000).toString());
const cols = ['t', 'closed', 'open', 'red', 'white', 'black', 'gate', 'dark', 'rings', 'angles', 'fired', 'fired2'];
if (opt.zoom) cols.push('zopen', 'zclosed');
if (opt.srcLong) cols.push('hopen', 'hclosed');
cols.push('cx', 'cy', 'cw', 'ch');
const lines = [cols.join(',')];

// Experiment only (not in the engine): square crop of K times the box's larger side, centered on it, clamped into the frame.
const SECOND_MIN_LONG = 960, SECOND_ZOOM = 4;
function cropRect(nbox, W, H, K) {
  const bw = (nbox[2] - nbox[0]) * W, bh = (nbox[3] - nbox[1]) * H, cx = (nbox[0] + nbox[2]) / 2 * W, cy = (nbox[1] + nbox[3]) / 2 * H;
  const side = Math.min(K * Math.max(bw, bh), W, H);
  return { x: Math.max(0, Math.min(W - side, cx - side / 2)), y: Math.max(0, Math.min(H - side, cy - side / 2)), side };
}
async function cropLook(rgb, fw, fh, nbox, K) {
  const c = cropRect(nbox, fw, fh, K);
  const sq = resize(rgb, fw, fh, c.x, c.y, c.side, c.side, S, S);
  const r = await infer(sq, S, S);
  return { dets: r.dets, open: bestConf(r.dets, spec.open), closed: bestConf(r.dets, spec.closed) };
}
const cboxToN = c => [c[0] - c[2] / 2, c[1] - c[3] / 2, c[0] + c[2] / 2, c[1] + c[3] / 2];
const zoomLook = (rgb, fw, fh, cbox, K) => cropLook(rgb, fw, fh, cboxToN(cbox), K);

let i = 0, nFire = 0, nFire2 = 0, mismatches = 0;
for await (const raw of frames()) {
  const t = i / opt.fps; i++;
  const rgb = opt.srcLong ? resize(raw, dec.w, dec.h, 0, 0, dec.w, dec.h, main.w, main.h) : raw;
  const { dets, img, lb } = await infer(rgb, main.w, main.h);
  const px = makePx(img, lb, main.w, main.h);
  const real = LE.unitCheck(dets.filter(d => d.conf >= MIN_BOX), px, main.w, main.h, spec);
  const dg = diagnose(dets, px, main.w, main.h);
  if ((dg.gate === 'pass') !== !!real) { mismatches++; console.error('VERDICT MISMATCH at t=' + t.toFixed(2) + ': instrumented ' + dg.gate + ' real ' + (real ? 'fire' : 'null')); process.exit(3); }
  if (real) nFire++;
  // Second look: only on a fired frame, only when the station has one and the full-size picture is large enough; the crop comes from the --src-long frame.
  let fired2 = real ? 1 : 0;
  if (real && Math.max(dec.w, dec.h) >= SECOND_MIN_LONG) {
    const z = await cropLook(raw, dec.w, dec.h, real.nbox, opt.zoom || SECOND_ZOOM);
    fired2 = bestConf(z.dets.filter(d => d.conf >= MIN_BOX), spec.open) < O.open ? 1 : 0;
  }
  if (fired2) nFire2++;
  const row = [t.toFixed(2), f3(bestConf(dets, spec.closed)), f3(bestConf(dets, spec.open)), f3(bestConf(dets, 'red_wire')), f3(bestConf(dets, 'white_wire')), f3(bestConf(dets, 'black_wire')),
    dg.gate, f3(dg.dark), dg.rings, dg.angles, real ? 1 : 0, fired2];
  if (opt.zoom) {
    if (dg.cbox) { const z = await zoomLook(rgb, main.w, main.h, dg.cbox, opt.zoom); row.push(f3(z.open), f3(z.closed)); } else row.push('', '');
  }
  if (opt.srcLong) {
    if (dg.cbox) { const z = await zoomLook(raw, dec.w, dec.h, dg.cbox, opt.zoom || 4); row.push(f3(z.open), f3(z.closed)); } else row.push('', '');
  }
  if (dg.cbox) row.push(...dg.cbox.map(f3)); else row.push('', '', '', '');
  lines.push(row.join(','));
}
const text = lines.join('\n') + '\n';
if (opt.out) fs.writeFileSync(opt.out, text); else process.stdout.write(text);
console.error(path.basename(video) + ': ' + (i) + ' frames, ' + main.w + 'x' + main.h + (opt.srcLong ? ' (src ' + dec.w + 'x' + dec.h + ')' : '') + ', fired ' + nFire + ', fired2 ' + nFire2 + ', verdict mismatches ' + mismatches);
process.exit(0);
