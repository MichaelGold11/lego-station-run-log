// Wire line engine tests with synthetic signals. Run: npm run test:line
import fs from 'node:fs';
// The engine is a plain UMD script: load it with a module shim (same as the /live tests).
const load = f => { const mod = { exports: {} }; new Function('module', fs.readFileSync(new URL('../app/' + f, import.meta.url), 'utf8'))(mod); return mod.exports; };
const LE = load('line-engine.js');
const LD = load('live-detect.js');
const CFG = JSON.parse(fs.readFileSync(new URL('../data/meta/wire-line.json', import.meta.url), 'utf8'));

const FRAME = 125;   // the page samples each station at about 8 Hz
let fails = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log('  pass  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); }
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// A station rig: every zone starts calm. step() makes one zone active (the others calm) for ms.
function rig(stationId, opts) {
  const o = opts || {};
  const st = CFG.stations.find(s => s.id === stationId);
  const eng = LE.createStation(st, { holdFrames: CFG.holdFrames, defaults: CFG.defaults, qaGraceSec: CFG.qaGraceSec, modelClasses: o.model || null });
  const cur = {};
  for (const z of st.zones) if (!(o.omit || []).includes(z.id)) cur[z.id] = { activity: 0, bright: 0 };
  if (o.model) for (const z of Object.keys(cur)) for (const c of o.model) cur[z]['class:' + c] = 0;
  let t = 0;
  const events = [];
  const r = {
    eng, cur, events, st,
    set(patch) { for (const z of Object.keys(patch || {})) Object.assign(cur[z], patch[z]); return r; },
    calm() { for (const z of Object.keys(cur)) for (const k of Object.keys(cur[z])) cur[z][k] = 0; return r; },
    play(ms, patch) { if (patch) r.set(patch); const end = t + ms; while (t < end) { events.push(...eng.update(JSON.parse(JSON.stringify(cur)), t)); t += FRAME; } return r; },
    step(patch, ms) { r.calm(); return r.play(ms == null ? 500 : ms, patch); },
    tick(ms) { const end = t + ms; while (t < end) { events.push(...eng.tick(t)); t += FRAME; } return r; },
    get t() { return t; },
    of: type => events.filter(e => e.type === type)
  };
  return r;
}
const act = v => ({ activity: v == null ? 0.5 : v });

console.log('config');
{
  check('the shipped wire-line.json has no problems', LE.checkConfig(CFG).length === 0, LE.checkConfig(CFG).join(' | '));
  const bad = JSON.parse(JSON.stringify(CFG));
  bad.stations[1].substeps[1].zones.zone = 'nowhere';
  check('a rule that names a missing zone is reported', LE.checkConfig(bad).some(m => /nowhere/.test(m)));
}

console.log('per-station models');
{
  const m = (file, classes) => ({ file: '/models/' + file, classes, imgsz: 640 });
  const withModels = (models, shared) => Object.assign(JSON.parse(JSON.stringify(CFG)), { models, model: shared || null });
  check('one model per station passes the config check', LE.checkConfig(withModels({ s1: m('s1.onnx', ['cutter', 'stripper']), s4: m('s4.onnx', ['bulb_on']) })).length === 0);
  check('a models key that is not a station is reported', LE.checkConfig(withModels({ s9: m('x.onnx', ['wire']) })).some(e => /"s9" is not a station/.test(e)));
  check('a bad file path is reported for that station', LE.checkConfig(withModels({ s2: m('../x.onnx', ['wire']) })).some(e => /^models\.s2 must look like/.test(e)));
  check('an empty class list is reported', LE.checkConfig(withModels({ s2: m('s2.onnx', []) })).some(e => /models\.s2: classes must be a non-empty/.test(e)));
  check('a repeated class name is reported', LE.checkConfig(withModels({ s3: m('s3.onnx', ['splice', 'splice']) })).some(e => /models\.s3: classes must not repeat/.test(e)));
  check('models as a list is reported', LE.checkConfig(withModels([m('s1.onnx', ['wire'])])).some(e => /models must be an object/.test(e)));
  const cfg = withModels({ s1: m('s1.onnx', ['cutter']) }, m('shared.onnx', ['wire']));
  check('a station uses its own model first', LE.modelFor(cfg, 's1').file === '/models/s1.onnx');
  check('a station without its own model falls back to the shared one', LE.modelFor(cfg, 's2').file === '/models/shared.onnx');
  check('no models at all means zones', LE.modelFor(CFG, 's1') === null);
}

console.log('class-count check');
{
  const raw = LE.checkModelOutput([1, 7, 8400], 3);
  check('raw head [1, 7, 8400] with 3 classes listed is ok', raw.kind === 'raw' && raw.found === 3 && raw.ok);
  const bad = LE.checkModelOutput([1, 7, 8400], 10);
  check('raw head with 3 classes but 10 listed is refused (the QA bug)', bad.kind === 'raw' && bad.found === 3 && !bad.ok);
  check('raw head with 3 classes but 2 listed is refused', !LE.checkModelOutput([1, 7, 8400], 2).ok);
  const e2e = LE.checkModelOutput([1, 300, 6], 4);
  check('end-to-end head [1, 300, 6] cannot be counted from the shape', e2e.kind === 'e2e' && e2e.found === null && e2e.ok);
  check('an unknown output shape is refused', !LE.checkModelOutput([1, 8400], 3).ok && !LE.checkModelOutput(null, 3).ok);
  const rows = new Float32Array([10, 10, 50, 50, 0.9, 1, 20, 20, 60, 60, 0.2, 7]);
  check('end-to-end rows: a weak row with a class past the list is ignored', !LE.e2eBadClass(rows, 2, 2, 0.4));
  check('end-to-end rows: a confident row with a class past the list is caught', LE.e2eBadClass(rows, 2, 1, 0.4));
}

console.log('normal cycle (s2, zones)');
{
  const r = rig('s2');
  r.play(500);
  r.step({ in: act() }).step({ parts: act(0.4) }).step({ crimp: act() }, 1000).step({ out: act() }).step({}, 500);
  const subs = r.of('substep');
  check('four detected substeps: pick, splice, insert, handoff', subs.map(e => e.substep).join() === 's2_pick,s2_get_splice,s2_insert,s2_handoff', subs.map(e => e.substep).join());
  check('moves: start, next, next, next (crimp and tug test need the model, so passing them is not a skip)', subs.map(e => e.move).join() === 'start,next,next,next', subs.map(e => e.move).join());
  check('no flags', r.of('flag').length === 0);
  const ce = r.of('cycle_end');
  check('one cycle_end at the handoff onset', ce.length === 1 && ce[0].t === 2500 && ce[0].substep === 's2_handoff', JSON.stringify(ce));
  check('cycle time = handoff onset minus pick onset (2.0 s)', ce[0] && near(ce[0].dur, 2.0), ce[0] && ce[0].dur);
  check('onset is the first frame of the hold, not the confirm frame', subs[0].t === 500);
  check('confidence = mean signal over the hold window, source zones', near(subs[1].conf, 0.4) && subs.every(e => e.source === 'zones'));
  check('every event names its station and cycle', r.events.every(e => e.station === 's2' && e.cycle === 1));
  const st = r.eng.state();
  check('state is between cycles after the handoff', !st.inCycle && st.cycle === 1 && st.lastCycleSec === 2);
}

console.log('hold frames and re-arming');
{
  const r = rig('s2');
  r.play(500).step({ in: act() }, 2 * FRAME).step({}, 500);
  check('a 2-frame blip does not count (hold is 3 frames)', r.events.length === 0, JSON.stringify(r.events));
  r.step({ in: act() }).step({ parts: act() }).step({ crimp: act() }).step({ out: act() }, 1500);
  const n = r.of('cycle_end').length;
  check('a hand resting in the out tray after the handoff does not start a new cycle', n === 1 && r.of('substep').length === 4, r.events.map(e => e.substep).join());
  r.step({ crimp: act() }, 1000);
  check('a fresh trigger after the cycle starts cycle 2 (skipping pick and splice is flagged)', r.of('substep').slice(-1)[0].cycle === 2 && r.of('flag').length === 2, JSON.stringify(r.of('flag').map(f => f.note)));
}

console.log('repeat inside a cycle (s1 makes a pair of wires)');
{
  const r = rig('s1');
  r.play(500);
  r.step({ supply: act() }).step({ work: act() }, 2000).step({ supply: act() }).step({ work: act() }, 2000).step({ out: act() }).step({}, 500);
  const subs = r.of('substep');
  check('pick, cut, pick again, cut again, handoff', subs.map(e => e.substep).join() === 's1_pick_wire,s1_measure_cut,s1_pick_wire,s1_measure_cut,s1_handoff', subs.map(e => e.substep).join());
  check('going back to pick is a repeat, not an error', subs[2].move === 'repeat' && subs[2].from === 's1_measure_cut');
  check('no flags (strip and check need the model)', r.of('flag').length === 0, JSON.stringify(r.of('flag')));
  check('one cycle of 5.0 s', r.of('cycle_end').length === 1 && near(r.of('cycle_end')[0].dur, 5.0), JSON.stringify(r.of('cycle_end')));
  const sum = LE.summarize(r.events, CFG);
  const s1 = sum.stations.s1.detected;
  check('substep averages add up both wires: pick 1.0 s, cut 4.0 s, handoff 0', s1.substepAvg.s1_pick_wire === 1 && s1.substepAvg.s1_measure_cut === 4 && s1.substepAvg.s1_handoff === 0, JSON.stringify(s1.substepAvg));
  check('strip and check fold into the cut time (no time of their own)', s1.substepAvg.s1_strip === 0 && s1.substepAvg.s1_check === 0);
  check('the repeat is counted', s1.repeats === 1);
  const rules = r.eng.rules();
  const strip = rules.find(x => x.id === 's1_strip');
  check('a model-only substep has no active rule without a model (shown as "needs the model")', strip.kind === null && strip.hasModelRule && !strip.ready);
}

console.log('a hand resting in a zone cannot bounce the state');
{
  const r = rig('s2');
  r.play(500);
  r.step({ in: act() }).step({ parts: act() });
  r.set({ crimp: act() }).play(1500);        // both parts and crimp busy
  const subs = r.of('substep').map(e => e.substep);
  check('forward to insert, no repeat back to splice while the splice bin stays busy', subs.join() === 's2_pick,s2_get_splice,s2_insert', subs.join());
  r.set({ parts: act(0) }).play(250).set({ parts: act() }).play(500);
  check('once the splice bin goes quiet and busy again, going back is a repeat', r.of('substep').slice(-1)[0].move === 'repeat' && r.of('substep').slice(-1)[0].substep === 's2_get_splice');
}

console.log('skipped substep');
{
  const r = rig('s2');
  r.play(500).step({ in: act() }).step({ crimp: act() }).step({ out: act() }).step({}, 300);
  const f = r.of('flag');
  check('jumping from pick to insert flags "skipped Take a splice"', f.length === 1 && f[0].note === 'skipped Take a splice' && f[0].substep === 's2_get_splice', JSON.stringify(f));
  check('the move is a jump', r.of('substep')[1].move === 'jump');
  const r2 = rig('s2', { omit: ['parts'] });
  r2.play(500).step({ in: act() }).step({ crimp: act() }).step({ out: act() }).step({}, 300);
  check('no flag when the skipped substep cannot be seen (its zone is not drawn)', r2.of('flag').length === 0 && r2.of('substep')[1].move === 'next');
  const rules = r2.eng.rules().find(x => x.id === 's2_get_splice');
  check('rules() says what is missing (the zone)', !rules.ready && rules.missing.length === 1 && rules.missing[0].zone === 'parts' && !rules.missing[0].signal);
}

console.log('QA station s4');
function s4Cycle(r, light, bin) {
  r.step({ in: act() }).step({ fixture: act() }, 1000);
  if (light) r.step({ bulb: { bright: 0.9 } }, 750);
  r.step({ fixture: act() }, 500);
  r.step({ [bin]: act() });
  return r.step({}, 300);
}
{
  const r = rig('s4');
  r.play(500);
  s4Cycle(r, true, 'pass_bin');
  check('the cycle ends at the sort', r.of('cycle_end').length === 1 && r.of('cycle_end')[0].substep === 's4_sort');
  check('no QA result yet: it waits a few seconds for a manual Pass or Fail', r.of('qa_result').length === 0);
  r.tick(6000);
  const q = r.of('qa_result');
  check('pass: light seen, pass bin, result pass from the bin', q.length === 1 && q[0].result === 'pass' && q[0].light === true && q[0].bin === 'pass' && q[0].source === 'zones', JSON.stringify(q));
  check('the qa_result is stamped with the cycle end time and cycle number', q[0].t === r.of('cycle_end')[0].t && q[0].cycle === 1);
  check('no mismatch flag', r.of('flag').length === 0, JSON.stringify(r.of('flag')));
  check('substeps seen: pick, connect, test, connect again (repeat), sort', r.of('substep').map(e => e.substep + ':' + e.move).join() === 's4_pick:start,s4_connect:next,s4_test:next,s4_connect:repeat,s4_sort:next', r.of('substep').map(e => e.substep + ':' + e.move).join());
}
{
  const r = rig('s4');
  r.play(500);
  s4Cycle(r, false, 'fail_bin').tick(6000);
  const q = r.of('qa_result');
  check('fail by bin: no light, fail bin, result fail, no reason', q.length === 1 && q[0].result === 'fail' && q[0].light === false && q[0].bin === 'fail' && q[0].reason === null, JSON.stringify(q));
  check('a dark bulb is not flagged as a skipped bulb test, and light and bin agree', r.of('flag').length === 0, JSON.stringify(r.of('flag')));
}
{
  const r = rig('s4');
  r.play(500);
  s4Cycle(r, true, 'fail_bin').tick(6000);
  const f = r.of('flag');
  check('light on but fail bin: "quality mismatch, review the video"', f.length === 1 && f[0].note === LE.MISMATCH_NOTE && f[0].light === true && f[0].bin === 'fail', JSON.stringify(f));
  const r2 = rig('s4');
  r2.play(500);
  s4Cycle(r2, false, 'pass_bin').tick(6000);
  check('no light but pass bin is a mismatch too', r2.of('flag').filter(e => e.note === LE.MISMATCH_NOTE).length === 1 && r2.of('qa_result')[0].result === 'pass');
}
{
  const r = rig('s4');
  r.play(500);
  r.step({ in: act() }).step({ fixture: act() });
  r.events.push(...r.eng.manualQa({ result: 'fail', reason: 'crimp_b', t: r.t }));
  r.step({ bulb: { bright: 0.9 } }, 750).step({ pass_bin: act() }).step({}, 300);
  const q = r.of('qa_result');
  check('manual Fail pressed during the cycle wins over the bin', q.length === 1 && q[0].result === 'fail' && q[0].reason === 'crimp_b' && q[0].source === 'manual' && q[0].bin === 'pass', JSON.stringify(q));
  check('light and bin still checked against each other (they agree here)', r.of('flag').length === 0);
}
{
  const r = rig('s4');
  r.play(500);
  s4Cycle(r, true, 'pass_bin').tick(2000);
  r.events.push(...r.eng.manualQa({ result: 'pass', t: r.t }));
  check('manual Pass within the grace time after the sort settles the waiting result', r.of('qa_result').length === 1 && r.of('qa_result')[0].source === 'manual');
  r.tick(6000);
  check('and nothing more comes later', r.of('qa_result').length === 1);
}
{
  const r = rig('s4');
  r.play(500);
  s4Cycle(r, false, 'fail_bin');
  r.eng.setQaHold(true);
  r.tick(8000);
  check('while a fail reason is being picked the result waits past the grace time', r.of('qa_result').length === 0);
  r.events.push(...r.eng.manualQa({ result: 'fail', reason: 'strip', t: r.t }));
  check('then takes the picked reason', r.of('qa_result').length === 1 && r.of('qa_result')[0].reason === 'strip');
}
{
  const r = rig('s4', { omit: ['bulb'] });
  r.play(500);
  s4Cycle(r, false, 'pass_bin');
  r.events.push(...r.eng.flush());
  const q = r.of('qa_result');
  check('no bulb zone: light unknown (null), result from the bin, no mismatch', q.length === 1 && q[0].light === null && q[0].result === 'pass' && r.of('flag').length === 0, JSON.stringify(q));
  check('flush settles a waiting result at once (session stop)', q.length === 1);
}
{
  const d = LE.qaDecide({ manual: null, light: null, bin: null });
  check('no light and no bin seen: result unknown', d.result === 'unknown' && !d.mismatch);
  const d2 = LE.qaDecide({ manual: { result: 'fail', reason: 'other' }, light: true, bin: 'pass' });
  check('qaDecide: the manual button wins, the reason is kept', d2.result === 'fail' && d2.reason === 'other' && d2.fromManual && !d2.mismatch);
}

console.log('model rule overrides the zones rule');
{
  const cls = ['splice', 'crimp_tool', 'crimped_splice'];
  const r = rig('s2', { model: cls });
  r.play(500).step({ in: act() }).step({ parts: act() }, 1000);
  check('with the model loaded, activity in the splice bin alone does not count as Take a splice', r.of('substep').length === 1, r.of('substep').map(e => e.substep).join());
  r.step({ parts: { 'class:splice': 0.8 } });
  check('the splice class in the splice bin does, with source model', r.of('substep')[1] && r.of('substep')[1].substep === 's2_get_splice' && r.of('substep')[1].source === 'model' && near(r.of('substep')[1].conf, 0.8));
  r.step({ crimp: { 'class:splice': 0.7 } }).step({ crimp: { 'class:crimp_tool': 0.9 } }).step({ crimp: { 'class:crimped_splice': 0.6 } }).step({ out: act() }).step({}, 300);
  const subs = r.of('substep');
  check('model-only substeps (crimp, tug test) are tracked when the model is on', subs.map(e => e.substep).join() === 's2_pick,s2_get_splice,s2_insert,s2_crimp,s2_pull_test,s2_handoff', subs.map(e => e.substep).join());
  check('sources: zones for pick and handoff (no model rule), model for the rest', subs.map(e => e.source).join() === 'zones,model,model,model,model,zones', subs.map(e => e.source).join());
  check('no flags', r.of('flag').length === 0);
  const r2 = rig('s2', { model: ['wire'] });
  check('a model that lacks the class falls back to the zones rule', r2.eng.rules().find(x => x.id === 's2_get_splice').kind === 'zones');
  r2.eng.setModel(null);
  check('setModel(null) turns model rules off', r2.eng.rules().find(x => x.id === 's2_crimp').kind === null);
}

console.log('source change drops the open cycle');
{
  const r = rig('s2');
  r.play(500).step({ in: act() }).step({ parts: act() });
  r.events.push(...r.eng.abandon(r.t));
  check('abandon leaves no open cycle and keeps the cycle count', !r.eng.state().inCycle && r.eng.state().cycle === 1);
  r.step({}, 500).step({ in: act() });
  check('the next cycle is number 2', r.of('substep').slice(-1)[0].cycle === 2 && r.of('substep').slice(-1)[0].move === 'start');
}

console.log('zone signals from pixels');
{
  const W = 20, H = 20, frame = v => { const a = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) a.set([v, v, v, 255], i * 4); return a; };
  const zones = { left: { x: 0, y: 0, w: 0.5, h: 1 }, right: { x: 0.5, y: 0, w: 0.5, h: 1 } };
  const a = LE.zoneSignals(frame(100), W, H, null, zones, null);
  check('first frame: no motion, bright is null until calibrated', a.signals.left.motion === 0 && a.signals.left.bright === null && a.signals.left.brightness === 100);
  const b = frame(100);
  for (let y = 5; y < 15; y++) for (let x = 2; x < 8; x++) b.set([200, 200, 200, 255], (y * W + x) * 4);
  const s = LE.zoneSignals(b, W, H, a.gray, zones, { motion: { left: 0.1 }, bright: { left: { off: 100 }, right: { off: 100, on: 140 } } });
  check('motion only where pixels changed', s.signals.left.motion > 0.3 && s.signals.right.motion === 0, JSON.stringify(s.signals));
  check('activity = motion minus the calibrated baseline', near(s.signals.left.activity, s.signals.left.motion - 0.1, 1e-9));
  check('brightness uses the brightest 10 percent, bright rises over the off baseline', s.signals.left.brightness === 200 && s.signals.left.bright === 1 && s.signals.right.bright === 0);
  const cal = LE.calibrationFrom([a.signals, s.signals]);
  check('calibration: motion baseline is the high percentile, brightness the mean', near(cal.motion.left, s.signals.left.motion, 1e-3) && cal.brightness.left === 150, JSON.stringify(cal));
  const dets = [{ cls: 'splice', conf: 0.8, nbox: [0.1, 0.1, 0.3, 0.3] }, { cls: 'splice', conf: 0.6, nbox: [0.6, 0.6, 0.8, 0.8] }, { cls: 'wire', conf: 0.9, nbox: [0.1, 0.1, 0.2, 0.2] }];
  const cs = LE.classSignals(dets, zones, ['splice', 'crimp_tool']);
  check('class signal = best confidence with the box center in the zone; unknown classes ignored', cs.left['class:splice'] === 0.8 && cs.right['class:splice'] === 0.6 && cs.left['class:crimp_tool'] === 0 && !('class:wire' in cs.left));
  const steady = LE.steadyClasses({ left: { 'class:splice': 0.3 }, right: { 'class:splice': 0.7 } }, cs);
  check('steadyClasses keeps the weaker of the last two results', steady.left['class:splice'] === 0.3 && steady.right['class:splice'] === 0.6);
  const hand = [Array.from({ length: 21 }, (_, i) => ({ x: i < 14 ? 0.2 : 0.7, y: 0.5 }))];
  const hp = LE.handPresence(hand, zones);
  check('hand presence = share of a hand inside the zone', near(hp.left, 14 / 21, 1e-3) && near(hp.right, 7 / 21, 1e-3));
  const m = LE.mergeSignals(s.signals, cs, hp);
  check('merged: activity = max(motion activity, hand presence), classes added', near(m.right.activity, 7 / 21, 1e-3) && m.left['class:splice'] === 0.8);
}

