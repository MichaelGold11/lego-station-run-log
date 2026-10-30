// Local server for the wire line platform. No dependencies; Node 18 or newer.
// Serves the wire line page (/line, also where / goes) and its session store (data/sessions/<id>/), and on a second
// port, over HTTPS on the local network, the phone camera page (/phone, any phone or tablet) that streams a phone's camera into /line.
// Also the archived LEGO run log (/runs): its app, a small JSON document store (data/<collection>/<id>.json) and the
// uploaded files (data/assets/<id>.<ext>).
//
//   npm start                  -> http://localhost:4173 (the wire line), and https://<this laptop>:4174/phone for phones and tablets
//   PORT=5000 npm start        -> another port
//   PHONE_PORT=4175 npm start  -> another port for the phone page (PHONE_PORT=off: no phone page)
//   DATA_DIR=/tmp/x npm start  -> another data folder (the tests use this)

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensurePhoneCert, lanAddresses, localNames } from './scripts/phone-cert.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const ASSETS = path.join(DATA, 'assets');
const APP_FILE = path.join(ROOT, 'app', 'lego-station-run-log.html');
const RUNTIME_FILE = path.join(ROOT, 'app', 'local-runtime.js');
const PORT = Number(process.env.PORT) || 4173;
const MAX_UPLOAD = 500 * 1024 * 1024;

// /live runs the YOLO model and the hand model in the browser. WASM threads need cross-origin isolation, so /live and its
// vendor and model files carry COOP and COEP (credentialless keeps the Google Fonts link working). /runs is left alone.
// Libraries come from node_modules (npm install); if that is missing the request is sent on to the pinned jsdelivr copy.
const ISOLATE = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Resource-Policy': 'same-origin' };
const DEPS = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies || {}; } catch (e) { return {}; } })();
const VENDOR = {
  '/vendor/ort/': { dir: path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist'), cdn: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + DEPS['onnxruntime-web'] + '/dist/' },
  '/vendor/mediapipe/': { dir: path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision'), cdn: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + DEPS['@mediapipe/tasks-vision'] + '/' }
};
const MODELS = path.join(ROOT, 'app', 'models');

// Wire line (/line): config, per-station setup and recorded sessions. The CSV exports use the same engine as the page.
const SESSIONS = path.join(DATA, 'sessions');
const SETUP_FILE = path.join(DATA, 'meta', 'wire-line-setup.json');
const STANDARD_FILE = path.join(DATA, 'meta', 'wire-line-standard.json');    // tracked in the repo's data/meta: the standard zones per role, shared through git
const LAYOUTS_FILE = path.join(DATA, 'meta', 'wire-line-layouts.json');    // saved floor layouts and the active one (git-ignored)
const LineEngine = (() => { const mod = { exports: {} }; new Function('module', fs.readFileSync(path.join(ROOT, 'app', 'line-engine.js'), 'utf8'))(mod); return mod.exports; })();
const SESSION_ID = /^\d{8}-\d{6}-[a-f0-9]{4}$/;
const STATION_ID = /^[a-z][a-z0-9_]{0,15}$/;
const SETUP_KEY = /^([a-z][a-z0-9_]{0,15})(?::([a-z][a-z0-9_]{0,15}))?$/;    // "s2", or "s5:s4" (station s5 running role s4)
const LAYOUT_ID = /^l-[a-f0-9]{8}$/;
const MAX_STATIONS = 100;    // per layout: a sanity limit on the request, not a design cap
const VIDEO_EXT = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv' };
const PHONE_PORT = process.env.PHONE_PORT === 'off' ? 0 : Number(process.env.PHONE_PORT) || 4174;
const CERT_DIR = path.join(DATA, 'phone-cert');

// The same minimal page skeleton the claude.ai artifact viewer wraps around the app.
const HEAD = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<style>:root{color-scheme:light;box-sizing:border-box}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}[hidden]{display:none!important}</style>'
  + '<script src="/local-runtime.js"></script></head><body>\n';

const TYPES = {
  '.mp4': 'video/mp4', '.mov': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.task': 'application/octet-stream'
};
const EXT_FOR_TYPE = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const SEG = /^[A-Za-z0-9_.~:@+-]{1,200}$/;
function docPath(segs) {
  // Even segment count: collection/doc[/collection/doc]. Each segment is checked so nothing leaves data/.
  if (!segs.length || segs.length % 2 || segs.some(s => !SEG.test(s) || s === '.' || s === '..') || segs[0] === 'assets') return null;
  return path.join(DATA, ...segs) + '.json';
}
function collPath(segs) {
  if (!segs.length || segs.length % 2 === 0 || segs.some(s => !SEG.test(s) || s === '.' || s === '..') || segs[0] === 'assets') return null;
  return path.join(DATA, ...segs);
}
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, f);
}
// Nested objects merge; arrays and everything else replace; {"__delete__": true} removes a field.
function merge(base, patch) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.__delete__ === true) delete out[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = merge(out[k], v);
    else out[k] = v;
  }
  return out;
}
function findAsset(id) {
  if (!/^[a-f0-9]{32}$/.test(id) || !fs.existsSync(ASSETS)) return null;
  const f = fs.readdirSync(ASSETS).find(n => n.startsWith(id + '.'));
  return f ? path.join(ASSETS, f) : null;
}
const hasFfmpeg = (() => { try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; } catch (e) { return false; } })();

// Every stored video is re-encoded to H.264 at most 1280 px tall: it plays in every browser
// (iPhone HEVC files do not play in Chrome or Edge) and keeps the repo small.
function normalizeVideo(src, id) {
  const out = path.join(ASSETS, id + '.mp4');
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', src, '-vf', "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out]);
  if (r.status !== 0) { try { fs.unlinkSync(out); } catch (e) { /* none */ } return null; }
  return out;
}

function send(res, code, body, type = 'application/json', extra) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' }, extra));
  res.end(buf);
}
const fail = (res, code, err, message) => send(res, code, { code: err, message });
// drain: past the limit, keep reading (and dropping) up to 8 times the limit before failing, so the caller can still send a clean 413.
function readBody(req, limit, drain) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, over = false;
    req.on('data', c => {
      n += c.length;
      if (over) { if (n > limit * 8) req.destroy(); return; }
      if (n > limit) {
        if (drain) { over = true; chunks.length = 0; return; }
        reject(Object.assign(new Error('too large'), { code: 'too_large' })); req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => over ? reject(Object.assign(new Error('too large'), { code: 'too_large' })) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function serveFile(req, res, file, type, extra) {
  const stat = fs.statSync(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    // Video seeking needs byte ranges.
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    if (start >= stat.size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); return res.end(); }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, Object.assign({ 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes' }, extra));
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, Object.assign({ 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' }, extra));
  fs.createReadStream(file).pipe(res);
}

// Local-only guard: a rebinding page has a foreign Host, a cross-site POST has a foreign Origin.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'].map(h => h + ':' + PORT);
async function handle(req, res) {
  if (!LOCAL_HOSTS.includes(req.headers.host)) return fail(res, 403, 'bad_host', 'This server only answers on localhost.');
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== undefined && !LOCAL_HOSTS.some(h => req.headers.origin === 'http://' + h)) return fail(res, 403, 'bad_origin', 'Cross-site requests are not allowed.');
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  // The front door is the wire line. The LEGO run log (the first study: one station's videos analyzed by an agent)
  // lives at /runs; it uses hash routes and absolute paths, so it works there unchanged.
  if (p === '/' || p === '/index.html') { res.writeHead(302, { Location: '/line' + url.search }); return res.end(); }
  if (p === '/runs') {
    const html = HEAD + fs.readFileSync(APP_FILE, 'utf8') + '\n</body></html>';
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (p === '/live') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'live-mock.html')), 'text/html; charset=utf-8', ISOLATE);
  if (p === '/live-engine.js') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'live-engine.js')), 'text/javascript; charset=utf-8', ISOLATE);
  if (p === '/live-detect.js') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'live-detect.js')), 'text/javascript; charset=utf-8', ISOLATE);
  const vend = Object.keys(VENDOR).find(k => p.startsWith(k));
  if (vend || p.startsWith('/models/')) {
    const rel = p.slice(vend ? vend.length : 8);
    if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(rel) || rel.includes('..')) return fail(res, 400, 'invalid_argument', 'Bad file path.');
    const f = path.join(vend ? VENDOR[vend].dir : MODELS, rel);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(req, res, f, TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', Object.assign({ 'Cache-Control': vend ? 'public, max-age=3600' : 'no-store' }, ISOLATE));
    if (vend) { res.writeHead(302, { Location: VENDOR[vend].cdn + rel }); return res.end(); }
    return fail(res, 404, 'not_found', 'No such model file.');
  }
  if (p === '/line') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'line.html')), 'text/html; charset=utf-8', ISOLATE);
  if (p === '/review') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'review.html')), 'text/html; charset=utf-8', ISOLATE);
  if (p === '/line-engine.js') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'line-engine.js')), 'text/javascript; charset=utf-8', ISOLATE);
  if (p === '/line-hands-worker.js') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'line-hands-worker.js')), 'text/javascript; charset=utf-8', ISOLATE);
  if (p === '/vendor/qrcode.js') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'vendor', 'qrcode.js')), 'text/javascript; charset=utf-8', ISOLATE);
  if (p.startsWith('/api/line/')) return lineApi(req, res, p);
  if (p.startsWith('/api/phone/')) return phoneApi(req, res, p);
  if (p === '/api/sessions' || p.startsWith('/api/sessions/')) return sessionsApi(req, res, p, url);
  if (p === '/api/training' || p.startsWith('/api/training/')) return trainingApi(req, res, p);
  if (p === '/local-runtime.js') return send(res, 200, fs.readFileSync(RUNTIME_FILE), 'text/javascript; charset=utf-8');
  if (p === '/api/info') return send(res, 200, { ffmpeg: hasFfmpeg, root: ROOT });

  if (p.startsWith('/_blob/')) {
    const f = findAsset(p.slice(7));
    if (!f) return fail(res, 404, 'not_found', 'No stored file with that id.');
    return serveFile(req, res, f, TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream');
  }

  if (p === '/api/assets' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, MAX_UPLOAD); } catch (e) { return fail(res, 413, 'too_large', 'Files over 500 MB are refused.'); }
    if (!body.length) return fail(res, 400, 'invalid_request', 'The upload was empty.');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const name = String(req.headers['x-filename'] || '');
    const id = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(ASSETS, { recursive: true });
    if (type.startsWith('video/')) {
      const ext = path.extname(name).toLowerCase() || EXT_FOR_TYPE[type] || '.mp4';
      const raw = path.join(ASSETS, id + '.upload' + ext);
      fs.writeFileSync(raw, body);
      let stored = hasFfmpeg ? normalizeVideo(raw, id) : null;
      if (stored) fs.unlinkSync(raw);
      else { stored = path.join(ASSETS, id + (ext === '.mov' ? '.mov' : ext)); fs.renameSync(raw, stored); }
      return send(res, 200, { id, url: '/_blob/' + id, sizeBytes: fs.statSync(stored).size, contentType: TYPES[path.extname(stored)] || type });
    }
    const ext = EXT_FOR_TYPE[type];
    if (!ext) return fail(res, 415, 'unsupported_type', 'Only video and image files are stored here.');
    fs.writeFileSync(path.join(ASSETS, id + ext), body);
    return send(res, 200, { id, url: '/_blob/' + id, sizeBytes: body.length, contentType: type });
  }
  if (p.startsWith('/api/assets/') && req.method === 'DELETE') {
    const f = findAsset(p.slice(12));
    if (f) fs.unlinkSync(f);
    return send(res, 200, { deleted: !!f });
  }

  if (p.startsWith('/api/db/')) {
    const segs = p.slice(8).split('/').filter(Boolean);
    if (segs.length % 2 === 1) {
      if (req.method !== 'GET') return fail(res, 405, 'invalid_argument', 'Collections are read-only.');
      const dir = collPath(segs);
      if (!dir) return fail(res, 400, 'invalid_argument', 'Bad collection path.');
      const docs = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => {
        try { return { id: n.slice(0, -5), data: readJson(path.join(dir, n)) }; } catch (e) { return null; }
      }).filter(Boolean) : [];
      return send(res, 200, { docs });
    }
    const f = docPath(segs);
    if (!f) return fail(res, 400, 'invalid_argument', 'Bad document path.');
    if (req.method === 'GET') return send(res, 200, fs.existsSync(f) ? { exists: true, data: readJson(f) } : { exists: false });
    if (req.method === 'DELETE') { if (fs.existsSync(f)) fs.unlinkSync(f); return send(res, 200, { ok: true }); }
    let data;
    try { data = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8')); } catch (e) { return fail(res, 400, 'invalid_argument', 'Body must be a JSON object.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(res, 400, 'invalid_argument', 'Body must be a JSON object.');
    if (req.method === 'PUT') { writeJson(f, data); return send(res, 200, { ok: true }); }
    if (req.method === 'PATCH') {
      if (!fs.existsSync(f)) return fail(res, 404, 'invalid_argument', 'update needs an existing document.');
      writeJson(f, merge(readJson(f), data));
      return send(res, 200, { ok: true });
    }
    return fail(res, 405, 'invalid_argument', 'Method not allowed.');
  }
  return fail(res, 404, 'not_found', 'Nothing here.');
}

