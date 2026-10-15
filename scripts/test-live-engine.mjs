// Engine tests with synthetic signals. Run: npm run test:live
import fs from 'node:fs';
// The package is ESM, the engine is a plain UMD script: load it with a module shim.
const mod = { exports: {} };
new Function('module', fs.readFileSync(new URL('../app/live-engine.js', import.meta.url), 'utf8'))(mod);
const LE = mod.exports;

const FRAME = 33;
let fails = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log('  pass  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); }
}

// Mutable signal rig: set values, then play them for N ms.
function rig(config) {
  const eng = LE.createEngine(config);
  const cur = {
    pinkStart: { pink: 0.5, blue: 0, motion: 0 },
    blueStart: { pink: 0, blue: 0.4, motion: 0 },
    build: { pink: 0, blue: 0, motion: 0 }
  };
  const snap = () => JSON.parse(JSON.stringify(cur));
  let t = 0;
  const r = {
    eng, cur,
    set(patch) { for (const z of Object.keys(patch)) Object.assign(cur[z], patch[z]); return r; },
    play(ms, patch) { if (patch) r.set(patch); const end = t + ms; while (t < end) { eng.update(snap(), t); t += FRAME; } return r; },
    arm() { eng.arm(snap(), t); return r; },
    get t() { return t; },
    get state() { return eng.getState(); }
  };
  return r;
}

// A clean cycle, in order.
function cleanCycle(r) {
  r.arm().play(500);
  r.play(300, { pinkStart: { motion: 0.4 } });                       // E1
  r.play(300, { pinkStart: { pink: 0.1, motion: 0.3 } });            // E2
  r.set({ pinkStart: { pink: 0.0, motion: 0 } });
  r.play(300, { build: { pink: 0.15, motion: 0.3 } });               // E3
  r.play(300, { blueStart: { motion: 0.4 } });                       // E3b
  r.play(300, { blueStart: { blue: 0.0, motion: 0.3 } });            // E4
  r.set({ blueStart: { motion: 0 } });
  r.play(300, { build: { blue: 0.1, motion: 0.4 } });                // E5
  r.play(600, { build: { motion: 0.6 } });                           // peak
  r.play(300, { build: { motion: 0.1 } });                           // settle
  r.play(900, { build: { motion: 0.01 } });                          // still, E6
  return r;
}

console.log('clean cycle');
{
  const r = cleanCycle(rig());
  const s = r.state;
  check('cycle completes', s.status === 'complete' && s.cycles.length === 1, s.status + ' phase ' + s.phase);
  check('9 substeps done', s.done.length === 9, String(s.done.length));
  check('substeps in order, no gaps', s.done.every((d, i) => d.dur >= 0 && (i === 0 || d.start === s.done[i - 1].end)));
  check('all confidences 60+', s.done.every(d => d.conf != null && d.conf >= 60), JSON.stringify(s.done.map(d => d.conf)));
  check('no flags on a clean cycle', !s.flags.outOfOrder && s.flags.rework === 0 && s.flags.lowConfidence === 0);
  check('orient and seat marked estimated', s.done[6].estimated && s.done[7].estimated);
  check('cycle total is positive', s.cycles[0].totalMs > 2000, String(s.cycles[0].totalMs));
  check('events E1..E6 logged', ['E1', 'E2', 'E3', 'E3b', 'E4', 'E5', 'SETTLE', 'E6'].every(id => s.events.some(e => e.id === id)));
}

console.log('over standard');
{
  const r = cleanCycle(rig({ standardCycleS: 1 }));
  check('over standard flag set', r.state.cycles[0].flags.overStandard === true);
  const r2 = cleanCycle(rig({ standardCycleS: 60 }));
  check('under standard has no flag', r2.state.cycles[0].flags.overStandard === false);
}

console.log('re-arm');
{
  const r = cleanCycle(rig());
  r.set({ build: { pink: 0, blue: 0, motion: 0 }, pinkStart: { pink: 0.5 }, blueStart: { blue: 0.4 } });
  r.play(500);
  check('not re-armed before 1 s of quiet', r.state.status === 'complete');
  r.play(1000);
  check('re-armed once parts are back and build is quiet', r.state.status === 'armed' && r.state.cycles.length === 1);
}