console.log('metrics over events');
// Build a session by hand: s1 6 cycles of 20 s, s2 4 of 30 s, s3 3 of 25 s, s4 3 of 15 s with QA results.
function cycleEvents(station, n, sec, start, gap, subIds) {
  const out = [];
  let t = start;
  for (let c = 1; c <= n; c++) {
    const step = sec * 1000 / (subIds.length - 1);
    subIds.forEach((id, k) => out.push({ type: 'substep', station, substep: id, move: k ? 'next' : 'start', source: 'zones', conf: 0.5, t: t + k * step, cycle: c }));
    out.push({ type: 'cycle_end', station, substep: subIds[subIds.length - 1], source: 'zones', conf: 0.5, t: t + sec * 1000, cycle: c, dur: sec });
    t += (sec + gap) * 1000;
  }
  return out;
}
{
  const ev = [{ type: 'session_start', t: 0 }];
  ['s1', 's2', 's3', 's4'].forEach(id => ev.push({ type: 'source_change', station: id, input: 'clip', t: 0 }));
  ev.push(...cycleEvents('s1', 6, 20, 1000, 10, ['s1_pick_wire', 's1_measure_cut', 's1_handoff']));
  ev.push(...cycleEvents('s2', 4, 30, 2000, 5, ['s2_pick', 's2_get_splice', 's2_insert', 's2_handoff']));
  ev.push(...cycleEvents('s3', 3, 25, 3000, 5, ['s3_pick', 's3_insert', 's3_handoff']));
  const s4 = cycleEvents('s4', 3, 15, 4000, 5, ['s4_pick', 's4_connect', 's4_test', 's4_sort']);
  ev.push(...s4);
  const ends = s4.filter(e => e.type === 'cycle_end');
  ev.push({ type: 'qa_result', station: 's4', cycle: 1, t: ends[0].t, result: 'pass', light: true, bin: 'pass', source: 'zones' });
  ev.push({ type: 'qa_result', station: 's4', cycle: 2, t: ends[1].t, result: 'fail', reason: 'crimp_a', light: false, bin: 'fail', source: 'manual' });
  ev.push({ type: 'qa_result', station: 's4', cycle: 3, t: ends[2].t, result: 'fail', reason: 'test_setup', light: false, bin: 'fail', source: 'manual' });
  for (let i = 0; i < 7; i++) ev.push({ type: 'manual', station: 's1', action: 'cycle_done', source: 'manual', t: 21000 + i * 30000 });
  ev.push({ type: 'session_end', t: 200000 });
  const sum = LE.summarize(ev, CFG);
  const L = sum.line;
  check('cycles per station (detected basis)', sum.stations.s1.cycles === 6 && sum.stations.s2.cycles === 4 && sum.stations.s3.cycles === 3 && sum.stations.s4.cycles === 3);
  check('WIP between neighbours: s1-s2 2 pairs, s2-s3 1, s3-s4 0', L.wip.map(w => w.n).join() === '2,1,0', JSON.stringify(L.wip));
  check('bottleneck = highest average cycle (s2, 30 s)', L.bottleneck === 's2' && sum.stations.s2.avgSec === 30);
  check('last, average and spread of cycle time', sum.stations.s1.lastSec === 20 && sum.stations.s1.stdSec === 0);
  check('first-pass yield leaves out the test setup fail: 1 pass / (1 pass + 1 defect) = 0.5', L.fpy === 0.5 && L.passed === 1 && L.failed === 2 && L.nonDefectFails === 1, JSON.stringify(L));
  check('fails by cause station: crimp_a goes to s2; test_setup is not a defect', L.failsByCause.s2 === 1 && L.failsByCause.s4 === 0 && L.failsByCause.s1 === 0);
  check('units done = s4 cycles; units per hour over the session', L.units === 3 && near(L.uph, 3 * 3600 / 200, 0.01), L.uph);
  check('detected vs manual cycle ends per station', L.cycleEnds.s1.detected === 6 && L.cycleEnds.s1.manual === 7 && L.cycleEnds.s2.manual === 0);
  check('manual cycle time = time between presses', sum.stations.s1.manual.avgSec === 30);
  check('idle share: s1 busy 120 s of 200 s observed', near(sum.stations.s1.detected.idleShare, 0.4, 1e-3), sum.stations.s1.detected.idleShare);
  const man = LE.summarize(ev.concat([
    { type: 'manual', station: 's4', action: 'pass', t: 150000 }, { type: 'manual', station: 's4', action: 'fail', reason: 'strip', t: 160000 },
    { type: 'manual', station: 's4', action: 'fail', reason: 'other', t: 170000 }, { type: 'manual', station: 's4', action: 'cycle_done', t: 180000 }
  ]), CFG, { basis: 'manual' });
  check('manual basis: units from the buttons, FPY from Pass and Fail (1 / 3)', man.line.units === 4 && near(man.line.fpy, 1 / 3, 1e-3) && man.line.unknown === 1, JSON.stringify(man.line));
  check('manual basis: "other" has no cause station', man.line.failsByCause.s1 === 1 && man.line.failsByCause.unknown === 1);
  const auto = LE.summarize([{ type: 'manual', station: 's3', action: 'cycle_done', t: 1 }, { type: 'manual', station: 's3', action: 'cycle_done', t: 5001 }], CFG);
  check('auto basis falls back to manual where nothing was detected', auto.stations.s3.basis === 'manual' && auto.stations.s3.cycles === 2 && auto.stations.s3.avgSec === 5);
  const live = LE.summarize(ev.filter(e => e.type !== 'qa_result'), CFG);
  check('a detected s4 cycle still inside its grace time counts as awaiting, not unknown', live.line.awaitingQa === 3 && live.line.unknown === 0);

  const meta = { id: '20261015-120000-abcd', crew: 'Group B', shift: 'Morning' };
  const sub = LE.substepsCsv(ev, CFG, meta).trim().split('\n');
  check('substeps.csv: header + one row per substep occurrence', sub[0] === LE.SUBSTEP_COLS.join(',') && sub.length === 1 + 6 * 3 + 4 * 4 + 3 * 3 + 3 * 4, sub.length);
  check('substeps.csv rows carry session, crew and shift', sub[1].startsWith('20261015-120000-abcd,Group B,Morning,s1,1,1,s1_pick_wire,Pull wire from supply,start,zones,1,'), sub[1]);
  const cyc = LE.cyclesCsv(ev, CFG, meta).trim().split('\n');
  check('cycles.csv: detected rows for every station plus manual rows', cyc.length === 1 + 6 + 4 + 3 + 3 + 7 && cyc.filter(l => l.includes(',manual,')).length === 7, cyc.length);
  const qaRow = cyc.find(l => l.includes(',s4,detected,2,'));
  check('cycles.csv: QA row has result, reason, cause station and defect', qaRow && qaRow.includes(',fail,crimp_a,s2,1,0,fail,'), qaRow);
  check('csv cells that look like formulas are made safe', LE.csvCell('=1+1') === "'=1+1" && LE.csvCell('a,b') === '"a,b"');
}

