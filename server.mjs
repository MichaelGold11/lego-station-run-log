// Local server for the LEGO Station Run Log.
// Serves the app, a small JSON document store (data/<collection>/<id>.json) and the
// uploaded files (data/assets/<id>.<ext>). No dependencies; Node 18 or newer.
//
//   npm start            -> http://localhost:4173
//   PORT=5000 npm start  -> another port

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const ASSETS = path.join(DATA, 'assets');
const APP_FILE = path.join(ROOT, 'app', 'lego-station-run-log.html');
const RUNTIME_FILE = path.join(ROOT, 'app', 'local-runtime.js');
const PORT = Number(process.env.PORT) || 4173;
const MAX_UPLOAD = 500 * 1024 * 1024;

// The same minimal page skeleton the claude.ai artifact viewer wraps around the app.
const HEAD = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<style>:root{color-scheme:light;box-sizing:border-box}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}[hidden]{display:none!important}</style>'
  + '<script src="/local-runtime.js"></script></head><body>\n';

const TYPES = {
  '.mp4': 'video/mp4', '.mov': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain'
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

function send(res, code, body, type = 'application/json') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
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
function serveFile(req, res, file, type) {
  const stat = fs.statSync(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    // Video seeking needs byte ranges.
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    if (start >= stat.size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); return res.end(); }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (p === '/' || p === '/index.html') {
    const html = HEAD + fs.readFileSync(APP_FILE, 'utf8') + '\n</body></html>';
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (p === '/live') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'live-mock.html')), 'text/html; charset=utf-8');
  if (p === '/live-engine.js') return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'live-engine.js')), 'text/javascript; charset=utf-8');
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

http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) fail(res, 500, 'unavailable', String(e && e.message || e)); });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`LEGO Station Run Log: http://localhost:${PORT}`);
  console.log(`Data folder: ${DATA}`);
  if (!hasFfmpeg) console.log('ffmpeg not found: uploads are stored as-is, and agents cannot analyze videos until it is installed.');
});