console.log('out of order');
{
  const r = rig();
  r.arm().play(300);
  r.play(300, { pinkStart: { motion: 0.4 } });
  r.play(300, { pinkStart: { pink: 0.1, motion: 0.3 } });
  r.set({ pinkStart: { pink: 0, motion: 0 } });
  r.play(300, { blueStart: { blue: 0, motion: 0.3 } });            // blue leaves first
  r.set({ blueStart: { motion: 0 } });
  r.play(300, { build: { pink: 0.15, motion: 0.3 } });             // then pink reaches build
  r.play(300, { build: { blue: 0.1, motion: 0.4 } });
  r.play(600, { build: { motion: 0.6 } });
  r.play(300, { build: { motion: 0.1 } });
  r.play(900, { build: { motion: 0.01 } });
  const s = r.state;
  check('out of order flagged', s.flags.outOfOrder === true);
  check('cycle still completes', s.status === 'complete', s.status);
  check('cycle record carries the flag', s.cycles[0] && s.cycles[0].flags.outOfOrder === true);
}

console.log('rework');
{
  const r = rig();
  r.arm().play(300);
  r.play(300, { pinkStart: { motion: 0.4 } });
  r.play(300, { pinkStart: { pink: 0.1, motion: 0.3 } });
  r.set({ pinkStart: { pink: 0, motion: 0 } });
  r.play(300, { build: { pink: 0.15, motion: 0.3 } });
  r.play(250, { build: { pink: 0 } });                               // short occlusion
  r.play(300, { build: { pink: 0.15 } });
  check('short occlusion is not rework', r.state.flags.rework === 0);
  r.play(1200, { build: { pink: 0 } });                              // really gone
  check('not counted until it returns', r.state.flags.rework === 0);
  r.play(300, { build: { pink: 0.15 } });
  check('rework counted once it returns', r.state.flags.rework === 1, String(r.state.flags.rework));
}

console.log('flicker');
{
  const r = rig();
  r.arm().play(300);
  r.play(300, { pinkStart: { motion: 0.4 } });                       // E1 confirmed
  check('E1 confirmed', r.state.phase === 1);
  for (let i = 0; i < 60; i++) r.play(FRAME, { pinkStart: { pink: i % 2 ? 0.5 : 0.0 } });
  check('flickering pink does not confirm E2', r.state.phase === 1, 'phase ' + r.state.phase);
  const q = rig();
  q.arm().play(200);
  for (let i = 0; i < 60; i++) q.play(FRAME, { pinkStart: { motion: i % 3 === 0 ? 0.5 : 0 } });
  check('flickering motion does not confirm E1', q.state.phase === 0, 'phase ' + q.state.phase);
}

console.log('low confidence');
{
  const r = rig();
  r.arm().play(300);
  r.play(300, { pinkStart: { motion: 0.11 } });                      // barely over 0.10
  check('weak E1 flags low confidence', r.state.flags.lowConfidence === 1 && r.state.events[0].conf < 60, JSON.stringify(r.state.events[0]));
}

console.log('manual advance and undo');
{
  const r = rig();
  r.arm().play(300);
  r.eng.manualAdvance(1000); r.eng.manualAdvance(1500); r.eng.manualAdvance(2000);
  let s = r.state;
  check('three manual advances reach phase 3', s.phase === 3, 'phase ' + s.phase);
  check('manual rows have no confidence and are marked manual', s.done.length === 3 && s.done.slice(1).every(d => d.manual && d.conf === null), JSON.stringify(s.done));
  s = r.eng.undo();
  check('undo steps back one substep', s.phase === 2 && s.done.length === 2, 'phase ' + s.phase);
  s = r.eng.undo(); s = r.eng.undo();
  check('undo back to armed', s.phase === 0 && s.done.length === 0, 'phase ' + s.phase);
  const m = rig();
  m.arm().play(100);
  for (let i = 0; i < 9; i++) m.eng.manualAdvance(1000 + i * 700);
  check('nine manual advances complete a cycle', m.state.status === 'complete' && m.state.cycles.length === 1, m.state.status);
  const s2 = m.eng.reset(9000);
  check('reset re-arms and keeps finished cycles', s2.status === 'armed' && s2.cycles.length === 1);
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