// ---------- wire line: config, setup, clips ----------
function lineConfig() {
  // DATA_DIR can point somewhere without a config: fall back to the one in the repo.
  const own = path.join(DATA, 'meta', 'wire-line.json');
  try { return readJson(fs.existsSync(own) ? own : path.join(ROOT, 'data', 'meta', 'wire-line.json')); } catch (e) { return null; }
}
const stationIds = cfg => (cfg && Array.isArray(cfg.stations) ? cfg.stations.map(s => s.id).filter(id => STATION_ID.test(id)) : []);
const num01 = v => typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1;
const numIn = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Zones, calibration and the saved correct state per station and role: key "s2" (station s2 running its own role) or
// "s5:s4" (station s5 running role s4). Unknown roles are refused; zones the role no longer has are dropped.
function cleanSetup(body, cfg) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object keyed by station.' };
  const out = {};
  for (const [key, v] of Object.entries(body)) {
    const m = SETUP_KEY.exec(key), st = m && cfg.stations.find(s => s.id === (m[2] || m[1]));
    if (!st) return { error: 'Unknown station "' + String(key).slice(0, 40) + '".' };
    const sid = LineEngine.setupKey(m[1], st.id);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'Station ' + sid + ' must be an object.' };
    const zoneIds = (st.zones || []).map(z => z.id), zones = {}, motion = {}, bright = {};
    for (const [zid, r] of Object.entries(v.zones || {})) {
      if (!zoneIds.includes(zid)) continue;
      if (!r || !num01(r.x) || !num01(r.y) || !num01(r.w) || !num01(r.h) || r.w <= 0 || r.h <= 0) return { error: sid + ': zone ' + zid + ' needs x, y, w, h between 0 and 1.' };
      zones[zid] = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    const c = v.calib && typeof v.calib === 'object' ? v.calib : {};
    for (const [zid, m] of Object.entries(c.motion || {})) if (zoneIds.includes(zid) && num01(m)) motion[zid] = m;
    for (const [zid, b] of Object.entries(c.bright || {})) {
      if (!zoneIds.includes(zid) || !b || typeof b !== 'object') continue;
      const e = {};
      if (numIn(b.off, 0, 255)) e.off = b.off;
      if (numIn(b.on, 0, 255)) e.on = b.on;
      if (Object.keys(e).length) bright[zid] = e;
    }
    out[sid] = { zones, calib: { motion, bright }, updatedAt: text(v.updatedAt, 40) || new Date().toISOString() };
    if (v.ref != null) {
      const ref = cleanRef(v.ref);
      if (!ref) return { error: sid + ': ref (the saved correct state) must look like { "anchor": "<zone id>", "classes": { "<class>": { "x", "y", "w", "h" } } }.' };
      if (zoneIds.includes(ref.anchor)) out[sid].ref = ref;    // an anchor zone the config no longer has: dropped like its zone
    }
  }
  return { setup: out };
}
// The standard setup per role: only the drawn zones, for the camera mount the models were trained on. Committed to git,
// so every laptop starts with the same boxes. Calibration is not part of it (it depends on the light that day).
function cleanStandard(body, cfg) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !body.roles || typeof body.roles !== 'object' || Array.isArray(body.roles)) return { error: 'Body must look like { "roles": { "<role>": { "zones": {} } } }.' };
  const roles = {};
  for (const [rid, v] of Object.entries(body.roles)) {
    const st = STATION_ID.test(rid) && cfg.stations.find(s => s.id === rid);
    if (!st) return { error: 'Unknown role "' + String(rid).slice(0, 40) + '".' };
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'Role ' + rid + ' must be an object.' };
    const zoneIds = (st.zones || []).map(z => z.id), zones = {};
    for (const [zid, r] of Object.entries(v.zones || {})) {
      if (!zoneIds.includes(zid)) continue;
      if (!r || !num01(r.x) || !num01(r.y) || !num01(r.w) || !num01(r.h) || r.w <= 0 || r.h <= 0) return { error: rid + ': zone ' + zid + ' needs x, y, w, h between 0 and 1 (w and h above 0).' };
      zones[zid] = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    // aspect: video width / height when the zones were drawn; source: what filmed it. Both optional (older records have neither).
    if (v.aspect != null && !numIn(v.aspect, 0.2, 5)) return { error: rid + ': aspect must be a number between 0.2 and 5 (video width divided by height).' };
    if (v.source != null && v.source !== 'phone' && v.source !== 'camera') return { error: rid + ': source must be "phone" or "camera".' };
    roles[rid] = { zones, note: text(v.note, 300), updatedAt: text(v.updatedAt, 40) || new Date().toISOString() };
    if (v.aspect != null) roles[rid].aspect = v.aspect;
    if (v.source != null) roles[rid].source = v.source;
  }
  return { standard: { version: 1, roles } };
}
// The saved correct state for positionCheck: per class, its box relative to the anchor zone (Save correct state on /line).
function cleanRef(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.anchor !== 'string' || !r.classes || typeof r.classes !== 'object' || Array.isArray(r.classes)) return null;
  const classes = {}, names = Object.keys(r.classes);
  if (!names.length || names.length > 50) return null;
  for (const c of names) {
    const b = r.classes[c];
    if (!/^[A-Za-z0-9_.\- ]{1,64}$/.test(c) || c === '__proto__' || !b || typeof b !== 'object' || ![b.x, b.y, b.w, b.h].every(v => numIn(v, -10, 10))) return null;
    classes[c] = { x: b.x, y: b.y, w: b.w, h: b.h, landscape: b.w >= b.h };
  }
  return { anchor: r.anchor, classes, frames: numIn(r.frames, 0, 1000) ? r.frames : null, saved: text(r.saved, 40) };
}

// ---------- wire line: floor layouts (docs/canvas-plan.md) ----------
// The built-in Class test comes from the config (LineEngine.classTestLayout) and is never stored. Saved layouts and the
// active one live in meta/wire-line-layouts.json: { active, layouts: [{ id, name, stations: [{ id, name, role, x, y }], updatedAt }] }.
function readLayouts() {
  try {
    const j = readJson(LAYOUTS_FILE);
    return { active: typeof j.active === 'string' ? j.active : LineEngine.CLASS_TEST, layouts: Array.isArray(j.layouts) ? j.layouts.filter(l => l && LAYOUT_ID.test(l.id)) : [] };
  } catch (e) { return { active: LineEngine.CLASS_TEST, layouts: [] }; }
}
function allLayouts(cfg) { const f = readLayouts(); return { active: f.active, layouts: [LineEngine.classTestLayout(cfg)].concat(f.layouts) }; }
function activeLayout(cfg) { const a = allLayouts(cfg); return a.layouts.find(l => l.id === a.active) || a.layouts[0]; }
// The stations the phone listener serves: the active layout's (a phone link for a station not on the floor is refused).
const phoneIds = cfg => (cfg ? activeLayout(cfg).stations.map(s => s.id) : []);
const LEVEL_IDS = LineEngine.LEVELS.map(l => l.id);
// An operator: { code: "Op-07", level: "new" | "training" | "certified" }, or null for nobody. undefined means "not valid".
function cleanOperator(o) {
  if (o == null || (o.code == null && o.level == null)) return null;
  if (typeof o !== 'object' || !LineEngine.OPERATOR_CODE.test(String(o.code)) || !LEVEL_IDS.includes(o.level)) return undefined;
  return { code: o.code, level: o.level };
}
// A layout from the page. session: also each station's input and operator, and its order (for session.json).
function cleanLayout(b, cfg, session) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'A layout must be a JSON object.' };
  const name = text(b.name, 60);
  if (!name) return { error: 'A layout needs a name.' };
  if (!Array.isArray(b.stations) || b.stations.length > MAX_STATIONS) return { error: 'stations must be a list of at most ' + MAX_STATIONS + '.' };
  const roles = stationIds(cfg), seen = {}, stations = [];
  for (const s of b.stations) {
    if (!s || typeof s !== 'object' || !STATION_ID.test(String(s.id || ''))) return { error: 'Station id "' + String(s && s.id).slice(0, 40) + '" must be short lowercase letters, digits or _.' };
    if (seen[s.id]) return { error: 'Station ' + s.id + ' appears twice.' };
    seen[s.id] = true;
    if (!roles.includes(s.role)) return { error: s.id + ': role "' + String(s.role).slice(0, 40) + '" is not a station of the config.' };
    const nm = text(s.name, 40);
    if (!nm) return { error: s.id + ' needs a name.' };
    if (!numIn(s.x, -1e5, 1e5) || !numIn(s.y, -1e5, 1e5)) return { error: s.id + ': x and y must be numbers (floor units).' };
    const out = { id: s.id, name: nm, role: s.role, x: Math.round(s.x), y: Math.round(s.y) };
    if (session) {
      const op = cleanOperator(s.operator);
      if (op === undefined) return { error: s.id + ': an operator is a code like Op-07 and a level (new, training or certified). No names.' };
      Object.assign(out, { order: stations.length + 1, input: ['camera', 'clip', 'phone', 'none'].includes(s.input) ? s.input : 'none', operator: op });
    }
    stations.push(out);
  }
  return { layout: { name, stations } };
}

// Labels for the recorded LEGO runs, so the clip list says "Run 1" instead of a hash.
function runLabels() {
  const out = {}, dir = path.join(DATA, 'runs');
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
    try { const j = readJson(path.join(dir, n)); if (j.video && j.video.assetId) out[j.video.assetId] = 'Run ' + j.number + (j.label ? ': ' + j.label : ''); } catch (e) { /* skip */ }
  }
  return out;
}

