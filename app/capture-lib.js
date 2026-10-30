// Capture, review and training-set helpers for the wire line. Pure functions, no DOM, no node modules, so the
// server, the review page and the tests all load this one file. Browser: window.CaptureLib. Node: module.exports.
//
// A capture is a JPEG frame plus what the system believed (boxes, claim). A person reviews it (confirmed, corrected,
// rejected, unsure); reviewed frames become a YOLO training set that is split by session, never by frame.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CaptureLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const REASONS = ['claim', 'unsure', 'cycle_end', 'cycle_start', 'stalled', 'sample', 'manual', 'home'];
  const VERDICTS = ['confirmed', 'corrected', 'rejected', 'unsure'];
  const MAX_BOXES = 100;
  const DAY_MS = 86400000;

  const isNum = v => typeof v === 'number' && isFinite(v);
  const round6 = v => Math.round(v * 1e6) / 1e6;

  // "c0001". Ids never get reused while the latest capture of a session exists: the next one is the highest plus one.
  function captureId(n) { return 'c' + String(n).padStart(4, '0'); }
  function nextCaptureNumber(ids) {
    let max = 0;
    for (const id of ids || []) { const m = /^c(\d{4,})$/.exec(id); if (m) max = Math.max(max, Number(m[1])); }
    return max + 1;
  }
  // The file name stem a reviewed frame has in the training set.
  function trainingName(sessionId, capId) { return sessionId + '_' + capId; }

  // The position of a class in a role's class list (the order the model and the notebooks use), or -1.
  function classIndex(classes, cls) { return Array.isArray(classes) ? classes.indexOf(cls) : -1; }

  // One normalized box [x1, y1, x2, y2] (each 0..1, right and bottom past left and top) as a YOLO label line:
  // "<classIndex> cx cy w h", 6 decimals. Returns null for a box that is not valid.
  function yoloLine(index, nbox) {
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(nbox) || nbox.length !== 4 || !nbox.every(v => isNum(v) && v >= 0 && v <= 1)) return null;
    const [x1, y1, x2, y2] = nbox;
    if (x2 <= x1 || y2 <= y1) return null;
    const f = v => v.toFixed(6);
    return index + ' ' + f((x1 + x2) / 2) + ' ' + f((y1 + y2) / 2) + ' ' + f(x2 - x1) + ' ' + f(y2 - y1);
  }
  // The label file text for a list of boxes ({ cls, nbox }): one line per box, or '' (a negative image).
  function labelText(boxes, classes) {
    const lines = [];
    for (const b of boxes || []) {
      const l = yoloLine(classIndex(classes, b.cls), b.nbox);
      if (l) lines.push(l);
    }
    return lines.length ? lines.join('\n') + '\n' : '';
  }

  // Check and clean a list of boxes: [{ cls, conf?, nbox: [x1, y1, x2, y2] }]. opts.classes: every cls must be one of
  // these. opts.conf: keep conf (a number 0..1, or left out). Returns { boxes } or { error } in plain words.
  function cleanBoxes(list, opts) {
    const o = opts || {};
    if (!Array.isArray(list)) return { error: 'boxes must be a list.' };
    if (list.length > (o.max || MAX_BOXES)) return { error: 'boxes: at most ' + (o.max || MAX_BOXES) + ' boxes.' };
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i], n = 'Box ' + (i + 1);
      if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: n + ' must be an object { cls, nbox }.' };
      if (typeof b.cls !== 'string' || !b.cls || b.cls.length > 60) return { error: n + ' needs a class name (cls).' };
      if (o.classes && !o.classes.includes(b.cls)) return { error: n + ': class "' + b.cls.slice(0, 40) + '" is not in this role\'s class list.' };
      if (!Array.isArray(b.nbox) || b.nbox.length !== 4 || !b.nbox.every(v => isNum(v) && v >= 0 && v <= 1) || b.nbox[2] <= b.nbox[0] || b.nbox[3] <= b.nbox[1]) return { error: n + ' needs nbox [x1, y1, x2, y2], each 0 to 1, right and bottom past left and top.' };
      const c = { cls: b.cls, nbox: b.nbox.map(round6) };
      if (o.conf && b.conf != null) {
        if (!isNum(b.conf) || b.conf < 0 || b.conf > 1) return { error: n + ': conf must be a number from 0 to 1.' };
        c.conf = round6(b.conf);
      }
      out.push(c);
    }
    return { boxes: out };
  }

  // A real JPEG starts with the bytes FF D8 FF.
  function isJpeg(bytes) { return !!bytes && bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF; }

  // ---------- hashing (pure, so the review page can split exactly like the server) ----------
  function utf8(s) { return typeof s === 'string' ? new TextEncoder().encode(s) : s; }
  function sha1(input) {
    const data = utf8(input), n = data.length;
    const total = ((n + 8) >> 6 << 6) + 64, buf = new Uint8Array(total);
    buf.set(data); buf[n] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(n * 8 / 0x100000000)); dv.setUint32(total - 4, (n * 8) >>> 0);
    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const w = new Uint32Array(80), rol = (x, s) => (x << s) | (x >>> (32 - s));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        const t = (rol(a, 5) + f + e + k + w[i]) >>> 0;
        e = d; d = c; c = rol(b, 30) >>> 0; b = a; a = t;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    return [h0, h1, h2, h3, h4].map(v => v.toString(16).padStart(8, '0')).join('');
  }
  // Which split a session lands in: "test" if pinned (pinned = { "<sessionId>": "test" }), else about 20% "val" by a
  // stable hash (first 4 bytes of sha1 of the session id), else "train". The same session always gets the same answer.
  function sessionSplit(sessionId, pinned) {
    if (pinned && pinned[sessionId] === 'test') return 'test';
    const u = parseInt(sha1(String(sessionId)).slice(0, 8), 16);
    return u % 5 === 0 ? 'val' : 'train';
  }

  // ---------- store-only zip writer ----------
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  // entries: [{ name, data }] (data: Uint8Array, Buffer or string). A name ending in "/" is a folder entry (no data).
  // Returns a Uint8Array. Store only (no compression: JPEG does not shrink). No zip64: at most 65535 entries and 4 GB.
  function zip(entries, date) {
    const d = date instanceof Date ? date : new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    if (entries.length > 65535) throw new Error('Too many files for a zip (' + entries.length + ').');
    const files = entries.map(e => {
      const dir = e.name.endsWith('/'), data = dir ? new Uint8Array(0) : utf8(e.data == null ? '' : e.data);
      return { name: utf8(e.name), dir, data, crc: crc32(data) };
    });
    let size = 22, bytes = 0;
    for (const f of files) { size += 30 + f.name.length + f.data.length + 46 + f.name.length; bytes += f.data.length; }
    if (size >= 0xFFFFFFFF) throw new Error('The training set is over 4 GB: too big for one zip.');
    const out = new Uint8Array(size), dv = new DataView(out.buffer);
    let p = 0;
    const offsets = [];
    for (const f of files) {
      offsets.push(p);
      dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 0x0800, true); dv.setUint16(p + 8, 0, true);
      dv.setUint16(p + 10, dosTime, true); dv.setUint16(p + 12, dosDate, true); dv.setUint32(p + 14, f.crc, true);
      dv.setUint32(p + 18, f.data.length, true); dv.setUint32(p + 22, f.data.length, true); dv.setUint16(p + 26, f.name.length, true); dv.setUint16(p + 28, 0, true);
      out.set(f.name, p + 30); out.set(f.data, p + 30 + f.name.length);
      p += 30 + f.name.length + f.data.length;
    }
    const cdStart = p;
    files.forEach((f, i) => {
      dv.setUint32(p, 0x02014b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 20, true); dv.setUint16(p + 8, 0x0800, true); dv.setUint16(p + 10, 0, true);
      dv.setUint16(p + 12, dosTime, true); dv.setUint16(p + 14, dosDate, true); dv.setUint32(p + 16, f.crc, true);
      dv.setUint32(p + 20, f.data.length, true); dv.setUint32(p + 24, f.data.length, true); dv.setUint16(p + 28, f.name.length, true);
      dv.setUint16(p + 30, 0, true); dv.setUint16(p + 32, 0, true); dv.setUint16(p + 34, 0, true); dv.setUint16(p + 36, 0, true);
      dv.setUint32(p + 38, f.dir ? 0x10 : 0, true); dv.setUint32(p + 42, offsets[i], true);
      out.set(f.name, p + 46);
      p += 46 + f.name.length;
    });
    dv.setUint32(p, 0x06054b50, true); dv.setUint16(p + 4, 0, true); dv.setUint16(p + 6, 0, true);
    dv.setUint16(p + 8, files.length, true); dv.setUint16(p + 10, files.length, true);
    dv.setUint32(p + 12, p - cdStart, true); dv.setUint32(p + 16, cdStart, true); dv.setUint16(p + 20, 0, true);
    return out;
  }

  // data.yaml for one role's export: the folders are train/images, val/images and test/images (labels sit beside them).
  // Ultralytics resolves a relative "path" against its own datasets folder, so the training cell sets path to the
  // folder the zip was unpacked into.
  function dataYaml(classes) {
    return '# YOLO dataset from the wire line review page. Set path to the folder this zip was unpacked into.\n'
      + 'path: .\ntrain: train/images\nval: val/images\ntest: test/images\nnc: ' + classes.length + '\nnames:\n'
      + classes.map((c, i) => '  ' + i + ': ' + c).join('\n') + '\n';
  }

  // ---------- retention ----------
  // Which captures the sweeper deletes. items: [{ key, receivedAt (ms), bytes, reviewed }]. Never a reviewed one.
  // First every unreviewed one older than reviewDays; then, while total media is over mediaCapMB, the oldest unreviewed.
  function planSweep(items, o) {
    const now = o.now, ageMs = o.reviewDays * DAY_MS, cap = o.mediaCapMB * 1024 * 1024;
    const del = new Set();
    let total = 0;
    for (const it of items) {
      if (!it.reviewed && now - it.receivedAt > ageMs) del.add(it.key);
      else total += it.bytes || 0;
    }
    if (total > cap) {
      const rest = items.filter(it => !it.reviewed && !del.has(it.key)).sort((a, b) => a.receivedAt - b.receivedAt);
      for (const it of rest) { if (total <= cap) break; del.add(it.key); total -= it.bytes || 0; }
    }
    return items.filter(it => del.has(it.key)).map(it => it.key);
  }

  // ---------- shared pool ----------
  // A contributor is a short code like "Mg-07" (letters, a dash, digits). Never a name.
  const CONTRIBUTOR = /^[A-Za-z]{1,4}-\d{1,3}$/;
  const POOL_MODES = ['home', 'group'];
  const isContributor = v => typeof v === 'string' && CONTRIBUTOR.test(v);
  // The pool block of data/meta/wire-line.json: { "dir": "<folder>" }. Optional; dir defaults to data/pool. Returns
  // { pool: { dir } } (dir '' means the default) or { error } in plain words.
  function cleanPool(p) {
    if (p == null) return { pool: { dir: '' } };
    if (typeof p !== 'object' || Array.isArray(p)) return { error: 'pool must look like { "dir": "data/pool" }.' };
    for (const k of Object.keys(p)) if (k !== 'dir') return { error: 'pool has an unknown key "' + k.slice(0, 40) + '"; only dir is used.' };
    if (p.dir == null || p.dir === '') return { pool: { dir: '' } };
    if (typeof p.dir !== 'string' || p.dir.length > 500 || p.dir.includes('\0') || !p.dir.trim()) return { error: 'pool.dir must be a folder path (text).' };
    return { pool: { dir: p.dir.trim() } };
  }

  return { REASONS, VERDICTS, isContributor, cleanPool, POOL_MODES, MAX_BOXES, captureId, nextCaptureNumber, trainingName, classIndex, yoloLine, labelText, cleanBoxes, isJpeg, sha1, sessionSplit, crc32, zip, dataYaml, planSweep };
});
