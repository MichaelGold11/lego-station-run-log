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

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