async function lineApi(req, res, p) {
  if (p === '/api/line/config') {
    if (req.method !== 'GET') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
    const cfg = lineConfig();
    if (!cfg) return fail(res, 500, 'unavailable', 'data/meta/wire-line.json is missing or is not valid JSON.');
    return send(res, 200, cfg);
  }
  if (p === '/api/line/setup') {
    if (req.method === 'GET') { try { return send(res, 200, fs.existsSync(SETUP_FILE) ? readJson(SETUP_FILE) : {}); } catch (e) { return send(res, 200, {}); } }
    if (req.method !== 'PUT') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
    const cfg = lineConfig();
    if (!cfg) return fail(res, 500, 'unavailable', 'data/meta/wire-line.json is missing or is not valid JSON.');
    let body;
    try { body = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8')); } catch (e) { return fail(res, 400, 'invalid_argument', 'Body must be JSON.'); }
    const r = cleanSetup(body, cfg);
    if (r.error) return fail(res, 400, 'invalid_argument', r.error);
    writeJson(SETUP_FILE, r.setup);
    return send(res, 200, { ok: true, setup: r.setup });
  }
  if (p === '/api/line/standard') {
    if (req.method === 'GET') {
      // DATA_DIR can point somewhere without one: fall back to the one in the repo.
      const f = fs.existsSync(STANDARD_FILE) ? STANDARD_FILE : path.join(ROOT, 'data', 'meta', 'wire-line-standard.json');
      try { return send(res, 200, fs.existsSync(f) ? readJson(f) : { version: 1, roles: {} }); } catch (e) { return send(res, 200, { version: 1, roles: {} }); }
    }
    if (req.method !== 'PUT') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
    const cfg = lineConfig();
    if (!cfg) return fail(res, 500, 'unavailable', 'data/meta/wire-line.json is missing or is not valid JSON.');
    let body;
    try { body = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8')); } catch (e) { return fail(res, 400, 'invalid_argument', 'Body must be JSON.'); }
    const r = cleanStandard(body, cfg);
    if (r.error) return fail(res, 400, 'invalid_argument', r.error);
    writeJson(STANDARD_FILE, r.standard);
    return send(res, 200, { ok: true, standard: r.standard });
  }
  if (p === '/api/line/layouts' || p.startsWith('/api/line/layouts/')) {
    const cfg = lineConfig();
    if (!cfg) return fail(res, 500, 'unavailable', 'data/meta/wire-line.json is missing or is not valid JSON.');
    const roles = (cfg.stations || []).map(s => ({ id: s.id, label: s.label }));
    if (p === '/api/line/layouts') {
      if (req.method === 'GET') return send(res, 200, Object.assign(allLayouts(cfg), { roles }));
      if (req.method !== 'POST') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
      let body;
      try { body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8')); } catch (e) { return fail(res, 400, 'invalid_argument', 'Body must be JSON.'); }
      const r = cleanLayout(body, cfg);
      if (r.error) return fail(res, 400, 'invalid_argument', r.error);
      const f = readLayouts();
      if (f.layouts.length >= 200) return fail(res, 400, 'invalid_argument', 'Too many saved layouts: delete some first.');
      const layout = Object.assign({ id: 'l-' + crypto.randomBytes(4).toString('hex') }, r.layout, { updatedAt: new Date().toISOString() });
      f.layouts.push(layout);
      writeJson(LAYOUTS_FILE, f);
      return send(res, 200, { ok: true, layout });
    }
    const m = /^\/api\/line\/layouts\/([^/]+)(\/use)?$/.exec(p), lid = m ? m[1] : '';
    if (!m || !(lid === LineEngine.CLASS_TEST || LAYOUT_ID.test(lid))) return fail(res, 400, 'invalid_argument', 'Bad layout id.');
    const f = readLayouts(), k = f.layouts.findIndex(l => l.id === lid);
    if (lid !== LineEngine.CLASS_TEST && k < 0) return fail(res, 404, 'not_found', 'No such layout.');
    if (m[2]) {
      // The layout /line shows: the phone listener serves its stations.
      if (req.method !== 'POST') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
      f.active = lid;
      writeJson(LAYOUTS_FILE, f);
      return send(res, 200, { ok: true, active: lid });
    }
    if (lid === LineEngine.CLASS_TEST) return fail(res, 409, 'built_in', 'Class test is built in and stays as it is. Duplicate it to change it.');
    if (req.method === 'PUT') {
      let body;
      try { body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8')); } catch (e) { return fail(res, 400, 'invalid_argument', 'Body must be JSON.'); }
      const r = cleanLayout(body, cfg);
      if (r.error) return fail(res, 400, 'invalid_argument', r.error);
      f.layouts[k] = Object.assign({ id: lid }, r.layout, { updatedAt: new Date().toISOString() });
      writeJson(LAYOUTS_FILE, f);
      return send(res, 200, { ok: true, layout: f.layouts[k] });
    }
    if (req.method === 'DELETE') {
      f.layouts.splice(k, 1);
      if (f.active === lid) f.active = LineEngine.CLASS_TEST;
      writeJson(LAYOUTS_FILE, f);
      return send(res, 200, { ok: true, active: f.active });
    }
    return fail(res, 405, 'invalid_argument', 'Method not allowed.');
  }
  if (p === '/api/line/clips') {
    const clips = [], runs = runLabels();
    if (fs.existsSync(ASSETS)) {
      for (const n of fs.readdirSync(ASSETS).sort()) {
        const m = /^([a-f0-9]{32})\.(mp4|webm)$/.exec(n);
        if (m) clips.push({ key: 'asset:' + m[1], label: runs[m[1]] || 'Clip ' + m[1].slice(0, 8), url: '/_blob/' + m[1], group: 'assets' });
      }
      clips.sort((a, b) => (a.label.startsWith('Run ') === b.label.startsWith('Run ') ? a.label.localeCompare(b.label, 'en', { numeric: true }) : a.label.startsWith('Run ') ? -1 : 1));
    }
    for (const s of listSessions().slice(0, 30)) {
      for (const v of s.videos) clips.push({ role: s.roles[v.station] || null, key: 'session:' + s.id + ':' + v.file, label: (s.title || s.id) + ', ' + v.station + (v.part > 1 ? ' part ' + v.part : ''), url: '/api/sessions/' + s.id + '/video/' + v.station + (v.part > 1 ? '?part=' + v.part : ''), group: 'sessions' });
    }
    return send(res, 200, { clips });
  }
  return fail(res, 404, 'not_found', 'Nothing here.');
}

// ---------- wire line: sessions ----------
// A session folder holds session.json, events.jsonl (append-only) and one video per station (plus -2, -3 when the
// recording restarted). session.json is cached here and written at most every 3 s while chunks arrive.
const SESS = new Map();
function sessionFile(id) { return path.join(SESSIONS, id, 'session.json'); }
function loadSession(id) {
  let s = SESS.get(id);
  if (!s) { s = { doc: readJson(sessionFile(id)), timer: null }; SESS.set(id, s); }
  return s;
}
function writeJsonRetry(f, obj) {
  // A virus scanner or indexer can hold the file for a moment on Windows: retry the rename a few times.
  for (let i = 0; i < 5; i++) {
    try { writeJson(f, obj); return; } catch (e) {
      if (i === 4) { try { fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n'); } catch (e2) { console.error('Could not write ' + f, e2); } }
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
function saveSession(id, now) {
  const s = SESS.get(id);
  if (!s) return;
  if (now) { if (s.timer) clearTimeout(s.timer); s.timer = null; writeJsonRetry(sessionFile(id), s.doc); return; }
  if (!s.timer) s.timer = setTimeout(() => { s.timer = null; writeJsonRetry(sessionFile(id), s.doc); }, 3000);
}
function readEvents(id) {
  const f = path.join(SESSIONS, id, 'events.jsonl');
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (e) { /* a torn line */ } }
  return out;
}
function videoList(doc) {
  const out = [];
  for (const [station, parts] of Object.entries(doc.recordings || {})) for (const r of parts) out.push({ station, part: r.part, file: r.file, mime: r.mime, bytes: r.bytes, chunks: r.chunks, gaps: (r.gaps || []).length, startedAt: r.startedAt });
  return out;
}
// Station id to role from a session's layout ({} for a session with no layout).
function layoutRoles(doc) {
  const out = {};
  if (doc.layout && Array.isArray(doc.layout.stations)) for (const s of doc.layout.stations) if (s && typeof s.id === 'string' && typeof s.role === 'string') out[s.id] = s.role;
  return out;
}
function listSessions() {
  if (!fs.existsSync(SESSIONS)) return [];
  const out = [];
  for (const id of fs.readdirSync(SESSIONS).filter(n => SESSION_ID.test(n)).sort().reverse()) {
    try {
      const d = SESS.has(id) ? SESS.get(id).doc : readJson(sessionFile(id));
      out.push({ id, title: d.title, crew: d.crew, shift: d.shift, startedAt: d.startedAt, endedAt: d.endedAt || null, videos: videoList(d), roles: layoutRoles(d) });
    } catch (e) { /* not a session */ }
  }
  return out;
}
// A session's stations: its layout's (sessions since the floor canvas), else its config's.
function sessionIds(doc) {
  if (doc.layout && Array.isArray(doc.layout.stations)) return doc.layout.stations.map(s => s.id);
  return stationIds(doc.config).length ? stationIds(doc.config) : stationIds(lineConfig());
}
// The config a session's summary and exports run on: its config snapshot with its layout applied.
function sessionConfig(doc) { const cfg = doc.config || lineConfig(); return doc.layout ? LineEngine.applyLayout(cfg, doc.layout) : cfg; }
function newSessionId() {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}
function cleanEvent(e, ids) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'is not an object';
  if (!LineEngine.EVENT_TYPES.includes(e.type)) return 'has an unknown type';
  if (typeof e.t !== 'number' || !isFinite(e.t)) return 'has no time t';
  if (e.station != null && !ids.includes(e.station)) return 'names an unknown station';
  if (e.type === 'operator' && (e.station == null || cleanOperator({ code: e.code, level: e.level }) === undefined)) return 'needs a station, a code like Op-07 and a level (no names)';
  if (JSON.stringify(e).length > 4000) return 'is too long';
  return null;
}

// ---------- wire line: captures, review and the training set ----------
// Per session: captures/<id>.jpg and captures.jsonl (what the page saw), review.jsonl (what a person said; the latest line
// per capture wins). Reviewed frames are copied into DATA/training/<role>/ as a YOLO set (images, labels, manifest.json).
// The pure parts (labels, split, zip, retention plan) are in app/capture-lib.js, shared with the review page.
const CaptureLib = (() => { const mod = { exports: {} }; new Function('module', fs.readFileSync(path.join(ROOT, 'app', 'capture-lib.js'), 'utf8'))(mod); return mod.exports; })();
const TRAINING = path.join(DATA, 'training');
const SPLITS_FILE = path.join(TRAINING, 'splits.json');    // { version: 1, sessions: { "<sessionId>": "test" } }
const CAPTURE_BODY_MAX = 600 * 1024;    // JSON with the image as base64
const CAPTURE_IMAGE_MAX = 400 * 1024;   // the decoded JPEG
const CAPTURE_ID = /^c\d{4,}$/;

function readLines(f) {
  const out = [];
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (e) { /* a torn line */ } }
  return out;
}
function writeFileAtomic(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, f);
}
const readCaptures = sid => readLines(path.join(SESSIONS, sid, 'captures.jsonl'));
function readReviews(sid) {
  const m = new Map();
  for (const r of readLines(path.join(SESSIONS, sid, 'review.jsonl'))) if (r && typeof r.captureId === 'string') m.set(r.captureId, r);
  return m;
}
// A role's class list, in the order the model and the notebooks use: its model's, else the suggested list.
function roleClasses(cfg, role) {
  const m = cfg && cfg.models && cfg.models[role], s = cfg && cfg.suggestedClasses && cfg.suggestedClasses[role];
  return m && Array.isArray(m.classes) && m.classes.length ? m.classes : Array.isArray(s) && s.length ? s : null;
}
const readSplits = () => { try { const j = readJson(SPLITS_FILE); return j && typeof j.sessions === 'object' && j.sessions ? j.sessions : {}; } catch (e) { return {}; } };

// One capture from the page: only known fields are kept. Returns { meta, image } or { error }.
function cleanCapture(b, ids, roles) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'Body must be a JSON object.' };
  if (typeof b.station !== 'string' || !ids.includes(b.station)) return { error: 'station must be one of this session\'s stations.' };
  if (typeof b.role !== 'string' || !roles.includes(b.role)) return { error: 'role must be one of the config\'s station ids.' };
  if (typeof b.t !== 'number' || !isFinite(b.t)) return { error: 't (milliseconds since 1970) is required.' };
  if (!CaptureLib.REASONS.includes(b.reason)) return { error: 'reason must be one of ' + CaptureLib.REASONS.join(', ') + '.' };
  if (b.videoT != null && !(typeof b.videoT === 'number' && isFinite(b.videoT) && b.videoT >= 0)) return { error: 'videoT must be seconds from the start of the recording.' };
  if (b.cycle != null && !(Number.isInteger(b.cycle) && b.cycle >= 0 && b.cycle < 1e6)) return { error: 'cycle must be a whole number.' };
  const r = CaptureLib.cleanBoxes(b.boxes, { conf: true });
  if (r.error) return { error: r.error };
  if (b.zones != null && (typeof b.zones !== 'object' || Array.isArray(b.zones) || JSON.stringify(b.zones).length > 4000)) return { error: 'zones must be a small object.' };
  if (b.standard != null && !(typeof b.standard === 'number' ? isFinite(b.standard) : typeof b.standard === 'string' && b.standard.length <= 60)) return { error: 'standard must be a short text or number.' };
  let model;
  if (b.model != null) {
    const mv = b.model.version;
    if (typeof b.model !== 'object' || Array.isArray(b.model) || typeof b.model.file !== 'string' || b.model.file.length > 120 || (mv != null && !(typeof mv === 'number' ? isFinite(mv) : typeof mv === 'string' && mv.length <= 40))) return { error: 'model must look like { "file": "/models/x.onnx", "version": "1" }.' };
    model = { file: b.model.file }; if (mv != null) model.version = mv;
  }
  const operator = b.operator == null ? undefined : cleanOperator(b.operator);
  if (operator === undefined && b.operator != null) return { error: 'operator needs a code like Op-07 and a level (no names).' };
  if (typeof b.image !== 'string') return { error: 'image must be a data:image/jpeg;base64 string.' };
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(b.image);
  if (!m) return { error: 'image must be a data:image/jpeg;base64 string.' };
  const image = Buffer.from(m[1], 'base64');
  if (image.length > CAPTURE_IMAGE_MAX) return { error: 'The image is over 400 KB.', status: 413, code: 'too_large' };
  if (!CaptureLib.isJpeg(image)) return { error: 'The image is not a JPEG.' };
  const meta = {
    station: b.station, role: b.role, stationName: text(b.stationName, 80) || undefined, t: b.t, videoT: b.videoT == null ? undefined : b.videoT,
    videoFile: text(b.videoFile, 100) || undefined, reason: b.reason, substep: text(b.substep, 60) || undefined, cycle: b.cycle == null ? undefined : b.cycle,
    claim: text(b.claim, 300) || undefined, boxes: r.boxes, zones: b.zones == null ? undefined : b.zones, standard: b.standard == null ? undefined : b.standard,
    model, operator: operator || undefined
  };
  return { meta, image };
}

// The training set of one role: DATA/training/<role>/{images,labels,manifest.json}.
const trainingDir = role => path.join(TRAINING, role);
function readManifest(role) {
  try { const m = readJson(path.join(trainingDir(role), 'manifest.json')); if (m && m.images && typeof m.images === 'object') return m; } catch (e) { /* none yet */ }
  return { version: 1, role, classes: [], images: {} };
}
function trainingCounts(man) {
  const e = Object.values(man.images);
  return { role: man.role, images: e.length, negatives: e.filter(x => !x.labels).length };
}
// Put one reviewed capture into the set (or take it out, for unsure). Replaces whatever an earlier review left.
function updateTraining(role, classes, sid, cap, verdict, boxes, reviewedAt) {
  const man = readManifest(role), name = CaptureLib.trainingName(sid, cap.id), dir = trainingDir(role);
  const img = path.join(dir, 'images', name + '.jpg'), lab = path.join(dir, 'labels', name + '.txt');
  if (verdict === 'unsure') {
    if (!man.images[name]) return trainingCounts(man);
    for (const f of [img, lab]) { try { fs.unlinkSync(f); } catch (e) { /* not there */ } }
    delete man.images[name];
  } else {
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'labels'), { recursive: true });
    const tmp = img + '.tmp';
    fs.copyFileSync(path.join(SESSIONS, sid, 'captures', cap.id + '.jpg'), tmp);
    fs.renameSync(tmp, img);
    const labelBoxes = verdict === 'rejected' ? [] : boxes;
    writeFileAtomic(lab, CaptureLib.labelText(labelBoxes, classes));
    const counts = {};
    for (const b of labelBoxes) counts[b.cls] = (counts[b.cls] || 0) + 1;
    man.images[name] = { session: sid, captureId: cap.id, reason: cap.reason, verdict, model: cap.model || null, standard: cap.standard == null ? null : cap.standard, t: cap.t, reviewedAt, labels: labelBoxes.length, labelCounts: counts };
  }
  man.role = role; man.classes = classes; man.updatedAt = reviewedAt;
  writeJson(path.join(dir, 'manifest.json'), man);
  return trainingCounts(man);
}

// ---------- retention ----------
// Unreviewed captures older than reviewDays go; then, while all capture media is over mediaCapMB, the oldest unreviewed.
// A reviewed capture (any verdict but unsure) is never swept. `now` is milliseconds, so tests can drive it.
function sweepCaptures(now) {
  const opts = Object.assign(LineEngine.captureDefaults(lineConfig()), { now });
  if (!fs.existsSync(SESSIONS)) return { deleted: 0, bytes: 0 };
  const items = [], bySession = {};
  for (const sid of fs.readdirSync(SESSIONS).filter(n => SESSION_ID.test(n))) {
    const caps = readCaptures(sid);
    if (!caps.length) continue;
    const reviews = readReviews(sid);
    bySession[sid] = caps;
    for (const c of caps) {
      let st = null; try { st = fs.statSync(path.join(SESSIONS, sid, 'captures', c.id + '.jpg')); } catch (e) { /* the file is gone */ }
      const rv = reviews.get(c.id);
      items.push({ key: sid + '/' + c.id, sid, id: c.id, receivedAt: typeof c.receivedAt === 'number' ? c.receivedAt : st ? st.mtimeMs : c.t, bytes: st ? st.size : 0, reviewed: !!rv && rv.verdict !== 'unsure' });
    }
  }
  const gone = new Set(CaptureLib.planSweep(items, opts));
  let bytes = 0;
  for (const sid of Object.keys(bySession)) {
    const mine = items.filter(i => i.sid === sid && gone.has(i.key));
    if (!mine.length) continue;
    const drop = new Set(mine.map(i => i.id));
    // The list is rewritten first (atomically), then the files go: a crash in between leaves orphan JPEGs, never a line without its image.
    writeFileAtomic(path.join(SESSIONS, sid, 'captures.jsonl'), bySession[sid].filter(c => !drop.has(c.id)).map(c => JSON.stringify(c) + '\n').join(''));
    for (const i of mine) { bytes += i.bytes; try { fs.unlinkSync(path.join(SESSIONS, sid, 'captures', i.id + '.jpg')); } catch (e) { /* already gone */ } }
  }
  if (gone.size) console.log(`Capture sweep: removed ${gone.size} unreviewed capture${gone.size === 1 ? '' : 's'} (${(bytes / 1048576).toFixed(1)} MB).`);
  return { deleted: gone.size, bytes };
}
function startSweeper() {
  const run = () => { try { sweepCaptures(Date.now()); } catch (e) { console.error('Capture sweep failed:', e); } };
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}

// ---------- training routes: GET /api/training, GET /api/training/<role>/export.zip ----------
function trainingApi(req, res, p) {
  if (req.method !== 'GET') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
  const cfg = lineConfig() || {};
  const pinned = readSplits();
  if (p === '/api/training') {
    const roles = new Set(stationIds(cfg));
    if (fs.existsSync(TRAINING)) for (const n of fs.readdirSync(TRAINING)) if (STATION_ID.test(n) && fs.existsSync(path.join(TRAINING, n, 'manifest.json'))) roles.add(n);
    const out = {};
    for (const role of [...roles].sort()) {
      const man = readManifest(role), e = Object.values(man.images), now = roleClasses(cfg, role);
      const byClass = {}, split = { train: 0, val: 0, test: 0 };
      for (const x of e) {
        for (const [c, n] of Object.entries(x.labelCounts || {})) byClass[c] = (byClass[c] || 0) + n;
        split[CaptureLib.sessionSplit(x.session, pinned)]++;
      }
      out[role] = { images: e.length, negatives: e.filter(x => !x.labels).length, sessions: new Set(e.map(x => x.session)).size, byClass, split, classes: man.classes.length ? man.classes : now || [], classesChanged: !!(man.classes.length && now && JSON.stringify(man.classes) !== JSON.stringify(now)) };
    }
    return send(res, 200, { roles: out, testSessions: Object.keys(pinned).filter(k => pinned[k] === 'test').sort() });
  }
  const m = /^\/api\/training\/([a-z][a-z0-9_]{0,15})\/export\.zip$/.exec(p);
  if (!m) return fail(res, 404, 'not_found', 'Nothing here.');
  const role = m[1], man = readManifest(role), names = Object.keys(man.images).sort();
  if (!names.length) return fail(res, 404, 'not_found', 'No reviewed frames for ' + role + ' yet.');
  const entries = [], exported = {};
  for (const d of ['train', 'val', 'test']) for (const k of ['images', 'labels']) entries.push({ name: d + '/' + k + '/' });
  for (const name of names) {
    const x = man.images[name], split = CaptureLib.sessionSplit(x.session, pinned);
    let img, lab;
    try { img = fs.readFileSync(path.join(trainingDir(role), 'images', name + '.jpg')); lab = fs.readFileSync(path.join(trainingDir(role), 'labels', name + '.txt')); } catch (e) { continue; }
    entries.push({ name: split + '/images/' + name + '.jpg', data: img }, { name: split + '/labels/' + name + '.txt', data: lab });
    exported[name] = Object.assign({ split }, x);
  }
  entries.push({ name: 'data.yaml', data: CaptureLib.dataYaml(man.classes) });
  entries.push({ name: 'manifest.json', data: JSON.stringify({ version: 1, role, classes: man.classes, exportedAt: new Date().toISOString(), images: exported }, null, 2) + '\n' });
  let zip;
  try { zip = Buffer.from(CaptureLib.zip(entries)); } catch (e) { return fail(res, 500, 'unavailable', String(e.message || e)); }
  return send(res, 200, zip, 'application/zip', { 'Content-Disposition': `attachment; filename="${role}-training.zip"` });
}

// ---------- clips: GET /api/sessions/<id>/captures/<capId>.mp4 ----------
// A 7 second clip (videoT - 3 to videoT + 4, the start clamped to 0) cut by ffmpeg from the station's recording and cached
// in <session>/clips/. While the session still records, a cached clip older than the recording file is cut again.
const CLIP_BEFORE_S = 3, CLIP_LEN_S = 7;
const CLIPS_BUSY = new Map();
function runFfmpeg(args, bin) {
  return new Promise(resolve => {
    let err = '', outText = '', p;
    try { p = spawn(bin || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, err: String(e.message || e) }); }
    p.stdout.on('data', d => { if (outText.length < 4000) outText += d; });
    p.stderr.on('data', d => { if (err.length < 4000) err += d; });
    p.on('error', e => resolve({ code: -1, err: String(e.message || e) }));
    p.on('close', code => resolve({ code, err, out: outText }));
  });
}
async function clipApi(req, res, id, doc, dir, capId) {
  const cap = readCaptures(id).find(c => c.id === capId);
  if (!cap) return fail(res, 404, 'not_found', 'No such capture.');
  if (cap.videoT == null) return fail(res, 404, 'no_video', 'This capture has no video position (it was not taken from a recording).');
  const parts = (doc.recordings && doc.recordings[cap.station]) || [];
  const rec = parts.find(r => r.file === cap.videoFile) || (cap.videoFile ? null : parts[0]);
  const src = rec && path.join(dir, rec.file);
  if (!rec || !fs.existsSync(src)) return fail(res, 404, 'no_video', 'The recording for this capture is missing, so there is no clip.');
  if (!hasFfmpeg) return fail(res, 503, 'unavailable', 'ffmpeg is not installed on this computer, so clips cannot be cut. Install ffmpeg or use the Play link.');
  const out = path.join(dir, 'clips', capId + '.mp4');
  let fresh = false;
  try { const st = fs.statSync(out); fresh = st.size > 0 && (!!doc.endedAt || st.mtimeMs >= fs.statSync(src).mtimeMs); } catch (e) { /* not cut yet */ }
  if (!fresh) {
    const key = id + '/' + capId;
    if (!CLIPS_BUSY.has(key)) {
      const job = (async () => {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const tmp = out + '.tmp.mp4';
        try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
        const r = await runFfmpeg(['-nostdin', '-v', 'error', '-y', '-ss', String(Math.max(0, cap.videoT - CLIP_BEFORE_S)), '-i', src, '-t', String(CLIP_LEN_S), '-an',
          '-vf', "scale=-2:'min(480,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp]);
        let size = 0; try { size = fs.statSync(tmp).size; } catch (e) { /* no output */ }
        // Seeking past the end still writes a valid file with no pictures in it: count them.
        if (r.code === 0 && size) {
          const pr = await runFfmpeg(['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', tmp], 'ffprobe');
          if (pr.code === 0 && Number(String(pr.out).trim()) === 0) size = 0;
        }
        if (r.code !== 0 || !size) { try { fs.unlinkSync(tmp); } catch (e) { /* none */ } return { error: r.code !== 0 ? 'ffmpeg could not cut the clip. ' + r.err.trim().split('\n').pop() : 'The recording ends before this moment, so there is no clip.' }; }
        fs.renameSync(tmp, out);
        return {};
      })().finally(() => CLIPS_BUSY.delete(key));
      CLIPS_BUSY.set(key, job);
    }
    const r = await CLIPS_BUSY.get(key);
    if (r.error) return fail(res, 500, 'unavailable', r.error);
  }
  return serveFile(req, res, out, 'video/mp4', { 'Cache-Control': 'private, max-age=60' });
}

// ---------- single run export: export.zip and digest.txt ----------
// One zip per run: run.json (every text: session, config snapshot, events, cycles, verdicts, units, substeps, captures with
// their reviews), the CSVs, captures/*.jpg, and the recordings only with ?video=1. digest.txt is a short plain-text
// summary to paste to Claude.
function parseCsv(t) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] == null ? '' : r[i]; }); return o; });
}
const RUN_CSVS = { 'substeps.csv': 'substepsCsv', 'cycles.csv': 'cyclesCsv', 'verdicts.csv': 'verdictsCsv', 'units.csv': 'unitsCsv' };
function runTables(id, doc, events) {
  const meta = { id, crew: doc.crew, shift: doc.shift, startedAtMs: doc.startedAtMs }, cfg = sessionConfig(doc), csv = {}, rows = {};
  for (const [name, fn] of Object.entries(RUN_CSVS)) {
    try { csv[name] = LineEngine[fn](events, cfg, meta); } catch (e) { csv[name] = ''; }
    rows[name] = parseCsv(csv[name]);
  }
  return { cfg, csv, rows };
}
function capturesWithReviews(id) {
  const reviews = readReviews(id), dir = path.join(SESSIONS, id, 'captures');
  return readCaptures(id).map(c => Object.assign({}, c, { image: fs.existsSync(path.join(dir, c.id + '.jpg')) ? 'captures/' + c.id + '.jpg' : null, review: reviews.get(c.id) || null }));
}
function runJson(id, doc, events, tables) {
  const session = Object.assign({}, doc); delete session.config; delete session.summary;
  let summary = doc.summary || null;
  if (!summary) { try { summary = LineEngine.summarize(events, tables.cfg, { now: doc.endedAtMs || events.length && events[events.length - 1].t || Date.now() }); } catch (e) { summary = null; } }
  return {
    version: 1, exportedAt: new Date().toISOString(), sessionId: id,
    session, config: tables.cfg, summary, events,
    cycles: tables.rows['cycles.csv'], substeps: tables.rows['substeps.csv'], verdicts: tables.rows['verdicts.csv'], units: tables.rows['units.csv'],
    captures: capturesWithReviews(id)
  };
}
function runExportZip(id, doc, dir, withVideo) {
  const events = readEvents(id), tables = runTables(id, doc, events);
  const entries = [{ name: 'run.json', data: JSON.stringify(runJson(id, doc, events, tables), null, 2) + '\n' }];
  for (const [name, text] of Object.entries(tables.csv)) entries.push({ name, data: text });
  for (const c of readCaptures(id)) { try { entries.push({ name: 'captures/' + c.id + '.jpg', data: fs.readFileSync(path.join(dir, 'captures', c.id + '.jpg')) }); } catch (e) { /* swept */ } }
  if (withVideo) {
    const vids = [];
    for (const parts of Object.values(doc.recordings || {})) for (const r of parts) { const f = path.join(dir, r.file); if (fs.existsSync(f)) vids.push({ name: 'video/' + r.file, f, size: fs.statSync(f).size }); }
    if (vids.reduce((a, v) => a + v.size, 0) > 1.5 * 1024 * 1024 * 1024) throw Object.assign(new Error('The recordings are over 1.5 GB: too big for one zip. Download the run without video and copy the videos from the session folder.'), { status: 413, code: 'too_large' });
    for (const v of vids) entries.push({ name: v.name, data: fs.readFileSync(v.f) });
  }
  return Buffer.from(CaptureLib.zip(entries));
}

