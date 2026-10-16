// Local server for the LEGO Station Run Log.
// Serves the app, a small JSON document store (data/<collection>/<id>.json) and the
// uploaded files (data/assets/<id>.<ext>). No dependencies; Node 18 or newer.
// Also serves the wire line page (/line) and its session store (data/sessions/<id>/).
//
//   npm start                  -> http://localhost:4173
//   PORT=5000 npm start        -> another port
//   DATA_DIR=/tmp/x npm start  -> another data folder (the tests use this)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const ASSETS = path.join(DATA, 'assets');
const APP_FILE = path.join(ROOT, 'app', 'lego-station-run-log.html');
const RUNTIME_FILE = path.join(ROOT, 'app', 'local-runtime.js');
const PORT = Number(process.env.PORT) || 4173;
const MAX_UPLOAD = 500 * 1024 * 1024;

// /live runs the YOLO model and the hand model in the browser. WASM threads need cross-origin isolation, so /live and its
// vendor and model files carry COOP and COEP (credentialless keeps the Google Fonts link working). / is left alone.
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
const LineEngine = (() => { const mod = { exports: {} }; new Function('module', fs.readFileSync(path.join(ROOT, 'app', 'line-engine.js'), 'utf8'))(mod); return mod.exports; })();
const SESSION_ID = /^\d{8}-\d{6}-[a-f0-9]{4}$/;
const STATION_ID = /^[a-z][a-z0-9_]{0,15}$/;
const VIDEO_EXT = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv' };

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
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { code: 'too_large' })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (p === '/' || p === '/index.html') {
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
  if (p === '/line-engine.js') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'line-engine.js')), 'text/javascript; charset=utf-8', ISOLATE);
  if (p === '/line-hands-worker.js') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'line-hands-worker.js')), 'text/javascript; charset=utf-8', ISOLATE);
  if (p.startsWith('/api/line/')) return lineApi(req, res, p);
  if (p === '/api/sessions' || p.startsWith('/api/sessions/')) return sessionsApi(req, res, p, url);
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

// Zones and calibration per station. Unknown stations are refused; zones the config no longer has are dropped.
function cleanSetup(body, cfg) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object keyed by station.' };
  const out = {};
  for (const [sid, v] of Object.entries(body)) {
    const st = STATION_ID.test(sid) && cfg.stations.find(s => s.id === sid);
    if (!st) return { error: 'Unknown station "' + String(sid).slice(0, 40) + '".' };
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
  }
  return { setup: out };
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
      for (const v of s.videos) clips.push({ key: 'session:' + s.id + ':' + v.file, label: (s.title || s.id) + ', ' + v.station + (v.part > 1 ? ' part ' + v.part : ''), url: '/api/sessions/' + s.id + '/video/' + v.station + (v.part > 1 ? '?part=' + v.part : ''), group: 'sessions' });
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
function listSessions() {
  if (!fs.existsSync(SESSIONS)) return [];
  const out = [];
  for (const id of fs.readdirSync(SESSIONS).filter(n => SESSION_ID.test(n)).sort().reverse()) {
    try {
      const d = SESS.has(id) ? SESS.get(id).doc : readJson(sessionFile(id));
      out.push({ id, title: d.title, crew: d.crew, shift: d.shift, startedAt: d.startedAt, endedAt: d.endedAt || null, videos: videoList(d) });
    } catch (e) { /* not a session */ }
  }
  return out;
}
function newSessionId() {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}
function cleanEvent(e, ids) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'is not an object';
  if (!LineEngine.EVENT_TYPES.includes(e.type)) return 'has an unknown type';
  if (typeof e.t !== 'number' || !isFinite(e.t)) return 'has no time t';
  if (e.station != null && !ids.includes(e.station)) return 'names an unknown station';
  if (JSON.stringify(e).length > 4000) return 'is too long';
  return null;
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
    const ids = stationIds(cfg), stations = {};
    for (const [sid, v] of Object.entries(body.stations || {})) {
      if (!ids.includes(sid)) return fail(res, 400, 'invalid_argument', 'Unknown station "' + String(sid).slice(0, 40) + '".');
      const input = v && ['camera', 'clip', 'none'].includes(v.input) ? v.input : 'none';
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
  const ids = stationIds(doc.config).length ? stationIds(doc.config) : stationIds(lineConfig());

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
      }
      if (list.length) fs.appendFileSync(path.join(dir, 'events.jsonl'), list.map(e => JSON.stringify(e)).join('\n') + '\n');
      return send(res, 200, { ok: true, appended: list.length });
    }
    if (what === 'end' && req.method === 'POST') {
      try { await readBody(req, 64 * 1024); } catch (e) { /* ignore the body */ }
      if (!doc.endedAt) { doc.endedAt = new Date().toISOString(); doc.endedAtMs = Date.now(); }
      try { doc.summary = LineEngine.summarize(readEvents(id), doc.config || lineConfig(), { now: doc.endedAtMs }); } catch (e) { doc.summary = null; console.error(e); }
      saveSession(id, true);
      return send(res, 200, Object.assign({}, doc, { videos: videoList(doc) }));
    }
    if (what === 'events.jsonl' && req.method === 'GET') {
      return send(res, 200, fs.readFileSync(path.join(dir, 'events.jsonl')), 'application/x-ndjson; charset=utf-8', { 'Content-Disposition': `attachment; filename="${id}-events.jsonl"` });
    }
    if ((what === 'substeps.csv' || what === 'cycles.csv') && req.method === 'GET') {
      const meta = { id, crew: doc.crew, shift: doc.shift, startedAtMs: doc.startedAtMs };
      const cfg = doc.config || lineConfig();
      const csv = what === 'substeps.csv' ? LineEngine.substepsCsv(readEvents(id), cfg, meta) : LineEngine.cyclesCsv(readEvents(id), cfg, meta);
      return send(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${id}-${what}"` });
    }
    return fail(res, 400, 'invalid_argument', 'Bad session path.');
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

http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) fail(res, 500, 'unavailable', String(e && e.message || e)); });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`LEGO Station Run Log: http://localhost:${PORT}`);
  console.log(`Data folder: ${DATA}`);
  if (!hasFfmpeg) console.log('ffmpeg not found: uploads are stored as-is, and agents cannot analyze videos until it is installed.');
});
