// Unit tracker tests with synthetic signal sequences. Run: node scripts/test-unit-tracker.mjs (part of npm run test:line)
import fs from 'node:fs';
const load = f => { const mod = { exports: {} }; new Function('module', fs.readFileSync(new URL('../app/' + f, import.meta.url), 'utf8'))(mod); return mod.exports; };
const LE = load('line-engine.js');
const SHIPPED = JSON.parse(fs.readFileSync(new URL('../data/meta/wire-line.json', import.meta.url), 'utf8'));
const S2 = SHIPPED.stations.find(s => s.id === 's2');
let fails = 0, passes = 0;
function check(name, cond, extra) { if (cond) { passes++; console.log('  pass  ' + name); } else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); } }

// A rig: feed one frame every 125 ms. in(t, ...) sets presence; ev() adds events to the next frame.
function rig(cfg) {
  const ut = LE.createUnitTracker(Object.assign({}, S2, { unitTracker: Object.assign({}, S2.unitTracker, cfg || {}) }));
  let t = 0, pend = [];
  const log = [];
  const r = {
    ut, log, get t() { return t; },
    ev(e) { pend.push(Object.assign({ station: 's2', t, source: 'model' }, e)); return r; },
    arrive() { return r.ev({ type: 'substep', substep: 's2_arrive', move: 'start' }); },
    step(id) { return r.ev({ type: 'substep', substep: id, move: 'next' }); },
    close() { return r.ev({ type: 'substep', substep: 's2_close', move: 'next' }).ev({ type: 'cycle_end', cycle: 1 }); },
    verdict(kind) { return r.ev({ type: 'verdict', kind }); },
    run(ms, present, hand) { for (let i = 0; i < Math.round(ms / 125); i++) { t += 125; pend.forEach(e => { e.t = t; }); log.push(...ut.update({ t, present, hand: !!hand, events: pend })); pend = []; } return r; },
    ends() { return log.filter(e => e.action === 'end'); },
    starts() { return log.filter(e => e.action === 'start'); }
  };
  return r;
}
const normalUnit = r => { r.run(1000, true).arrive().run(500, true).step('s2_open').run(1000, true).step('s2_arrange').run(2000, true).close().run(1000, true); return r; };

console.log('unit tracker: normal unit');
{
  const r = rig(); r.run(1000, false);
  check('waiting while the work area is empty', r.ut.state().phase === 'waiting' && r.ut.state().next === '#001');
  r.run(1000, true).arrive();
  r.run(500, true);
  check('in_progress as soon as a unit has been in view for enterMs, numbered #001', r.ut.state().phase === 'in_progress' && r.ut.state().no === '#001' && r.starts().length === 1, JSON.stringify(r.ut.state().phase));
  r.step('s2_open').run(1000, true).step('s2_arrange').run(1500, true).verdict('mistake').close().run(500, true);
  check('complete when the cycle closes', r.ut.state().phase === 'complete' && r.ut.state().completed === 1);
  r.run(1000, false);
  check('complete unit still in the record until it has been gone for departMs', r.ut.state().phase === 'complete' && r.ends().length === 0);
  r.run(1500, false);
  const e = r.ends()[0];
  check('departed: result complete, ended departed, reset the checker', e && e.result === 'complete' && e.ended === 'departed' && e.reset === true && !e.needsReview, JSON.stringify(e));
  check('record carries number, station, per-step times, mistakes', e.no === '#001' && e.station === 's2' && e.steps.length >= 3 && e.steps.every(s => s.sec >= 0) && e.mistakes === 1 && e.reviews === 0 && e.end > e.start, JSON.stringify(e));
  check('the end time is when the unit left, not when the debounce ran out', e.end <= r.t - 2000 + 125);
  check('back to waiting, next number #002', r.ut.state().phase === 'waiting' && r.ut.state().next === '#002' && r.ut.state().completed === 1);
}

console.log('unit tracker: brief occlusion and a hand over the unit');
{
  const r = rig(); r.run(500, false); r.run(1000, true).arrive().run(500, true).step('s2_open').run(500, true);
  r.run(1000, false);                     // the model loses it for 1 s
  r.run(500, true).step('s2_arrange').run(500, true);
  check('a 1 s occlusion does not end the unit', r.ends().length === 0 && r.ut.state().phase === 'in_progress' && r.ut.state().no === '#001');
  r.run(5000, false, true);               // a hand covers it for 5 s: the model sees nothing
  check('a hand over the unit holds it', r.ends().length === 0);
  r.run(2200, false, false);
  check('hand gone and still nothing for departMs: it ends', r.ends().length === 1);
  const r2 = rig(); r2.run(500, true);
  check('a unit already in view when tracking starts is not counted until the area empties', r2.ut.state().phase === 'waiting' && r2.starts().length === 0);
  r2.run(500, false).run(1000, true);
  check('then the next one starts #001', r2.starts().length === 1 && r2.starts()[0].no === '#001');
  const r3 = rig(); r3.run(500, false).run(300, true).run(500, false).run(300, true).run(500, false);
  check('a flicker shorter than enterMs does not start a unit', r3.starts().length === 0);
}

console.log('unit tracker: leaves before complete');
{
  const r = rig(); r.run(500, false).run(1000, true).arrive().run(500, true).step('s2_open').run(1000, true).run(3000, false);
  const e = r.ends()[0];
  check('incomplete, flagged needs review, ended departed', e && e.result === 'incomplete' && e.needsReview === true && e.ended === 'departed' && e.reset === true, JSON.stringify(e));
  check('an incomplete unit is not counted as completed', r.ut.state().completed === 0 && r.ut.state().incomplete === 1 && r.ut.state().needsReview === 1);
  normalUnit(r.run(500, true));
  check('the next unit gets the next number', r.ut.state().no === '#002', r.ut.state().no);
}

console.log('unit tracker: two units back to back');
{
  const r = rig(); r.run(500, false);
  normalUnit(r); r.run(3000, false);
  normalUnit(r.run(1000, true)); r.run(3000, false);
  const e = r.ends();
  check('two complete units #001 and #002, completed 2', e.length === 2 && e[0].no === '#001' && e[1].no === '#002' && e.every(x => x.result === 'complete') && r.ut.state().completed === 2, JSON.stringify(e.map(x => [x.no, x.result])));
  check('per-unit numbers advance and times do not overlap', e[1].start >= e[0].end);
}

console.log('unit tracker: new unit enters while the old one is still in view (newUnitNeedsEmpty off, the old behavior)');
{
  const r = rig({ newUnitNeedsEmpty: false }); r.run(500, false);
  normalUnit(r);
  r.run(300, true).arrive().run(500, true);           // new wires arrive, the old unit never left the view
  const e = r.ends();
  check('the old unit ends as new_unit, complete', e.length === 1 && e[0].ended === 'new_unit' && e[0].result === 'complete' && e[0].reset === false, JSON.stringify(e));
  check('the new unit is #002, in progress', r.ut.state().no === '#002' && r.ut.state().phase === 'in_progress');
  check('the new unit starts with its arrival step', r.ut.state().current.steps[0] && r.ut.state().current.steps[0].id === 's2_arrive');
}

console.log('unit tracker: session stopped mid-unit');
{
  const r = rig(); r.run(500, false).run(1000, true).arrive().run(500, true).step('s2_open').run(500, true);
  const out = r.ut.stop(r.t);
  check('an open unit ends as session_stopped, incomplete, flagged', out.length === 1 && out[0].ended === 'session_stopped' && out[0].result === 'incomplete' && out[0].needsReview);
  const r2 = rig(); normalUnit(r2.run(500, false));
  const o2 = r2.ut.stop(r2.t);
  check('a complete unit at stop is complete and counted', o2[0].result === 'complete' && o2[0].ended === 'session_stopped' && r2.ut.state().completed === 1);
  check('stop with nothing open does nothing', rig().ut.stop(0).length === 0);
}

console.log('unit tracker: cross-check against the key presses');
{
  const r = rig(); r.run(500, false); normalUnit(r); r.run(3000, false); normalUnit(r.run(500, true)); r.run(3000, false);
  r.ut.noteManual(1); 
  check('one press against two auto units: one disagreement', r.ut.state().manual === 1 && r.ut.state().completed === 2 && r.ut.state().disagreements === 1);
  r.ut.noteManual(2);
  check('two presses: they agree', r.ut.state().disagreements === 0);
}