const DIGEST_MAX = 6000;
const fmtS = v => (Math.round(v * 10) / 10) + 's';
const stampOf = ms => ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '-';
function digestText(id, doc) {
  const events = readEvents(id), tables = runTables(id, doc, events), cfg = tables.cfg, L = [];
  L.push('WIRE LINE RUN ' + id + (doc.title ? ' "' + doc.title + '"' : ''));
  const dur = doc.startedAtMs && (doc.endedAtMs || (events.length && events[events.length - 1].t)) ? ((doc.endedAtMs || events[events.length - 1].t) - doc.startedAtMs) / 1000 : null;
  L.push('Started ' + stampOf(doc.startedAtMs) + (doc.endedAt ? ', ended, ' : ', not ended, ') + (dur == null ? 'duration unknown' : Math.round(dur / 60 * 10) / 10 + ' min') + (doc.crew ? '. Crew ' + doc.crew : '') + (doc.shift ? ', shift ' + doc.shift : '') + '.');
  L.push('Process: ' + (cfg.name || '?') + (cfg.draft ? ' (' + cfg.draft + ')' : '') + '; ' + events.length + ' events.');
  const roles = layoutRoles(doc), sids = sessionIds(doc);
  L.push('Stations: ' + sids.map(sid => sid + (roles[sid] && roles[sid] !== sid ? ' (' + roles[sid] + ')' : '') + (doc.recordings && doc.recordings[sid] && doc.recordings[sid].length ? ' video' : '')).join(', '));
  const models = Object.entries(cfg.models || {}).map(([r, m]) => r + ': ' + String(m.file || '').split('/').pop() + (m.version != null ? ' v' + m.version : ''));
  if (models.length) L.push('Models: ' + models.join('; '));
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  L.push('Events by type: ' + (Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => k + ' ' + v).join(', ') || 'none'));
  L.push('');
  L.push('CYCLES');
  const cyc = tables.rows['cycles.csv'], per = {};
  for (const r of cyc) (per[r.station] = per[r.station] || []).push(r);
  if (!cyc.length) L.push('none');
  for (const [st, rs] of Object.entries(per)) {
    const t = rs.map(r => Number(r.cycle_s)).filter(v => isFinite(v) && v > 0), res = {};
    for (const r of rs) if (r.result) res[r.result] = (res[r.result] || 0) + 1;
    const rsn = {}; for (const r of rs) if (r.reason) rsn[r.reason] = (rsn[r.reason] || 0) + 1;
    L.push(st + ': ' + rs.length + ' cycles' + (t.length ? ', mean ' + fmtS(t.reduce((a, b) => a + b, 0) / t.length) + ' (min ' + fmtS(Math.min(...t)) + ', max ' + fmtS(Math.max(...t)) + ')' : '')
      + (Object.keys(res).length ? '; results ' + Object.entries(res).map(([k, v]) => k + ' ' + v).join(', ') : '')
      + (Object.keys(rsn).length ? '; reasons ' + Object.entries(rsn).map(([k, v]) => k + ' ' + v).join(', ') : '')
      + (rs.some(r => r.flags && r.flags !== '0') ? '; with flags ' + rs.filter(r => r.flags && r.flags !== '0').length : ''));
  }
  const ver = tables.rows['verdicts.csv'];
  L.push(''); L.push('VERDICTS (' + ver.length + ')');
  const vc = {}; for (const v of ver) vc[v.event] = (vc[v.event] || 0) + 1;
  if (ver.length) L.push('By kind: ' + Object.entries(vc).map(([k, v]) => k + ' ' + v).join(', '));
  for (const v of ver.slice(0, 12)) L.push('- ' + v.time + ' ' + v.station + ' c' + v.cycle + ' ' + v.step + ' ' + v.event + (v.message ? ': ' + String(v.message).slice(0, 110) : ''));
  if (ver.length > 12) L.push('- ... ' + (ver.length - 12) + ' more in verdicts.csv');
  const units = tables.rows['units.csv'];
  if (units.length) L.push('Units: ' + units.length);
  const caps = capturesWithReviews(id);
  L.push(''); L.push('CAPTURES (' + caps.length + ')');
  if (caps.length) {
    const rc = {}, vd = { confirmed: 0, corrected: 0, rejected: 0, unsure: 0, todo: 0 }, cl = {};
    for (const c of caps) {
      rc[c.reason] = (rc[c.reason] || 0) + 1;
      vd[c.review ? c.review.verdict : 'todo']++;
      if (c.review && c.review.verdict !== 'unsure') for (const b of c.boxes || []) { const e = cl[b.cls] = cl[b.cls] || { kept: 0, wrongFrame: 0, fixedFrame: 0 }; if (c.review.verdict === 'confirmed') e.kept++; else if (c.review.verdict === 'rejected') e.wrongFrame++; else e.fixedFrame++; }
    }
    L.push('By reason: ' + Object.entries(rc).map(([k, v]) => k + ' ' + v).join(', '));
    L.push('Reviews: right ' + vd.confirmed + ', fixed ' + vd.corrected + ', wrong ' + vd.rejected + ', not sure ' + vd.unsure + ', not reviewed ' + vd.todo);
    for (const [k, e] of Object.entries(cl).sort()) L.push('- model boxes ' + k + ': on right frames ' + e.kept + ', on wrong frames ' + e.wrongFrame + ', on fixed frames ' + e.fixedFrame);
    const notes = caps.filter(c => c.review && c.review.note).slice(0, 8);
    for (const c of notes) L.push('- note ' + c.id + ' (' + c.station + ', ' + c.review.verdict + '): ' + c.review.note.slice(0, 120));
  }
  let out = L.join('\n') + '\n';
  if (Buffer.byteLength(out) > DIGEST_MAX) {
    let cut = out.slice(0, DIGEST_MAX - 60);
    while (Buffer.byteLength(cut) > DIGEST_MAX - 60) cut = cut.slice(0, -50);
    out = cut.replace(/\n[^\n]*$/, '') + '\n[digest cut at 6 KB; the full data is in the run export]\n';
  }
  return out;
}

