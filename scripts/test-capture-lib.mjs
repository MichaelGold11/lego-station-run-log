// Capture, review and training-set helper tests (app/capture-lib.js). Run: npm run test:line
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const load = f => { const mod = { exports: {} }; new Function('module', fs.readFileSync(new URL('../app/' + f, import.meta.url), 'utf8'))(mod); return mod.exports; };
const CL = load('capture-lib.js');

let fails = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log('  pass  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); }
}

console.log('YOLO labels and class index');
{
  const classes = ['red_wire', 'white_wire', 'connector_open'];
  check('class index is the position in the list, -1 when missing', CL.classIndex(classes, 'connector_open') === 2 && CL.classIndex(classes, 'red_wire') === 0 && CL.classIndex(classes, 'nope') === -1 && CL.classIndex(null, 'x') === -1);
  check('a box becomes "<class> cx cy w h" with 6 decimals', CL.yoloLine(2, [0.1, 0.2, 0.5, 0.8]) === '2 0.300000 0.500000 0.400000 0.600000', CL.yoloLine(2, [0.1, 0.2, 0.5, 0.8]));
  check('a full-frame box is 0.5 0.5 1 1', CL.yoloLine(0, [0, 0, 1, 1]) === '0 0.500000 0.500000 1.000000 1.000000');
  check('a degenerate, out-of-range or malformed box gives null', [[0.5, 0.5, 0.5, 0.9], [0.6, 0.1, 0.4, 0.9], [-0.1, 0, 0.5, 0.5], [0, 0, 1.2, 1], [0, 0, 1], 'x', null, [0, 0, NaN, 1]].every(b => CL.yoloLine(0, b) === null) && CL.yoloLine(-1, [0, 0, 1, 1]) === null && CL.yoloLine(1.5, [0, 0, 1, 1]) === null);
  check('a label file has one line per box and ends with a newline; no boxes is an empty file', CL.labelText([{ cls: 'red_wire', nbox: [0, 0, 0.5, 0.5] }, { cls: 'white_wire', nbox: [0.5, 0.5, 1, 1] }], classes) === '0 0.250000 0.250000 0.500000 0.500000\n1 0.750000 0.750000 0.500000 0.500000\n' && CL.labelText([], classes) === '');
}

console.log('box validation');
{
  const classes = ['a', 'b'];
  const ok = CL.cleanBoxes([{ cls: 'a', conf: 0.51234567, nbox: [0.1, 0.1, 0.5, 0.5] }], { classes, conf: true });
  check('good boxes pass, rounded to 6 decimals, conf kept only when asked', ok.boxes && ok.boxes[0].conf === 0.512346 && !('conf' in CL.cleanBoxes([{ cls: 'a', conf: 0.5, nbox: [0, 0, 1, 1] }], { classes }).boxes[0]));
  check('a class outside the list is refused and named', /class "zzz" is not in this role/.test(CL.cleanBoxes([{ cls: 'zzz', nbox: [0, 0, 1, 1] }], { classes }).error || ''));
  check('without a class list any class name passes', !!CL.cleanBoxes([{ cls: 'zzz', nbox: [0, 0, 1, 1] }], {}).boxes);
  check('bad shapes are refused', ['x', null, [], { cls: 5, nbox: [0, 0, 1, 1] }, { cls: 'a' }, { cls: 'a', nbox: [0, 0, 1] }, { cls: 'a', nbox: [0.5, 0, 0.5, 1] }, { cls: 'a', nbox: [0, 0, 2, 1] }, { cls: 'a', nbox: [0, 0, 1, 1], conf: 2 }].every(b => CL.cleanBoxes([b], { classes, conf: true }).error));
  check('not a list, or too many boxes, is refused', CL.cleanBoxes('x', {}).error && CL.cleanBoxes(new Array(101).fill({ cls: 'a', nbox: [0, 0, 1, 1] }), {}).error);
  check('an empty list is fine', CL.cleanBoxes([], { classes }).boxes.length === 0);
}

console.log('ids, JPEG check, session split');
{
  check('capture ids are zero padded and the next one follows the highest', CL.captureId(1) === 'c0001' && CL.captureId(12345) === 'c12345' && CL.nextCaptureNumber([]) === 1 && CL.nextCaptureNumber(['c0001', 'c0007', 'c0003', 'junk']) === 8);
  check('JPEG magic bytes: FF D8 FF only', CL.isJpeg(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1])) && !CL.isJpeg(Buffer.from('GIF89a..')) && !CL.isJpeg(Buffer.from([0xFF, 0xD8])) && !CL.isJpeg(null) && !CL.isJpeg(Buffer.from('\x89PNG\r\n\x1a\n')));
  const ok = ['', 'a', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), '20261029-180407-23b0', 'ä'.repeat(40)].every(s => CL.sha1(s) === crypto.createHash('sha1').update(s).digest('hex'));
  check('the pure sha1 matches node crypto, including the padding edge lengths', ok);
  const ids = Array.from({ length: 400 }, (_, i) => '20261029-' + String(100000 + i) + '-' + (i * 7919 % 65536).toString(16).padStart(4, '0'));
  const first = ids.map(i => CL.sessionSplit(i, {}));
  check('the split is stable: asked again, or after a pin elsewhere, the same answer', ids.every((i, k) => CL.sessionSplit(i, {}) === first[k] && CL.sessionSplit(i, { other: 'test' }) === first[k]));
  const val = first.filter(s => s === 'val').length;
  check('about 20% of sessions land in val, the rest in train, none in test', val > 400 * 0.14 && val < 400 * 0.26 && first.every(s => s === 'val' || s === 'train'), String(val));
  check('a session pinned test is test whatever its hash, and only "test" counts as a pin', ids.every(i => CL.sessionSplit(i, { [i]: 'test' }) === 'test') && ids.every((i, k) => CL.sessionSplit(i, { [i]: null }) === first[k] && CL.sessionSplit(i, { [i]: 'val' }) === first[k]));
  const v = ids.find((_, k) => first[k] === 'val');
  check('the hash is the first 4 bytes of sha1 modulo 5 (0 is val)', parseInt(crypto.createHash('sha1').update(v).digest('hex').slice(0, 8), 16) % 5 === 0);
}

