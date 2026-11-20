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

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