console.log('model output decoding (live-detect, generalized)');
{
  const lb = LD.letterbox(640, 480, 640);
  const e2e = new Float32Array([100, 180, 200, 280, 0.9, 1, 300, 380, 340, 420, 0.2, 0, 10, 90, 60, 140, 0.5, 7].concat(new Array(6 * 5).fill(0)));
  const d = LD.decodeOutput(e2e, [1, 8, 6], lb, 640, 480, 0.25, 0.7, ['wire', 'splice']);
  check('end-to-end head [1, N, 6]: boxes mapped, weak ones dropped, unnamed classes get class_<i>', d.length === 2 && d[0].cls === 'splice' && d[1].cls === 'class_7' && near(d[0].box[1], 180 - lb.padY), JSON.stringify(d.map(x => [x.cls, x.box])));
  const N = 3, raw = new Float32Array(6 * N);
  const setA = (i, cx, cy, w, h, sc) => { raw[i] = cx; raw[N + i] = cy; raw[2 * N + i] = w; raw[3 * N + i] = h; sc.forEach((v, c) => { raw[(4 + c) * N + i] = v; }); };
  setA(0, 320, 320, 50, 50, [0.1, 0.8]); setA(1, 100, 200, 40, 40, [0.7, 0.1]); setA(2, 500, 300, 40, 40, [0.1, 0.1]);
  const d2 = LD.decodeOutput(raw, [1, 6, N], lb, 640, 480, 0.25, 0.7, ['wire', 'splice', 'extra']);
  check('raw head [1, 4 + nc, N]: nc read from the shape, names from the config', d2.length === 2 && d2[0].cls === 'splice' && d2[1].cls === 'wire', JSON.stringify(d2.map(x => x.cls)));
  const lego = new Float32Array(7);
  lego.set([320, 240, 60, 60, 0.1, 0.9, 0.2]);
  const d3 = LD.decode(lego, 1, lb, 640, 480, 0.25, 0.7);
  check('decode() without classes still names the LEGO classes (the /live page is unchanged)', d3.length === 1 && d3[0].cls === 'pink_brick');
}

