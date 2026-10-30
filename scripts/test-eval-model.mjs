// Tests for scripts/eval-model.mjs scoring. Run: npm run test:eval
import { iou, matchImage, addCounts, prf, summarize, parseLabels, confFor, pickImages } from './eval-model.mjs';

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  pass  ' + name);
  else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

check('iou identical is 1', near(iou([0, 0, 1, 1], [0, 0, 1, 1]), 1));
check('iou disjoint is 0', iou([0, 0, 1, 1], [2, 2, 3, 3]) === 0);
check('iou half overlap is 1/3', near(iou([0, 0, 2, 1], [1, 0, 3, 1]), 1 / 3));
check('iou degenerate box is 0', iou([0, 0, 0, 0], [0, 0, 0, 0]) === 0);

const g = [{ cls: 'a', box: [0, 0, 10, 10] }, { cls: 'a', box: [20, 20, 30, 30] }, { cls: 'b', box: [50, 50, 60, 60] }];
let m = matchImage(g, [{ cls: 'a', conf: 0.9, box: [0, 0, 10, 10] }, { cls: 'a', conf: 0.8, box: [21, 21, 31, 31] }, { cls: 'b', conf: 0.7, box: [0, 0, 5, 5] }], 0.4);
check('two a hits', m.a.tp === 2 && m.a.fp === 0 && m.a.fn === 0);
check('b miss is one fp and one fn', m.b.tp === 0 && m.b.fp === 1 && m.b.fn === 1);

m = matchImage(g, [{ cls: 'a', conf: 0.3, box: [0, 0, 10, 10] }], 0.4);
check('below threshold is ignored (fn, no fp)', m.a.tp === 0 && m.a.fp === 0 && m.a.fn === 2);
m = matchImage(g, [{ cls: 'a', conf: 0.3, box: [0, 0, 10, 10] }], { a: 0.2 });
check('per class threshold applies', m.a.tp === 1 && m.a.fn === 1);

m = matchImage([{ cls: 'a', box: [0, 0, 10, 10] }], [{ cls: 'a', conf: 0.9, box: [0, 0, 10, 10] }, { cls: 'a', conf: 0.8, box: [0, 0, 10, 10] }], 0.4);
check('a duplicate detection is a false positive', m.a.tp === 1 && m.a.fp === 1 && m.a.fn === 0);
m = matchImage([{ cls: 'a', box: [0, 0, 10, 10] }], [{ cls: 'b', conf: 0.9, box: [0, 0, 10, 10] }], 0.4);
check('wrong class never matches', m.a.fn === 1 && m.b.fp === 1);
m = matchImage([{ cls: 'a', box: [0, 0, 10, 10] }], [{ cls: 'a', conf: 0.9, box: [6, 0, 16, 10] }], 0.4);
check('IoU under 0.5 does not match', m.a.tp === 0 && m.a.fp === 1 && m.a.fn === 1);
m = matchImage([], [{ cls: 'a', conf: 0.9, box: [0, 0, 1, 1] }], 0.4);
check('negative image with a detection is a fp', m.a.fp === 1);
m = matchImage([], [], 0.4);
check('negative image with nothing is empty', Object.keys(m).length === 0);

const tot = {};
addCounts(tot, { a: { tp: 1, fp: 0, fn: 1 } }); addCounts(tot, { a: { tp: 2, fp: 1, fn: 0 }, b: { tp: 0, fp: 0, fn: 1 } });
check('addCounts sums', tot.a.tp === 3 && tot.a.fp === 1 && tot.a.fn === 1 && tot.b.fn === 1);

let r = prf({ tp: 3, fp: 1, fn: 1 });
check('precision, recall, f1', near(r.precision, 0.75) && near(r.recall, 0.75) && near(r.f1, 0.75));
r = prf({ tp: 0, fp: 0, fn: 0 });
check('nothing at all is null', r.precision === null && r.recall === null && r.f1 === null);
r = prf({ tp: 0, fp: 0, fn: 2 });
check('all missed: precision null, recall 0, f1 0', r.precision === null && r.recall === 0 && r.f1 === 0);

const rows = summarize({ b: { tp: 1, fp: 1, fn: 0 }, a: { tp: 3, fp: 1, fn: 1 } }, ['a', 'b', 'c']);
check('summary follows config order, skips unseen classes, adds all', rows.map(x => x.cls).join() === 'a,b,all');
check('all row is micro-averaged', rows[2].tp === 4 && rows[2].fp === 2 && rows[2].fn === 1 && near(rows[2].precision, 4 / 6));

const lab = parseLabels('1 0.5 0.5 0.2 0.4\n\n0 0.1 0.1 0.2 0.2\n', ['x', 'y']);
check('parseLabels converts yolo to corners', lab.length === 2 && lab[0].cls === 'y' && near(lab[0].box[0], 0.4) && near(lab[0].box[3], 0.7));
check('parseLabels of empty text is empty', parseLabels('', ['x']).length === 0);

check('confFor falls back to defaults.class then 0.4', confFor({ defaults: { class: 0.5 } }, 's1', 'a') === 0.5 && confFor({}, 's1', 'a') === 0.4);
check('confFor honors a per class override', confFor({ defaults: { class: 0.5 }, models: { s1: { classConf: { a: 0.3 } } } }, 's1', 'a') === 0.3);

const man = { images: { s1_c0001: { session: 'sess-a' }, s2_c0001: { session: 'sess-b' }, s3_c0001: { session: 'sess-c' } } };
const both = pickImages(man, { 'sess-a': 'test' }, 'both'), test = pickImages(man, { 'sess-a': 'test' }, 'test');
check('pinned session lands in test', test.some(x => x.session === 'sess-a') && both.every(x => x.split !== 'train'));
check('train images are excluded', pickImages(man, {}, 'both').every(x => x.split === 'val'));

console.log(fails ? fails + ' failed' : 'all passed');
process.exit(fails ? 1 : 0);