console.log('zip writer');
{
  // A small reader of the zip structure: end record, central directory, local headers.
  function readZip(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let e = buf.length - 22;
    if (dv.getUint32(e, true) !== 0x06054b50) return null;
    const n = dv.getUint16(e + 10, true), cdSize = dv.getUint32(e + 12, true), cdOff = dv.getUint32(e + 16, true);
    const files = [];
    let p = cdOff;
    for (let i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) return null;
      const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), cs = dv.getUint32(p + 20, true), us = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true);
      const name = Buffer.from(buf.subarray(p + 46, p + 46 + nl)).toString('utf8');
      if (dv.getUint32(off, true) !== 0x04034b50) return null;
      const lnl = dv.getUint16(off + 26, true), lel = dv.getUint16(off + 28, true), start = off + 30 + lnl + lel;
      files.push({ name, method, crc, size: us, csize: cs, data: Buffer.from(buf.subarray(start, start + cs)) });
      p += 46 + nl;
    }
    return { files, count: n, cdEnd: cdOff + cdSize, cdOff };
  }
  check('crc32 matches node zlib', [Buffer.alloc(0), Buffer.from('hello'), crypto.randomBytes(5000)].every(b => CL.crc32(b) === zlib.crc32(b)));
  const jpg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), crypto.randomBytes(3000)]);
  const z = CL.zip([{ name: 'train/', data: null }, { name: 'train/images/a.jpg', data: jpg }, { name: 'train/labels/a.txt', data: '0 0.5 0.5 1.000000 1.000000\n' }, { name: 'empty.txt', data: '' }, { name: 'ünï.txt', data: 'x' }], new Date(2026, 9, 30, 12, 0, 0));
  const r = readZip(Buffer.from(z));
  check('the zip has an end record, a central directory and every file in order', r && r.count === 5 && r.files.map(f => f.name).join() === 'train/,train/images/a.jpg,train/labels/a.txt,empty.txt,ünï.txt' && r.cdEnd === z.length - 22);
  check('every entry is stored (method 0), sizes agree and the bytes are intact', r.files.every(f => f.method === 0 && f.size === f.csize && f.crc === zlib.crc32(f.data)) && r.files[1].data.equals(jpg) && r.files[2].data.toString() === '0 0.5 0.5 1.000000 1.000000\n' && r.files[3].size === 0 && r.files[0].size === 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-test-'));
  try {
    fs.writeFileSync(path.join(dir, 't.zip'), z);
    const has = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status != null;
    if (has) {
      const t = spawnSync('unzip', ['-tq', path.join(dir, 't.zip')], { encoding: 'utf8' });
      check('the system unzip accepts it and tests every file ok', t.status === 0, (t.stdout + t.stderr).slice(0, 200));
      spawnSync('unzip', ['-q', path.join(dir, 't.zip'), '-d', path.join(dir, 'out')]);
      check('unzip extracts the JPEG byte for byte', fs.existsSync(path.join(dir, 'out/train/images/a.jpg')) && fs.readFileSync(path.join(dir, 'out/train/images/a.jpg')).equals(jpg));
    } else console.log('  skip  system unzip not installed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  check('an empty zip is just the end record', CL.zip([]).length === 22 && readZip(Buffer.from(CL.zip([]))).count === 0);
}

console.log('data.yaml');
{
  const y = CL.dataYaml(['red_wire', 'connector_open']);
  check('data.yaml lists the three image folders, nc and the names in class order', /^path: \.$/m.test(y) && /^train: train\/images$/m.test(y) && /^val: val\/images$/m.test(y) && /^test: test\/images$/m.test(y) && /^nc: 2$/m.test(y) && /names:\n {2}0: red_wire\n {2}1: connector_open\n$/.test(y), y);
}

console.log('retention plan');
{
  const DAY = 86400000, now = 100 * DAY, MB = 1024 * 1024;
  const it = (key, ageDays, mb, reviewed) => ({ key, receivedAt: now - ageDays * DAY, bytes: mb * MB, reviewed: !!reviewed });
  const items = [it('old', 9, 1), it('oldReviewed', 30, 1, true), it('fresh', 1, 1), it('edge', 7, 1), it('newer', 6.9, 1)];
  const plan = CL.planSweep(items, { now, reviewDays: 7, mediaCapMB: 1000 });
  check('only unreviewed captures older than reviewDays go (exactly 7 days stays)', plan.join() === 'old', plan.join());
  const big = [it('a', 3, 400), it('b', 2, 400), it('c', 1, 400), it('r', 5, 300, true)];
  const plan2 = CL.planSweep(big, { now, reviewDays: 7, mediaCapMB: 1000 });
  check('over the media cap: the oldest unreviewed first, just enough, reviewed ones never', plan2.join() === 'a,b', plan2.join());
  const plan3 = CL.planSweep(big, { now, reviewDays: 7, mediaCapMB: 100 });
  check('if only reviewed media is left over the cap nothing more is deleted', plan3.join() === 'a,b,c', plan3.join());
  check('nothing to do gives an empty plan', CL.planSweep([], { now, reviewDays: 7, mediaCapMB: 1 }).length === 0);
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