// ---------- step checker (Ruza's live_check.py rules) ----------
// Zone rects for the checker rig: the station's zones side by side, each the full height (0..1 of the frame).
function rectsFor(station) { const n = station.zones.length, out = {}; station.zones.forEach((z, k) => { out[z.id] = { x: k / n, y: 0, w: 1 / n, h: 1 }; }); return out; }
// A detection centered at (cx, cy) of a zone, w and h as shares of the zone.
function det(rects, cls, zone, conf, p) {
  const z = rects[zone], q = Object.assign({ cx: 0.5, cy: 0.5, w: 0.4, h: 0.2 }, p);
  const x = z.x + q.cx * z.w, y = z.y + q.cy * z.h, w = q.w * z.w, h = q.h * z.h;
  return { cls, conf, nbox: [x - w / 2, y - h / 2, x + w / 2, y + h / 2] };
}
// The real tracker plus the checker, fed every FRAME like the page. motion = the highest zone activity (all calm = still)
// unless r.motion is set; r.hands as given (null = Hands off). With a model: a model result every `every` ms from see(),
// or by hand with shot() (every: Infinity).
function crig(station, opts) {
  const o = opts || {}, rects = rectsFor(station), every = o.every || 250;
  const eng = LE.createStation(station, { holdFrames: CFG.holdFrames, defaults: CFG.defaults, qaGraceSec: CFG.qaGraceSec, modelClasses: o.model || null });
  const chk = LE.createChecker(station, o.check);
  const cur = {};
  for (const z of station.zones) cur[z.id] = { activity: 0, bright: 0 };
  if (o.model) for (const z of Object.keys(cur)) for (const c of o.model) cur[z]['class:' + c] = 0;
  let t = 0, fid = 0, frame = null, lastF = -1e9, dets = [];
  const r = {
    eng, chk, rects, verdicts: [], events: [], hands: o.hands == null ? null : o.hands, motion: null,
    set(patch) { for (const z of Object.keys(patch || {})) Object.assign(cur[z], patch[z]); return r; },
    calm() { for (const z of Object.keys(cur)) for (const k of Object.keys(cur[z])) cur[z][k] = 0; return r; },
    see(list) { dets = list; return r; },
    shot(list) { frame = { id: ++fid, t, dets: list }; return r; },
    det: (cls, zone, conf, p) => det(rects, cls, zone, conf, p),
    play(ms, patch) {
      if (patch) r.set(patch);
      const end = t + ms;
      while (t < end) {
        if (o.model && every !== Infinity && t - lastF >= every) { frame = { id: ++fid, t, dets }; lastF = t; }
        const evs = eng.update(JSON.parse(JSON.stringify(cur)), t);
        r.events.push(...evs);
        const motion = r.motion != null ? r.motion : Math.max(...Object.values(cur).map(z => z.activity));
        r.verdicts.push(...chk.update({ t, events: evs, state: eng.state(), modelOn: !!o.model, frame, zones: rects, hands: r.hands, motion }));
        t += FRAME;
      }
      return r;
    },
    step(patch, ms) { r.calm(); return r.play(ms == null ? 500 : ms, patch); },
    busy(ms) { r.motion = 0.5; r.play(ms || 500); r.motion = null; return r; },    // a hand passes: the view is not clear
    get t() { return t; },
    kinds: () => r.verdicts.map(v => v.kind + ': ' + v.message).join(' | '),
    last: () => r.verdicts[r.verdicts.length - 1]
  };
  return r;
}
const st2 = () => JSON.parse(JSON.stringify(CFG.stations.find(s => s.id === 's2')));
const withStation = s => { const c = JSON.parse(JSON.stringify(CFG)); c.stations = c.stations.map(x => (x.id === s.id ? s : x)); return c; };
const S2_CLASSES = ['splice', 'crimp_tool', 'crimped_splice'];

