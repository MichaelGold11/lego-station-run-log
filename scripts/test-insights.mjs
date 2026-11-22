// Assembly Insights tests: the digest of one session, the rollup every /insights page uses, the life of a flag,
// the audit rules (false-alarm rate named only after 5 reviews, "no remaining issue" is not a false alarm), and the
// simulated week. Run: npm run test:line (or node scripts/test-insights.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = f => { const mod = { exports: {} }; new Function('module', fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'))(mod); return mod.exports; };
const LineEngine = load('line-engine.js'), L = load('insights-lib.js');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'meta', 'wire-line.json'), 'utf8'));
let fails = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log('  pass  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); }
}

// A session at S2: six clean cycles of 12 s (one at 20 s), one wrong-order mistake, setup gaps flagged at the start.
const T0 = Date.UTC(2026, 10, 18, 15, 0, 0), s2 = config.stations.find(s => s.id === 's2');
const subs = s2.substeps.map(s => s.id), ev = [{ type: 'session_start', t: T0 }];
ev.push({ type: 'flag', station: 's2', substep: 's1x', note: 'no data: Cut wires not drawn', source: 'page', t: T0 });
let t = T0 + 1000;
for (let c = 1; c <= 6; c++) {
  const len = c === 6 ? 20000 : 12000;
  subs.forEach((id, k) => ev.push({ type: 'substep', station: 's2', substep: id, move: k ? 'next' : 'start', source: 'zones', conf: 0.9, cycle: c, t: t + k * len / subs.length, videoT: (t - T0) / 1000 }));
  ev.push({ type: 'cycle_end', station: 's2', cycle: c, source: 'zones', t: t + len });
  t += len + 2000;
}
ev.push({ type: 'substep', station: 's2', substep: subs[2], move: 'start', source: 'zones', conf: 0.3, cycle: 7, t: t + 500, videoT: 99 });
ev.push({ type: 'flag', station: 's2', substep: subs[0], note: 'skipped ' + s2.substeps[0].label, source: 'zones', cycle: 7, t: t + 500 });
ev.push({ type: 'verdict', station: 's2', kind: 'mistake', reason: 'wrong_order', message: 'Wrong order', substep: subs[0], cycle: 7, t: t + 800, conf: null, videoT: 99.3 });
ev.push({ type: 'verdict', station: 's2', kind: 'review', reason: 'low_confidence', message: 'Not sure', substep: subs[1], cycle: 7, t: t + 5000, conf: 0.51 });
ev.push({ type: 'session_end', t: t + 9000 });
const layout = { id: 'l1', name: 'My station S2', stations: [{ id: 's2', name: 'S2 Arrange and clamp', role: 's2', order: 1 }] };
const doc = { title: 'Test run', startedAtMs: T0, endedAtMs: t + 9000, layout };
const captures = [{ id: 'c0001', station: 's2', t: t + 900, reason: 'unsure' }, { id: 'c0002', station: 's2', t: t + 60000, reason: 'sample' }];
const cfg = LineEngine.applyLayout(config, layout);

console.log('digest');
const d = L.digestSession({ id: '20261118-150000-abcd', doc, events: ev, captures, config: cfg }, LineEngine);
check('only the layout station is in the digest', Object.keys(d.stations).join() === 's2', Object.keys(d.stations).join());
check('six finished cycles', d.stations.s2.cycles.length === 6, d.stations.s2.cycles.length);
check('cycle seconds come from the engine', d.stations.s2.cycles[0].sec === 12 && d.stations.s2.cycles[5].sec === 20);
check('per-step seconds add up to the cycle', Math.abs(Object.values(d.stations.s2.cycles[0].subs).reduce((a, b) => a + b, 0) - 12) < 0.2);
check('two observations: the mistake and the unsure one', d.observations.length === 2, d.observations.map(o => o.kind).join());
check('the skipped flag joins its mistake, not a third observation', !d.observations.some(o => o.kind === 'skipped'));
const wo = d.observations.find(o => o.kind === 'wrong_order');
check('wrong order has the camera\'s step order', wo && wo.seen.join() === subs[2], wo && wo.seen.join());
check('wrong order has the nearby unsure photo', wo && wo.photo === '/api/sessions/20261118-150000-abcd/captures/c0001.jpg', wo && wo.photo);
check('a photo a minute away is not used', d.observations.find(o => o.kind === 'low_confidence').photo === null);
check('confidence is a percent', d.observations.find(o => o.kind === 'low_confidence').conf === 51);
check('setup gaps are not observations', !d.observations.some(o => /no data/.test(o.message)));

