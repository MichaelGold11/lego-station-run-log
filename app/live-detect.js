// Live detection helpers: YOLO pre and post processing, the map from detections to engine signals,
// and the build quality check (ported from the team's vision/live_check.py).
// No dependencies. Browser: window.LiveDetect. Node: module.exports.
//
// Boxes: `box` is in source pixels [x1,y1,x2,y2]; `nbox` is the same box in 0..1 of the frame.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiveDetect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CLASSES = ['plate', 'pink_brick', 'blue_slope'];
  const PLATE = 'plate', PINK = 'pink_brick', BLUE = 'blue_slope';
  const PART_NAME = { plate: 'white plate', pink_brick: 'pink brick', blue_slope: 'blue slope' };
  const STEPS = [
    { part: PLATE, text: 'Place base plate' },
    { part: PINK, text: 'Attach pink brick' },
    { part: BLUE, text: 'Secure blue slope' }
  ];
  const TUNING = {
    detectConf: 0.35,     // boxes below this are ignored
    sureConf: 0.60,       // a decision that rests on a box below this becomes "needs review"
    clearSeconds: 0.3,    // hands must be gone this long before a check
    posTolerance: 0.13,   // allowed position error, as a share of the plate size
    motionLimit: 4.0,     // mean pixel change (0..255) that still counts as still
    plateMargin: 0.08,    // student's on-plate margin
    whiteV: 110,          // the plate must look white: median brightness above this
    plateExpand: 0.15,    // plate box grows by this share for the "part is on the plate" test
    handMotion: 0.35,     // motion value given to a zone that has a hand landmark in it
    startPad: 0.3,        // start zones count 30 percent bigger (a part sitting near the edge of a drawn zone still counts)
    pad: 114              // letterbox gray, same as ultralytics
  };

  // ---------- model input and output ----------
  // Same geometry as ultralytics letterbox: scale to fit, gray padding, centered.
  function letterbox(srcW, srcH, size) {
    const scale = Math.min(size / srcW, size / srcH);
    const nw = Math.round(srcW * scale), nh = Math.round(srcH * scale);
    const dw = (size - nw) / 2, dh = (size - nh) / 2;
    return { scale, nw, nh, padX: Math.round(dw - 0.1), padY: Math.round(dh - 0.1), size };
  }

  // rgba (size*size*4) -> out Float32Array(3*size*size), channels first, 0..1.
  function fillTensor(rgba, size, out) {
    const n = size * size, o = out || new Float32Array(3 * n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      o[i] = rgba[j] / 255; o[n + i] = rgba[j + 1] / 255; o[2 * n + i] = rgba[j + 2] / 255;
    }
    return o;
  }

  // Raw YOLO output [1, 4 + classes, N]: rows cx, cy, w, h (model pixels), then one score per class. Needs NMS.
  // (This model's NMS-free head was not the trained one, so the plain head plus NMS is what matches best.pt.)
  // Returns detections in frame pixels, highest confidence first. Same rules as ultralytics: best class per anchor, class-wise NMS at iou.
  // classes (optional): class names in model order for another model (the /line page). Defaults to the LEGO classes.
  function decode(data, n, lb, srcW, srcH, minConf, iou, classes) {
    const names = classes || CLASSES, nc = names.length, cand = [];
    for (let i = 0; i < n; i++) {
      let best = -1, score = 0;
      for (let c = 0; c < nc; c++) { const v = data[(4 + c) * n + i]; if (v > score) { score = v; best = c; } }
      if (best < 0 || !(score >= minConf)) continue;
      const cx = data[i], cy = data[n + i], w = data[2 * n + i], h = data[3 * n + i];
      cand.push({ c: best, s: score, b: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] });
    }
    cand.sort((x, y) => y.s - x.s);
    const thr = iou == null ? 0.7 : iou, keep = [];
    const area = b => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    for (const d of cand) {
      let ok = true;
      for (const k of keep) {
        if (k.c !== d.c) continue;
        const ix = Math.max(0, Math.min(k.b[2], d.b[2]) - Math.max(k.b[0], d.b[0])), iy = Math.max(0, Math.min(k.b[3], d.b[3]) - Math.max(k.b[1], d.b[1]));
        const inter = ix * iy;
        if (inter / (area(k.b) + area(d.b) - inter) > thr) { ok = false; break; }
      }
      if (ok) keep.push(d);
    }
    const clampX = v => Math.max(0, Math.min(srcW, v)), clampY = v => Math.max(0, Math.min(srcH, v));
    const out = [];
    for (const k of keep) {
      const x1 = clampX((k.b[0] - lb.padX) / lb.scale), y1 = clampY((k.b[1] - lb.padY) / lb.scale);
      const x2 = clampX((k.b[2] - lb.padX) / lb.scale), y2 = clampY((k.b[3] - lb.padY) / lb.scale);
      if (x2 - x1 < 2 || y2 - y1 < 2) continue;
      out.push({ cls: names[k.c], conf: k.s, box: [x1, y1, x2, y2], nbox: [x1 / srcW, y1 / srcH, x2 / srcW, y2 / srcH] });
    }
    return out;
  }

  // Any supported output tensor: the raw head [1, 4 + nc, N] (decoded above, nc read from the shape) or an end-to-end
  // head [1, N, 6] with rows x1, y1, x2, y2, score, class (model pixels, NMS already done). classes: names in model order;
  // a class the list does not name is called class_<i>.
  function decodeOutput(data, dims, lb, srcW, srcH, minConf, iou, classes) {
    const names = classes || CLASSES;
    const name = i => names[i] || ('class_' + i);
    if (dims.length === 3 && dims[2] === 6 && dims[1] > 6) {
      const n = dims[1], out = [];
      const clampX = v => Math.max(0, Math.min(srcW, v)), clampY = v => Math.max(0, Math.min(srcH, v));
      for (let i = 0; i < n; i++) {
        const o = i * 6, s = data[o + 4];
        if (!(s >= minConf)) continue;
        const x1 = clampX((data[o] - lb.padX) / lb.scale), y1 = clampY((data[o + 1] - lb.padY) / lb.scale);
        const x2 = clampX((data[o + 2] - lb.padX) / lb.scale), y2 = clampY((data[o + 3] - lb.padY) / lb.scale);
        if (x2 - x1 < 2 || y2 - y1 < 2) continue;
        out.push({ cls: name(Math.round(data[o + 5])), conf: s, box: [x1, y1, x2, y2], nbox: [x1 / srcW, y1 / srcH, x2 / srcW, y2 / srcH] });
      }
      return out.sort((a, b) => b.conf - a.conf);
    }
    const nc = Math.max(1, dims[1] - 4), list = [];
    for (let i = 0; i < nc; i++) list.push(name(i));
    return decode(data, dims[2], lb, srcW, srcH, minConf, iou, list);
  }

  // Median brightness (V of HSV = max channel) of a box in an RGBA image. The plate is white, so a dark box is not it.
  function medianV(rgba, w, h, box) {
    const x1 = Math.max(0, Math.floor(box[0])), y1 = Math.max(0, Math.floor(box[1]));
    const x2 = Math.min(w, Math.ceil(box[2])), y2 = Math.min(h, Math.ceil(box[3]));
    if (x2 <= x1 || y2 <= y1) return 0;
    const hist = new Uint32Array(256); let n = 0;
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
      const j = (y * w + x) * 4, r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
      hist[r > g ? (r > b ? r : b) : (g > b ? g : b)]++; n++;
    }
    let acc = 0; const half = n / 2;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= half) return v; }
    return 0;
  }

  // Best box per class. plateOk(det) can veto a plate box (the white test).
  function bestPerClass(dets, minConf, plateOk) {
    const best = {};
    for (const d of dets) {
      if (d.conf < (minConf == null ? TUNING.detectConf : minConf)) continue;
      if (d.cls === PLATE && plateOk && !plateOk(d)) continue;
      if (!best[d.cls] || d.conf > best[d.cls].conf) best[d.cls] = d;
    }
    return best;
  }

  // ---------- detections -> engine signals ----------
  const centerOf = nb => [(nb[0] + nb[2]) / 2, (nb[1] + nb[3]) / 2];
  const inRect = (p, z) => p[0] >= z.x && p[0] <= z.x + z.w && p[1] >= z.y && p[1] <= z.y + z.h;
  // Grow a box [x1,y1,x2,y2] so its width and height are `frac` larger, around its center.
  function expandBox(nb, frac) {
    const dx = (nb[2] - nb[0]) * frac / 2, dy = (nb[3] - nb[1]) * frac / 2;
    return [nb[0] - dx, nb[1] - dy, nb[2] + dx, nb[3] + dy];
  }
  const boxToRect = b => ({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] });
  function overlapShare(nb, rect) { // share of the part box that lies inside the rect
    const ix = Math.max(0, Math.min(nb[2], rect.x + rect.w) - Math.max(nb[0], rect.x));
    const iy = Math.max(0, Math.min(nb[3], rect.y + rect.h) - Math.max(nb[1], rect.y));
    const a = (nb[2] - nb[0]) * (nb[3] - nb[1]);
    return a > 0 ? (ix * iy) / a : 0;
  }
  // hands: array of hands, each an array of landmarks {x, y} in 0..1.
  function handInZone(hands, zone) {
    if (!hands || !zone) return false;
    for (const h of hands) for (const p of h) if (inRect([p.x, p.y], zone)) return true;
    return false;
  }

  // best: bestPerClass result. zones: {pinkStart, blueStart, build} as {x,y,w,h} (0..1).
  // motion: {pinkStart, blueStart, build} from frame differencing (0..1). hands: landmarks or null.
  // Returns the engine's signals: {zone: {pink, blue, motion}}.
  // all (optional): every detection above the floor. A start zone looks at all of them, so a false box elsewhere that scores
  // higher than the real part (a speaker grille read as the blue slope) cannot hide it.
  function mapSignals(best, zones, motion, hands, opts, all) {
    const o = Object.assign({}, TUNING, opts || {});
    const part = { pink: best[PINK] || null, blue: best[BLUE] || null };
    const pool = all && all.length ? all.filter(d => d.conf >= o.detectConf) : Object.values(best);
    const cls = { pink: PINK, blue: BLUE };
    const grow = z => ({ x: z.x - z.w * o.startPad / 2, y: z.y - z.h * o.startPad / 2, w: z.w * (1 + o.startPad), h: z.h * (1 + o.startPad) });
    const sig = {};
    for (const key of ['pinkStart', 'blueStart']) {
      const z = zones[key] ? grow(zones[key]) : null, s = { pink: 0, blue: 0, motion: 0 };
      for (const k of ['pink', 'blue']) {
        if (!z) continue;
        for (const d of pool) if (d.cls === cls[k] && d.conf > s[k] && inRect(centerOf(d.nbox), z)) s[k] = d.conf;
      }
      sig[key] = s;
    }
    const plate = best[PLATE] || null;
    const region = plate ? boxToRect(expandBox(plate.nbox, o.plateExpand)) : (zones.build || null);
    const b = { pink: 0, blue: 0, motion: 0 };
    for (const k of ['pink', 'blue']) {
      if (!part[k] || !region) continue;
      const onIt = plate ? inRect(centerOf(part[k].nbox), region) : overlapShare(part[k].nbox, region) >= 0.5;
      if (onIt) b[k] = part[k].conf;
    }
    sig.build = b;
    for (const key of ['pinkStart', 'blueStart', 'build']) {
      let m = Math.max(0, Math.min(1, (motion && motion[key]) || 0));
      if (handInZone(hands, zones[key])) m = Math.max(m, o.handMotion);
      sig[key].motion = m;
    }
    return sig;
  }

  // ---------- global stillness (is anything moving in the whole frame) ----------
  // Block-averages the frame to a small gray image and returns {mean, gray}. prev is the previous gray or null.
  function globalMotion(rgba, w, h, prev) {
    const gw = 80, gh = Math.max(1, Math.round(80 * h / w));
    const gray = new Uint8Array(gw * gh), bx = w / gw, by = h / gh;
    let sum = 0;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0, n = 0;
      const x0 = Math.floor(x * bx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * bx)), y0 = Math.floor(y * by), y1 = Math.max(y0 + 1, Math.floor((y + 1) * by));
      for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) {
        const j = (yy * w + xx) * 4; s += (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8; n++;
      }
      const g = n ? s / n : 0, i = y * gw + x;
      gray[i] = g;
      if (prev && prev.length === gray.length) sum += Math.abs(g - prev[i]);
    }
    return { mean: prev && prev.length === gray.length ? sum / gray.length : 0, gray };
  }

  // ---------- plate geometry ----------
  const landscape = d => (d.box[2] - d.box[0]) >= (d.box[3] - d.box[1]);
  function onPlate(part, plate, margin) {
    const m = margin == null ? TUNING.plateMargin : margin;
    const [x1, y1, x2, y2] = plate.box, mx = (x2 - x1) * m, my = (y2 - y1) * m;
    const c = [(part.box[0] + part.box[2]) / 2, (part.box[1] + part.box[3]) / 2];
    return c[0] >= x1 - mx && c[0] <= x2 + mx && c[1] >= y1 - my && c[1] <= y2 + my;
  }
  function relative(part, plate) {
    const [x1, y1, x2, y2] = plate.box, pw = x2 - x1, ph = y2 - y1;
    const cx = (part.box[0] + part.box[2]) / 2, cy = (part.box[1] + part.box[3]) / 2;
    return { x: (cx - x1) / pw, y: (cy - y1) / ph, w: (part.box[2] - part.box[0]) / pw, h: (part.box[3] - part.box[1]) / ph };
  }
  // Reference positions as seen if the plate is turned. Fractions of the plate: a quarter turn swaps w and h.
  const rot180 = p => ({ x: 1 - p.x, y: 1 - p.y, w: p.w, h: p.h });
  const rotCW = p => ({ x: 1 - p.y, y: p.x, w: p.h, h: p.w });
  const rotCCW = p => ({ x: p.y, y: 1 - p.x, w: p.h, h: p.w });
  // The reference as it can look now. Same plate orientation: as saved, or flipped 180 degrees (a box can't tell them apart).
  // Other orientation (portrait vs landscape): a quarter turn either way.
  function refVariants(ref, plateLandscape) {
    const fns = (!!ref.plate_landscape === !!plateLandscape) ? [p => p, rot180] : [rotCW, rotCCW];
    return fns.map(f => { const parts = {}; for (const k of Object.keys(ref.parts)) parts[k] = f(ref.parts[k]); return parts; });
  }

  // ---------- the quality check ----------
  function verdict(kind, message, step, badPart, confidence, reason) {
    return { kind, message, step: step == null ? -1 : step, badPart: badPart || null, confidence: confidence || 0, reason: reason || null };
  }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  // dets: bestPerClass result (px boxes). ref: saved correct build. cycle: {done}.
  function checkBuild(dets, ref, cycle, opts) {
    const o = Object.assign({}, TUNING, opts || {});
    const plate = dets[PLATE];
    const order = STEPS.map(s => s.part);
    if (!plate) {
      if (cycle.done === 0 || cycle.done === STEPS.length) return verdict('idle', 'Place the white plate to start', 0);
      return verdict('review', 'Plate not visible. Is it covered or out of view?', cycle.done, PLATE, 0, 'low_confidence');
    }
    const placed = {};
    for (const n of Object.keys(dets)) if (n !== PLATE && onPlate(dets[n], plate, o.plateMargin)) placed[n] = dets[n];
    const sureKind = (...c) => (Math.min(...c) >= o.sureConf ? 'error' : 'review');

    // 1) a part placed before an earlier step is done
    for (let i = 1; i < STEPS.length; i++) {
      const part = order[i];
      if (!placed[part]) continue;
      const missing = order.slice(1, i).filter(p => !placed[p]);
      if (missing.length) {
        return verdict(sureKind(placed[part].conf, plate.conf), `Wrong order: ${PART_NAME[part]} placed before ${PART_NAME[missing[0]]} (step ${order.indexOf(missing[0]) + 1} skipped)`,
          order.indexOf(missing[0]), part, placed[part].conf, 'wrong_order');
      }
    }

    // 2) every placed part must be where the saved build says. Pick the plate turn that fits best.
    const variants = refVariants(ref, landscape(plate));
    const errOf = parts => {
      let worst = 0;
      for (const n of Object.keys(placed)) {
        const want = parts[n]; if (!want) continue;
        const r = relative(placed[n], plate);
        worst = Math.max(worst, Math.abs(r.x - want.x), Math.abs(r.y - want.y));
      }
      return worst;
    };
    const parts = variants.reduce((a, b) => (errOf(b) < errOf(a) ? b : a));
    for (const n of Object.keys(placed)) {
      const want = parts[n]; if (!want) continue;
      const d = placed[n], r = relative(d, plate);
      const off = Math.max(Math.abs(r.x - want.x), Math.abs(r.y - want.y));
      const turned = (r.w >= r.h) !== (want.w >= want.h);
      if (off > o.posTolerance || turned) {
        return verdict(sureKind(d.conf, plate.conf), `${cap(PART_NAME[n])} ${turned ? 'turned the wrong way' : 'in the wrong spot'}`,
          order.indexOf(n), n, d.conf, turned ? 'turned' : 'wrong_spot');
      }
    }

    // 3) a part that was already verified has gone missing
    for (let i = 1; i < cycle.done; i++) {
      if (!placed[order[i]]) return verdict('error', `${cap(PART_NAME[order[i]])} is missing (step ${i + 1})`, i, order[i], 0, 'missing');
    }

    // 4) progress
    const nPresent = 1 + order.slice(1).filter(p => placed[p]).length;
    if (nPresent > cycle.done) {
      const part = order[nPresent - 1], conf = part === PLATE ? plate.conf : placed[part].conf;
      if (conf < o.sureConf) {
        return verdict('review', `Step ${nPresent} looks done but I'm not sure (${Math.round(conf * 100)}%). Please check.`, nPresent - 1, part, conf, 'low_confidence');
      }
      if (nPresent === STEPS.length) return verdict('complete', 'Assembly complete', nPresent - 1, null, conf);
      return verdict('verified', `Step ${nPresent} verified`, nPresent - 1, null, conf);
    }
    return verdict('waiting', 'No change yet', cycle.done);
  }

  // Average a few frames of detections into the saved correct build. Returns the reference or an error text.
  function makeReference(detsList, opts) {
    const o = Object.assign({}, TUNING, opts || {});
    const good = detsList.filter(d => d[PLATE] && d[PINK] && d[BLUE] && onPlate(d[PINK], d[PLATE], o.plateMargin) && onPlate(d[BLUE], d[PLATE], o.plateMargin));
    if (good.length < Math.max(2, Math.floor(detsList.length / 3))) {
      const missing = [PLATE, PINK, BLUE].filter(p => !detsList.some(d => d[p])).map(p => PART_NAME[p]);
      return missing.length ? 'Could not see the ' + missing.join(' and the ') + '.' : 'Parts are not clearly on the plate. Keep hands away and try again.';
    }
    const med = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const ref = { plate_landscape: good.filter(d => landscape(d[PLATE])).length > good.length / 2, parts: {}, saved: new Date().toISOString() };
    for (const p of [PINK, BLUE]) {
      const rels = good.map(d => relative(d[p], d[PLATE]));
      ref.parts[p] = {}; for (const k of ['x', 'y', 'w', 'h']) ref.parts[p][k] = med(rels.map(r => r[k]));
    }
    return ref;
  }

  // Turns a stream of detections into verdicts, only while the view is clear of hands. Time is passed in (seconds).
  function createChecker(opts) {
    const o = Object.assign({}, TUNING, opts || {});
    let ref = null, cycle, verdictNow = null, clearSince = null, checked = false, recent = [], events = [], clear = false;
    const fresh = () => { cycle = { done: 0, started: null, stepStarted: null, stepTimes: [], errors: 0 }; };
    fresh();

    function apply(v, now) {
      if (v.kind === 'waiting') return null;
      if (v.kind === 'idle') {
        if (cycle.done === STEPS.length) { fresh(); }   // the finished build was taken away: next cycle
        verdictNow = v; return null;
      }
      if (cycle.done === STEPS.length && v.kind === 'complete') return null;
      verdictNow = v;
      if (v.kind === 'verified' || v.kind === 'complete') {
        if (cycle.started == null) cycle.started = cycle.stepStarted = now;
        const stepS = Math.round((now - (cycle.stepStarted == null ? now : cycle.stepStarted)) * 10) / 10;
        cycle.stepTimes.push(stepS); cycle.done = v.step + 1; cycle.stepStarted = now;
        if (v.kind === 'complete') v.message = 'Assembly complete. Remove the build to start the next one.';
      } else if (v.kind === 'error') cycle.errors++;
      const ev = Object.assign({ t: now }, v);
      events.push(ev);
      return ev;
    }

    // dets: bestPerClass result. view: {hands: bool, still: bool}. Returns a new event or null.
    // now: time stamped on events (seconds). clock: a wall clock for the hands-clear timer (defaults to now), so a paused video can still clear.
    function step(dets, view, now, clock) {
      const c = clock == null ? now : clock;
      if (view.hands || !view.still) clearSince = null;
      else if (clearSince == null) clearSince = c;
      clear = clearSince != null && c - clearSince >= o.clearSeconds;
      if (view.hands || !clear) {
        if (cycle.started == null && view.hands) cycle.started = cycle.stepStarted = now;
        if (!clear) { checked = false; recent = []; }
        return null;
      }
      if (!ref) return null;
      recent = recent.concat([dets]).slice(-3);
      if (checked || recent.length < 3) return null;
      checked = true;
      const votes = recent.map(d => checkBuild(d, ref, cycle, o));
      const kinds = votes.map(v => v.kind);
      let v = votes[0];
      for (const x of votes) if (kinds.filter(k => k === x.kind).length > kinds.filter(k => k === v.kind).length) v = x;
      if (kinds.filter(k => k === v.kind).length < 2) {
        v = verdict('review', 'Results flickered between checks. Hold still and clear the view again.', cycle.done, null, 0, 'low_confidence');
      }
      return apply(v, now);
    }
    return {
      step, setRef(r) { ref = r || null; }, hasRef: () => !!ref, restart() { fresh(); verdictNow = null; checked = false; recent = []; },
      get cycle() { return cycle; }, get verdict() { return verdictNow; }, get events() { return events; }, get clear() { return clear; },
      clearEvents() { events = []; }
    };
  }

  return {
    CLASSES, PLATE, PINK, BLUE, PART_NAME, STEPS, TUNING,
    letterbox, fillTensor, decode, decodeOutput, medianV, bestPerClass,
    expandBox, handInZone, mapSignals, globalMotion,
    landscape, onPlate, relative, refVariants, checkBuild, makeReference, createChecker
  };
});
