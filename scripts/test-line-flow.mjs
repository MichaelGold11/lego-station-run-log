// End-to-end line flow: one unit through S2 then S3 under one number, with the REAL step engines, checkers and unit trackers of the shipped
// wire-line.json (model on), fed synthetic model detections frame by frame in the page's order (processStation in app/line.html).
// Run: node scripts/test-line-flow.mjs (part of npm run test:line)
import fs from 'node:fs';
const load = f => { const mod = { exports: {} }; new Function('module', fs.readFileSync(new URL('../app/' + f, import.meta.url), 'utf8'))(mod); return mod.exports; };
const LE = load('line-engine.js');
const CFG = JSON.parse(fs.readFileSync(new URL('../data/meta/wire-line.json', import.meta.url), 'utf8'));
let fails = 0;
function check(name, cond, extra) { if (cond) console.log('  pass  ' + name); else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); } }

const W = 640, H = 480, DT = 100;                      // 10 frames a second
// Zones as drawn on a session (fractions of the view).
const ZONES = {
  s2: { wires: { x: 0.05, y: 0.1, w: 0.4, h: 0.8 }, connectors: { x: 0.5, y: 0.1, w: 0.45, h: 0.4 }, work: { x: 0.3, y: 0.3, w: 0.65, h: 0.65 } },
  s3: { wires: { x: 0.05, y: 0.1, w: 0.4, h: 0.8 }, connectors: { x: 0.5, y: 0.1, w: 0.45, h: 0.4 }, work: { x: 0.3, y: 0.3, w: 0.65, h: 0.65 } }
};
// Pixels with a dark colorless speck on every ring, so the S2 finished-unit check sees the black wire it cannot see by model.
const px = (x, y) => (Math.round(x) + Math.round(y)) % 5 === 0 ? [10, 10, 10] : [200, 200, 200];
const det = (cls, conf, cx, cy, w, h) => ({ cls, conf, nbox: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], box: [(cx - w / 2) * W, (cy - h / 2) * H, (cx + w / 2) * W, (cy + h / 2) * H] });

function build(id, link, cfg, role) {
  cfg = cfg || CFG; role = role || id;
  const stn = cfg.stations.find(s => s.id === id), mcfg = cfg.models[id];
  const track = LE.trackedClasses(stn, mcfg.classes.slice());
  const eng = LE.createStation(stn, { holdFrames: CFG.holdFrames, defaults: CFG.defaults, qaGraceSec: CFG.qaGraceSec, modelClasses: track });
  const chk = LE.createChecker(stn); chk.setRef(null);
  const ut = LE.createUnitTracker(stn, { link });
  return { id, stn, track, eng, chk, ut, zones: ZONES[role], prevDets: null, events: [], seq: 0 };
}
// One frame of one station, as the page's processStation and the replay do it.
function frame(S, rawDets, t, act) {
  const dets = rawDets.slice();
  if (S.stn.assembly) { const done = LE.unitCheck(dets, px, W, H, S.stn.assembly); if (done) dets.push(done); }
  const base = {}; for (const z of S.stn.zones) base[z.id] = { activity: (act && act[z.id]) || 0, motion: 0, brightness: 0.5, bright: 0 };
  const cls = LE.steadyClasses(S.prevDets ? LE.classSignals(S.prevDets, S.zones, S.track) : null, LE.classSignals(dets, S.zones, S.track));
  S.prevDets = dets;
  const sig = LE.mergeSignals(base, cls, null);
  const stp = LE.stepStation(S.eng, S.ut, sig, t), evs = stp.events; evs.forEach(e => S.events.push(e));
  if (stp.held) S.chk.dismiss();
  const vds = stp.held ? [] : S.chk.update({ t, events: LE.checkerEvents(evs, S.ut), state: S.eng.state(), modelOn: true, frame: { id: ++S.seq, t, dets }, zones: S.zones, hands: null, motion: 0, idle: false });
  vds.forEach(e => S.events.push(e));
  const out = S.ut.update({ t, present: LE.unitPresent(dets, S.stn.unitTracker), hand: false, events: evs.concat(vds) });
  for (const e of out) { S.events.push(e); if (e.action === 'end' && e.reset) { S.eng.abandon(t).forEach(x => S.events.push(x)); S.chk.restart(); } }
}
function world() {
  const link = LE.createUnitLink(CFG), s2 = build('s2', link), s3 = build('s3', link);
  let t = 0;
  const w = { s2, s3, link, get t() { return t; },
    // Hold a scene for ms: dets2 / dets3 are what each station's model sees; act2 / act3 the zone activity.
    run(ms, dets2, dets3, act2, act3) { for (let n = Math.round(ms / DT); n > 0; n--) { t += DT; frame(s2, dets2 || [], t, act2); frame(s3, dets3 || [], t, act3); } return w; } };
  return w;
}
const subs = (S, from) => S.events.filter(e => e.type === 'substep' && e.t >= (from || 0)).map(e => e.substep);
const units = (S, action) => S.events.filter(e => e.type === 'unit' && (!action || e.action === action));
const mistakes = S => S.events.filter(e => (e.type === 'verdict' && (e.kind === 'mistake' || e.kind === 'review')) || e.type === 'flag');