console.log('rollup');
let r = L.rollup([d], {}, { now: t + 10000 });
const st = r.stations[0];
check('reference is the station\'s own median after 5 cycles', st.refSec === 12 && st.refSource === 'median', st.refSec + ' ' + st.refSource);
check('pace: mean 13.3 s against 12 s is 11% slower and past the line', st.pacePct === 11 && st.slow, st.pacePct);
check('time lost counts only the slow cycle', st.timeLostSec === 8, st.timeLostSec);
check('two open Needs Review', st.review === 2 && st.action === 0 && r.line.open.review === 2);
check('S2-only layout: no S3 station, so units done is null', r.line.units === null && r.line.doneAt.length === 0, JSON.stringify([r.line.units, r.line.doneAt]));
check('S2-only layout: the headline says no units done', /No units done \(no S3 station\)/.test(r.headline), r.headline);
check('S2-only layout: units in progress are the engine\'s count at session end', d.wipAtEnd != null && r.line.wipUnits === d.wipAtEnd && r.line.wipUnits >= 6, JSON.stringify([d.wipAtEnd, r.line.wipUnits]));
{
  // An S2 then S3 floor: six S2 cycles, four S3 cycles. Done counts the S3 cycles; the other two S2 units are still in progress.
  const s3 = config.stations.find(x => x.id === 's3'), subs3 = s3.substeps.map(x => x.id), ev3 = ev.filter(e => e.type !== 'session_end'), lay3 = { id: 'l2', name: 'S2 S3', stations: [{ id: 's2', name: 'S2', role: 's2', order: 1 }, { id: 's3', name: 'S3', role: 's3', order: 2 }] };
  let t3 = T0 + 1000;
  for (let c = 1; c <= 4; c++) {
    subs3.forEach((id, k) => ev3.push({ type: 'substep', station: 's3', substep: id, move: k ? 'next' : 'start', source: 'zones', conf: 0.9, cycle: c, t: t3 + k * 3000, videoT: (t3 - T0) / 1000 }));
    ev3.push({ type: 'cycle_end', station: 's3', cycle: c, source: 'zones', t: t3 + subs3.length * 3000 });
    t3 += subs3.length * 3000 + 2000;
  }
  ev3.push({ type: 'session_end', t: t + 9000 });
  const doc3 = { title: 'S2 S3', startedAtMs: T0, endedAtMs: t + 9000, layout: lay3 };
  const d3 = L.digestSession({ id: '20261118-160000-abcd', doc: doc3, events: ev3, captures: [], config: LineEngine.applyLayout(config, lay3) }, LineEngine);
  const r3 = L.rollup([d3], {}, { now: t + 10000 });
  check('S3 layout: units done = S3 cycles (4), counted at s3', r3.line.units === 4 && r3.line.doneAt.join() === 's3', JSON.stringify([r3.line.units, r3.line.doneAt]));
  check('S3 layout: wipUnits is a number from the engine (started at S2 minus done at S3)', typeof r3.line.wipUnits === 'number' && r3.line.wipUnits === d3.wipAtEnd && r3.line.wipUnits >= 2, JSON.stringify([d3.wipAtEnd, r3.line.wipUnits]));
  check('S3 layout: headline counts 4 units done', /^4 units done/.test(r3.headline), r3.headline);
}
check('the slow station with open flags is the focus', r.focus === 's2');
check('headline names it', /S2 Arrange and clamp is the one to look at/.test(r.headline), r.headline);
check('a standard time wins over the median', L.rollup([d], {}, { refSec: { s2: 10 } }).stations[0].pacePct === 33);
check('no false-alarm rate without reviews', r.camera.faRate === null);
check('a period with nothing in it has no cycles', L.rollup([d], {}, { from: t + 20000, to: t + 30000 }).line.cycles === 0);

