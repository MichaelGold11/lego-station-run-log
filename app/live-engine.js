// Live station engine: the SOP config, a pure rules engine and the plain color + motion signal code.
// No dependencies. Browser: window.LiveEngine. Node: module.exports.
//
// Pipeline: camera -> signals (this file, computeSignals) -> rules (createEngine) -> checklist and dashboard.
// computeSignals is the part a trained model replaces later. createEngine only needs per-zone signals:
//   { pinkStart: {pink, blue, motion}, blueStart: {...}, build: {...} }   (all 0..1)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- SOP config ----------
  const SUBSTEPS = ['idle_pre', 'pick_pink', 'place_pink', 'seat_pink', 'pick_blue', 'carry_blue', 'orient_blue', 'seat_blue', 'release'];
  const LABELS = {
    idle_pre: 'Waiting for start', pick_pink: 'Pick pink brick', hold_plate: 'Hold plate', place_pink: 'Place pink on plate',
    seat_pink: 'Seat pink brick', pick_blue: 'Pick blue slope', carry_blue: 'Carry blue slope', orient_blue: 'Orient blue slope',
    seat_blue: 'Seat blue slope', release: 'Release', idle_post: 'Idle after cycle'
  };
  const SOP_STEPS = [
    { id: 'pink', title: '1. Pink brick on plate', substeps: ['pick_pink', 'place_pink', 'seat_pink'] },
    { id: 'blue', title: '2. Blue slope on', substeps: ['pick_blue', 'carry_blue', 'orient_blue', 'seat_blue'] },
    { id: 'release', title: '3. Release', substeps: ['release'] }
  ];
  const NOT_DETECTED = { hold_plate: 'needs hand tracking (coming with the model)' };
  const ESTIMATED = { orient_blue: true, seat_blue: true };
  const COLORS = {
    idle_pre: '#c9ccc9', pick_pink: '#2a78d6', hold_plate: '#e87ba4', place_pink: '#eb6834', seat_pink: '#1baf7a',
    pick_blue: '#2a78d6', carry_blue: '#2a78d6', orient_blue: '#eb6834', seat_blue: '#1baf7a', release: '#eda100', idle_post: '#c9ccc9'
  };
  // What the rules are waiting for in each phase (phase = index into SUBSTEPS).
  const WAITING = [
    'Waiting for hands to touch the pink brick',
    'Waiting for the pink brick to leave its spot',
    'Waiting for the pink brick to reach the plate',
    'Waiting for hands to reach for the blue slope',
    'Waiting for the blue slope to leave its spot',
    'Waiting for the blue slope to reach the plate',
    'Waiting for the build to settle',
    'Waiting for the build to settle',
    'Waiting for the build to stay still for 0.5 s'
  ];

  const DEFAULT_CONFIG = {
    confirmFrames: 4,          // frames an event must hold before it confirms
    motionStart: 0.10,         // E1: motion at the pink start zone
    pinkMovedFrac: 0.60,       // E1: pink below this share of its armed baseline
    pinkLeftFrac: 0.30,        // E2: pink below this share of its baseline
    pinkBuild: 0.06,           // E3: pink share of the build zone
    motionBlue: 0.10,          // E3b: motion at the blue start zone
    blueLeftFrac: 0.30,        // E4: blue below this share of its baseline
    blueBuild: 0.02,           // E5: blue share of the build zone
    settleMotion: 0.06,        // build motion below this = build is settling
    stillMotion: 0.025,        // E6: build motion below this counts as still
    stillMs: 500,              // E6: how long the build must stay still
    peakDropFrac: 0.5,         // orient to seat split: motion fell below this share of its peak
    reworkVanishFrac: 0.4,     // rework: pink in build below this share of pinkBuild
    reworkVanishMs: 700,       // rework: pink must stay gone this long
    rearmFrac: 0.8,            // auto re-arm: start zones back above this share of baseline
    rearmQuietMs: 1000,        // auto re-arm: build quiet this long
    minBaseline: 0.005,        // baselines below this disable the checks that need them
    lowConfidence: 60,         // events under this percent raise the low confidence flag
    standardCycleS: 5.5,       // over standard flag (the page sets this from Run 1)
    motionEma: 0.5             // smoothing of build motion for the peak and settle checks
  };

  const clamp01 = v => Math.max(0, Math.min(1, v));
  const clone = o => JSON.parse(JSON.stringify(o));
  // Confidence of one frame: 50% at the threshold, 100% at twice the threshold (or at zero for "below").
  const above = (v, thr) => clamp01(0.5 + 0.5 * ((v - thr) / thr));
  const below = (v, thr) => clamp01(0.5 + 0.5 * ((thr - v) / thr));

  function createEngine(userConfig) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, userConfig || {});
    let S = fresh();
    let undoStack = [];
    let lastT = 0;
    let lastSig = null;

    function fresh() {
      return {
        phase: -1,                 // -1 not armed, 0..8 current substep, 9 cycle complete
        armT: 0, base: { pink: 0, blue: 0 },
        B: [], BC: [], BM: [], skipped: {},   // boundaries: time, confidence, manual
        events: [], cnt: {}, ooo: false, oooLatched: false,
        rework: 0, lowConf: 0, vanishT: null, reworkOpen: false, returnCnt: 0,
        peakVal: 0, peakT: 0, ema: 0, quietT: null,
        cycles: [], cycleNo: 0, lastEvent: null, lastReason: ''
      };
    }
    function snapshot() { undoStack.push(clone(S)); if (undoStack.length > 200) undoStack.shift(); }

    // Debounce helper: returns {done, onset, conf} once `ok` held for n frames (and minMs when given).
    function hold(name, ok, conf, t, minMs) {
      let c = S.cnt[name];
      if (!ok) { if (c) delete S.cnt[name]; return null; }
      if (!c) c = S.cnt[name] = { t0: t, n: 0, sum: 0 };
      c.n++; c.sum += conf;
      if (c.n >= cfg.confirmFrames && (!minMs || t - c.t0 >= minMs)) return { onset: c.t0, conf: Math.round(100 * c.sum / c.n) };
      return null;
    }

    function confirm(boundaryIdx, id, label, onset, conf, manual) {
      S.B[boundaryIdx] = onset; S.BC[boundaryIdx] = manual ? null : conf; S.BM[boundaryIdx] = !!manual;
      const ev = { id, label, tMs: onset, conf: manual ? null : conf, manual: !!manual };
      S.events.push(ev); S.lastEvent = ev;
      if (!manual && conf < cfg.lowConfidence) S.lowConf++;
      S.cnt = {};
    }

    function arm(signals, tMs) {
      snapshot();
      const sg = signals || lastSig || {};
      S.cycles = S.cycles || [];
      const keep = { cycles: S.cycles, cycleNo: S.cycleNo };
      S = fresh(); S.cycles = keep.cycles; S.cycleNo = keep.cycleNo;
      S.base = { pink: sg.pinkStart ? sg.pinkStart.pink : 0, blue: sg.blueStart ? sg.blueStart.blue : 0 };
      S.phase = 0; S.armT = tMs; S.B[0] = tMs; lastT = tMs;
      return view(tMs);
    }

    function reset(tMs) {
      snapshot();
      const keep = { cycles: S.cycles, cycleNo: S.cycleNo, base: S.base, phase: S.phase };
      S = fresh(); S.cycles = keep.cycles; S.cycleNo = keep.cycleNo; S.base = keep.base;
      const t = tMs == null ? lastT : tMs;
      if (keep.phase >= 0) { S.phase = 0; S.armT = t; S.B[0] = t; }
      return view(t);
    }

    // Back to not armed (a new source starts here). Finished cycles are kept.
    function unarm() {
      const keep = { cycles: S.cycles, cycleNo: S.cycleNo };
      S = fresh(); S.cycles = keep.cycles; S.cycleNo = keep.cycleNo; undoStack = [];
      return view(lastT);
    }

    function finishCycle() {
      const B = S.B;
      S.cycleNo++;
      const total = B[9] - B[1];
      const over = total > cfg.standardCycleS * 1000;
      const substeps = [];
      for (let i = 1; i < 9; i++) substeps.push({ key: SUBSTEPS[i], start: B[i], end: B[i + 1], dur: B[i + 1] - B[i] });
      S.cycles.push({
        n: S.cycleNo, startMs: B[1], endMs: B[9], totalMs: total,
        steps: { pink: B[4] - B[1], blue: B[8] - B[4], release: B[9] - B[8] },
        substeps,
        flags: { outOfOrder: S.ooo, rework: S.rework, overStandard: over, lowConfidence: S.lowConf }
      });
      S.phase = 9; S.quietT = null;
    }

    function update(signals, tMs) {
      lastT = tMs; lastSig = signals;
      if (S.phase < 0 || !signals) return view(tMs);
      const pS = signals.pinkStart || {}, bS = signals.blueStart || {}, bd = signals.build || {};
      const pinkBase = S.base.pink, blueBase = S.base.blue;
      const t = tMs;
      S.ema = cfg.motionEma * (bd.motion || 0) + (1 - cfg.motionEma) * S.ema;
      const m = S.ema;
      const bothInBuild = (bd.pink || 0) > cfg.pinkBuild && (bd.blue || 0) > cfg.blueBuild;

      // Side detector: blue leaves its start before pink is in the build zone.
      if (S.phase <= 2 && !S.oooLatched && blueBase >= cfg.minBaseline) {
        const thr = cfg.blueLeftFrac * blueBase, v = bS.blue || 0;
        const r = hold('ooo', v < thr, below(v, thr), t);
        if (r) {
          snapshot(); S.oooLatched = true; S.ooo = true; S.oooT = r.onset; S.oooConf = r.conf;
          const ev = { id: 'OOO', label: 'Blue slope left before pink reached the plate', tMs: r.onset, conf: r.conf, manual: false };
          S.events.push(ev); S.lastEvent = ev;
          if (r.conf < cfg.lowConfidence) S.lowConf++;
          delete S.cnt.ooo;
        }
      }

      // Rework: pink vanishes from the build zone after E3 and comes back.
      if (S.phase >= 3 && S.phase <= 8) {
        const goneThr = cfg.reworkVanishFrac * cfg.pinkBuild, v = bd.pink || 0;
        if (!S.reworkOpen) {
          const r = hold('vanish', v < goneThr, below(v, goneThr), t, cfg.reworkVanishMs);
          if (r) { snapshot(); S.reworkOpen = true; delete S.cnt.vanish; }
        } else {
          const r = hold('return', v > cfg.pinkBuild, above(v, cfg.pinkBuild), t);
          if (r) {
            snapshot(); S.reworkOpen = false; S.rework++;
            const ev = { id: 'REWORK', label: 'Pink brick vanished from the plate and came back', tMs: r.onset, conf: r.conf, manual: false };
            S.events.push(ev); S.lastEvent = ev; delete S.cnt['return'];
            if (r.conf < cfg.lowConfidence) S.lowConf++;
          }
        }
      }

      switch (S.phase) {
        case 0: { // E1 cycle start
          let ok = false, conf = 0;
          const mv = pS.motion || 0;
          if (mv > cfg.motionStart) { ok = true; conf = Math.max(conf, above(mv, cfg.motionStart)); }
          if (pinkBase >= cfg.minBaseline) {
            const thr = cfg.pinkMovedFrac * pinkBase, v = pS.pink || 0;
            if (v < thr) { ok = true; conf = Math.max(conf, below(v, thr)); }
          }
          const r = hold('E1', ok, conf, t);
          if (r) { snapshot(); confirm(1, 'E1', 'Cycle start', r.onset, r.conf); S.phase = 1; }
          break;
        }
        case 1: { // E2 pink left its start
          const thr = cfg.pinkLeftFrac * pinkBase, v = pS.pink || 0;
          const r = pinkBase >= cfg.minBaseline ? hold('E2', v < thr, below(v, thr), t) : null;
          if (r) { snapshot(); confirm(2, 'E2', 'Pink left its start', r.onset, r.conf); S.phase = 2; }
          break;
        }
        case 2: { // E3 pink in build
          const v = bd.pink || 0;
          const r = hold('E3', v > cfg.pinkBuild, above(v, cfg.pinkBuild), t);
          if (r) {
            snapshot(); confirm(3, 'E3', 'Pink in the build zone', r.onset, r.conf);
            if (S.oooLatched) { // blue already left: E3b and E4 are folded into this moment
              S.B[4] = S.B[3]; S.BC[4] = null; S.BM[4] = false; S.skipped[3] = true; S.skipped[4] = true;
              S.B[5] = S.B[3]; S.BC[5] = null; S.BM[5] = false;
              S.phase = 5;
            } else S.phase = 3;
          }
          break;
        }
        case 3: { // E3b motion at blue start
          const v = bS.motion || 0;
          const r = hold('E3b', v > cfg.motionBlue, above(v, cfg.motionBlue), t);
          if (r) { snapshot(); confirm(4, 'E3b', 'Hands at the blue slope', r.onset, r.conf); S.phase = 4; break; }
          // Hands came in unseen but the blue slope is already gone: fold E3b into E4.
          const thr3 = cfg.blueLeftFrac * blueBase, bv = bS.blue || 0;
          const r2 = blueBase >= cfg.minBaseline ? hold('E3bskip', bv < thr3, below(bv, thr3), t) : null;
          if (r2) {
            snapshot(); confirm(4, 'E3b', 'Hands at the blue slope (not seen)', r2.onset, r2.conf);
            S.skipped[4] = true; confirm(5, 'E4', 'Blue left its start', r2.onset, r2.conf); S.phase = 5;
          }
          break;
        }
        case 4: { // E4 blue left start
          const thr = cfg.blueLeftFrac * blueBase, v = bS.blue || 0;
          const r = blueBase >= cfg.minBaseline ? hold('E4', v < thr, below(v, thr), t) : null;
          if (r) { snapshot(); confirm(5, 'E4', 'Blue left its start', r.onset, r.conf); S.phase = 5; }
          break;
        }
        case 5: { // E5 blue in build
          const v = bd.blue || 0;
          const r = hold('E5', v > cfg.blueBuild, above(v, cfg.blueBuild), t);
          if (r) {
            snapshot(); confirm(6, 'E5', 'Blue in the build zone', r.onset, r.conf);
            S.phase = 6; S.peakVal = 0; S.peakT = r.onset; S.ema = bd.motion || 0;
          }
          break;
        }
        case 6: case 7: case 8: {
          if (m >= S.peakVal && S.phase <= 7) { S.peakVal = m; S.peakT = t; }
          if (S.phase === 6) { // orient to seat: motion fell off its peak
            const r = hold('peak', S.peakVal > cfg.settleMotion && m < cfg.peakDropFrac * S.peakVal, 1, t);
            if (r) { snapshot(); S.B[7] = Math.max(S.peakT, S.B[6]); S.BC[7] = null; S.BM[7] = false; S.phase = 7; S.cnt = {}; }
          }
          if (S.phase <= 7) { // settle: build motion low after it was active
            const active = S.peakVal > cfg.settleMotion;
            const r = hold('settle', active && m < cfg.settleMotion, below(m, cfg.settleMotion), t);
            if (r) {
              snapshot();
              if (S.phase === 6) { S.B[7] = Math.min(Math.max(S.peakT, S.B[6]), r.onset); S.BC[7] = null; S.BM[7] = false; }
              confirm(8, 'SETTLE', 'Build settled', r.onset, r.conf);
              S.phase = 8;
            }
          } else { // phase 8: E6 still for stillMs, or fall back if motion returns
            const r = hold('E6', m < cfg.stillMotion && bothInBuild, below(m, cfg.stillMotion), t, cfg.stillMs);
            if (r) {
              snapshot(); confirm(9, 'E6', 'Release, cycle complete', r.onset, r.conf);
              finishCycle();
              break;
            }
            const rb = hold('resume', m > 1.5 * cfg.settleMotion, 1, t);
            if (rb) { snapshot(); S.phase = 7; S.cnt = {}; S.B[8] = undefined; S.events.pop(); S.lastEvent = S.events[S.events.length - 1] || null; }
          }
          break;
        }
        case 9: { // re-arm when the parts are back at their start spots and the build is quiet
          const pOk = pinkBase >= cfg.minBaseline ? (pS.pink || 0) >= cfg.rearmFrac * pinkBase : true;
          const bOk = blueBase >= cfg.minBaseline ? (bS.blue || 0) >= cfg.rearmFrac * blueBase : true;
          const quiet = m < cfg.stillMotion;
          if (pOk && bOk && quiet) {
            if (S.quietT == null) S.quietT = t;
            if (t - S.quietT >= cfg.rearmQuietMs) {
              const keep = { cycles: S.cycles, cycleNo: S.cycleNo, base: S.base };
              S = fresh(); S.cycles = keep.cycles; S.cycleNo = keep.cycleNo; S.base = keep.base;
              S.phase = 0; S.armT = t; S.B[0] = t; undoStack = [];
            }
          } else S.quietT = null;
          break;
        }
      }
      return view(tMs);
    }

    // Space bar: mark the current substep done now.
    function manualAdvance(tMs) {
      lastT = tMs;
      if (S.phase < 0) return arm(lastSig, tMs);
      if (S.phase === 9) return reset(tMs);
      snapshot();
      const p = S.phase;
      const manual = (idx, id, label) => confirm(idx, id, label, tMs, 0, true);
      if (p === 0) { manual(1, 'E1', 'Cycle start'); S.phase = 1; }
      else if (p === 1) { manual(2, 'E2', 'Pink left its start'); S.phase = 2; }
      else if (p === 2) {
        manual(3, 'E3', 'Pink in the build zone');
        if (S.oooLatched) { S.B[4] = tMs; S.B[5] = tMs; S.BC[4] = S.BC[5] = null; S.BM[4] = S.BM[5] = false; S.skipped[3] = S.skipped[4] = true; S.phase = 5; } else S.phase = 3;
      }
      else if (p === 3) { manual(4, 'E3b', 'Hands at the blue slope'); S.phase = 4; }
      else if (p === 4) { manual(5, 'E4', 'Blue left its start'); S.phase = 5; }
      else if (p === 5) { manual(6, 'E5', 'Blue in the build zone'); S.phase = 6; S.peakVal = 0; S.peakT = tMs; S.ema = 0; }
      else if (p === 6) { S.B[7] = tMs; S.BC[7] = null; S.BM[7] = true; S.phase = 7; S.cnt = {}; }
      else if (p === 7) { manual(8, 'SETTLE', 'Build settled'); S.phase = 8; }
      else if (p === 8) { manual(9, 'E6', 'Release, cycle complete'); finishCycle(); }
      return view(tMs);
    }

    function undo() {
      if (!undoStack.length) return view(lastT);
      S = undoStack.pop();
      return view(lastT);
    }

    function view(tMs) {
      const p = S.phase, B = S.B;
      const done = [];
      for (let i = 0; i < Math.min(p < 0 ? 0 : p, 9); i++) {
        if (B[i] == null || B[i + 1] == null) continue;
        const bi = i === 6 ? 6 : i + 1; // orient_blue takes the confidence of E5
        done.push({
          key: SUBSTEPS[i], start: B[i], end: B[i + 1], dur: B[i + 1] - B[i],
          conf: S.BM[bi] ? null : (S.BC[bi] == null ? null : S.BC[bi]), manual: !!S.BM[bi] || (i === 7 && !!S.BM[8]),
          estimated: !!ESTIMATED[SUBSTEPS[i]], skipped: !!S.skipped[i]
        });
      }
      const running = p >= 1 && p <= 8;
      const elapsed = running ? tMs - B[1] : (p === 9 ? B[9] - B[1] : 0);
      const status = p < 0 ? 'unarmed' : p === 0 ? 'armed' : p === 9 ? 'complete' : 'running';
      return {
        status, phase: p, current: p >= 0 && p <= 8 ? SUBSTEPS[p] : null,
        currentStartMs: p >= 0 && p <= 8 ? B[p] : null,
        waitingFor: p < 0 ? 'Press Arm with the parts in place' : p === 9 ? 'Cycle complete. Waiting for the next parts' : WAITING[p],
        cycleStartMs: p >= 1 ? B[1] : null, elapsedMs: elapsed,
        done, events: S.events.slice(), lastEvent: S.lastEvent,
        flags: {
          outOfOrder: S.ooo, rework: S.rework, lowConfidence: S.lowConf,
          overStandard: elapsed > cfg.standardCycleS * 1000
        },
        baseline: { pink: S.base.pink, blue: S.base.blue },
        buildMotionEma: S.ema,
        cycles: S.cycles.slice(), cycleNo: S.cycleNo
      };
    }

    // Keep the clock moving without new signals (Manual mode, paused video).
    function tick(tMs) { lastT = tMs; return view(tMs); }
    function setConfig(patch) { Object.assign(cfg, patch || {}); }
    function clearCycles() { S.cycles = []; S.cycleNo = 0; undoStack = []; }
    return { update, tick, unarm, arm, manualAdvance, undo, reset, getState: () => view(lastT), config: cfg, setConfig, clearCycles };
  }

  // ---------- Plain color + motion signals (the detector a model replaces later) ----------
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: mx === 0 ? 0 : d / mx, v: mx };
  }
  const DEFAULT_REFS = { pink: { h: 350, s: 0.35, v: 0.72 }, blue: { h: 196, s: 0.42, v: 0.5 } };
  const DEFAULT_TOL = { pink: { h: 14, s: 0.2, v: 0.3 }, blue: { h: 22, s: 0.3, v: 0.3 } };
  const MOTION = { noise: 6, scale: 32 };   // per-pixel diff noise floor, and the mean diff that counts as motion 1.0
  const ZONE_KEYS = ['pinkStart', 'blueStart', 'build'];

  function matchHsv(h, s, v, ref, tol) {
    let dh = Math.abs(h - ref.h); if (dh > 180) dh = 360 - dh;
    return dh <= tol.h && Math.abs(s - ref.s) <= tol.s && Math.abs(v - ref.v) <= tol.v && s >= 0.12;
  }

  // rgba: RGBA bytes (w*h). zones: {key: {x,y,w,h}} normalized. prevGray: Uint8Array(w*h) or null.
  // hl: optional Uint8ClampedArray(w*h*4) that receives highlight colors inside the zones.
  function computeSignals(rgba, w, h, prevGray, zones, refs, tol, hl) {
    const gray = prevGray ? new Uint8Array(prevGray) : new Uint8Array(w * h);
    const out = {};
    if (hl) hl.fill(0);
    for (const key of ZONE_KEYS) {
      const z = zones[key];
      if (!z) { out[key] = { pink: 0, blue: 0, motion: 0 }; continue; }
      const x0 = Math.max(0, Math.floor(z.x * w)), y0 = Math.max(0, Math.floor(z.y * h));
      const x1 = Math.min(w, Math.ceil((z.x + z.w) * w)), y1 = Math.min(h, Math.ceil((z.y + z.h) * h));
      let n = 0, np = 0, nb = 0, dsum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x, j = i * 4;
          const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
          const gv = (r * 77 + g * 150 + b * 29) >> 8;
          if (prevGray) { const d = Math.abs(gv - prevGray[i]) - MOTION.noise; if (d > 0) dsum += d; }
          gray[i] = gv;
          n++;
          const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
          if (mx - mn < 22) continue; // gray, white and dark pixels never match a color
          const hsv = rgbToHsv(r, g, b);
          if (refs.pink && matchHsv(hsv.h, hsv.s, hsv.v, refs.pink, tol.pink)) { np++; if (hl) { hl[j] = 255; hl[j + 1] = 40; hl[j + 2] = 160; hl[j + 3] = 200; } }
          else if (refs.blue && matchHsv(hsv.h, hsv.s, hsv.v, refs.blue, tol.blue)) { nb++; if (hl) { hl[j] = 20; hl[j + 1] = 140; hl[j + 2] = 255; hl[j + 3] = 200; } }
        }
      }
      out[key] = n ? { pink: np / n, blue: nb / n, motion: prevGray ? clamp01(dsum / n / MOTION.scale) : 0 } : { pink: 0, blue: 0, motion: 0 };
    }
    return { signals: out, gray };
  }

  return {
    SUBSTEPS, LABELS, SOP_STEPS, NOT_DETECTED, ESTIMATED, COLORS, WAITING, DEFAULT_CONFIG, DEFAULT_REFS, DEFAULT_TOL, MOTION, ZONE_KEYS,
    createEngine, computeSignals, rgbToHsv, matchHsv
  };
});