console.log('checker: config');
{
  check('the shipped config has no positionCheck and no mustStay (both opt-in, off)', CFG.stations.every(s => !s.positionCheck && s.substeps.every(x => !x.model || !x.model.mustStay)));
  const s = st2();
  s.positionCheck = { anchor: 'crimp', classes: ['splice'], tolerance: 0.14 };
  s.substeps[4].model.mustStay = true;
  const ok = withStation(s);
  ok.sounds = { verified: false };
  check('positionCheck, mustStay and sounds pass the config check', LE.checkConfig(ok).length === 0, LE.checkConfig(ok).join(' | '));
  const bad = withStation(Object.assign(st2(), { positionCheck: { anchor: 'nowhere', classes: [], tolerance: 2 } }));
  const e = LE.checkConfig(bad).join(' | ');
  check('a bad positionCheck is reported: anchor, classes, tolerance', /anchor "nowhere"/.test(e) && /classes must be a non-empty/.test(e) && /tolerance must be/.test(e), e);
  const b2 = st2(); b2.substeps[4].model.mustStay = 'yes';
  const c2 = withStation(b2); c2.sounds = { verified: 'no' };
  const e2 = LE.checkConfig(c2).join(' | ');
  check('mustStay that is not true or false, and a bad sounds block, are reported', /mustStay must be true or false/.test(e2) && /sounds must look like/.test(e2), e2);
}

console.log('checker: wrong order and progress (zones)');
{
  const r = crig(st2());
  r.play(500).step({ in: act() }).step({ crimp: act() });
  const m = r.verdicts.find(v => v.kind === 'mistake');
  check('a tracker jump is a mistake "Wrong order: <label> before <skipped label> (step N skipped)"', m && m.message === 'Wrong order: Push wire A into the splice before Take a splice (step 2 skipped)' && m.substep === 's2_get_splice' && m.reason === 'wrong_order' && m.conf === null && m.station === 's2' && m.cycle === 1, r.kinds());
  check('it comes straight from the tracker, at the confirming frame (no clear view needed)', m && m.t === 1250 && r.chk.current.kind === 'mistake', m && m.t);
  check('a zones substep is verified at once with no confidence: "Step N verified: <label>"', r.verdicts[0].kind === 'verified' && r.verdicts[0].message === 'Step 1 verified: Take a wire pair from the in tray' && r.verdicts[0].conf === null);
  check('the red box goes around the zone of the step done out of order (the shown verdict keeps zones and box)', r.chk.current.zones.join() === 'crimp' && r.chk.current.box === null);
  r.step({}, 250);
  check('not cleared before the view has been clear 0.3 s', r.verdicts.length === 2, r.kinds());
  r.play(250);
  const c = r.last();
  check('then "Mistake cleared. Continue with <next substep>" (kind cleared, no longer showing)', c.kind === 'cleared' && c.message === 'Mistake cleared. Continue with Crimp side A' && c.substep === 's2_crimp' && !r.chk.current && r.chk.cleared.message === c.message, r.kinds());
  r.step({ out: act() }).step({}, 300);
  const done = r.last();
  check('the closing substep gives "Cycle complete" with the cycle time', done.kind === 'verified' && done.message === 'Cycle complete' && done.cycle_s === 1.5 && done.cycle === 1, JSON.stringify(done));
}
{
  const r = crig(CFG.stations.find(s => s.id === 's1'));
  r.play(500).step({ supply: act() }).step({ work: act() }, 2000).step({ supply: act() }).step({ work: act() }, 2000).step({ out: act() }).step({}, 500);
  check('a repeat (s1 makes two wires) is not a mistake: every verdict is verified', r.verdicts.length === 5 && r.verdicts.every(v => v.kind === 'verified'), r.kinds());
  check('the repeat gets its own "Step 1 verified" (verified is never deduped)', r.verdicts.filter(v => v.message === 'Step 1 verified: Pull wire from supply').length === 2);
  check('step_s = seconds since the previous verified step', r.verdicts[1].step_s === 0.5 && r.last().message === 'Cycle complete' && r.last().cycle_s === 5, JSON.stringify(r.verdicts.map(v => v.step_s)));
}
{
  const r = crig(st2(), { model: S2_CLASSES });
  r.play(500).step({ in: act() }).step({ crimp: { 'class:crimp_tool': 0.5 } });
  check('a jump confirmed by a model rule under 0.60 is a review with the same message', r.last().kind === 'review' && r.last().message === 'Wrong order: Crimp side A before Take a splice (step 2 skipped)' && r.last().conf === 0.5, r.kinds());
  const r2 = crig(st2(), { model: S2_CLASSES });
  r2.play(500).step({ in: act() }).step({ crimp: { 'class:crimp_tool': 0.8 } });
  check('at 0.60 or more it is a mistake', r2.last().kind === 'mistake' && r2.last().conf === 0.8, r2.kinds());
}