console.log('the life of a flag');
const id = wo.id, now = t + 20000;
let rv = L.decide(null, { type: 'confirm' }, now);
check('confirm -> Action Required', rv.state === 'action_required');
rv = L.decide(rv, { type: 'plan', plan: 'assist' }, now + 1);
rv = L.decide(rv, { type: 'corrected', verified: false }, now + 2);
check('corrected but not verified stays open', rv.state === 'action_required' && rv.result === 'corrected');
rv = L.decide(rv, { type: 'verify' }, now + 3);
check('verified -> Resolved, with every step in the history', rv.state === 'resolved' && rv.history.length === 4);
r = L.rollup([d], { [id]: rv }, { now });
check('a resolved flag leaves the open counts on every page', r.stations[0].review === 1 && r.line.open.review === 1 && r.stations[0].action === 0);
const closed = L.decide(L.decide(null, { type: 'confirm' }, now), { type: 'no_remaining' }, now + 1);
check('"No remaining issue" closes without counting as a false alarm', closed.state === 'closed' && L.rollup([d], { [id]: closed }, {}).camera.falseAlarms === 0);
check('unable to verify leaves it in the review queue', L.decide(null, { type: 'unable' }, now).state === 'needs_review');
check('reopen goes back to Needs Review', L.decide(rv, { type: 'reopen' }, now).state === 'needs_review');

console.log('false alarms (audit: only name a checkpoint with 5+ reviews)');
const many = Object.assign({}, d, { observations: [] });
for (let k = 0; k < 6; k++) many.observations.push(Object.assign({}, wo, { id: 'x~s2~' + k, t: wo.t + k }));
const four = {}; for (let k = 0; k < 4; k++) four['x~s2~' + k] = L.decide(null, { type: 'dismiss' }, now);
check('4 reviews: no named rate', L.rollup([many], four, {}).camera.top === null);
const five = Object.assign({}, four, { 'x~s2~4': L.decide(null, { type: 'confirm' }, now) });
const r5 = L.rollup([many], five, {});
check('5 reviews: named at 80%', r5.camera.top && r5.camera.top.faRate === 80, JSON.stringify(r5.camera.top));
check('a mostly-false-alarm station counts for less in the focus', r5.stations[0].falseAlarmPct === 80);

console.log('simulation');
const demo = L.makeDemo(config, T0);
const rd = L.rollup(demo.digests, demo.reviews, { from: T0 - 7 * 86400000, to: T0 + 86400000, now: T0, refSec: demo.refSec });
check('a week of four stations', demo.digests.length === 7 && rd.stations.length === 4);
check('S2 is past the 10% line by the last day', rd.days[rd.days.length - 1].pct.s2 > 10, rd.days[rd.days.length - 1].pct.s2);
check('the trend names S2 as getting slower', rd.trend && rd.trend.worst && rd.trend.worst.id === 's2');
check('S4 pull-test flags are mostly false alarms', rd.camera.top && rd.camera.top.station === 's4' && rd.camera.top.faRate >= 60, JSON.stringify(rd.camera.top));
check('same numbers on every page: station open counts add up to the line', rd.stations.reduce((a, s) => a + s.review + s.action, 0) === rd.line.open.review + rd.line.open.action);

console.log('units per session (C5)');
{
  const U0 = 1700000000000, at = sec => U0 + sec * 1000;
  const st = (station, sec, no, unit) => ({ type: 'unit', station, action: 'start', t: at(sec), unit, no });
  const en = (station, from, to, no, unit) => ({ type: 'unit', station, action: 'end', t: at(to), start: at(from), end: at(to), unit, no, result: 'complete', needsReview: false, ended: 'departed', unlinked: false });
  const evU = [st('s2', 0, 1, 1), en('s2', 0, 40, 1, 1), st('s3', 50, 1, 1), en('s3', 50, 90, 1, 1), st('s2', 45, 2, 2), en('s2', 45, 80, 2, 2), st('s3', 100, 2, 2)];
  const du = L.digestSession({ id: '20261122-100000-abcd', doc: { title: 'U', startedAtMs: U0 }, events: evU, captures: [], config }, LineEngine);
  const byUnit = n => du.units.find(u => u.unit === n);
  check('digest.units has one row per unit (2)', Array.isArray(du.units) && du.units.length === 2, JSON.stringify(du.units.map(u => u.unit)));
  check('unit 1 is done after S3 completes, 90 s in total', byUnit(1) && byUnit(1).stage === 'done' && byUnit(1).totalSec === 90, JSON.stringify(byUnit(1) && [byUnit(1).stage, byUnit(1).totalSec]));
  check('unit 2 is at S3, open, its time runs to the last event (now = 100 s, so 0 s there)', byUnit(2) && byUnit(2).stage === 's3' && byUnit(2).s3Sec === 0, JSON.stringify(byUnit(2) && [byUnit(2).stage, byUnit(2).s3Sec]));
  check('a session with no unit events has units []', Array.isArray(d.units) && d.units.length === 0);
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