// Scenes (what the model sees).
const S2 = {
  wires: [det('red_wire', 0.8, 0.2, 0.5, 0.25, 0.04), det('white_wire', 0.8, 0.2, 0.6, 0.25, 0.04), det('black_wire', 0.7, 0.2, 0.7, 0.25, 0.04)],
  open: [det('connector_open', 0.8, 0.65, 0.6, 0.12, 0.14), det('red_wire', 0.8, 0.5, 0.6, 0.25, 0.04)],
  closed: [det('connector_closed', 0.9, 0.65, 0.6, 0.12, 0.14), det('red_wire', 0.85, 0.5, 0.6, 0.25, 0.04), det('white_wire', 0.8, 0.5, 0.65, 0.25, 0.04)]
};
const S3 = {
  arrive: [det('connector_closed', 0.9, 0.5, 0.6, 0.12, 0.14), det('red_wire', 0.8, 0.35, 0.6, 0.25, 0.04)],
  open: [det('connector_closed', 0.9, 0.5, 0.6, 0.12, 0.14), det('connector_open', 0.8, 0.75, 0.3, 0.12, 0.14), det('red_wire', 0.8, 0.35, 0.6, 0.25, 0.04)],
  two: [det('connector_closed', 0.9, 0.5, 0.6, 0.12, 0.14), det('connector_closed', 0.8, 0.75, 0.3, 0.12, 0.14), det('red_wire', 0.8, 0.35, 0.6, 0.25, 0.04)],
  one: [det('connector_closed', 0.9, 0.5, 0.6, 0.12, 0.14), det('red_wire', 0.8, 0.35, 0.6, 0.25, 0.04)]
};
// A unit worked through S2, ending with it sitting finished in view (call run() for what comes next).
function s2Unit(w) {
  w.run(1600, S2.wires).run(1000, S2.open, null, { connectors: 0.6 })
    .run(1000, S2.open, null, { wires: 0.6 }).run(1500, S2.closed, null, { work: 0.6 }).run(1000, S2.closed);
}
// A unit worked through S3 (arrive, new connector open, two closed for 1.5 s, then 3.5 s), still in view.
function s3Unit(w) { w.run(1000, null, S3.arrive).run(1000, null, S3.open).run(1500, null, S3.two); }