async function sessionsApi(req, res, p, url) {
  if (p === '/api/sessions') {
    if (req.method === 'GET') return send(res, 200, { sessions: listSessions() });
    if (req.method !== 'POST') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
    const cfg = lineConfig();
    if (!cfg) return fail(res, 500, 'unavailable', 'data/meta/wire-line.json is missing or is not valid JSON.');
    let body;
    try { body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8') || '{}'); } catch (e) { return fail(res, 400, 'invalid_argument', 'Body must be JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'invalid_argument', 'Body must be a JSON object.');
    // The floor layout at the start: its stations are the session's (s5, s6 ...), each with its role, position, input and operator.
    let layout = null, ids = stationIds(cfg);
    if (body.layout != null) {
      const r = cleanLayout(body.layout, cfg, true);
      if (r.error) return fail(res, 400, 'invalid_argument', 'Layout: ' + r.error);
      layout = Object.assign({ id: text(body.layout.id, 40) || null }, r.layout, { builtIn: body.layout.builtIn === true });
      ids = layout.stations.map(s => s.id);
    }
    const stations = {};
    for (const [sid, v] of Object.entries(body.stations || {})) {
      if (!ids.includes(sid)) return fail(res, 400, 'invalid_argument', 'Unknown station "' + String(sid).slice(0, 40) + '".');
      const input = v && ['camera', 'clip', 'phone', 'none'].includes(v.input) ? v.input : 'none';
      stations[sid] = { input, label: text(v && v.label, 200), record: !!(v && v.record) };
    }
    let setup = {};
    try { setup = fs.existsSync(SETUP_FILE) ? readJson(SETUP_FILE) : {}; } catch (e) { /* none */ }
    const id = newSessionId(), now = Date.now();
    const doc = {
      id, title: text(body.title, 120), crew: text(body.crew, 80), shift: text(body.shift, 40), notes: text(body.notes, 2000),
      startedAt: new Date(now).toISOString(), startedAtMs: now, endedAt: null, stations,
      client: body.client && typeof body.client === 'object' && JSON.stringify(body.client).length <= 2000 ? body.client : {},
      config: cfg, setup, recordings: {}
    };
    if (layout) {
      doc.layout = layout;
      // The current operator per station, kept up to date from the operator events.
      doc.operators = {};
      for (const st of layout.stations) if (st.operator) doc.operators[st.id] = Object.assign({ at: doc.startedAt }, st.operator);
    }
    fs.mkdirSync(path.join(SESSIONS, id), { recursive: true });
    fs.writeFileSync(path.join(SESSIONS, id, 'events.jsonl'), '');
    SESS.set(id, { doc, timer: null });
    saveSession(id, true);
    return send(res, 200, { id, startedAt: doc.startedAt, startedAtMs: now });
  }

  // Everything below is /api/sessions/<id>[/...]. The path is already decoded, so an encoded slash makes extra segments.
  const segs = p.slice('/api/sessions/'.length).split('/');
  const id = segs[0], rest = segs.slice(1);
  if (!SESSION_ID.test(id)) return fail(res, 400, 'invalid_argument', 'Bad session id.');
  if (!fs.existsSync(sessionFile(id))) return fail(res, 404, 'not_found', 'No such session.');
  const S = loadSession(id), doc = S.doc, dir = path.join(SESSIONS, id);
  const ids = sessionIds(doc);

  if (!rest.length) {
    if (req.method !== 'GET') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
    const evf = path.join(dir, 'events.jsonl');
    const events = fs.existsSync(evf) ? fs.readFileSync(evf, 'utf8').split('\n').filter(l => l.trim()).length : 0;
    return send(res, 200, Object.assign({}, doc, { eventCount: events, videos: videoList(doc) }));
  }
  if (rest.length === 1) {
    const what = rest[0];
    if (what === 'events' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8')); } catch (e) { return fail(res, 400, 'invalid_argument', 'Body must be JSON.'); }
      const list = Array.isArray(body) ? body : body && Array.isArray(body.events) ? body.events : null;
      if (!list || list.length > 5000) return fail(res, 400, 'invalid_argument', 'Send {"events": [...]} with at most 5000 events.');
      for (let i = 0; i < list.length; i++) {
        const why = cleanEvent(list[i], ids);
        if (why) return fail(res, 400, 'invalid_argument', 'Event ' + i + ' ' + why + '.');
        if (typeof list[i].ts !== 'number') list[i].ts = Math.round((list[i].t - doc.startedAtMs)) / 1000;
        // An operator event keeps its known fields only (nothing about the person can ride along), and updates the current operator.
        if (list[i].type === 'operator') {
          const e = list[i];
          list[i] = { type: 'operator', t: e.t, ts: e.ts, station: e.station, code: e.code == null ? null : e.code, level: e.level == null ? null : e.level };
          doc.operators = doc.operators || {};
          if (e.code == null) doc.operators[e.station] = null; else doc.operators[e.station] = { code: e.code, level: e.level, at: new Date(e.t).toISOString() };
          saveSession(id, false);
        }
      }
      if (list.length) fs.appendFileSync(path.join(dir, 'events.jsonl'), list.map(e => JSON.stringify(e)).join('\n') + '\n');
      return send(res, 200, { ok: true, appended: list.length });
    }
    if (what === 'captures' && req.method === 'POST') {
      let raw, body;
      try { raw = await readBody(req, CAPTURE_BODY_MAX, true); } catch (e) { return fail(res, e && e.code === 'too_large' ? 413 : 400, e && e.code === 'too_large' ? 'too_large' : 'invalid_argument', e && e.code === 'too_large' ? 'A capture over 600 KB was refused.' : 'The request was cut off.'); }
      try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return fail(res, 400, 'invalid_argument', 'Body must be JSON.'); }
      const roles = stationIds(doc.config || lineConfig());
      const r = cleanCapture(body, ids, roles);
      if (r.error) return fail(res, r.status || 400, r.code || 'invalid_argument', r.error);
      const lim = LineEngine.captureDefaults(lineConfig()), have = readCaptures(id);
      if (have.length >= lim.maxPerSession) return fail(res, 409, 'capture_limit', 'This session already has ' + have.length + ' captures (the limit is ' + lim.maxPerSession + ').');
      if (have.filter(c => c.station === r.meta.station).length >= lim.maxPerStation) return fail(res, 409, 'capture_limit', 'Station ' + r.meta.station + ' already has its ' + lim.maxPerStation + ' captures for this session.');
      const cid = CaptureLib.captureId(CaptureLib.nextCaptureNumber(have.map(c => c.id)));
      const meta = Object.assign({ id: cid }, r.meta, { receivedAt: Date.now(), bytes: r.image.length });
      fs.mkdirSync(path.join(dir, 'captures'), { recursive: true });
      const jpg = path.join(dir, 'captures', cid + '.jpg');
      writeFileAtomic(jpg, r.image);
      try { fs.appendFileSync(path.join(dir, 'captures.jsonl'), JSON.stringify(meta) + '\n'); } catch (e) { try { fs.unlinkSync(jpg); } catch (e2) { /* none */ } throw e; }
      return send(res, 200, { id: cid });
    }
    if (what === 'captures' && req.method === 'GET') {
      const reviews = readReviews(id);
      return send(res, 200, { captures: readCaptures(id).map(c => Object.assign({}, c, { review: reviews.get(c.id) || null })), split: readSplits()[id] === 'test' ? 'test' : null });
    }
    if (what === 'review' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch (e) { return fail(res, 400, 'invalid_argument', 'Body must be JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'invalid_argument', 'Body must be a JSON object.');
      if (typeof body.captureId !== 'string' || !CAPTURE_ID.test(body.captureId)) return fail(res, 400, 'invalid_argument', 'captureId must look like c0001.');
      if (!CaptureLib.VERDICTS.includes(body.verdict)) return fail(res, 400, 'invalid_argument', 'verdict must be one of ' + CaptureLib.VERDICTS.join(', ') + '.');
      const cap = readCaptures(id).find(c => c.id === body.captureId);
      if (!cap || !fs.existsSync(path.join(dir, 'captures', cap.id + '.jpg'))) return fail(res, 404, 'not_found', 'No such capture.');
      const classes = roleClasses(lineConfig(), cap.role) || roleClasses(doc.config, cap.role);
      if (!classes) return fail(res, 400, 'invalid_argument', 'Role ' + cap.role + ' has no class list in the config.');
      if (body.note != null && typeof body.note !== 'string') return fail(res, 400, 'invalid_argument', 'note must be text.');
      // Posted boxes are checked whenever they come; only "corrected" uses them. "confirmed" keeps the capture's own boxes.
      let posted = [];
      if (body.boxes != null || body.verdict === 'corrected') {
        const r = CaptureLib.cleanBoxes(body.boxes, { classes });
        if (r.error) return fail(res, 400, 'invalid_argument', r.error);
        posted = r.boxes;
      }
      let final = [];
      if (body.verdict === 'corrected') final = posted;
      else if (body.verdict === 'confirmed') {
        const r = CaptureLib.cleanBoxes(cap.boxes, { classes });
        if (r.error) return fail(res, 400, 'invalid_argument', 'The capture\'s own boxes cannot be confirmed (' + r.error + ') Use corrected and fix them.');
        final = r.boxes;
      }
      const man = readManifest(cap.role);
      if (body.verdict !== 'unsure' && Object.keys(man.images).length && man.classes.length && JSON.stringify(man.classes) !== JSON.stringify(classes)) return fail(res, 409, 'classes_changed', 'The class list for ' + cap.role + ' changed since its training set was started. Move data/training/' + cap.role + ' aside first.');
      const reviewedAt = new Date().toISOString();
      const line = { captureId: cap.id, verdict: body.verdict, boxes: final, note: text(body.note, 500), reviewedAt };
      fs.appendFileSync(path.join(dir, 'review.jsonl'), JSON.stringify(line) + '\n');
      return send(res, 200, { ok: true, training: updateTraining(cap.role, classes, id, cap, body.verdict, final, reviewedAt) });
    }
    if (what === 'split' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8')); } catch (e) { return fail(res, 400, 'invalid_argument', 'Body must be JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || !(body.split === 'test' || body.split === null)) return fail(res, 400, 'invalid_argument', 'Send { "split": "test" } to hold this session out, or { "split": null } to release it.');
      const pinned = readSplits();
      if (body.split === 'test') pinned[id] = 'test'; else delete pinned[id];
      writeJson(SPLITS_FILE, { version: 1, sessions: pinned });
      return send(res, 200, { ok: true, split: body.split });
    }
    if (what === 'end' && req.method === 'POST') {
      try { await readBody(req, 64 * 1024); } catch (e) { /* ignore the body */ }
      if (!doc.endedAt) { doc.endedAt = new Date().toISOString(); doc.endedAtMs = Date.now(); }
      try { doc.summary = LineEngine.summarize(readEvents(id), sessionConfig(doc), { now: doc.endedAtMs }); } catch (e) { doc.summary = null; console.error(e); }
      saveSession(id, true);
      return send(res, 200, Object.assign({}, doc, { videos: videoList(doc) }));
    }
    if (what === 'export.zip' && req.method === 'GET') {
      let z;
      try { z = runExportZip(id, doc, dir, url.searchParams.get('video') === '1'); } catch (e) { return fail(res, e.status || 500, e.code || 'unavailable', String(e.message || e)); }
      return send(res, 200, z, 'application/zip', { 'Content-Disposition': `attachment; filename="${id}-run.zip"` });
    }
    if (what === 'digest.txt' && req.method === 'GET') {
      return send(res, 200, digestText(id, doc), 'text/plain; charset=utf-8');
    }
    if (what === 'events.jsonl' && req.method === 'GET') {
      return send(res, 200, fs.readFileSync(path.join(dir, 'events.jsonl')), 'application/x-ndjson; charset=utf-8', { 'Content-Disposition': `attachment; filename="${id}-events.jsonl"` });
    }
    if ((what === 'substeps.csv' || what === 'cycles.csv' || what === 'verdicts.csv' || what === 'units.csv') && req.method === 'GET') {
      const meta = { id, crew: doc.crew, shift: doc.shift, startedAtMs: doc.startedAtMs };
      const cfg = sessionConfig(doc);
      const fn = { 'substeps.csv': LineEngine.substepsCsv, 'cycles.csv': LineEngine.cyclesCsv, 'verdicts.csv': LineEngine.verdictsCsv, 'units.csv': LineEngine.unitsCsv }[what];
      const csv = fn(readEvents(id), cfg, meta);
      return send(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${id}-${what}"` });
    }
    return fail(res, 400, 'invalid_argument', 'Bad session path.');
  }
  if (rest.length === 2 && rest[0] === 'captures') {
    if (req.method !== 'GET') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
    const m = /^(c\d{4,})\.(jpg|mp4)$/.exec(rest[1]);
    if (!m) return fail(res, 400, 'invalid_argument', 'Bad capture name; use c0001.jpg or c0001.mp4.');
    if (m[2] === 'mp4') return clipApi(req, res, id, doc, dir, m[1]);
    const f = path.join(dir, 'captures', m[1] + '.jpg');
    if (!fs.existsSync(f)) return fail(res, 404, 'not_found', 'No such capture.');
    return serveFile(req, res, f, 'image/jpeg', { 'Cache-Control': 'private, max-age=3600' });
  }
  if (rest.length === 2 && rest[0] === 'video') {
    const station = rest[1];
    if (!STATION_ID.test(station) || !ids.includes(station)) return fail(res, 400, 'invalid_argument', 'Bad station name.');
    const part = url.searchParams.has('part') ? Number(url.searchParams.get('part')) : 1;
    if (!Number.isInteger(part) || part < 1 || part > 99) return fail(res, 400, 'invalid_argument', 'part must be a whole number from 1 to 99.');
    const parts = (doc.recordings[station] = doc.recordings[station] || []);
    let rec = parts.find(r => r.part === part);
    if (req.method === 'GET') {
      if (!rec || !fs.existsSync(path.join(dir, rec.file))) return fail(res, 404, 'not_found', 'No recording for that station.');
      return serveFile(req, res, path.join(dir, rec.file), TYPES[path.extname(rec.file)] || 'video/webm');
    }
    if (req.method !== 'POST') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
    const seq = Number(url.searchParams.get('seq'));
    if (!url.searchParams.has('seq') || !Number.isInteger(seq) || seq < 0) return fail(res, 400, 'invalid_argument', 'seq must be a whole number from 0.');
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!VIDEO_EXT[mime]) return fail(res, 415, 'unsupported_type', 'Send video/mp4 or video/webm chunks.');
    let body;
    try { body = await readBody(req, 32 * 1024 * 1024); } catch (e) { return fail(res, 413, 'too_large', 'A chunk over 32 MB was refused.'); }
    if (!rec) {
      const t0 = Number(url.searchParams.get('t0'));
      rec = { part, file: station + (part > 1 ? '-' + part : '') + VIDEO_EXT[mime], mime, startedAt: isFinite(t0) && t0 > 0 ? t0 : Date.now(), chunks: 0, bytes: 0, nextSeq: 0, gaps: [], rejected: 0 };
      parts.push(rec);
    } else if (rec.mime !== mime) return fail(res, 400, 'invalid_argument', 'This recording is ' + rec.mime + '; start a new part for another format.');
    if (seq < rec.nextSeq) {
      // Already have it (a retry) or it came late: appending would scramble the file, so it is refused.
      rec.rejected = (rec.rejected || 0) + 1;
      saveSession(id, false);
      return send(res, 409, { code: 'out_of_order', message: 'Chunk ' + seq + ' is behind; the next expected chunk is ' + rec.nextSeq + '.', expected: rec.nextSeq });
    }
    const gap = seq > rec.nextSeq;
    if (gap) {
      rec.gaps.push({ expected: rec.nextSeq, got: seq, at: new Date().toISOString() });
      console.warn(`Session ${id} ${station}: video chunk gap, expected ${rec.nextSeq}, got ${seq}.`);
    }
    fs.appendFileSync(path.join(dir, rec.file), body);
    rec.nextSeq = seq + 1; rec.chunks++; rec.bytes += body.length; rec.lastChunkAt = Date.now();
    saveSession(id, gap || rec.chunks === 1);
    return send(res, 200, { ok: true, expected: rec.nextSeq, bytes: rec.bytes });
  }
  return fail(res, 400, 'invalid_argument', 'Bad session path.');
}