console.log('checker: confidence (model substeps, clear-view checks)');
{
  const r = crig(st2(), { model: S2_CLASSES });
  r.play(500).step({ in: act() });
  r.see([r.det('splice', 'parts', 0.5)]).step({ parts: { 'class:splice': 0.5 } }, 1500);
  const rv = r.verdicts.filter(v => v.kind === 'review');
  check('a model substep under 0.60 gives review "<label> looks done but I\'m not sure"', rv.length === 1 && rv[0].message === "Take a splice looks done but I'm not sure" && rv[0].substep === 's2_get_splice' && rv[0].conf === 0.5, r.kinds());
  check('...at the first check with 3 model results taken in clear view (clear from 1.3 s; results at 1.5, 1.75, 2.0 s)', rv[0] && rv[0].t === 2000, rv[0] && rv[0].t);
  r.play(3000);
  check('the same review again is shown but is no new verdict (not re-sounded)', r.verdicts.filter(v => v.kind === 'review').length === 1 && r.chk.current.kind === 'review', r.kinds());
  r.see([r.det('splice', 'parts', 0.8)]).play(1500);
  const ok = r.last();
  check('once the model is sure (0.60 or more): "Step N verified: <label>" with its confidence', ok.kind === 'verified' && ok.message === 'Step 2 verified: Take a splice' && ok.conf === 0.8 && r.chk.current.box, JSON.stringify(ok));
  const r2 = crig(st2(), { model: S2_CLASSES });
  r2.play(500).step({ in: act() }).see([r2.det('splice', 'parts', 0.9)]).step({ parts: { 'class:splice': 0.9 } }, 1500);
  check('a sure model substep is verified at its first clear-view check', r2.last().kind === 'verified' && r2.last().message === 'Step 2 verified: Take a splice' && r2.last().conf === 0.9, r2.kinds());
  const r3 = crig(st2(), { model: S2_CLASSES });
  r3.play(500).step({ in: act() }).see([r3.det('splice', 'parts', 0.9)]);
  r3.hands = true; r3.step({ parts: { 'class:splice': 0.9 } }, 2000);
  check('with a hand in the tile the model substep waits for its verdict', r3.verdicts.length === 1 && r3.chk.pending === 's2_get_splice', r3.kinds());
  r3.hands = false; r3.play(1500);
  check('...and gets it once the view is clear', r3.last().message === 'Step 2 verified: Take a splice');
}

console.log('checker: missing part (mustStay, opt-in)');
{
  const run = s => {
    const r = crig(s, { model: S2_CLASSES });
    const all = [r.det('crimped_splice', 'crimp', 0.8)];
    r.play(500).step({ in: act() }).see(all).step({ parts: { 'class:splice': 0.8 } }).step({ crimp: { 'class:splice': 0.8 } })
      .step({ crimp: { 'class:crimp_tool': 0.8 } }).step({ crimp: { 'class:crimped_splice': 0.8 } }, 1500);
    r.see([]).busy(500).play(1500);
    return r;
  };
  const s = st2(); s.substeps.find(x => x.id === 's2_pull_test').model.mustStay = true;
  const r = run(s);
  const miss = r.verdicts.find(v => v.kind === 'mistake');
  const vs = r.verdicts.filter(v => v.kind === 'verified').map(v => v.substep).join();
  check('each clear-view check verifies the newest model step (Take a splice was overtaken before 3 results came in, like live_check.py)', vs === 's2_pick,s2_insert,s2_crimp,s2_pull_test', r.kinds());
  check('mustStay: a verified part gone from its zone is a mistake "<class> is missing (step N)"', miss && miss.message === 'Crimped splice is missing (step 5)' && miss.reason === 'missing' && miss.substep === 's2_pull_test' && miss.conf === null, r.kinds());
  r.play(3000);
  check('rechecked every second while it shows, same message: no new verdict', r.verdicts.filter(v => v.kind === 'mistake').length === 1);
  r.see([r.det('crimped_splice', 'crimp', 0.8)]).busy(500).play(1500);
  check('put back: "Mistake cleared. Continue with <next substep>"', r.last().kind === 'cleared' && r.last().message === 'Mistake cleared. Continue with Pass to station 3', r.kinds());
  const r2 = run(st2());
  check('without mustStay the same run raises nothing', !r2.verdicts.some(v => v.kind === 'mistake' || v.kind === 'review'), r2.kinds());
  r.step({ out: act() }).step({}, 300).see([]).busy(500).play(1500);
  check('after the cycle ends the part may leave (no missing mistake)', r.last().message === 'Cycle complete', r.kinds());
}

console.log('checker: position and orientation (positionCheck, Save correct state)');
const posStation = () => Object.assign(st2(), { positionCheck: { anchor: 'crimp', classes: ['splice'], tolerance: 0.14 } });
let REF = null;
{
  const r = crig(posStation(), { model: S2_CLASSES });
  r.see([r.det('splice', 'crimp', 0.8)]).busy(500);
  check('Save correct state needs a clear view', /hands out of view/.test(r.chk.saveRef(r.t).error || ''));
  r.play(500);
  check('...and 3 model results taken in it', /of 3 model results/.test(r.chk.saveRef(r.t).error || ''), JSON.stringify(r.chk.saveRef(r.t)));
  r.play(2500);
  const saved = r.chk.saveRef(r.t), b = saved.ref && saved.ref.classes.splice;
  check('saved: each listed class\'s median box relative to the anchor zone, plus landscape', b && near(b.x, 0.5) && near(b.y, 0.5) && near(b.w, 0.4) && near(b.h, 0.2) && b.landscape === true && saved.ref.anchor === 'crimp' && saved.ref.frames === 10, JSON.stringify(saved));
  REF = saved.ref;
  const r2 = crig(posStation(), { model: S2_CLASSES });
  r2.see([r2.det('crimp_tool', 'crimp', 0.8)]).play(1500);
  check('a listed class that is not in view cannot be saved', /Could not see Splice in Crimp area/.test(r2.chk.saveRef(r2.t).error || ''), JSON.stringify(r2.chk.saveRef(r2.t)));
  const r3 = crig(st2(), { model: S2_CLASSES });
  check('a station without positionCheck has nothing to save', /no positionCheck/.test(r3.chk.saveRef(0).error));
}
{
  const r = crig(posStation(), { model: S2_CLASSES });
  r.chk.setRef(REF);
  r.see([r.det('splice', 'crimp', 0.8, { cx: 0.6 })]).play(1500);
  check('within the tolerance (0.10 of the zone off, limit 0.14): no mistake', r.verdicts.length === 0, r.kinds());
  r.see([r.det('splice', 'crimp', 0.8, { cx: 0.7 })]).busy().play(1500);
  check('off by more than 0.14 of the anchor zone: mistake "<class> is in the wrong position"', r.last() && r.last().kind === 'mistake' && r.last().message === 'Splice is in the wrong position' && r.last().reason === 'wrong_position' && near(r.chk.current.box[0], 2 / 4 + 0.5 / 4, 1e-9), r.kinds());
  r.see([r.det('splice', 'crimp', 0.8, { w: 0.2, h: 0.4 })]).busy().play(1500);
  check('portrait where the saved state is landscape: "<class> is turned the wrong way"', r.last().kind === 'mistake' && r.last().message === 'Splice is turned the wrong way' && r.last().reason === 'turned', r.kinds());
  r.see([r.det('splice', 'crimp', 0.5, { cy: 0.8 })]).busy().play(1500);
  check('the same on a box under 0.60 is a review', r.last().kind === 'review' && r.last().message === 'Splice is in the wrong position' && r.last().conf === 0.5, r.kinds());
  r.see([r.det('splice', 'crimp', 0.3, { cy: 0.8 })]).busy().play(1500);
  check('a box under 0.35 is ignored (the review clears)', r.last().kind === 'cleared', r.kinds());
}
{
  const r = crig(posStation(), { model: S2_CLASSES });
  r.chk.setRef(REF);
  const far = c => [r.det('splice', 'crimp', c, { cx: 0.9 })];
  r.see(far(0.5)).play(1500);
  check('dedupe across kinds: a review first ...', r.verdicts.length === 1 && r.last().kind === 'review', r.kinds());
  r.see(far(0.8)).play(1500);
  check('...that becomes sure is a new verdict (mistake, sounded)', r.verdicts.length === 2 && r.last().kind === 'mistake', r.kinds());
  r.see(far(0.55)).play(1500).see(far(0.7)).play(1500).see(far(0.5)).play(1500);
  check('a showing mistake is not turned back into a review by a less sure look (confidence hovering at 0.60: no new verdicts)', r.verdicts.length === 2 && r.chk.current.kind === 'mistake', r.kinds());
}

