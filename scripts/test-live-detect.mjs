// Tests for the detection mapping and the build check. Run: npm run test:live
import fs from 'node:fs';
const mod = { exports: {} };
new Function('module', fs.readFileSync(new URL('../app/live-detect.js', import.meta.url), 'utf8'))(mod);
const LD = mod.exports;
const mod2 = { exports: {} };
new Function('module', fs.readFileSync(new URL('../app/live-engine.js', import.meta.url), 'utf8'))(mod2);
const LE = mod2.exports;

let fails = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log('  pass  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra ? ' (' + extra + ')' : '')); }
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const nb = (cx, cy, w, h) => [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
const det = (cls, conf, cx, cy, w, h, W = 1000, H = 1000) => {
  const n = nb(cx, cy, w, h);
  return { cls, conf, nbox: n, box: [n[0] * W, n[1] * H, n[2] * W, n[3] * H] };
};
const zones = { pinkStart: { x: .1, y: .1, w: .2, h: .2 }, blueStart: { x: .6, y: .1, w: .2, h: .2 }, build: { x: .3, y: .5, w: .3, h: .3 } };
const noMotion = { pinkStart: 0, blueStart: 0, build: 0 };

console.log('letterbox and decode');
{
  const lb = LD.letterbox(720, 1280, 640);
  check('portrait 720x1280 letterboxes to 360x640 with 140 px side bars', lb.nw === 360 && lb.nh === 640 && lb.padX === 140 && lb.padY === 0 && near(lb.scale, 0.5));
  const lb2 = LD.letterbox(1280, 720, 640);
  check('landscape 1280x720 letterboxes to 640x360 with 140 px top bars', lb2.nw === 640 && lb2.nh === 360 && lb2.padY === 140 && lb2.padX === 0);
  // N = 4 anchors, rows: cx, cy, w, h, then plate, pink, blue scores
  const N = 4, data = new Float32Array(7 * N);
  const setA = (i, cx, cy, w, h, sc) => { data[i] = cx; data[N + i] = cy; data[2 * N + i] = w; data[3 * N + i] = h; sc.forEach((v, c) => { data[(4 + c) * N + i] = v; }); };
  setA(0, 140 + 150, 200, 100, 200, [0.1, 0.8, 0.2]);      // pink
  setA(1, 140 + 152, 202, 100, 200, [0.1, 0.7, 0.2]);      // same pink, overlaps: removed by NMS
  setA(2, 140 + 30, 30, 40, 40, [0.2, 0.1, 0.9]);          // blue far away
  setA(3, 400, 400, 40, 40, [0.1, 0.1, 0.2]);              // below the floor
  const d = LD.decode(data, N, lb, 720, 1280, 0.25, 0.7);
  check('decode keeps best class per anchor, applies NMS, drops weak boxes', d.length === 2 && d[0].cls === 'blue_slope' && d[1].cls === 'pink_brick', JSON.stringify(d.map(x => x.cls)));
  const pk = d.find(x => x.cls === 'pink_brick');
  check('decode maps model pixels to frame pixels', near(pk.box[0], (290 - 50 - 140) / 0.5) && near(pk.box[1], 200), JSON.stringify(pk.box));
  check('decode gives normalized boxes', near(pk.nbox[0], pk.box[0] / 720) && near(pk.nbox[3], pk.box[3] / 1280));
  const rgba = new Uint8ClampedArray(4 * 4).fill(255);
  rgba[0] = 51; rgba[1] = 102; rgba[2] = 153;
  const t = LD.fillTensor(rgba, 2);
  check('tensor is channels first, 0..1', near(t[0], 0.2) && near(t[4], 0.4) && near(t[8], 0.6) && t[1] === 1, Array.from(t).slice(0, 9).join(','));
}

console.log('plate white filter and best box');
{
  const w = 10, h = 10, dark = new Uint8ClampedArray(w * h * 4), bright = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { dark.set([40, 40, 40, 255], i * 4); bright.set([230, 225, 220, 255], i * 4); }
  check('a dark box is not white', LD.medianV(dark, w, h, [0, 0, 10, 10]) <= 110);
  check('a bright box is white', LD.medianV(bright, w, h, [0, 0, 10, 10]) > 110);
  const best = LD.bestPerClass([det('pink_brick', 0.5, .2, .2, .1, .1), det('pink_brick', 0.7, .5, .5, .1, .1), det('plate', 0.9, .5, .5, .3, .3), det('blue_slope', 0.3, .5, .5, .1, .1)], 0.35, d => d.cls !== 'plate');
  check('best box per class: highest confidence wins', best.pink_brick.conf === 0.7);
  check('best box per class: plate veto and low confidence are dropped', !best.plate && !best.blue_slope);
}

console.log('detections to engine signals');
{
  let s = LD.mapSignals({ pink_brick: det('pink_brick', 0.7, .2, .2, .05, .05), blue_slope: det('blue_slope', 0.6, .7, .2, .05, .05) }, zones, noMotion, null);
  check('pink in its start zone gives pinkStart.pink = confidence', near(s.pinkStart.pink, 0.7) && s.pinkStart.blue === 0);
  check('blue in its start zone gives blueStart.blue = confidence', near(s.blueStart.blue, 0.6) && s.blueStart.pink === 0);
  check('nothing in the build zone when parts are at their start', s.build.pink === 0 && s.build.blue === 0);

  s = LD.mapSignals({ blue_slope: det('blue_slope', 0.9, .9, .9, .05, .05) }, zones, noMotion, null, null, [det('blue_slope', 0.9, .9, .9, .05, .05), det('blue_slope', 0.5, .7, .2, .05, .05)]);
  check('start zone sees a weaker real part when a stronger false box is elsewhere', near(s.blueStart.blue, 0.5));
  s = LD.mapSignals({ pink_brick: det('pink_brick', 0.7, .31, .2, .03, .03) }, zones, noMotion, null);
  check('start zones count a little bigger than drawn', near(s.pinkStart.pink, 0.7));
  s = LD.mapSignals({ pink_brick: det('pink_brick', 0.7, .45, .65, .05, .05) }, zones, noMotion, null);
  check('no plate: a part in the build zone counts as build', near(s.build.pink, 0.7) && s.pinkStart.pink === 0);
  s = LD.mapSignals({ pink_brick: det('pink_brick', 0.7, .1, .9, .05, .05) }, zones, noMotion, null);
  check('no plate: a part outside the build zone does not', s.build.pink === 0);

  const plate = det('plate', 0.8, .5, .5, .2, .2);
  s = LD.mapSignals({ plate, pink_brick: det('pink_brick', 0.55, .5, .5, .05, .05), blue_slope: det('blue_slope', 0.5, .5, .5, .05, .05) }, zones, noMotion, null);
  check('with a plate: parts on it count as build (even outside the build zone)', near(s.build.pink, 0.55) && near(s.build.blue, 0.5));
  s = LD.mapSignals({ plate, pink_brick: det("pink_brick", 0.55, .62, .5, .04, .04) }, zones, noMotion, null);
  check('plate box is grown about 15 percent', s.build.pink === 0 && near(LD.expandBox(plate.nbox, 0.15)[2], .6 + .015));
  s = LD.mapSignals({ plate, pink_brick: det('pink_brick', 0.55, .605, .5, .04, .04) }, zones, noMotion, null);
  check('a part just inside the grown plate counts', near(s.build.pink, 0.55));
  s = LD.mapSignals({ plate, pink_brick: det('pink_brick', 0.55, .45, .65, .05, .05) }, zones, noMotion, null);
  check('with a plate the build zone is ignored', s.build.pink === 0);

  s = LD.mapSignals({}, zones, { pinkStart: 0.04, blueStart: 0, build: 0.2 }, null);
  check('frame differencing motion passes through', near(s.pinkStart.motion, 0.04) && near(s.build.motion, 0.2));
  const hand = [[{ x: .15, y: .15 }, { x: .9, y: .9 }]];
  s = LD.mapSignals({}, zones, { pinkStart: 0.01, blueStart: 0.01, build: 0.01 }, hand);
  check('a hand landmark in a zone raises that zone motion', near(s.pinkStart.motion, LD.TUNING.handMotion) && near(s.blueStart.motion, 0.01) && near(s.build.motion, 0.01));
  s = LD.mapSignals({}, zones, { pinkStart: 0.6, blueStart: 0, build: 0 }, hand);
  check('a hand never lowers motion', near(s.pinkStart.motion, 0.6));
  check('empty detections give zero part signals', LD.mapSignals({}, zones, noMotion, null).build.pink === 0);
}

console.log('engine runs on mapped signals');
{
  const eng = LE.createEngine({ pinkBuild: 0.3, blueBuild: 0.3, confirmFrames: 3 });
  const plate = det('plate', 0.8, .5, .5, .2, .2);
  const sigAt = (best, motion, hands) => LD.mapSignals(best, zones, motion, hands);
  const pinkHome = det('pink_brick', 0.7, .2, .2, .05, .05), blueHome = det('blue_slope', 0.6, .7, .2, .05, .05);
  const pinkOn = det('pink_brick', 0.7, .5, .5, .05, .05), blueOn = det('blue_slope', 0.6, .5, .52, .05, .05);
  let t = 0;
  const run = (n, best, motion, hands) => { for (let i = 0; i < n; i++) { eng.update(sigAt(best, motion || noMotion, hands), t); t += 100; } };
  eng.arm(sigAt({ plate, pink_brick: pinkHome, blue_slope: blueHome }, noMotion), 0);
  run(3, { plate, pink_brick: pinkHome, blue_slope: blueHome }, null, [[{ x: .2, y: .2 }]]);
  run(4, { plate, blue_slope: blueHome });
  run(4, { plate, pink_brick: pinkOn, blue_slope: blueHome });
  run(4, { plate, pink_brick: pinkOn }, null, [[{ x: .7, y: .2 }]]);
  run(4, { plate, pink_brick: pinkOn });
  run(5, { plate, pink_brick: pinkOn, blue_slope: blueOn }, { pinkStart: 0, blueStart: 0, build: 0.3 });
  run(8, { plate, pink_brick: pinkOn, blue_slope: blueOn });
  run(10, { plate, pink_brick: pinkOn, blue_slope: blueOn });
  const s = eng.getState();
  check('a scripted cycle of detections completes a cycle in the engine', s.cycles.length === 1, s.status + ' phase ' + s.phase + ' ' + JSON.stringify(s.events.map(e => e.id)));
}

console.log('quality check');
{
  // Correct build: pink on the plate's left, blue on the right. Plate 0.4 wide, 0.3 tall (landscape).
  const mk = (over = {}) => {
    const plate = det('plate', 0.9, .5, .5, .4, .3);
    const pink = det('pink_brick', 0.9, .5 - .1, .5, .2, .06);
    const blue = det('blue_slope', 0.9, .5 + .12, .5, .08, .08);
    return Object.assign({ plate, pink_brick: pink, blue_slope: blue }, over);
  };
  const ref = LD.makeReference([mk(), mk(), mk()]);
  check('makeReference records plate-relative positions and orientation', typeof ref === 'object' && ref.plate_landscape === true && near(ref.parts.pink_brick.x, 0.25) && near(ref.parts.blue_slope.x, 0.8, 1e-3), JSON.stringify(ref));
  check('makeReference explains what is missing', typeof LD.makeReference([{ plate: mk().plate }]) === 'string');

  let v = LD.checkBuild(mk(), ref, { done: 0 });
  check('a correct build verifies up to complete', v.kind === 'complete', v.kind + ' ' + v.message);
  v = LD.checkBuild({ plate: mk().plate }, ref, { done: 0 });
  check('plate alone is step 1', v.kind === 'verified' && v.step === 0);
  v = LD.checkBuild({ plate: mk().plate, blue_slope: mk().blue_slope }, ref, { done: 1 });
  check('blue before pink is wrong order', v.kind === 'error' && v.reason === 'wrong_order', v.kind + ' ' + v.message);
  v = LD.checkBuild(mk({ pink_brick: det('pink_brick', 0.9, .5 + .05, .5, .2, .06) }), ref, { done: 1 });
  check('pink in the wrong spot', v.kind === 'error' && v.reason === 'wrong_spot', v.kind + ' ' + v.message);
  v = LD.checkBuild(mk({ pink_brick: det('pink_brick', 0.9, .5 - .1, .5, .06, .2) }), ref, { done: 1 });
  check('pink turned the wrong way', v.kind === 'error' && v.reason === 'turned', v.kind + ' ' + v.message);
  v = LD.checkBuild(mk({ pink_brick: det('pink_brick', 0.5, .5 + .05, .5, .2, .06) }), ref, { done: 1 });
  check('a mistake on a weak box is needs review', v.kind === 'review', v.kind);
  v = LD.checkBuild({ plate: mk().plate, pink_brick: mk().pink_brick }, ref, { done: 3 });
  check('a verified part that vanished is missing', v.kind === 'error' && v.reason === 'missing', v.kind + ' ' + v.message);
  v = LD.checkBuild(mk({ blue_slope: det('blue_slope', 0.45, .5 + .12, .5, .08, .08) }), ref, { done: 2 });
  check('a correct but weak step is low confidence', v.kind === 'review' && v.reason === 'low_confidence', v.kind);

  // Plate turned a quarter turn (portrait): the same build rotated, positions follow.
  const rotated = () => {
    const plate = det('plate', 0.9, .5, .5, .3, .4);
    // clockwise quarter turn: x' = 1 - y, y' = x (plate fractions), w and h swap
    const part = (cls, p) => { const x = 1 - p.y, y = p.x, w = p.h, h = p.w; return det(cls, 0.9, .5 - .15 + x * .3, .5 - .2 + y * .4, w * .3, h * .4); };
    return { plate, pink_brick: part('pink_brick', ref.parts.pink_brick), blue_slope: part('blue_slope', ref.parts.blue_slope) };
  };
  v = LD.checkBuild(rotated(), ref, { done: 0 });
  check('a plate turned 90 degrees is not a false "turned"', v.kind === 'complete', v.kind + ' ' + v.message);
  const flipped = () => {
    const f = p => det(p.cls, p.conf, 1 - (p.nbox[0] + p.nbox[2]) / 2, 1 - (p.nbox[1] + p.nbox[3]) / 2, p.nbox[2] - p.nbox[0], p.nbox[3] - p.nbox[1]);
    const m = mk(); return { plate: f(m.plate), pink_brick: f(m.pink_brick), blue_slope: f(m.blue_slope) };
  };
  v = LD.checkBuild(flipped(), ref, { done: 0 });
  check('a 180 degree flip counts as the same', v.kind === 'complete', v.kind + ' ' + v.message);

  // Checker: only while the hands are clear, 2 of 3 vote.
  const ck = LD.createChecker();
  ck.setRef(ref);
  let t = 0, ev = null;
  const tick = (dets, view) => { t += 0.1; const e = ck.step(dets, view, t); if (e) ev = e; return e; };
  for (let i = 0; i < 10; i++) tick(mk(), { hands: true, still: false });
  check('no verdict while hands are in view', ev === null && ck.verdict === null);
  for (let i = 0; i < 12; i++) tick(mk(), { hands: false, still: true });
  check('verdict arrives after the view is clear', ev && ev.kind === 'complete', ev && ev.kind);
  const n = ck.events.length;
  for (let i = 0; i < 12; i++) tick(mk(), { hands: false, still: true });
  check('one check per clear view', ck.events.length === n);

  const ck2 = LD.createChecker(); ck2.setRef(ref);
  let t2 = 0, got = null;
  const feed = dets => { t2 += 0.12; const e = ck2.step(dets, { hands: false, still: true }, t2); if (e) got = e; };
  const good = mk(), bad = mk({ pink_brick: det('pink_brick', 0.9, .5 + .05, .5, .2, .06) });
  for (let i = 0; i < 8; i++) feed({ plate: good.plate });
  check('checker verifies step 1', got && got.kind === 'verified' && ck2.cycle.done === 1, got && got.kind);
  ck2.step(good, { hands: true, still: false }, t2 += 0.12);
  got = null; feed(good); feed(good); feed(good); feed(bad); feed(good); feed(bad);
  check('2 of 3 vote decides', got && got.kind === 'error', got && got.kind);
  const ck3 = LD.createChecker(); ck3.setRef(ref);
  let t3 = 0, got3 = null;
  const f3 = dets => { t3 += 0.12; const e = ck3.step(dets, { hands: false, still: true }, t3); if (e) got3 = e; };
  f3({}); f3({}); f3({}); f3({ plate: good.plate }); f3({}); f3({ plate: good.plate, blue_slope: good.blue_slope }); f3({});
  check('flickering results ask for a review instead of guessing', got3 && got3.kind === 'review', got3 && got3.kind);
}

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