// ---------- phone cameras (any phone or tablet): the HTTPS listener for the phone page, and the WebRTC signaling ----------
// Phone browsers (Safari, Chrome) only open the camera on a secure page, so phones get their own listener: HTTPS on every interface
// (IPv6 and IPv4) on PHONE_PORT, with the certificate from scripts/phone-cert.mjs. It serves the phone page, the CA
// download (/ca.crt) and the phone half of the signaling, nothing else: the data, session and model API stay on the
// localhost server above. The video goes from the phone to /line directly over WebRTC on the local network (no STUN,
// no TURN); this server only passes one offer and one answer per connection. Every phone request needs its station's
// key (k=), which only /line shows.
//   phone: POST /phone/offer, then GET /phone/poll until the answer comes, then every 2 s as a heartbeat
//   /line: POST /api/phone/poll (the stations that want a phone; returns their offers), /api/phone/answer, /drop, /bye
// A new offer for a station replaces the one before it. The phone sends a new one by itself when its connection drops
// or /line lets go of it (a reload, another source picked).
// Each station has its own key: HMAC-SHA256(pairing secret, station id), 16 base64url characters (96 bits). So the link
// for S1 cannot be edited into S2's and take over S2's phone. The secret is kept in <data>/phone-cert/pairing-secret, so
// phones keep working across restarts. "New pairing code" on /line (POST /api/phone/rotate) replaces it and cuts off every phone.
const PH = { on: false, server: null, cert: null, error: '', secret: null, slots: {}, laptops: new Map(), checkedAt: 0 };
const SECRET_FILE = path.join(CERT_DIR, 'pairing-secret');
const SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/;
const PHONE_SEEN_MS = 10000;     // a phone that has not polled for this long is gone: /line does not get its offer
const LAPTOP_SEEN_MS = 10000;    // likewise a /line page: what it answered is dropped, so its phones send new offers
const CLIENT_ID = /^[A-Za-z0-9_-]{8,40}$/;
const PHONE_HDR = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const PHONE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src blob: mediastream:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const stationKey = sid => crypto.createHmac('sha256', PH.secret).update(sid).digest('base64url').slice(0, 16);
function keyOk(sid, k) {
  if (!PH.secret) return false;
  const a = Buffer.from(String(k || '')), b = Buffer.from(stationKey(sid));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Read the saved pairing secret, or make one (fresh: a new one). If it cannot be saved it still works until the next start.
function loadSecret(fresh) {
  if (!fresh) { try { const t = fs.readFileSync(SECRET_FILE, 'utf8').trim(); if (SECRET_RE.test(t)) return (PH.secret = t); } catch (e) { /* none yet */ } }
  PH.secret = crypto.randomBytes(32).toString('base64url');
  try { fs.mkdirSync(CERT_DIR, { recursive: true }); fs.writeFileSync(SECRET_FILE, PH.secret + '\n', { mode: 0o600 }); }
  catch (e) { console.error('Phone cameras: could not save the pairing secret in ' + SECRET_FILE + ': ' + (e && e.message || e)); }
  return PH.secret;
}
// Where a phone can reach this laptop, best first. On a Mac the Bonjour name (<LocalHostName>.local) leads: it keeps
// working when the address changes, and it is the only way in on an IPv6-only hotspot besides the raw IPv6 address.
function phoneHosts() {
  const named = localNames().map(n => ({ host: n, kind: 'name' }));
  const addrs = lanAddresses().map(a => ({ host: a.family === 6 ? '[' + a.address + ']' : a.address, kind: a.kind, iface: a.iface }));
  return process.platform === 'darwin' ? named.concat(addrs) : addrs.concat(named);
}
// Load or make the certificate. A new network gives the laptop new addresses: then it is reissued (same CA) and the
// running listener switches to it, so a phone that trusted the CA keeps working.
function loadPhoneCert() {
  PH.checkedAt = Date.now();
  try {
    const c = ensurePhoneCert(CERT_DIR);
    if (c.created) console.log('Phone cameras: made a new local CA in ' + CERT_DIR + '. Phones that trusted an older one must install this one.');
    else if (c.reissued) console.log('Phone cameras: new certificate for ' + c.names.concat(c.ips).join(', '));
    if (c.reissued || !PH.cert) { PH.cert = c; if (PH.server) PH.server.setSecureContext({ key: c.key, cert: c.cert }); }
    PH.error = '';
  } catch (e) { PH.error = String(e && e.message || e); console.error('Phone cameras: ' + PH.error); }
  return PH.cert;
}
function laptopsAlive() {
  const t = Date.now();
  for (const [id, c] of PH.laptops) if (t - c.seen > LAPTOP_SEEN_MS) { PH.laptops.delete(id); dropAnswered(id); }
  return PH.laptops;
}
function dropAnswered(client, only) { for (const [sid, s] of Object.entries(PH.slots)) if (s.state === 'answered' && s.laptop === client && (!only || only === sid)) s.state = 'dropped'; }
// For the phone's screen: a /line page wants this station's phone ('open'), /line is open with another source there
// ('not_picked'), or no /line page is open ('closed').
function laptopState(sid) {
  const ls = laptopsAlive();
  if (!ls.size) return 'closed';
  for (const c of ls.values()) if (c.want.has(sid)) return 'open';
  return 'not_picked';
}
const sdpOk = v => typeof v === 'string' && v.startsWith('v=0') && v.length <= 100000;
const cleanSettings = v => (v && typeof v === 'object' ? { width: numIn(v.width, 1, 10000) ? v.width : null, height: numIn(v.height, 1, 10000) ? v.height : null, frameRate: numIn(v.frameRate, 0, 240) ? v.frameRate : null } : {});

// /line's half (localhost only, behind the guard in handle()).
async function phoneApi(req, res, p) {
  if (p === '/api/phone/info') {
    if (req.method !== 'GET') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
    if (PH.on && Date.now() - PH.checkedAt > 5000) loadPhoneCert();
    const keys = {};
    if (PH.on) for (const sid of phoneIds(lineConfig())) keys[sid] = stationKey(sid);
    // trusted: the addresses the certificate covers (no warning once the phone trusts the CA); the others always warn.
    return send(res, 200, { on: PH.on, port: PHONE_PORT, keys, hosts: PH.on ? phoneHosts() : [], trusted: PH.cert ? PH.cert.names.concat(PH.cert.ips.map(ip => (ip.includes(':') ? '[' + ip + ']' : ip))) : [],
      error: PH.error || (PHONE_PORT ? null : 'The phone page is off (PHONE_PORT=off).'), validTo: PH.cert ? PH.cert.validTo : null });
  }
  if (req.method !== 'POST') return fail(res, 405, 'invalid_argument', 'Method not allowed.');
  let b;
  try { b = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8') || '{}'); } catch (e) { return fail(res, 400, 'invalid_argument', 'Body must be JSON.'); }
  if (!b || typeof b !== 'object' || !CLIENT_ID.test(String(b.client || ''))) return fail(res, 400, 'invalid_argument', 'client must be the page id.');
  const t = Date.now(), ids = phoneIds(lineConfig());
  if (p === '/api/phone/bye') { dropAnswered(b.client); PH.laptops.delete(b.client); return send(res, 200, { ok: true }); }
  if (p === '/api/phone/rotate') {
    // A new pairing code: every phone link and QR code so far stops working, and the waiting offers are forgotten.
    if (!PH.on) return fail(res, 409, 'unavailable', PH.error || 'The phone page is off.');
    loadSecret(true); PH.slots = {};
    console.log('Phone cameras: new pairing code. Phones must scan the QR code on /line again.');
    return send(res, 200, { ok: true });
  }
  if (p === '/api/phone/poll') {
    const want = new Set((Array.isArray(b.want) ? b.want : []).filter(s => ids.includes(s)));
    laptopsAlive();
    const me = PH.laptops.get(b.client) || { want: new Set(), seen: t };
    for (const sid of me.want) if (!want.has(sid)) dropAnswered(b.client, sid);    // this page picked another source there
    me.want = want; me.seen = t; PH.laptops.set(b.client, me);
    const offers = [], phones = {};
    for (const sid of want) {
      const s = PH.slots[sid];
      if (!s) { phones[sid] = { state: 'none' }; continue; }
      let busy = false;
      // Another /line page has this phone. If that page is gone (a reload) this one takes over; else it waits.
      if (s.state === 'answered' && s.laptop !== b.client) { if (PH.laptops.has(s.laptop)) busy = true; else s.state = 'dropped'; }
      const seen = t - s.lastPoll;
      if (s.state === 'waiting' && seen < PHONE_SEEN_MS) offers.push({ station: sid, id: s.id, sdp: s.sdp, camera: s.camera, settings: s.settings });
      phones[sid] = { state: s.state, id: s.id, seen, busy, camera: s.camera };
    }
    return send(res, 200, { offers, phones });
  }
  const sid = String(b.station || ''), s = PH.slots[sid];
  if (!ids.includes(sid)) return fail(res, 400, 'invalid_argument', 'Unknown station.');
  if (p === '/api/phone/answer') {
    if (!sdpOk(b.sdp)) return fail(res, 400, 'invalid_argument', 'sdp must be a session description.');
    if (!s || s.id !== b.id || s.state === 'dropped') return send(res, 409, { code: 'replaced', message: 'That offer is gone; the phone sends a new one.' });
    if (s.state === 'answered' && s.laptop !== b.client) return send(res, 409, { code: 'busy', message: 'Another /line page has this phone.' });
    Object.assign(s, { state: 'answered', answer: b.sdp, laptop: b.client, answeredAt: t });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/phone/drop') {
    // /line gave up on this connection (it never connected, or it was lost): the phone's next poll says so.
    if (s && s.id === b.id && (s.state === 'waiting' || s.laptop === b.client)) s.state = 'dropped';
    return send(res, 200, { ok: true });
  }
  return fail(res, 404, 'not_found', 'Nothing here.');
}

// The page a phone gets without a valid link (a new pairing code, an edited link, a station the config does not have).
function phoneGate() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wire line camera</title>'
    + '<style>body{margin:0;padding:24px 18px;font:17px/1.45 -apple-system,system-ui,sans-serif;background:#eef0ee;color:#15181b}h1{font-size:22px;margin:0 0 10px}a{color:#a3522a;font-weight:600}'
    + '@media (prefers-color-scheme: dark){body{background:#101214;color:#eff1ef}a{color:#dc8b55}}</style></head><body>'
    + '<h1>This link does not work</h1><p>It is old (someone made a new pairing code on the laptop), it is not complete, or its station is not on the floor layout '
    + 'the laptop shows. On the laptop, open <b>/line</b>, press <b>Connect a camera</b> on the station, pick <b>Phone or tablet</b>, and scan the QR code it shows '
    + 'with this phone\'s camera.</p></body></html>';
}

// The phones' half (HTTPS on the local network). Nothing here reads or writes the data folder.
async function phoneHandle(req, res) {
  const url = new URL(req.url, 'https://phone'), p = url.pathname, get = req.method === 'GET' || req.method === 'HEAD';
  const json = (code, body) => send(res, code, body, 'application/json', PHONE_HDR);
  if (p === '/ca.crt' && get) return send(res, 200, PH.cert.caDer, 'application/x-x509-ca-cert', PHONE_HDR);
  // Only the stations on the active floor layout: a link for a station that is not on the floor is refused.
  const cfg = lineConfig(), lay = cfg ? activeLayout(cfg) : { stations: [] }, ids = lay.stations.map(s => s.id), sid = String(url.searchParams.get('s') || '').toLowerCase(), ok = ids.includes(sid) && keyOk(sid, url.searchParams.get('k'));
  if ((p === '/' || p === '/phone') && get) {
    const html = ok ? fs.readFileSync(path.join(ROOT, 'app', 'phone.html')) : phoneGate();
    return send(res, ok ? 200 : 403, html, 'text/html; charset=utf-8', Object.assign({ 'Content-Security-Policy': PHONE_CSP }, PHONE_HDR));
  }
  if (!p.startsWith('/phone/')) return json(404, { code: 'not_found', message: 'Nothing here.' });
  if (!ok) return json(403, { code: 'bad_key', message: 'This link is old or is not for this station. Scan the QR code on the laptop again.' });
  if (p === '/phone/hello' && get) {
    const ls = lay.stations.find(x => x.id === sid), role = cfg.stations.find(x => x.id === ls.role) || {};
    return json(200, { station: sid, label: text(LineEngine.shortName(sid, ls.name, role.label), 80), role: text(role.label, 80), laptop: laptopState(sid) });
  }
  if (p === '/phone/offer' && req.method === 'POST') {
    let b;
    try { b = JSON.parse((await readBody(req, 128 * 1024)).toString('utf8')); } catch (e) { return json(400, { code: 'invalid_argument', message: 'Body must be JSON.' }); }
    if (!b || typeof b !== 'object' || !CLIENT_ID.test(String(b.client || '')) || !sdpOk(b.sdp)) return json(400, { code: 'invalid_argument', message: 'Send { client, sdp } with the offer.' });
    const id = crypto.randomBytes(8).toString('hex'), t = Date.now();
    PH.slots[sid] = { id, client: b.client, sdp: b.sdp, camera: text(b.camera, 80), settings: cleanSettings(b.settings), at: t, lastPoll: t, state: 'waiting', answer: null, laptop: null };
    return json(200, { id, laptop: laptopState(sid) });
  }
  if (p === '/phone/poll' && get) {
    const s = PH.slots[sid], laptop = laptopState(sid);
    // Not this phone's offer any more: another phone took the station ('replaced'), or the server forgot it ('unknown': send a new one).
    if (!s || s.id !== url.searchParams.get('id')) return json(200, { state: s && s.client !== url.searchParams.get('c') ? 'replaced' : 'unknown', laptop });
    s.lastPoll = Date.now();
    return json(200, { state: s.state, answer: s.state === 'answered' ? s.answer : null, laptop });
  }
  return json(405, { code: 'invalid_argument', message: 'Method not allowed.' });
}

function startPhone() {
  if (!PHONE_PORT || !loadPhoneCert()) return;    // no certificate: /line shows why next to each phone source
  loadSecret(false);
  const server = https.createServer({ key: PH.cert.key, cert: PH.cert.cert }, (req, res) => {
    phoneHandle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { code: 'unavailable', message: 'The laptop had a problem.' }, 'application/json', PHONE_HDR); });
  });
  let host = '::';    // dual stack: IPv6 (an iPhone hotspot can be IPv6 only) and IPv4
  server.on('error', e => {
    if (host === '::' && (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL')) { host = '0.0.0.0'; server.listen(PHONE_PORT, host); return; }    // no IPv6 here
    PH.on = false;
    PH.error = e.code === 'EADDRINUSE' ? 'Port ' + PHONE_PORT + ' is busy (another npm start?). Stop it, or start with PHONE_PORT=<another port>.' : String(e && e.message || e);
    console.error('Phone cameras: ' + PH.error);
  });
  PH.server = server;
  server.listen(PHONE_PORT, host, () => {
    PH.on = true;
    const h = phoneHosts()[0], base = `https://${h ? h.host : 'localhost'}:${PHONE_PORT}`;
    console.log(`Phone cameras: ${base} (on /line, press Connect a camera on a station, pick Phone or tablet and scan its QR code)`);
    const s1 = phoneIds(lineConfig())[0];
    if (s1) console.log(`  ${s1.toUpperCase()} phone link: ${base}/phone?s=${s1}&k=${stationKey(s1)} (every station has its own key: /line shows each one's QR code)`);
  });
}

http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) fail(res, 500, 'unavailable', String(e && e.message || e)); });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Wire line: http://localhost:${PORT}/line`);
  console.log(`LEGO run log (archived): http://localhost:${PORT}/runs`);
  console.log(`Data folder: ${DATA}`);
  startSweeper();
  if (!hasFfmpeg) console.log('ffmpeg not found: uploads are stored as-is, and agents cannot analyze videos until it is installed.');
  startPhone();
});