console.log('checker: vote, flicker, clear-view gate, recheck');
{
  const vote = shots => {
    const r = crig(posStation(), { model: S2_CLASSES, every: Infinity });
    r.chk.setRef(REF);
    r.play(500);
    for (const s of shots) r.shot([r.det('splice', 'crimp', s[0], { cx: s[1] })]).play(250);
    return r;
  };
  const r1 = vote([[0.8, 0.9], [0.8, 0.5], [0.8, 0.9]]);
  check('vote: 2 of the last 3 checks find the wrong position, so it is a mistake', r1.verdicts.length === 1 && r1.last().kind === 'mistake', r1.kinds());
  const r2 = vote([[0.8, 0.5], [0.8, 0.9], [0.8, 0.5]]);
  check('one stray result out of 3 raises nothing', r2.verdicts.length === 0, r2.kinds());
  const r3 = vote([[0.8, 0.9], [0.5, 0.9], [0.8, 0.5]]);
  check('no majority (mistake, review, fine): review "Results flickered between checks, take a look"', r3.verdicts.length === 1 && r3.last().kind === 'review' && r3.last().message === 'Results flickered between checks, take a look' && r3.last().reason === 'flicker', r3.kinds());
  const r4 = vote([[0.8, 0.9], [0.8, 0.9]]);
  check('fewer than 3 clear-view results: no check yet', r4.verdicts.length === 0);
}
{
  const r = crig(posStation(), { model: S2_CLASSES, every: Infinity });
  r.chk.setRef(REF);
  r.motion = 0.5; r.shot([]).play(250);
  check('a model result taken while the view is not clear is not used', r.chk.frames === 0);
  r.motion = null; r.play(125).shot([]).play(125);
  check('nor one taken in the first 0.3 s of a clear view', r.chk.frames === 0 && !r.chk.clear);
  r.play(250).shot([]).play(125);
  check('after 0.3 s it is', r.chk.frames === 1 && r.chk.clear);
}
{
  const r = crig(st2(), { hands: false });
  r.play(500).step({ in: act() }).step({ crimp: act() });
  r.hands = true; r.step({}, 2000);
  check('Hands on and a hand in the tile: no clear view, the mistake stays', r.last().kind === 'mistake' && r.chk.current.kind === 'mistake');
  r.hands = false; r.play(500);
  check('hand gone and zones still for 0.3 s: checked and cleared', r.last().kind === 'cleared');
  const r2 = crig(st2());
  r2.play(500).step({ in: act() }).step({ crimp: act() });
  r2.motion = 0.06; r2.step({}, 2000);
  check('zone motion of 0.05 or more is not a clear view', r2.last().kind === 'mistake');
  r2.motion = 0.04; r2.play(500);
  check('under 0.05 is', r2.last().kind === 'cleared');
}
{
  const r = crig(posStation(), { model: S2_CLASSES });
  r.chk.setRef(REF);
  r.see([r.det('splice', 'crimp', 0.8, { cx: 0.9 })]).play(1500);
  const m = r.last();
  r.play(3000);
  check('a showing mistake that stays the same is not repeated', r.verdicts.length === 1 && m.kind === 'mistake', r.kinds());
  const t0 = r.t;
  r.see([r.det('splice', 'crimp', 0.8)]).play(2000);
  const c = r.last();
  check('rechecked every 1.0 s in the same clear spell: fixed gives "Mistake cleared"', c.kind === 'cleared', r.kinds());
  check('...at the next recheck (within 1.0 s of the fix, 1.0 s after the last check)', c.t - t0 < 1000 + FRAME && (c.t - m.t) % 125 === 0, c.t - t0);
  const r2 = crig(posStation(), { model: S2_CLASSES });
  r2.chk.setRef(REF);
  r2.see([r2.det('splice', 'crimp', 0.8)]).play(1500).see([r2.det('splice', 'crimp', 0.8, { cx: 0.9 })]).play(3000);
  check('nothing showing: one check per clear spell (a change waits for the next one)', r2.verdicts.length === 0, r2.kinds());
  r2.busy().play(1500);
  check('...which then finds it', r2.last() && r2.last().kind === 'mistake', r2.kinds());
}

console.log('checker: logs (verdicts.csv, cycles.csv counts)');
{
  const r = crig(st2());
  r.play(500).step({ in: act() }).step({ crimp: act() }).step({}, 500).step({ out: act() }).step({}, 300);
  const extra = { type: 'verdict', station: 's2', t: 1300, cycle: 1, substep: 's2_insert', kind: 'review', message: 'Results flickered between checks, take a look', conf: null, videoT: 1.3, videoFile: 's2.mp4' };
  const ev = [{ type: 'session_start', t: 0 }].concat(r.events, r.verdicts, [extra]);
  const v = LE.verdictsCsv(ev, CFG, { id: 'sess' }).trim().split('\n');
  check('verdicts.csv: header and one row per verdict, in time order', v[0] === LE.VERDICT_COLS.join(',') && v.length === 1 + r.verdicts.length + 1 && v[2].includes(',mistake,') && v[3].includes(',review,'), v.join(' / '));
  check('verdicts.csv row: session, station, time, ts, cycle, step number, event, message, empty confidence for zones', v[2] === 'sess,s2,1970-01-01T00:00:01Z,1.25,1,2,mistake,Wrong order: Push wire A into the splice before Take a splice (step 2 skipped),,,,,', v[2]);
  check('verdicts.csv quotes a message with a comma and keeps the video position', v[3] === 'sess,s2,1970-01-01T00:00:01Z,1.3,1,3,review,"Results flickered between checks, take a look",,,,s2.mp4,1.3', v[3]);
  check('verdicts.csv: Cycle complete has step_seconds and cycle_seconds', /,verified,Cycle complete,,[\d.]+,[\d.]+,,$/.test(v[v.length - 1]), v[v.length - 1]);
  const c = LE.cyclesCsv(ev, CFG, { id: 'sess' }).trim().split('\n'), h = c[0].split(','), row = (c.find(l => l.includes(',s2,detected,1,')) || '').split(',');
  check('cycles.csv gains mistakes and reviews per cycle (1 and 1 here)', h.indexOf('mistakes') === h.indexOf('flags') + 1 && row[h.indexOf('mistakes')] === '1' && row[h.indexOf('reviews')] === '1', c.join(' / '));
  check('the server accepts verdict events (EVENT_TYPES)', LE.EVENT_TYPES.includes('verdict'));
}