console.log('line flow: unit #001 through S2 then S3');
const w = world();
w.run(2000);
check('1. both views empty: nothing started', units(w.s2).length === 0 && units(w.s3).length === 0);
s2Unit(w);
{
  const st = units(w.s2, 'start');
  check('1. S2 #001 starts', st.length === 1 && st[0].no === '#001', JSON.stringify(st));
  check('1. S2 substeps in order: arrive, open, arrange, close', subs(w.s2).join() === 's2_arrive,s2_open,s2_arrange,s2_close', subs(w.s2).join());
  check('1. S2 cycle ends (unit complete)', w.s2.events.some(e => e.type === 'cycle_end') && w.s2.ut.state().phase === 'complete', w.s2.ut.state().phase);
  check('1. S2 no mistake or flag', mistakes(w.s2).length === 0, JSON.stringify(mistakes(w.s2)));
}
// 2. The unit leaves S2 and shows up at S3 about 3 s later.
w.run(3000);
const t3 = w.t;
check('2. S2 #001 ended departed complete', (() => { const e = units(w.s2, 'end')[0]; return e && e.no === '#001' && e.ended === 'departed' && e.result === 'complete'; })(), JSON.stringify(units(w.s2, 'end')));
w.run(1000, null, S3.arrive);
{
  const st = units(w.s3, 'start')[0];
  check('2. S3 starts with no #001 from s2, not unlinked', st && st.no === '#001' && st.from === 's2' && st.unlinked === false, JSON.stringify(st));
}
// 3. S3 steps.
w.run(1000, null, S3.open);
const tTwo = w.t;
w.run(1500, null, S3.two);
check('3. two closed connectors for 1.5 s: not done yet', !w.s3.events.some(e => e.type === 'cycle_end') && w.s3.ut.state().phase === 'in_progress', subs(w.s3).join());
w.run(1000, null, S3.two);
check('3. still not done at 2.5 s', !w.s3.events.some(e => e.type === 'cycle_end') && w.s3.ut.state().phase === 'in_progress');
w.run(1000, null, S3.two);
check('3. done by 3.5 s of two closed connectors', w.s3.events.some(e => e.type === 'cycle_end') && w.s3.ut.state().phase === 'complete');
w.run(1000, null, S3.two);
{
  check('3. s3_arrive, s3_add_connector, s3_insert in order', subs(w.s3).join() === 's3_arrive,s3_add_connector,s3_insert', subs(w.s3).join());
  const ce = w.s3.events.filter(e => e.type === 'cycle_end');
  const ins = w.s3.events.find(e => e.type === 'substep' && e.substep === 's3_insert');
  check('3. S3 complete once: s3_insert fired when the two connectors showed, the cycle ended only after the 3 s hold (checked at 1.5, 2.5, 3.5 s)', ce.length === 1 && w.s3.ut.state().phase === 'complete' && ins.t - tTwo < 500, JSON.stringify(ce));
  check('3. S3 no mistake, no flag', mistakes(w.s3).length === 0, JSON.stringify(mistakes(w.s3)));
}
// 4. Finished unit stays; no second cycle, no new unit; then leaves.
const nSub = subs(w.s3).length;
w.run(4000, null, S3.two).run(2000, null, S3.one).run(1000, null, S3.arrive).run(1500, null, S3.two);
check('4. while it stays at S3: no second cycle, no new unit', units(w.s3, 'start').length === 1 && subs(w.s3).length === nSub && w.s3.events.filter(e => e.type === 'cycle_end').length === 1, units(w.s3, 'start').length + ' starts, ' + subs(w.s3).join());
w.run(3000);
{
  const e = units(w.s3, 'end')[0];
  check('4. S3 #001 ended departed complete', e && units(w.s3, 'end').length === 1 && e.no === '#001' && e.ended === 'departed' && e.result === 'complete' && !e.needsReview, JSON.stringify(e));
}
// 5. Second unit through both.
s2Unit(w); w.run(3000).run(1000, null, S3.arrive); s3Unit(w); w.run(3500, null, S3.two).run(3000);
{
  const e2 = units(w.s2, 'end'), e3 = units(w.s3, 'end');
  check('5. #002 at S2 and #002 at S3, both complete', e2.length === 2 && e2[1].no === '#002' && e2[1].result === 'complete' && e3.length === 2 && e3[1].no === '#002' && e3[1].result === 'complete' && !e3[1].unlinked, JSON.stringify(e2.map(e => e.no)) + JSON.stringify(e3.map(e => e.no)));
}
// 6. Quick carry: appears at S3 within 1 s of leaving S2 (before the 2 s departure debounce ends).
s2Unit(w);
w.run(700);
w.run(1000, null, S3.arrive);
{
  const st = units(w.s3, 'start').pop();
  check('6. quick carry: S3 gets the S2 number (#003), not ?01', st && st.no === '#003' && !st.unlinked && st.from === 's2', JSON.stringify(st));
  check('6. quick carry: S2 has not queued it (queue empty yet, S2 end later)', w.link.length('s2') === 0);
}
w.run(1000, null, S3.open).run(1500, null, S3.two).run(3500, null, S3.two);
w.run(3000);
{
  const e2 = units(w.s2, 'end'), e3 = units(w.s3, 'end');
  check('6. S2 #003 ended, and nothing is left in the S2 to S3 queue (not queued twice)', e2.length === 3 && e2[2].no === '#003' && w.link.length('s2') === 0, 'queue ' + w.link.length('s2'));
  check('6. S3 #003 complete', e3.length === 3 && e3[2].no === '#003' && e3[2].result === 'complete', JSON.stringify(e3.map(e => e.no + e.result)));
}
// 7. A unit at S3 with nothing from S2.
w.run(2000).run(1000, null, S3.arrive);
w.run(3000);
{
  const st = units(w.s3, 'start').pop(), e = units(w.s3, 'end').pop();
  check('7. unit at S3 with nothing from S2 gets ?01 and is flagged for review', st && st.no === '?01' && st.unlinked === true && e && e.no === '?01' && e.needsReview === true && e.unlinked === true, JSON.stringify(e));
  check('7. S2 numbering untouched', units(w.s2, 'start').length === 3);
}
// 8. The S2-role station is not called s2 (Michael's layout: s4 runs role s2, s3 runs role s3). The hand-off must follow the station id.
console.log('line flow: layout with the S2-role station named s4');
{
  const LAY = { id: 'l-s4', name: 'Renamed', stations: [{ id: 's4', role: 's2', x: 0, y: 0 }, { id: 's3', role: 's3', x: 760, y: 0 }] };
  const cfg = LE.applyLayout(CFG, LAY);
  check('8. applyLayout: s3 takes units from s4, not from the role id s2', cfg.stations.find(x => x.id === 's3').unitTracker.from === 's4' && cfg.stations.find(x => x.id === 's4').unitTracker.from == null);
  check('8. applyLayout leaves the base config untouched', CFG.stations.find(x => x.id === 's3').unitTracker.from === 's2');
  const lk = LE.createUnitLink(cfg);
  check('8. the link marks s4 as upstream and s3 as fed by s4', lk.up.s4 === true && !lk.up.s2 && lk.from.s3 === 's4');
  const a = build('s4', lk, cfg, 's2'), b = build('s3', lk, cfg, 's3');
  let t = 0;
  const run = (ms, d4, d3, a4, a3) => { for (let n = Math.round(ms / DT); n > 0; n--) { t += DT; frame(a, d4 || [], t, a4); frame(b, d3 || [], t, a3); } };
  run(2000);
  run(1600, S2.wires); run(1000, S2.open, null, { connectors: 0.6 }); run(1000, S2.open, null, { wires: 0.6 }); run(1500, S2.closed, null, { work: 0.6 }); run(1000, S2.closed);
  run(3000);
  run(1000, null, S3.arrive);
  const st = units(b, 'start')[0];
  check('8. a unit that departs s4 is #001 at s3, linked, not ?01', units(a, 'end')[0] && units(a, 'end')[0].no === '#001' && st && st.no === '#001' && st.from === 's4' && st.unlinked === false, JSON.stringify(st));
  // The same layout with the default ids still works.
  const cfg2 = LE.applyLayout(CFG, { id: 'l-d', name: 'Default ids', stations: [{ id: 's2', role: 's2' }, { id: 's3', role: 's3' }] });
  check('8. default ids: s3 still takes units from s2', cfg2.stations.find(x => x.id === 's3').unitTracker.from === 's2');
  // A layout with no station for the upstream role keeps the role id (nothing to point at).
  const cfg3 = LE.applyLayout(CFG, { id: 'l-n', name: 'No S2', stations: [{ id: 's3', role: 's3' }] });
  check('8. no station runs the upstream role: from is kept as written', cfg3.stations[0].unitTracker.from === 's2');
}
console.log(fails ? '\n' + fails + ' FAILED' : '\nall line flow checks passed');
process.exit(fails ? 1 : 0);
