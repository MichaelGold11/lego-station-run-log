// Tests for scripts/ingest-footage.mjs: frame selection and the captures.jsonl line shape. Run: npm run test:ingest
import fs from 'node:fs';
import { selectFrames, captureLine, claimText, sessionId } from './ingest-footage.mjs';
const load = f => { const mod = { exports: {} }; new Function('module', fs.readFileSync(new URL('../app/' + f, import.meta.url), 'utf8'))(mod); return mod.exports; };
const CL = load('capture-lib.js');

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  pass  ' + name);
  else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); }
}

// 400 synthetic frames: red often, white sometimes, connector_closed rare, some empty, some unsure
const classes = ['red_wire', 'white_wire', 'connector_open', 'connector_closed'];
const frames = [];
for (let i = 0; i < 400; i++) {
  const dets = [];
  if (i % 10 === 0) { /* empty */ }
  else {
    dets.push({ cls: 'red_wire', conf: i % 6 === 1 ? 0.3 + (i % 5) * 0.02 : 0.6 + (i % 7) * 0.05 });
    if (i % 3 === 0) dets.push({ cls: 'white_wire', conf: 0.5 + (i % 5) * 0.08 });
    if (i % 40 === 5) dets.push({ cls: 'connector_closed', conf: 0.55 + (i % 9) * 0.03 });
    if (i % 17 === 0) dets.push({ cls: 'connector_open', conf: 0.3 + (i % 4) * 0.05 });
  }
  frames.push({ idx: i, dets });
}
const sel = selectFrames(frames, { n: 150, classes });
const byIdx = new Map(frames.map(f => [f.idx, f]));
const has = (f, c) => f.dets.some(d => d.cls === c && d.conf >= 0.25);
console.log('selection');
check('about 150 unique, ascending', sel.length === 150 && new Set(sel).size === 150 && sel.every((v, i) => !i || v > sel[i - 1]), sel.length);
check('deterministic', JSON.stringify(sel) === JSON.stringify(selectFrames(frames, { n: 150, classes })));
const nEmpty = sel.filter(i => byIdx.get(i).dets.length === 0).length;
check('fixed empty share (15 of 150)', nEmpty === 15, nEmpty);
const nLow = sel.filter(i => { const d = byIdx.get(i).dets; return d.length && d.some(x => x.conf < 0.5); }).length;
check('at least the fixed low-confidence share (22 of 150)', nLow >= 22, nLow);
const rare = sel.filter(i => has(byIdx.get(i), 'connector_closed')).length;
check('the rare class is fully represented', rare === frames.filter(f => has(f, 'connector_closed')).length, rare);
check('every class appears', classes.every(c => sel.some(i => has(byIdx.get(i), c))));
check('not just the common class (white_wire at least 20)', sel.filter(i => has(byIdx.get(i), 'white_wire')).length >= 20);
check('n larger than the video returns every frame', selectFrames(frames.slice(0, 20), { n: 150, classes }).length === 20);
check('empty input', selectFrames([], { n: 10 }).length === 0);
check('no detections at all: spread evenly', (() => { const s = selectFrames(Array.from({ length: 100 }, (_, i) => ({ idx: i, dets: [] })), { n: 10 }); return s.length === 10 && s[0] < 10 && s[9] > 89; })());

console.log('captures.jsonl line');
{
  const boxes = [{ cls: 'red_wire', conf: 0.81, nbox: [0.1, 0.2, 0.3, 0.4] }, { cls: 'connector_open', conf: 0.4, nbox: [0.5, 0.5, 0.7, 0.6] }];
  const line = captureLine({ id: 'c0001', role: 's2', stationName: 'Connector', t: 1793315047358, videoT: 12.5, contributor: 'Op-07', boxes, model: { file: '/models/s2-connector.onnx' }, receivedAt: 1793315047358, bytes: 123456 });
  const round = JSON.parse(JSON.stringify(line));
  check('reason and mode are home', round.reason === 'home' && round.mode === 'home');
  check('station = role, contributor code kept', round.station === 's2' && round.role === 's2' && round.contributor === 'Op-07');
  check('no operator names or operator field', !('operator' in round) && !/name/i.test(Object.keys(round).join(',').replace('stationName', '')));
  check('id matches the server id format', /^c\d{4,}$/.test(round.id) && round.id === CL.captureId(1));
  const r = CL.cleanBoxes(round.boxes, { conf: true, classes });
  check('boxes pass the server box validator', !r.error && r.boxes.length === 2, r.error);
  check('boxes survive cleaning unchanged', JSON.stringify(r.boxes.map(b => [b.cls, b.conf, b.nbox])) === JSON.stringify(boxes.map(b => [b.cls, b.conf, b.nbox])));
  check('numeric fields', typeof round.t === 'number' && typeof round.videoT === 'number' && round.bytes <= 400 * 1024);
  check('claim text', round.claim === 'Home footage, pre-label: connector_open 0.40, red_wire 0.81', round.claim);
  check('empty claim', claimText([]) === 'Home footage, pre-label: nothing found');
  check('a bad box is rejected by the validator', !!CL.cleanBoxes([{ cls: 'red_wire', nbox: [0.5, 0.5, 0.4, 0.6] }], {}).error);
  if (!CL.REASONS.includes('home')) console.log('  NOTE  app/capture-lib.js REASONS does not list "home" yet, so POST /captures would refuse it; /review reads the files directly');
}
console.log('session id');
check('format', /^\d{8}-\d{6}-[0-9a-f]{4}$/.test(sessionId(Date.now(), 'ab12')));

console.log(fails ? '\n' + fails + ' FAILED' : '\nAll passed');
process.exit(fails ? 1 : 0);