console.log('floor layouts (docs/canvas-plan.md)');
{
  const ct = LE.classTestLayout(CFG);
  check('Class test: the config\'s four stations, built in, named "S1 Cut and strip" and so on', ct.id === 'class-test' && ct.builtIn && ct.stations.map(s => s.id + '/' + s.role).join() === 's1/s1,s2/s2,s3/s3,s4/s4' && ct.stations[0].name === 'S1 Cut and strip' && ct.stations[3].name === 'S4 QA test', JSON.stringify(ct.stations));
  check('Class test is the L from the photo: S1 on top, S2 below it, S3 right of S2, S4 right of S3', ct.stations.map(s => s.x + ',' + s.y).join(' ') === '0,0 0,560 760,560 1520,560', ct.stations.map(s => s.x + ',' + s.y).join(' '));
  check('positions sit on the 40-unit grid', ct.stations.every(s => s.x % LE.FLOOR.grid === 0 && s.y % LE.FLOOR.grid === 0));
  check('the next station id is the lowest free s<n>', LE.nextStationId(ct.stations) === 's5' && LE.nextStationId([{ id: 's1' }, { id: 's2' }, { id: 's4' }]) === 's3' && LE.nextStationId([]) === 's1');
  check('setup keys: s2 for its own role, s5:s4 for station s5 running role s4', LE.setupKey('s2', 's2') === 's2' && LE.setupKey('s5', 's4') === 's5:s4' && LE.setupKey('s3') === 's3');
  check('short name drops a leading station id only', LE.shortName('s5', 'S5 QA test', 'QA test') === 'QA test' && LE.shortName('s1', 'S10 tester', 'QA test') === 'S10 tester' && LE.shortName('s5', 'Back tester', 'QA test') === 'Back tester' && LE.shortName('s5', 'S5', 'QA test') === 'QA test');
  const cfgM = Object.assign({}, CFG, { models: { s2: { file: '/models/crimp.onnx', classes: ['wire', 'splice', 'crimp_tool', 'crimped_splice'] } } });
  const lay = { id: 'l-test', name: 'Two crimpers, two testers', stations: [
    { id: 's1', name: 'S1 Cut and strip', role: 's1', x: 0, y: 0 }, { id: 's2', name: 'S2 Crimp side A', role: 's2', x: 0, y: 560 },
    { id: 's5', name: 'S5 Crimp side A', role: 's2', x: 760, y: 560 }, { id: 's3', name: 'S3 Crimp side B', role: 's3', x: 1520, y: 560 },
    { id: 's4', name: 'S4 QA test', role: 's4', x: 2280, y: 560 }, { id: 's6', name: 'Second tester', role: 's4', x: 3040, y: 560 },
    { id: 's7', name: 'Ghost', role: 'nope', x: 0, y: 0 }] };
  const eff = LE.applyLayout(cfgM, lay);
  check('applyLayout: one station per entry in flow order, unknown roles left out', eff.stations.map(s => s.id).join() === 's1,s2,s5,s3,s4,s6' && eff.stations.map(s => s.order).join() === '1,2,3,4,5,6');
  const s5 = eff.stations.find(s => s.id === 's5'), s6 = eff.stations.find(s => s.id === 's6');
  check('a station is a copy of its role with its own id, name and position', s5.role === 's2' && s5.label === 'Crimp side A' && s5.name === 'S5 Crimp side A' && s5.x === 760 && s5.substeps.map(x => x.id).join() === CFG.stations[1].substeps.map(x => x.id).join() && s6.qa && s6.cycleEnds === 's4_sort');
  check('models are keyed by station id: s5 runs its role\'s model; the config itself is untouched', eff.models.s5 && eff.models.s5.file === '/models/crimp.onnx' && eff.models.s2 && !eff.models.s1 && LE.modelFor(eff, 's5') === eff.models.s5 && cfgM.stations.length === 4 && !cfgM.stations[0].role);
  check('a fail reason\'s cause goes to the first station in flow order with that role', eff.failReasons.find(r => r.id === 'crimp_a').cause === 's2' && eff.failReasons.find(r => r.id === 'other').cause === null);
  const noS1 = LE.applyLayout(CFG, { stations: [{ id: 's2', role: 's2' }, { id: 's4', role: 's4' }] });
  check('a cause role with no station in the layout gives no cause station', noS1.failReasons.find(r => r.id === 'strip').cause === null && noS1.stations[0].name === 'S2 Crimp side A');
  check('the config check still runs on the file as written', LE.checkConfig(CFG).length === 0);

  // Shared roles: s1 4 cycles of 10 s; s2 and s5 side by side, 2 cycles of 20 s each; s3 3 of 12 s; testers s4 (2) and s6 (1).
  const ev = [{ type: 'session_start', t: 0 }];
  ev.push(...cycleEvents('s1', 4, 10, 1000, 2, ['s1_pick_wire', 's1_measure_cut', 's1_handoff']));
  ev.push(...cycleEvents('s2', 2, 20, 2000, 2, ['s2_pick', 's2_insert', 's2_handoff']));
  ev.push(...cycleEvents('s5', 2, 20, 3000, 2, ['s2_pick', 's2_insert', 's2_handoff']));
  ev.push(...cycleEvents('s3', 3, 12, 4000, 2, ['s3_pick', 's3_insert', 's3_handoff']));
  const e4 = cycleEvents('s4', 2, 8, 5000, 2, ['s4_pick', 's4_connect', 's4_sort']), e6 = cycleEvents('s6', 1, 8, 6000, 2, ['s4_pick', 's4_connect', 's4_sort']);
  ev.push(...e4, ...e6);
  e4.filter(e => e.type === 'cycle_end').forEach((e, k) => ev.push({ type: 'qa_result', station: 's4', cycle: k + 1, t: e.t, result: 'pass', light: true, bin: 'pass', source: 'zones' }));
  ev.push({ type: 'qa_result', station: 's6', cycle: 1, t: e6[e6.length - 1].t, result: 'fail', reason: 'crimp_a', light: false, bin: 'fail', source: 'manual' });
  ev.push({ type: 'session_end', t: 100000 });
  const sum = LE.summarize(ev, eff), L = sum.line;
  check('two QA stations: units, passes and fails add up (3 units, 2 pass, 1 fail)', L.units === 3 && L.passed === 2 && L.failed === 1 && near(L.fpy, 2 / 3, 1e-3), JSON.stringify(L));
  check('side by side (s2 and s5): no WIP between them; WIP between stages adds the stage up', L.wip.map(w => w.n === null ? '-' : w.n).join() === '0,-,1,0,-', JSON.stringify(L.wip));
  check('bottleneck: a station\'s average over its stage (s2 and s5 20 s / 2 = 10 s), so s3 at 12 s sets the pace', L.bottleneck === 's3', L.bottleneck);
  check('fails by cause: crimp_a is charged to s2, the first Crimp side A in flow order', L.failsByCause.s2 === 1 && L.failsByCause.s5 === 0);
  const csv = LE.substepsCsv(ev, eff, { id: 'x' }).trim().split('\n'), cyc = LE.cyclesCsv(ev, eff, { id: 'x' }).trim().split('\n');
  check('CSVs carry the new station ids with their role\'s substep labels and QA columns', csv.some(l => l.startsWith('x,,,s5,1,1,s2_pick,Take a wire pair from the in tray,')) && cyc.some(l => l.includes(',s6,detected,1,') && l.includes(',fail,crimp_a,s2,1,')), cyc.join(' / '));
  // With one station per role, the Class test layout gives the same numbers as the bare config.
  const ev2 = [{ type: 'session_start', t: 0 }].concat(cycleEvents('s1', 3, 20, 1000, 5, ['s1_pick_wire', 's1_handoff']), cycleEvents('s2', 2, 30, 2000, 5, ['s2_pick', 's2_handoff']), cycleEvents('s4', 1, 10, 3000, 5, ['s4_pick', 's4_sort']), [{ type: 'session_end', t: 90000 }]);
  check('Class test numbers are the same as before the canvas', JSON.stringify(LE.summarize(ev2, LE.applyLayout(CFG, ct))) === JSON.stringify(LE.summarize(ev2, CFG)));
}

console.log('operators (dashboard plan, decision 1)');
{
  check('operator is an event type the server accepts', LE.EVENT_TYPES.includes('operator'));
  check('levels: new, in training, certified (ids new, training, certified)', LE.LEVELS.map(l => l.id).join() === 'new,training,certified' && LE.LEVELS[1].label === 'In training');
  check('codes: 7, 07, op-7 and Op-07 all become Op-07; 123 stays 3 digits', ['7', '07', 'op-7', 'Op-07', ' OP 7 '].every(v => LE.operatorCode(v) === 'Op-07') && LE.operatorCode('123') === 'Op-123' && LE.OPERATOR_CODE.test('Op-123'));
  check('a name, an empty code or 4 digits is not a code', [null, '', 'Michael', 'Op-Mike', '1234', 'Op-07 Mike'].every(v => LE.operatorCode(v) === null));
}

console.log('regressions: new station placement and per-layout saves (ea1dcf3, de886c8)');
{
  // Class test cards: 640 wide, positions from the layout; the middle of the view lands on s3's card.
  const rects = LE.classTestLayout(CFG).stations.map(s => ({ x: s.x, y: s.y, w: LE.FLOOR.cardW, h: 320 }));
  const mid = rects[2], [x, y] = LE.freeSpot(rects, mid.x, mid.y);
  const overlaps = r => x < r.x + r.w && r.x < x + LE.FLOOR.cardW && y < r.y + r.h && r.y < y + 520;
  check('a new station asked for a spot on top of a card goes to a free spot, not on the card', !rects.some(overlaps), x + ',' + y);
  check('a free middle is kept as it is (snapped to the grid)', JSON.stringify(LE.freeSpot([], 80, 120)) === '[80,120]');
  const dist = Math.hypot(x - mid.x, y - mid.y);
  check('the free spot is the nearest one: within one ring or two of the wanted spot', dist <= 2 * 200 * Math.SQRT2, String(dist));
  // Saves: a timer per layout. Fake timers record what is pending.
  let id = 0; const live = new Map(), ran = [];
  const sched = LE.saveScheduler({ set: (fn, ms) => { live.set(++id, fn); return id; }, clear: t => { live.delete(t); } });
  sched.later('a', () => ran.push('a'), 400);
  sched.later('b', () => ran.push('b'), 400);
  check('a save for layout b does not cancel the pending save for layout a', live.size === 2 && sched.pending().join() === 'a,b');
  for (const [k, fn] of [...live]) { live.delete(k); fn(); }
  check('both saves run', ran.sort().join() === 'a,b' && sched.pending().length === 0);
  sched.later('a', () => ran.push('a1'), 400); sched.later('a', () => ran.push('a2'), 400);
  check('a second edit on the same layout replaces its pending save', live.size === 1);
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