console.log('unit tracker: presence, config, exports');
{
  const cfg = S2.unitTracker;
  check('presence needs a listed class at the confidence', LE.unitPresent([{ cls: 'red_wire', conf: 0.5 }], cfg) && !LE.unitPresent([{ cls: 'red_wire', conf: 0.2 }], cfg) && !LE.unitPresent([{ cls: 'hand', conf: 0.9 }], cfg) && !LE.unitPresent([], cfg));
  check('S2 and S3 have the tracker on; S1 and S4 do not', LE.unitTrackerOn(S2) && LE.unitTrackerOn(SHIPPED.stations.find(s => s.id === 's3')) && SHIPPED.stations.filter(s => s.id !== 's2' && s.id !== 's3').every(s => !LE.unitTrackerOn(s)) && LE.checkConfig(SHIPPED).length === 0, LE.checkConfig(SHIPPED).join(' / '));
  check('the shipped config is valid', LE.checkConfig(SHIPPED).length === 0, LE.checkConfig(SHIPPED).join(' | '));
  const bad = JSON.parse(JSON.stringify(SHIPPED)); bad.stations.find(s => s.id === 's2').unitTracker = { enabled: true, departMs: -5, presentConf: 3, presenceClasses: [1] };
  const msg = LE.checkConfig(bad).join(' | ');
  check('a bad unitTracker is reported', /departMs/.test(msg) && /presentConf/.test(msg) && /presenceClasses/.test(msg), msg);
  const bad2 = JSON.parse(JSON.stringify(SHIPPED)); bad2.stations.find(s => s.id === 's1').unitTracker = { enabled: true };
  check('a tracker on a station with no arrival substep is reported', LE.checkConfig(bad2).some(m => /s1: unitTracker needs/.test(m)));
  check('unit is an event type the server accepts', LE.EVENT_TYPES.includes('unit'));
  check('#001 formatting', LE.unitNo(1) === '#001' && LE.unitNo(42) === '#042' && LE.unitNo(1234) === '#1234');

  // Session export: unit events -> units.csv appended columns and the tracked-units table.
  const r = rig(); r.run(500, false); normalUnit(r); r.run(3000, false); r.run(1000, true).arrive().run(500, true).run(3000, false);
  const ev = [{ type: 'session_start', t: 0 }];
  const cyc = [];
  for (let k = 0; k < 2; k++) { cyc.push({ type: 'substep', station: 's2', substep: 's2_arrive', move: 'start', cycle: k + 1, t: 1000 + k * 20000 }, { type: 'substep', station: 's2', substep: 's2_close', move: 'next', cycle: k + 1, t: 9000 + k * 20000 }, { type: 'cycle_end', station: 's2', cycle: k + 1, t: 9000 + k * 20000 }); }
  const all = ev.concat(cyc, r.log.map(e => Object.assign({}, e, { t: e.t + 100 })));
  const csv = LE.unitsCsv(all, SHIPPED, { id: 'x', crew: 'A', shift: 'Day' }).trim().split('\n'), head = csv[0].split(','), base = LE.unitCols(SHIPPED);
  check('units.csv: the older columns keep their names and order', JSON.stringify(head.slice(0, 5)) === JSON.stringify(['session_id', 'crew', 'shift', 'unit', 'status']) && head.includes('lead_s') && head.indexOf('lead_s') < head.indexOf('unit_no'));
  check('units.csv: unit_no and the s2 tracker columns are appended', head.includes('unit_no') && head.includes('s2_unit_result') && head.includes('s2_unit_ended') && head.includes('s2_unit_review') && head.length === base.length);
  check('units.csv: the first row carries #001 complete', csv[1].split(',')[head.indexOf('unit_no')] === '#001' && csv[1].split(',')[head.indexOf('s2_unit_result')] === 'complete', csv[1]);
  const tc = LE.trackedUnitsCsv(all, SHIPPED, { id: 'x', crew: 'A', shift: 'Day' }).trim().split('\n');
  check('the tracked-units table has a row per unit, the incomplete one flagged', tc.length === 3 && /#001/.test(tc[1]) && /,complete,departed,/.test(tc[1]) && /#002/.test(tc[2]) && /,incomplete,departed,/.test(tc[2]), tc.join(' / '));
  const noTr = LE.unitCols(Object.assign({}, SHIPPED, { stations: SHIPPED.stations.map(s => Object.assign({}, s, { unitTracker: null })) }));
  check('without any tracker the columns are exactly the old ones', noTr[noTr.length - 1] === 'lead_s');
}

console.log('unit tracker: S2 to S3 hand-off (one number down the line)');
{
  const S3 = SHIPPED.stations.find(x => x.id === 's3');
  const link = LE.createUnitLink(SHIPPED);
  const u2 = LE.createUnitTracker(S2, { link }), u3 = LE.createUnitTracker(S3, { link });
  let t = 0; const out = { s2: [], s3: [] };
  const fr = (id, ms, present, evs) => { const ut = id === 's2' ? u2 : u3; for (let k = 0; k < Math.round(ms / 125); k++) { t += 125; out[id].push(...ut.update({ t, present, hand: false, events: k === 0 && evs ? evs.map(e => Object.assign({ station: id, t, source: 'model' }, e)) : [] })); } };
  const s2unit = () => { fr('s2', 1000, true, [{ type: 'substep', substep: 's2_arrive', move: 'start' }]); fr('s2', 1000, true, [{ type: 'substep', substep: 's2_close', move: 'next' }, { type: 'cycle_end' }]); fr('s2', 2500, false); };
  const s3unit = (done, gone) => { fr('s3', 1000, true, [{ type: 'substep', substep: 's3_arrive', move: 'start' }]); if (done) fr('s3', 1000, true, [{ type: 'substep', substep: 's3_insert', move: 'next' }, { type: 'cycle_end' }]); if (gone) fr('s3', 2500, false); };
  fr('s2', 500, false); fr('s3', 500, false);
  s2unit(); s2unit(); s2unit();
  check('S2 numbered #001 to #003 and queued three for S3', u2.state().completed === 3 && u2.state().queue === 3, JSON.stringify([u2.state().completed, u2.state().queue]));
  s3unit(true, true);
  check('the first unit at S3 is the same #001', out.s3[0].no === '#001' && out.s3[0].unit === 1 && out.s3[0].from === 's2' && !out.s3[0].unlinked, JSON.stringify(out.s3[0]));
  check('S3 ends it complete and the queue is down to two', out.s3.filter(e => e.action === 'end')[0].result === 'complete' && u3.state().queueFrom === 2);
  s3unit(true, true);
  check('the next S3 unit is #002', out.s3.filter(e => e.action === 'start')[1].no === '#002');
  check('S2 units not received by S3 show as the queue length', u2.state().queue === 1 && u3.state().queueFrom === 1);
  s3unit(true, true); s3unit(true, true);
  const st4 = out.s3.filter(e => e.action === 'start')[3];
  check('an S3 arrival with nothing queued is unlinked, flagged, and does not use a number', st4.unlinked && st4.no === '?01' && st4.unit === null, JSON.stringify(st4));
  const e4 = out.s3.filter(e => e.action === 'end')[3];
  check('the unlinked unit needs review even though S3 completed it', e4.needsReview && e4.result === 'complete');
  s2unit(); s3unit(true, true);
  check('the order is not broken: the next real S2 unit is #004 at S3', out.s3.filter(e => e.action === 'start')[4].no === '#004', out.s3.filter(e => e.action === 'start').map(e => e.no).join(','));
  const link2 = LE.createUnitLink(SHIPPED), a = LE.createUnitTracker(S2, { link: link2 }), b = LE.createUnitTracker(S3, { link: link2 });
  let tt = 0; const o3 = [];
  const f2 = (ms, p, evs) => { for (let k = 0; k < Math.round(ms / 125); k++) { tt += 125; a.update({ t: tt, present: p, hand: false, events: k === 0 && evs ? evs.map(e => Object.assign({ station: 's2', t: tt, source: 'model' }, e)) : [] }); } };
  const f3 = (ms, p, evs) => { for (let k = 0; k < Math.round(ms / 125); k++) { tt += 125; o3.push(...b.update({ t: tt, present: p, hand: false, events: k === 0 && evs ? evs.map(e => Object.assign({ station: 's3', t: tt, source: 'model' }, e)) : [] })); } };
  f2(500, false); f3(500, false); f2(1000, true, [{ type: 'substep', substep: 's2_arrive', move: 'start' }]); f2(500, true, [{ type: 'substep', substep: 's2_close', move: 'next' }, { type: 'cycle_end' }]);
  f3(1000, true, [{ type: 'substep', substep: 's3_arrive', move: 'start' }]); f2(3000, false);
  check('a finished unit still debouncing at S2 is claimed by S3 (#001), once', o3.find(e => e.action === 'start').no === '#001' && b.state().queueFrom === 0 && a.state().queue === 0);
  const r2 = rig(); r2.run(500, false); r2.arrive().run(125, false);
  check('the number is given when the unit arrives, before any step', r2.starts().length === 1 && r2.starts()[0].no === '#001');
  const bad = JSON.parse(JSON.stringify(SHIPPED)); bad.stations.find(x => x.id === 's3').unitTracker.from = 's9';
  check('a from that names no station is reported', LE.checkConfig(bad).some(m => /from "s9"/.test(m)));
  const evs = out.s2.concat(out.s3).concat([{ type: 'session_start', t: 0 }]);
  const csv = LE.trackedUnitsCsv(evs, SHIPPED, { id: 'x', crew: 'A', shift: 'Day' }).trim().split('\n');
  check('the per-unit export has one row per unit with S2 and S3 columns', /s2_arrive_ts/.test(csv[0]) && /s3_end_ts/.test(csv[0]) && /#001,1,0,/.test(csv[1]) && csv.some(l => /\?01/.test(l)), csv.slice(0, 3).join(' / '));
  check('every row has the same number of cells as the header', csv.every(l => l.split(',').length === csv[0].split(',').length));
}

console.log('unit tracker: newUnitNeedsEmpty (a finished unit\'s own wires do not start a new unit)');
{
  check('the shipped S2 and S3 set newUnitNeedsEmpty', S2.unitTracker.newUnitNeedsEmpty === true && SHIPPED.stations.find(x => x.id === 's3').unitTracker.newUnitNeedsEmpty === true);
  const r = rig(); r.run(500, false);
  normalUnit(r);
  r.run(300, true).arrive().run(500, true).step('s2_open').run(500, true).arrive().run(1000, true);   // the finished unit's wires fire the arrival again, twice
  check('still one unit, still complete, no new start', r.starts().length === 1 && r.ends().length === 0 && r.ut.state().phase === 'complete' && r.ut.state().no === '#001', JSON.stringify(r.ut.state().phase));
  check('the arrival inside the finished unit is not logged as a step of it', r.ut.state().current.steps.filter(x => x.id === 's2_arrive').length === 1);
  r.run(1000, false);
  check('a hand over the table keeps the unit from having left', r.ut.state().phase === 'complete'); r.run(500, false, true).run(1500, false, true);
  check('with a hand still in view it has not left', r.ends().length === 0);
  r.run(3000, false);
  check('it leaves after departMs of nothing in view, as departed', r.ends().length === 1 && r.ends()[0].ended === 'departed' && r.ends()[0].result === 'complete');
  r.run(500, true).arrive().run(500, true);
  check('the next arrival after it left is #002', r.starts().length === 2 && r.ut.state().no === '#002');
  const off = rig({ newUnitNeedsEmpty: false }); off.run(500, false); normalUnit(off); off.run(300, true).arrive().run(500, true);
  check('switched off, the old behavior holds (new_unit)', off.ends().length === 1 && off.ends()[0].ended === 'new_unit');
  const bad = JSON.parse(JSON.stringify(SHIPPED)); bad.stations.find(x => x.id === 's2').unitTracker.newUnitNeedsEmpty = 'yes';
  check('a bad newUnitNeedsEmpty is reported', LE.checkConfig(bad).some(m => /newUnitNeedsEmpty/.test(m)));
}

console.log('unit tracker: synthetic S2 to S3 run, two units, wires still in view when the arrival re-fires');
{
  const S3 = SHIPPED.stations.find(x => x.id === 's3');
  const link = LE.createUnitLink(SHIPPED), u2 = LE.createUnitTracker(S2, { link }), u3 = LE.createUnitTracker(S3, { link });
  let t = 0; const out = { s2: [], s3: [] };
  const fr = (id, ms, present, evs) => { const ut = id === 's2' ? u2 : u3; for (let k = 0; k < Math.round(ms / 125); k++) { t += 125; out[id].push(...ut.update({ t, present, hand: false, events: k === 0 && evs ? evs.map(e => Object.assign({ station: id, t, source: 'model' }, e)) : [] })); } };
  const ev2 = (substep, extra) => [Object.assign({ type: 'substep', substep, move: 'next' }, {})].concat(extra || []);
  const s2unit = () => { fr('s2', 1000, true, [{ type: 'substep', substep: 's2_arrive', move: 'start' }]); fr('s2', 1000, true, ev2('s2_close', [{ type: 'cycle_end' }])); fr('s2', 500, true, [{ type: 'substep', substep: 's2_arrive', move: 'start' }]); fr('s2', 500, true); fr('s2', 2500, false); };
  fr('s2', 500, false); fr('s3', 500, false);
  s2unit(); s2unit();
  const st = out.s2.filter(e => e.action === 'start'), en = out.s2.filter(e => e.action === 'end');
  check('S2: two units #001 and #002, both complete, both departed (no extra unit from the re-fired arrival)', st.length === 2 && en.length === 2 && en.every(e => e.ended === 'departed' && e.result === 'complete'), JSON.stringify(en.map(e => [e.no, e.ended])));
  const s3unit = (g) => { fr('s3', 1000, true, [{ type: 'substep', substep: 's3_arrive', move: 'start' }]); fr('s3', 1000, true, [{ type: 'substep', substep: 's3_insert', move: 'next' }, { type: 'cycle_end' }]); fr('s3', 500, true, [{ type: 'substep', substep: 's3_arrive', move: 'start' }]); fr('s3', 2500, false); };
  s3unit(); s3unit();
  const s3s = out.s3.filter(e => e.action === 'start'), s3e = out.s3.filter(e => e.action === 'end');
  check('S3 gets #001 then #002, the same numbers, linked', s3s.length === 2 && s3s[0].no === '#001' && s3s[1].no === '#002' && s3s.every(e => e.from === 's2' && !e.unlinked), JSON.stringify(s3s.map(e => e.no)));
  check('S3 ends both complete', s3e.length === 2 && s3e.every(e => e.result === 'complete'));
  s3unit();
  const s3n = out.s3.filter(e => e.action === 'start');
  check('a third S3 arrival with nothing queued stays unlinked (?01)', s3n.length === 3 && s3n[2].no === '?01' && s3n[2].unlinked && s3n[2].unit === null, JSON.stringify(s3n[2]));
}

console.log('\nunit tracker: step engine gated while a finished unit is still in view');
{
  const ut = LE.createUnitTracker(S2);
  const calls = { update: 0, idle: 0 };
  // A stand-in step engine whose wires keep re-firing substeps and, on 'close', a cycle_end; it counts how it is driven.
  let script = [];
  const eng = { update(sig, t) { calls.update++; return script.map(e => Object.assign({ station: 's2', t, source: 'model' }, e)); }, idle() { calls.idle++; } };
  let t = 0; const all = [];
  const fr = (ms, present, evs) => { for (let i = 0; i < Math.round(ms / 125); i++) { t += 125; script = i === 0 && evs ? evs : []; const r = LE.stepStation(eng, ut, {}, t); all.push(...r.events); ut.update({ t, present, hand: false, events: r.events }); } };
  fr(1000, false);
  fr(1000, true, [{ type: 'substep', substep: 's2_arrive', move: 'start' }]);
  fr(1000, true, [{ type: 'substep', substep: 's2_open', move: 'next' }]);
  fr(500, true, [{ type: 'substep', substep: 's2_close', move: 'next' }, { type: 'cycle_end', cycle: 1 }]);
  check('complete after the first cycle_end', ut.state().phase === 'complete' && ut.holding());
  const u0 = calls.update, n0 = all.length;
  fr(2000, true, [{ type: 'substep', substep: 's2_arrive', move: 'start' }, { type: 'verdict', kind: 'mistake' }, { type: 'cycle_end', cycle: 2 }]);
  check('while held: the engine is not updated, no events, no second cycle_end, no mistake', calls.update === u0 && all.length === n0 && ut.state().mistakes === undefined && ut.state().current.mistakes === 0 && ut.state().completed === 1);
  fr(1000, true, [{ type: 'substep', substep: 's2_arrive', move: 'start' }]);
  check('re-fired arrival while held does not start a unit', ut.state().counted === 1 && ut.state().phase === 'complete');
  fr(2500, false);
  check('unit departs after departMs, tracker no longer holds', ut.state().phase === 'waiting' && !ut.holding() && ut.state().units.length === 1);
  const u1 = calls.update;
  fr(1000, true, [{ type: 'substep', substep: 's2_arrive', move: 'start' }]);
  fr(500, true, [{ type: 'substep', substep: 's2_close', move: 'next' }, { type: 'cycle_end', cycle: 1 }]);
  check('after departure the next unit runs normally: engine updated, #002 complete', calls.update > u1 && ut.state().no === '#002' && ut.state().phase === 'complete' && all.filter(e => e.type === 'cycle_end').length === 2);
  check('stepStation without a tracker just updates the engine', LE.stepStation(eng, null, {}, 1).held === false);
}

console.log('\nline units: one row per unit across S2 and S3');
{
  const S3 = SHIPPED.stations.find(x => x.id === 's3');
  const T0 = 1000000, at = sec => T0 + sec * 1000;
  const st = (station, sec, no, unit, extra) => Object.assign({ type: 'unit', station, action: 'start', t: at(sec), unit, no, videoT: sec, videoFile: station + '.mp4' }, extra || {});
  const en = (station, from, to, no, unit, extra) => Object.assign({ type: 'unit', station, action: 'end', t: at(to), start: at(from), end: at(to), unit, no, result: 'complete', needsReview: false, ended: 'departed', unlinked: false }, extra || {});
  const vd = (station, sec, kind, message) => ({ type: 'verdict', station, t: at(sec), kind, message, videoT: sec, videoFile: station + '.mp4' });
  const CFG2 = { stations: [S2, S3] };
  const byNo = rows => Object.fromEntries(rows.map(r => [r.no, r]));
  // 1: overlap. #001 done at S2 (0-20), at S3 from 30 (open); #002 at S2 from 25 (open).
  let ev = [st('s2', 0, '#001', 1), en('s2', 0, 20, '#001', 1), st('s3', 30, '#001', 1, { from: 's2' }), st('s2', 25, '#002', 2)];
  let rows = LE.lineUnits(ev, CFG2, { now: at(40) }), r = byNo(rows);
  check('lineUnits: #001 at S3 while #002 is at S2, two rows', rows.length === 2 && r['#001'].stage === 's3' && r['#002'].stage === 's2', JSON.stringify(rows.map(x => x.stage)));
  check('lineUnits: seconds in stage at now, and per-station seconds', r['#001'].stageSec === 10 && r['#001'].s2Sec === 20 && r['#001'].waitSec === 10 && r['#001'].s3Sec === 10 && r['#001'].totalSec === 40 && r['#002'].stageSec === 15 && r['#002'].s2Sec === 15 && r['#002'].s3Sec === null && r['#002'].waitSec === null, JSON.stringify([r['#001'], r['#002']]));
  check('lineUnits: video file and start time per station, null where the station has none', r['#001'].s2.videoFile === 's2.mp4' && r['#001'].s2.videoT === 0 && r['#001'].s3.videoT === 30 && r['#002'].s3 === null);
  check('lineUnits: in-line units sort oldest first', rows[0].no === '#001');
  ev.push(en('s3', 30, 45, '#001', 1, { from: 's2' }));
  rows = LE.lineUnits(ev, CFG2, { now: at(50) }); r = byNo(rows);
  check('lineUnits: S3 completes it, #001 done with a total and result complete, listed after in-line #002', r['#001'].stage === 'done' && r['#001'].result === 'complete' && r['#001'].totalSec === 45 && r['#001'].stageSec === null && rows[0].no === '#002' && rows[1].no === '#001');
  // 2: S2 hands over two units before S3 takes one: both waiting, oldest claimed first.
  ev = [st('s2', 0, '#001', 1), en('s2', 0, 10, '#001', 1), st('s2', 15, '#002', 2), en('s2', 15, 25, '#002', 2)];
  rows = LE.lineUnits(ev, CFG2, { now: at(40) }); r = byNo(rows);
  check('lineUnits: two units handed over, both waiting_s3 with wait seconds from when each left S2', rows.length === 2 && rows.every(x => x.stage === 'waiting_s3') && r['#001'].stageSec === 30 && r['#002'].stageSec === 15 && r['#001'].waitSec === 30 && rows[0].no === '#001');
  const link = LE.createUnitLink(CFG2), a = LE.createUnitTracker(S2, { link }), b = LE.createUnitTracker(S3, { link });
  let t = 0; const evs = [];
  const fr = (ut, ms, present, es) => { for (let k = 0; k < Math.round(ms / 125); k++) { t += 125; evs.push(...ut.update({ t, present, hand: false, events: k === 0 && es ? es.map(e => Object.assign({ station: ut === a ? 's2' : 's3', t, source: 'model' }, e)) : [] })); } };
  const s2u = () => { fr(a, 1000, true, [{ type: 'substep', substep: 's2_arrive', move: 'start' }]); fr(a, 1000, true, [{ type: 'substep', substep: 's2_close', move: 'next' }, { type: 'cycle_end' }]); fr(a, 3000, false); };
  fr(a, 500, false); fr(b, 500, false); s2u(); s2u();
  fr(b, 1000, true, [{ type: 'substep', substep: 's3_arrive', move: 'start' }]);
  rows = LE.lineUnits(evs, CFG2, { now: t }); r = byNo(rows);
  check('lineUnits: with real trackers S3 claims #001 first, #002 still waiting_s3', r['#001'].stage === 's3' && r['#002'].stage === 'waiting_s3' && r['#001'].s3.station === 's3', JSON.stringify(rows.map(x => x.no + ':' + x.stage)));
  // 3: unlinked ?01 at S3.
  ev = [st('s3', 5, '?01', null, { from: 's2', unlinked: true }), en('s3', 5, 15, '?01', null, { from: 's2', unlinked: true, needsReview: true }), st('s2', 20, '#001', 1)];
  rows = LE.lineUnits(ev, CFG2, { now: at(30) }); r = byNo(rows);
  check('lineUnits: unlinked ?01 at S3 needs review and sorts before the in-line unit', rows[0].no === '?01' && r['?01'].stage === 'needs_review' && r['?01'].needsReview && r['?01'].unit === null && r['?01'].s2 === null && r['#001'].stage === 's2', JSON.stringify(rows.map(x => x.no + ':' + x.stage)));
  // 4: stopped mid-cycle.
  ev = [st('s2', 0, '#001', 1), en('s2', 0, 8, '#001', 1, { result: 'incomplete', needsReview: true, ended: 'session_stopped' }), st('s2', 20, '#002', 2), en('s2', 20, 30, '#002', 2)];
  rows = LE.lineUnits(ev, CFG2, { now: at(40) }); r = byNo(rows);
  check('lineUnits: a unit stopped mid-cycle is needs_review with result incomplete, ahead of the waiting one', rows[0].no === '#001' && r['#001'].stage === 'needs_review' && r['#001'].result === 'incomplete' && r['#002'].stage === 'waiting_s3');
  // 5: messages land on the right unit, by station and window.
  ev = [st('s2', 0, '#001', 1), vd('s2', 4, 'mistake', 'Red wire is missing'), en('s2', 0, 10, '#001', 1), st('s2', 12, '#002', 2), vd('s2', 14, 'review', 'Looks done but not sure'), vd('s3', 14, 'mistake', 'S3 other unit'),
    en('s2', 12, 20, '#002', 2), st('s3', 22, '#001', 1, { from: 's2' }), vd('s3', 24, 'mistake', 'Connector is turned'), vd('s2', 25, 'mistake', 'S2 between units'), en('s3', 22, 30, '#001', 1, { from: 's2' })];
  rows = LE.lineUnits(ev, CFG2, { now: at(40) }); r = byNo(rows);
  const msgs = x => x.map(m => m.message).join('|');
  check('lineUnits: mistakes by station and window', msgs(r['#001'].mistakes.s2) === 'Red wire is missing' && msgs(r['#001'].mistakes.s3) === 'Connector is turned' && msgs(r['#002'].mistakes.s2) === 'Looks done but not sure' && r['#002'].mistakes.s3.length === 0, JSON.stringify([r['#001'].mistakes, r['#002'].mistakes]));
  check('lineUnits: counts on the station and a message carries its video time', r['#001'].s2.mistakes === 1 && r['#002'].s2.mistakes === 0 && r['#002'].s2.reviews === 1 && r['#001'].mistakes.s2[0].videoT === 4);
  rows = LE.lineUnits([st('s2', 0, '#001', 1), en('s2', 0, 10, '#001', 1)], { stations: [S2] }, { now: at(12) });
  check('lineUnits: with no S3 station a unit that left S2 is waiting_s3, never done', rows.length === 1 && rows[0].stage === 'waiting_s3' && rows[0].stageSec === 2);
  check('lineUnits: no tracked events gives no rows', LE.lineUnits([], CFG2, { now: 0 }).length === 0);
  // C2: steps per station and the verdict code.
  const sb = (station, sec, substep, move) => ({ type: 'substep', station, t: at(sec), substep, move: move || 'next' });
  const vdc = (station, sec, kind, message, reason) => Object.assign(vd(station, sec, kind, message), { reason });
  ev = [st('s2', 0, '#001', 1), sb('s2', 1, 's2_arrive', 'start'), sb('s2', 4, 's2_open'), sb('s2', 5, 's2_open', 'repeat'), vdc('s2', 6, 'mistake', 'Wrong order: Close before Open', 'wrong_order'), sb('s2', 9, 's2_close'), en('s2', 0, 10, '#001', 1), sb('s2', 12, 's2_arrive', 'start')];
  rows = LE.lineUnits(ev, CFG2, { now: at(20) }); r = byNo(rows);
  const stp = r['#001'].s2.steps;
  check('lineUnits steps: key, label, start, end and seconds per step, repeats left out, the last step runs to the window end', stp.length === 3 && stp[0].key === 's2_arrive' && stp[0].start === at(1) && stp[0].end === at(4) && stp[0].sec === 3 && stp[1].key === 's2_open' && stp[1].sec === 5 && stp[2].key === 's2_close' && stp[2].end === at(10) && stp[2].sec === 1 && typeof stp[0].label === 'string' && stp[0].label.length > 0, JSON.stringify(stp));
  check('lineUnits steps: events outside the unit window are not its steps; no S3 gives null', LE.lineUnits(ev, CFG2, { now: at(20) }).length === 1 && r['#001'].s3 === null);
  check('lineUnits code: the verdict reason on the message, null when the verdict has none', r['#001'].mistakes.s2[0].code === 'wrong_order' && LE.lineUnits([st('s2', 0, '#001', 1), vd('s2', 2, 'mistake', 'x'), en('s2', 0, 10, '#001', 1)], CFG2, { now: at(20) })[0].mistakes.s2[0].code === null);

  // C1: lineUnitStats. Four units done (S2 20 s, 40 s, 20 s, 40 s -> avg 30; S3 10 s each), one at S2 stuck, one waiting, one at S3, one to review.
  const E = [];
  let k = 0;
  const unit = (n, s2a, s2b, s3a, s3b, extra) => { const no = '#00' + n; E.push(st('s2', s2a, no, n), en('s2', s2a, s2b, no, n, extra && extra.s2)); if (s3a != null) { E.push(st('s3', s3a, no, n, { from: 's2' })); if (s3b != null) E.push(en('s3', s3a, s3b, no, n, Object.assign({ from: 's2' }, extra && extra.s3))); } };
  unit(1, 0, 20, 20, 30); unit(2, 20, 60, 60, 70); unit(3, 70, 90, 90, 100); unit(4, 100, 140, 140, 150);
  E.push(vdc('s2', 105, 'mistake', 'Red wire is missing', 'missing_step'));
  unit(5, 150, 160, 160, null);       // at S3 open
  unit(6, 160, 170, null, null);      // waiting_s3
  E.push(st('s2', 175, '#007', 7));   // at S2 open
  let rs = LE.lineUnits(E, CFG2, { now: at(200) }), sx = LE.lineUnitStats(rs, { now: at(200), runStart: at(0) });
  check('stats: done and in progress by stage', sx.done === 4 && sx.inProgress.s2 === 1 && sx.inProgress.waiting_s3 === 1 && sx.inProgress.s3 === 1 && sx.inProgress.needs_review === 0 && sx.inProgress.total === 3, JSON.stringify(sx.inProgress));
  check('stats: avg unit time (S2 start to S3 done), station averages with n, bottleneck is the slower', sx.avgUnitSec === 40 && sx.stations.s2.n === 6 && sx.stations.s3.n === 4 && sx.stations.s3.avgSec === 10 && sx.stations.s2.avgSec === 23.3 && sx.bottleneck === 's2', JSON.stringify(sx));
  check('stats: units per hour is done per hour since runStart (4 in 200 s = 72), null before 60 s', sx.unitsPerHour === 72 && LE.lineUnitStats(rs, { now: at(30), runStart: at(0) }).unitsPerHour === null && LE.lineUnitStats(rs, { now: at(200) }).unitsPerHour === null);
  check('stats: right first time counts done units with no mistake or review (3 of 4 = 75)', sx.rightFirstTime.n === 3 && sx.rightFirstTime.of === 4 && sx.rightFirstTime.pct === 75, JSON.stringify(sx.rightFirstTime));
  check('stats: stuck alert only for the over-twice unit: #005 at S3 40 s vs average 10 s; #007 at S2 25 s vs 23.3 s is not', sx.alerts.length === 1 && sx.alerts[0].kind === 'stuck' && sx.alerts[0].unit === 5 && sx.alerts[0].no === '#005' && sx.alerts[0].station === 's3' && sx.alerts[0].stage === 's3' && sx.alerts[0].sec === 40 && sx.alerts[0].message === 'Unit #005 stuck at S3 for 40 s, average 10 s', JSON.stringify(sx.alerts));
  const emptyS = LE.lineUnitStats([], { now: at(100), runStart: at(0) });
  check('stats: empty rows give zeros and nulls', emptyS.done === 0 && emptyS.avgUnitSec === null && emptyS.bottleneck === null && emptyS.rightFirstTime.pct === null && emptyS.rightFirstTime.of === 0 && emptyS.alerts.length === 0 && emptyS.stations.s2.n === 0 && emptyS.unitsPerHour === 0);
  // Stuck: twice the average, and the review and wrong-order alerts come first.
  const E2 = [];
  const u2 = (n, a, b) => E2.push(st('s2', a, '#00' + n, n), en('s2', a, b, '#00' + n, n));
  u2(1, 0, 40); u2(2, 40, 80); u2(3, 80, 120);   // s2 avg 40 n 3
  E2.push(st('s2', 120, '#004', 4));              // open at S2
  let r2 = LE.lineUnitStats(LE.lineUnits(E2, CFG2, { now: at(210) }), { now: at(210), runStart: at(0) });
  check('stats stuck: more than twice the average at S2 (#004 at 90 s, avg 40 s) alerts, exactly 2x (80 s) does not', r2.alerts.some(a => a.unit === 4 && a.kind === 'stuck' && a.sec === 90 && a.message === 'Unit #004 stuck at S2 for 90 s, average 40 s') && LE.lineUnitStats(LE.lineUnits(E2, CFG2, { now: at(200) }), { now: at(200) }).alerts.length === 0, JSON.stringify(r2.alerts));
  check('stats stuck: not before 3 finished units', LE.lineUnitStats(LE.lineUnits(E2.slice(0, 6), CFG2, { now: at(500) }), { now: at(500) }).alerts.length === 0);
  const E3 = E2.concat([vdc('s2', 125, 'mistake', 'Wrong order: Close before Open', 'wrong_order'), st('s3', 140, '?01', null, { from: 's2', unlinked: true }), en('s3', 140, 150, '?01', null, { from: 's2', unlinked: true, needsReview: true })]);
  r2 = LE.lineUnitStats(LE.lineUnits(E3, CFG2, { now: at(210) }), { now: at(210), runStart: at(0) });
  check('stats alerts: problems first (review, wrong order, then stuck), each with the full shape', r2.alerts.map(a => a.kind).join() === 'review,wrong_order,stuck' && r2.alerts[0].no === '?01' && r2.alerts[0].message === 'Unit ?01 needs review at S3' && r2.alerts[1].unit === 4 && r2.alerts[1].sec === 85 && /Wrong order/.test(r2.alerts[1].message) && ['kind', 'unit', 'no', 'station', 'stage', 'sec', 'message'].every(f => f in r2.alerts[0]) && r2.inProgress.needs_review === 1, JSON.stringify(r2.alerts));

  // C3: unitPhotos.
  const cap = (t, o) => Object.assign({ t: at(t), station: 's2', path: 'p' + t }, o || {});
  const prow = LE.lineUnits([st('s2', 0, '#001', 1), en('s2', 0, 20, '#001', 1), st('s3', 30, '#001', 1, { from: 's2' }), en('s3', 30, 40, '#001', 1, { from: 's2' }), st('s2', 50, '#002', 2)], CFG2, { now: at(60) }).find(x => x.unit === 1);
  const ph = LE.unitPhotos(prow, [cap(35, { station: 's3' }), cap(5), cap(10, { unit: 2 }), cap(25), cap(15, { unit: 1 }), cap(32, { station: 's3', unit: 2 }), cap(55)]);
  check('unitPhotos: stamped by unit, unstamped by station and window, in time order', ph.map(c => c.path).join() === 'p5,p15,p35', ph.map(c => c.path).join());
  check('unitPhotos: an open window runs on (inclusive of now), a closed one is half-open [start, end), no row or no captures gives none', LE.unitPhotos(prow, [cap(50, { station: 's2' }), cap(60, { station: 's2' }), cap(61, { station: 's2' })]).length === 0 && LE.unitPhotos(LE.lineUnits([st('s2', 50, '#002', 2)], CFG2, { now: at(60) })[0], [cap(50), cap(60), cap(61)]).map(c => c.path).join() === 'p50,p60' && LE.unitPhotos(prow, [cap(20, { station: 's2' })]).length === 0 && LE.unitPhotos(prow, [cap(40, { station: 's3' })]).length === 0, 'J1 3 / C1 4 / J1 nit 5');
  // Z3 fixes. Findings: W1 1, C1 3, J1 1, C1 4, C1 6, W1 nit 4.
  {
    const sbz = (station, sec, substep, move) => ({ type: 'substep', station, t: at(sec), substep, move: move || 'next' });
    const vz = (station, sec, kind, message, reason) => Object.assign(vd(station, sec, kind, message), { reason });
    // W1 1: consecutive events of one step key are one step.
    let zr = LE.lineUnits([st('s2', 0, '#001', 1), sbz('s2', 1, 's2_arrive', 'start'), sbz('s2', 4, 's2_open'), sbz('s2', 6, 's2_open'), sbz('s2', 8, 's2_open'), sbz('s2', 9, 's2_close'), sbz('s2', 11, 's2_open'), en('s2', 0, 12, '#001', 1)], CFG2, { now: at(20) })[0].s2.steps;
    check('W1 1: consecutive same-key substep events make one step (start of the first, end of the last); a later return is its own step', zr.map(x => x.key).join() === 's2_arrive,s2_open,s2_close,s2_open' && zr[1].start === at(4) && zr[1].end === at(9) && zr[1].sec === 5 && zr[3].end === at(12), JSON.stringify(zr.map(x => [x.key, x.sec])));
    // C1 3: a review message with reason wrong_order is no wrong_order alert; a mistake is.
    const zE = [st('s2', 0, '#001', 1), vz('s2', 2, 'review', 'Not sure', 'wrong_order'), vz('s2', 3, 'mistake', 'Wrong order: A before B', 'wrong_order')];
    let za = LE.lineUnitStats(LE.lineUnits(zE, CFG2, { now: at(10) }), { now: at(10) }).alerts;
    check('C1 3: only a mistake verdict makes a wrong_order alert, a review with reason wrong_order does not', za.length === 1 && za[0].kind === 'wrong_order' && /Wrong order: A before B/.test(za[0].message), JSON.stringify(za));
    // J1 1: a done unit has no wrong_order alert, its mistake stays on the row.
    const zD = [st('s2', 0, '#001', 1), vz('s2', 2, 'mistake', 'Wrong order: A before B', 'wrong_order'), en('s2', 0, 10, '#001', 1), st('s3', 11, '#001', 1, { from: 's2' }), en('s3', 11, 20, '#001', 1, { from: 's2' })];
    const zRows = LE.lineUnits(zD, CFG2, { now: at(500) });
    check('J1 1: a done unit gets no wrong_order alert, its mistake stays on the row', zRows[0].stage === 'done' && LE.lineUnitStats(zRows, { now: at(500) }).alerts.length === 0 && zRows[0].mistakes.s2.length === 1 && zRows[0].s2.mistakes === 1);
    // C1 4: the next unit's arrival step belongs to the next unit only.
    const zH = [st('s2', 0, '#001', 1), sbz('s2', 1, 's2_arrive', 'start'), en('s2', 0, 10, '#001', 1), st('s2', 10, '#002', 2), sbz('s2', 10, 's2_arrive', 'start'), vz('s2', 10, 'mistake', 'x')];
    const hr = LE.lineUnits(zH, CFG2, { now: at(15) }), h1 = hr.find(x => x.unit === 1), h2 = hr.find(x => x.unit === 2);
    check('C1 4: a closed window is [start, end): the step and the verdict at the shared instant belong to the next unit', h1.s2.steps.length === 1 && h1.s2.steps[0].start === at(1) && h2.s2.steps.length === 1 && h2.s2.steps[0].start === at(10) && h1.s2.messages.length === 0 && h2.s2.messages.length === 1);
    // C1 6: stuck compares with the unrounded mean. s2 times 10, 10, 11 -> mean 10.333, shown 10.3; 2x = 20.67; stage 20.65 is not stuck (a rounded 10.3 would say stuck), 20.8 is.
    const zS = [st('s2', 0, '#001', 1), en('s2', 0, 10, '#001', 1), st('s2', 10, '#002', 2), en('s2', 10, 20, '#002', 2), st('s2', 20, '#003', 3), en('s2', 20, 31, '#003', 3), st('s2', 31, '#004', 4)];
    const sa = LE.lineUnitStats(LE.lineUnits(zS, CFG2, { now: at(51.65) }), { now: at(51.65) }), sb2 = LE.lineUnitStats(LE.lineUnits(zS, CFG2, { now: at(51.8) }), { now: at(51.8) });
    check('C1 6: stuck uses the unrounded average, only the shown avgSec is rounded', sa.stations.s2.avgSec === 10.3 && sa.alerts.length === 0 && sb2.alerts.length === 1 && sb2.alerts[0].kind === 'stuck', JSON.stringify([sa.alerts, sb2.alerts]));
    // W1 nit 4: alerts name the unit as the table does.
    check('W1 nit 4: alert messages use the table label (#001), not Unit 1', za[0].message.startsWith('Unit #001 at S2') && !/Unit 1\b/.test(za[0].message));
  }
  check('unitPhotos: no row or no captures gives none', LE.unitPhotos(null, [cap(1)]).length === 0 && LE.unitPhotos(prow, []).length === 0 && LE.unitPhotos(prow, undefined).length === 0);

  // C6: tracked-units.csv video columns.
  const tcsv = LE.trackedUnitsCsv([st('s2', 0, '#001', 1), en('s2', 0, 10, '#001', 1), st('s3', 20, '#001', 1, { from: 's2' }), en('s3', 20, 30, '#001', 1, { from: 's2' }), st('s2', 40, '#002', 2)], CFG2, { id: 'x', crew: 'A', shift: 'Day' }).trim().split('\n');
  const hdr = tcsv[0].split(','), c1 = tcsv[1].split(','), c2 = tcsv[2].split(',');
  check('tracked-units: header gains <id>_video_file and <id>_video_t, units carry file and start time (open unit too)', hdr.includes('s2_video_file') && hdr.includes('s2_video_t') && hdr.includes('s3_video_file') && hdr.includes('s3_video_t') && c1[hdr.indexOf('s2_video_file')] === 's2.mp4' && c1[hdr.indexOf('s2_video_t')] === '0' && c1[hdr.indexOf('s3_video_file')] === 's3.mp4' && c1[hdr.indexOf('s3_video_t')] === '20' && c2[hdr.indexOf('s2_video_file')] === 's2.mp4' && c2[hdr.indexOf('s2_video_t')] === '40' && c2.length === hdr.length, tcsv.join(' / '));
  // after-stop S2 (C1 codex should): a unit flagged before Stop is Incomplete after Stop, and strip WIP (review alerts only at needs_review) sums to inProgress.total (0).
  {
    const evs = [st('s2', 0, '#001', 1), en('s2', 0, 8, '#001', 1, { result: 'incomplete', needsReview: true })], now = at(30);
    const rs = LE.lineUnits(evs, CFG2, { now, stopped: true }), ss = LE.lineUnitStats(rs, { now, runStart: at(0) }), ip = ss.inProgress;
    const rv = ss.alerts.filter(al => al.kind === 'review' && al.stage === 'needs_review').length;
    check('C1 codex should: after Stop a unit flagged before Stop leaves strip WIP (sum equals inProgress.total, 0)', rs[0].stage === 'incomplete' && ss.incomplete === 1 && ip.total === 0 && ip.s2 + ip.waiting_s3 + ip.s3 + rv === ip.total, JSON.stringify([rs[0].stage, ss.incomplete, ip, ss.alerts]));
    // W1 walk mix after Stop: #001 done at S3, #002 at S3, #003 waiting for S3, #004 at S2, ?01 unlinked at S3 flagged. Strip: S2 WIP, queue, S3 WIP all 0, S3 done 1.
    {
      const e2 = [st('s2', 0, '#001', 1), en('s2', 0, 10, '#001', 1), st('s3', 12, '#001', 1), en('s3', 12, 20, '#001', 1),
        st('s2', 21, '#002', 2), en('s2', 21, 30, '#002', 2), st('s3', 32, '#002', 2),
        st('s2', 33, '#003', 3), en('s2', 33, 40, '#003', 3),
        st('s2', 42, '#004', 4),
        st('s3', 44, '?01', null, { unlinked: true, needsReview: true })];
      const r2 = LE.lineUnits(e2, CFG2, { now: at(60), stopped: true }), s4 = LE.lineUnitStats(r2, { now: at(60), runStart: at(0) }), ip4 = s4.inProgress;
      const rv4 = { s2: 0, s3: 0 }; for (const al of s4.alerts) if (al.kind === 'review' && al.stage === 'needs_review') rv4[al.station === 's3' ? 's3' : 's2']++;
      // W2 walk: ?01 unlinked, S3 finished it complete: after Stop it stays needs_review with an alert, so the strip must zero WIP on the stopped snapshot.
      {
        const e3 = [st('s2', 0, '#001', 1), en('s2', 0, 10, '#001', 1), st('s3', 12, '#001', 1), en('s3', 12, 20, '#001', 1),
          st('s3', 30, '?01', null, { unlinked: true, needsReview: true }), en('s3', 30, 40, '?01', null, { unlinked: true, needsReview: true })];
        const r3 = LE.lineUnits(e3, CFG2, { now: at(60), stopped: true }), s5 = LE.lineUnitStats(r3, { now: at(60), runStart: at(0) });
        const html3 = fs.readFileSync(new URL('../app/line.html', import.meta.url), 'utf8'), sb3 = html3.slice(html3.indexOf('function stripBoard'), html3.indexOf('function stripBoard') + 1400);
        check('W2 walk: stopped snapshot with an unlinked S3-complete unit: S3 done counts only stage done, strip WIP all 0', s5.done === 1 && r3.some(r => r.stage === 'needs_review') && s5.alerts.some(al => al.kind === 'review') && /stp \? 0 : ip\.s2 \+ rv\.s2/.test(sb3) && /out\.queue = stp \? 0/.test(sb3) && /out\.wip\[c\] = stp \? 0/.test(sb3), JSON.stringify([s5.done, r3.map(r => r.no + ':' + r.stage), s5.alerts]));
      }
      check('W1 walk: after Stop the strip WIP at S2, the queue and WIP at S3 are 0 and S3 done is 1', s4.done === 1 && ip4.total === 0 && ip4.s2 + rv4.s2 === 0 && ip4.waiting_s3 === 0 && ip4.s3 + rv4.s3 === 0, JSON.stringify([s4.done, ip4, s4.alerts, r2.map(r => r.no + ':' + r.stage)]));
    }
    check('C1 codex should: line.html adds only needs_review alerts to station WIP', /al\.kind === 'review' && al\.stage === 'needs_review'\) \{ const k = /.test(fs.readFileSync(new URL('../app/line.html', import.meta.url), 'utf8')));
  }
}

// C2 Q2 (unit-board S4): after Stop the flow strip shows the stopped run's summary, the same run the frozen board shows.
{
  const html = fs.readFileSync(new URL('../app/line.html', import.meta.url), 'utf8');
  const stop = html.split('\n').find(l => l.includes('G.lastBoard = {') && l.includes('sid: sess.id')) || '';
  const rd = html.slice(html.indexOf('function render() {'), html.indexOf('setInterval(render, 250)'));
  check('C2 Q2: Stop keeps the run summary in the snapshot beside the board rows', /rows: LE\.lineUnits\(/.test(stop) && /summary: LE\.summarize\(G\.events/.test(stop), stop.trim().slice(0, 120));
  check('C2 Q2: render() uses the kept summary while there is no session, else summarizes live', /G\.summary = \(!G\.session && G\.lastBoard && G\.lastBoard\.summary\) \|\| LE\.summarize\(/.test(rd));
  check('C2 Q2: the next Start clears the snapshot', /G\.events = \[\]; G\.queue = \[\]; G\.evSeen = -1; G\.lastBoard = null;/.test(html));
}

// after-stop S1: one count, Incomplete after Stop, and the model-load path.
{
  const html = fs.readFileSync(new URL('../app/line.html', import.meta.url), 'utf8'), mock = fs.readFileSync(new URL('../app/live-mock.html', import.meta.url), 'utf8');
  const ins = fs.readFileSync(new URL('../app/insights.html', import.meta.url), 'utf8'), ur = fs.readFileSync(new URL('../app/unit-record.js', import.meta.url), 'utf8');
  const stop = html.split('\n').find(l => l.includes('G.lastBoard = {') && l.includes('sid: sess.id')) || '';
  const live = html.split('\n').find(l => l.includes('function boardSource') ) ? html.slice(html.indexOf('function boardSource'), html.indexOf('function boardNow')) : '';
  const WP = "ort.env.wasm.wasmPaths = new URL('/vendor/ort/', location.href).href;";
  check('after-stop: wasmPaths is absolute in line.html and live-mock.html', html.includes(WP) && mock.includes(WP) && !/wasmPaths = '\/vendor/.test(html + mock));
  check('after-stop: the Stop snapshot is built with stopped: true and marked stopped', /stopped: true, rows: LE\.lineUnits\(G\.events, G\.config, \{ now: tn, stopped: true \}\)/.test(stop), stop.trim().slice(0, 140));
  check('after-stop: the live board does not pass stopped', /lineUnits\(G\.events, G\.config, \{ now: t \}\)/.test(live) && !/stopped/.test(live.replace('G.lastBoard', '')));
  check('after-stop: BD_STAGE, insights STAGE_LABEL and unit-record STAGE say Incomplete', /BD_STAGE = \{[^}]*incomplete: \['Incomplete', ''\]/.test(html) && /STAGE_LABEL = \{[^}]*incomplete: 'Incomplete'/.test(ins) && /STAGE = \{[^}]*incomplete: 'Incomplete'/.test(ur));
  check('after-stop: insights has a neutral .ub-stage.incomplete style (no red, amber or coral)', /\.ub-stage\.incomplete \{[^}]*panel3/.test(ins) && !/\.ub-stage\.incomplete \{[^}]*(amber|coral|orange|crit)/.test(ins));
  check('after-stop: second tile is Incomplete after Stop (stats.incomplete, plain sub line), else Units in progress', /src\.stopped \? tile\('Incomplete', stats\.incomplete \|\| 0, 'not finished at S3 when the run stopped'\)\s*: tile\('Units in progress', ip\.total/.test(html));
  check('after-stop: a new Start clears the snapshot, so the tile reads Units in progress again', /G\.lastBoard = null;/.test(html) && /if \(!G\.session && G\.lastBoard\) return G\.lastBoard;/.test(html));
  check('after-stop: the strip reads the board stats: S3 done is stats.done, WIP is in progress at each station plus the queue', /out\.done\[c\] = b\.stats\.done/.test(html) && /out\.wip\[a\] = stp \? 0 : ip\.s2 \+ rv\.s2; out\.queue = stp \? 0 : ip\.waiting_s3/.test(html) && /out\.wip\[c\] = stp \? 0 : ip\.s3 \+ rv\.s3/.test(html) && /renderSummary\(G\.summary, t\)/.test(html));
  check('after-stop: tiles and strip share one lineUnitStats call (boardNow)', /const rows = src\.rows, stats = boardNow\(t\)\.stats;/.test(html) && (html.match(/LE\.lineUnitStats\(/g) || []).length === 1);
  // The same arithmetic on engine rows: strip WIP (at S2 + queue + at S3, a review at the station its alert names) equals the tiles' in progress.
  const rows = [
    { no: '#001', unit: 1, stage: 'done', s2: { end: 1, result: 'complete', station: 's2' }, s3: { end: 2, result: 'complete', station: 's3' } },
    { no: '#002', unit: 2, stage: 's2', s2: { end: null, station: 's2' } },
    { no: '#003', unit: 3, stage: 'waiting_s3', s2: { end: 5, result: 'complete', station: 's2' } },
    { no: '#004', unit: 4, stage: 's3', s2: { end: 5, result: 'complete', station: 's2' }, s3: { end: null, station: 's3' } },
    { no: '#005', unit: 5, stage: 'needs_review', needsReview: true, s2: { end: 5, result: 'incomplete', station: 's2' } },
    { no: '?01', unit: 6, stage: 'needs_review', needsReview: true, s3: { end: null, station: 's3', unlinked: true } }
  ];
  for (const r of rows) for (const k of ['s2', 's3']) if (r[k]) { r[k].messages = []; r[k].sec = 5; } 
  const stt = LE.lineUnitStats(rows, { now: 1000, runStart: 0 }), ip = stt.inProgress, rv = { s2: 0, s3: 0 };
  for (const al of stt.alerts) if (al.kind === 'review') rv[al.station === 's3' ? 's3' : 's2']++;
  check('after-stop: strip arithmetic: S3 done equals tiles done (S3 complete only), WIP figures add up to tiles in progress', stt.done === 1 && (ip.s2 + rv.s2) + ip.waiting_s3 + (ip.s3 + rv.s3) === ip.total && ip.total === 5, JSON.stringify([stt.done, ip, rv]));
}

// after-stop-followups S1 (C3): station cards after Stop, run from the page's own function on the real engine's stopped rows.
{
  const S3 = SHIPPED.stations.find(x => x.id === 's3');
  const T0 = 1000000, at = sec => T0 + sec * 1000;
  const st = (station, sec, no, unit, extra) => Object.assign({ type: 'unit', station, action: 'start', t: at(sec), unit, no, videoT: sec, videoFile: station + '.mp4' }, extra || {});
  const en = (station, from, to, no, unit, extra) => Object.assign({ type: 'unit', station, action: 'end', t: at(to), start: at(from), end: at(to), unit, no, result: 'complete', needsReview: false, ended: 'departed', unlinked: false }, extra || {});
  const vd = (station, sec, kind, message) => ({ type: 'verdict', station, t: at(sec), kind, message, videoT: sec, videoFile: station + '.mp4' });
  const CFG2 = { stations: [S2, S3] };
  const html = fs.readFileSync(new URL('../app/line.html', import.meta.url), 'utf8');
  const src = (a, b) => html.slice(html.indexOf(a), html.indexOf(b));
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const code = src('const BD_STAGE', 'function boardStations') + src('function boardCardHtml', 'function renderBoard') + '; return { boardCardHtml, bdClock };';
  const { boardCardHtml, bdClock } = new Function('esc', code)(esc);
  // #001 done at S3, #002 cut off at S3 (S2 left at 30), #003 cut off at S2 (in S2 since 42), #004 left S2 and waits for S3 (cut off at S2)
  const ev = [st('s2', 0, '#001', 1), en('s2', 0, 10, '#001', 1), st('s3', 12, '#001', 1), en('s3', 12, 20, '#001', 1),
    st('s2', 21, '#002', 2), en('s2', 21, 30, '#002', 2), st('s3', 32, '#002', 2), st('s2', 42, '#003', 3)];
  const cards = (rows, stopped) => ['s2', 's3'].map(k => boardCardHtml(k, { id: k, name: k.toUpperCase() }, rows, { stopped, takt: 5 })).join('');
  const rs = LE.lineUnits(ev, CFG2, { now: at(60), stopped: true }), later = LE.lineUnits(ev, CFG2, { now: at(60), stopped: true });
  const html1 = cards(rs, true), c2 = boardCardHtml('s2', null, rs, { stopped: true }), c3 = boardCardHtml('s3', null, rs, { stopped: true });
  check('C3: after Stop no card has "now:", "Waiting for a unit" or a running timer class', !/now:|Waiting for a unit|over/.test(html1), html1.slice(0, 80));
  check('C3: the S3 card holds #002 as Incomplete with its time held at Stop (S3 start 32 to Stop 60 = 0:28)', /#002/.test(c3) && /Incomplete/.test(c3) && c3.includes('>' + bdClock(28) + '<'), c3.slice(0, 200));
  check('C3: the S2 card holds #003 as Incomplete with its time held at Stop (42 to 60 = 0:18)', /#003/.test(c2) && /Incomplete/.test(c2) && c2.includes('>' + bdClock(18) + '<'), c2.slice(0, 200));
  check('C3: the done unit #001 is on no card', !/#001/.test(html1));
  check('C3: the Incomplete label uses the board neutral chip (no warn, crit, good)', /class="chip "/.test(c3) && !/chip (warn|crit|good)/.test(html1));
  check('C3: rendering again at a later clock gives the same card', cards(later, true) === html1);
  const none = boardCardHtml('s3', null, LE.lineUnits([st('s2', 0, '#001', 1)], CFG2, { now: at(20), stopped: true }), { stopped: true });
  check('C3: a card with no unit at Stop says so plainly and is not the live wording', /No unit at this station when the run stopped/.test(none) && !/Waiting for a unit/.test(none), none.slice(0, 160));
  const live = LE.lineUnits(ev, CFG2, { now: at(60) }), lv = cards(live, false), lv2 = cards(LE.lineUnits(ev, CFG2, { now: at(90) }), false);
  check('C3: the live board still shows the unit, "time in stage" and a running time', /time in stage/.test(lv) && /#002/.test(lv) && /#003/.test(lv) && lv !== lv2 && lv.includes('>' + bdClock(28) + '<') && lv2.includes('>' + bdClock(58) + '<'), lv.slice(0, 120));
  check('C3: renderBoard calls boardCardHtml with the snapshot flag', /boardCardHtml\(k, stn, rows, \{ stopped: !!src\.stopped/.test(html));
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
