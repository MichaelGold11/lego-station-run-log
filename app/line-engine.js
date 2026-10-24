// Wire line engine: config-driven substep tracking for several stations, the zone signal code, the QA logic,
// and the metric and CSV functions. The /line page, the server (CSV exports) and the tests all load this file.
// No dependencies, no DOM. Browser: window.LineEngine. Node: module.exports.
//
// Pipeline per station: frame -> zoneSignals (+ classSignals, handPresence) -> createStation().update -> events,
// then createChecker().update (those events + model results + clear view) -> verdicts (mistake alerts).
// Signals are per zone, all 0..1: { work: { activity, bright, 'class:cutter': 0.7 }, ... }.
// A zone that is not drawn is left out, and a signal that is not available yet (bright before calibration,
// classes with the model off) is left out too. A rule that reads a missing signal is "not ready" and never fires.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LineEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = { activity: 0.1, bright: 0.5, class: 0.4 };
  const MOTION = { noise: 6, scale: 32 };      // per-pixel gray diff noise floor, and the mean diff that counts as motion 1.0
  const BRIGHT_SPAN = 60;                        // without a "Bulb on" calibration, a rise of 60 gray levels counts as bright 1.0
  const MISMATCH_NOTE = 'quality mismatch, review the video';
  const EVENT_TYPES = ['substep', 'cycle_end', 'qa_result', 'flag', 'manual', 'session_start', 'session_end', 'source_change', 'verdict', 'operator'];
  const CYCLE_ACTIONS = { cycle_done: 'unknown', pass: 'pass', fail: 'fail' };   // manual actions that close a manual cycle

  const clamp01 = v => Math.max(0, Math.min(1, v));
  const round = (v, d) => { const k = Math.pow(10, d == null ? 3 : d); return Math.round(v * k) / k; };
  const isNum = v => typeof v === 'number' && isFinite(v);

  // ---------- rules ----------
  // A rule is {zone, signal, min} or {zone, class, min} or {anyOf: [rule, ...]}. min falls back to the config defaults.
  const members = rule => (rule ? (Array.isArray(rule.anyOf) ? rule.anyOf : [rule]) : []);
  const sigKey = m => (m.class ? 'class:' + m.class : (m.signal || 'activity'));
  function memberMin(m, defaults) {
    if (isNum(m.min)) return m.min;
    const d = Object.assign({}, DEFAULTS, defaults);
    return m.class ? d.class : (isNum(d[m.signal || 'activity']) ? d[m.signal || 'activity'] : DEFAULTS.activity);
  }

  // The rule that drives a substep now: the model rule when a model is loaded that knows all its classes, else the zones rule.
  function activeRule(sub, modelClasses) {
    if (modelClasses && sub.model) {
      const cls = members(sub.model).map(m => m.class).filter(Boolean);
      if (cls.length && cls.every(c => modelClasses.indexOf(c) >= 0)) return { kind: 'model', rule: sub.model };
    }
    if (sub.zones) return { kind: 'zones', rule: sub.zones };
    return null;
  }

  // ready: at least one member has its signal. ok: some member is at or over its min. v: the highest member value.
  function evalRule(rule, signals, defaults) {
    let ready = false, ok = false, v = 0;
    const vals = [];
    for (const m of members(rule)) {
      const z = signals && signals[m.zone], x = z ? z[sigKey(m)] : undefined;
      if (!isNum(x)) { vals.push(null); continue; }
      ready = true; vals.push(x);
      if (x >= memberMin(m, defaults)) ok = true;
      if (x > v) v = x;
    }
    return { ready, ok, v, vals };
  }

  // What a rule still needs before it can fire: [{zone}] (zone not drawn) or [{zone, signal}] (signal not there yet).
  function missingOf(rule, signals) {
    const out = [];
    for (const m of members(rule)) {
      const z = signals && signals[m.zone];
      if (!z) out.push({ zone: m.zone });
      else if (!isNum(z[sigKey(m)])) out.push({ zone: m.zone, signal: sigKey(m) });
    }
    return out;
  }

  // Plain English for a rule, using the station's zone labels.
  function ruleText(rule, station) {
    const zl = id => { const z = station && station.zones && station.zones.find(x => x.id === id); return z ? z.label : id; };
    return members(rule).map(m => (m.class ? 'model sees ' + m.class + ' in ' + zl(m.zone) : (m.signal === 'bright' ? zl(m.zone) + ' goes bright' : 'activity in ' + zl(m.zone)))).join(' or ');
  }

  // Problems in a line config (the team edits it by hand). Returns a list of plain sentences; empty means fine.
  function checkConfig(cfg) {
    const errs = [];
    if (!cfg || !Array.isArray(cfg.stations) || !cfg.stations.length) return ['The config has no stations.'];
    const seenSt = {}, seenSub = {};
    for (const st of cfg.stations) {
      if (!st || !/^[a-z][a-z0-9_]{0,15}$/.test(st.id || '')) { errs.push('Station id "' + (st && st.id) + '" must be short lowercase letters, digits or _.'); continue; }
      if (seenSt[st.id]) errs.push('Station ' + st.id + ' appears twice.');
      seenSt[st.id] = true;
      const zones = {};
      for (const z of st.zones || []) { if (!/^[a-z][a-z0-9_]{0,23}$/.test(z.id || '')) errs.push(st.id + ': zone id "' + z.id + '" is not valid.'); zones[z.id] = true; }
      if (!Array.isArray(st.substeps) || !st.substeps.length) { errs.push(st.id + ' has no substeps.'); continue; }
      for (const sub of st.substeps) {
        if (seenSub[sub.id]) errs.push('Substep ' + sub.id + ' appears twice.');
        seenSub[sub.id] = true;
        for (const kind of ['zones', 'model']) {
          for (const m of members(sub[kind])) {
            if (!zones[m.zone]) errs.push(sub.id + ' (' + kind + ' rule) uses zone "' + m.zone + '", which ' + st.id + ' does not have.');
            if (kind === 'model' && !m.class) errs.push(sub.id + ': a model rule needs a class.');
            if (kind === 'zones' && m.signal && m.signal !== 'activity' && m.signal !== 'bright') errs.push(sub.id + ': signal "' + m.signal + '" is not activity or bright.');
          }
        }
        if (sub.model && sub.model.mustStay != null && typeof sub.model.mustStay !== 'boolean') errs.push(sub.id + ': mustStay must be true or false.');
      }
      const pc = st.positionCheck;
      if (pc != null) {
        if (typeof pc !== 'object' || Array.isArray(pc)) errs.push(st.id + ': positionCheck must look like { "anchor": "<zone id>", "classes": ["..."], "tolerance": 0.14 }.');
        else {
          if (!zones[pc.anchor]) errs.push(st.id + ': positionCheck anchor "' + pc.anchor + '" is not one of its zones.');
          if (!Array.isArray(pc.classes) || !pc.classes.length || pc.classes.some(c => typeof c !== 'string' || !c)) errs.push(st.id + ': positionCheck classes must be a non-empty list of class names.');
          if (pc.tolerance != null && !(isNum(pc.tolerance) && pc.tolerance > 0 && pc.tolerance <= 1)) errs.push(st.id + ': positionCheck tolerance must be a number above 0 and at most 1.');
        }
      }
      if (st.cycleEnds && !st.substeps.some(s => s.id === st.cycleEnds)) errs.push(st.id + ': cycleEnds "' + st.cycleEnds + '" is not one of its substeps.');
      if (st.qa) {
        for (const k of ['lightSubstep', 'sortSubstep']) if (st.qa[k] && !st.substeps.some(s => s.id === st.qa[k])) errs.push(st.id + ': qa.' + k + ' "' + st.qa[k] + '" is not one of its substeps.');
        for (const z of Object.keys(st.qa.bins || {})) if (!zones[z]) errs.push(st.id + ': qa bin zone "' + z + '" is not one of its zones.');
      }
    }
    for (const r of cfg.failReasons || []) if (r.cause != null && !seenSt[r.cause]) errs.push('Fail reason ' + r.id + ' names cause station "' + r.cause + '", which does not exist.');
    if (cfg.sounds != null && (typeof cfg.sounds !== 'object' || Array.isArray(cfg.sounds) || (cfg.sounds.verified != null && typeof cfg.sounds.verified !== 'boolean'))) errs.push('sounds must look like { "verified": true }.');
    if (cfg.model) errs.push(...modelShapeErrors('model', cfg.model));
    if (cfg.models != null) {
      if (typeof cfg.models !== 'object' || Array.isArray(cfg.models)) errs.push('models must be an object keyed by station id: { "s1": { "file": "/models/<name>.onnx", "classes": [...] } }.');
      else for (const id of Object.keys(cfg.models)) {
        if (!seenSt[id]) { errs.push('models: "' + id + '" is not a station id.'); continue; }
        if (cfg.models[id]) errs.push(...modelShapeErrors('models.' + id, cfg.models[id]));
      }
    }
    return errs;
  }

  // One model entry: { file: "/models/<name>.onnx", classes: [unique strings], imgsz }.
  function modelShapeErrors(name, m) {
    const e = [], ex = name + ' must look like { "file": "/models/<name>.onnx", "classes": [...], "imgsz": 640 }.';
    if (typeof m !== 'object' || Array.isArray(m) || typeof m.file !== 'string' || !/^\/models\/[A-Za-z0-9_.-]+\.onnx$/.test(m.file) || !Array.isArray(m.classes)) return [ex];
    if (!m.classes.length || m.classes.some(c => typeof c !== 'string' || !c)) e.push(name + ': classes must be a non-empty list of names.');
    else if (new Set(m.classes).size !== m.classes.length) e.push(name + ': classes must not repeat a name.');
    return e;
  }
  // The model a station runs: its own entry in cfg.models, else the shared cfg.model, else null.
  function modelFor(cfg, id) { return (cfg && cfg.models && cfg.models[id]) || (cfg && cfg.model) || null; }
  // Class count from an output shape. Raw head [1, 4 + C, N] gives C; end-to-end [1, N, 6] does not (found null).
  function checkModelOutput(dims, k) {
    const d = Array.from(dims || []);
    if (d.length === 3 && d[2] === 6 && d[1] > 6) return { kind: 'e2e', found: null, ok: true };
    if (d.length === 3 && d[1] > 4) return { kind: 'raw', found: d[1] - 4, ok: d[1] - 4 === k };
    return { kind: 'unknown', found: null, ok: false };
  }
  // End-to-end head rows (x1, y1, x2, y2, score, class): true if a row at or above minConf has a class index outside 0..k-1.
  function e2eBadClass(data, n, k, minConf) {
    for (let i = 0; i < n; i++) if (data[i * 6 + 4] >= minConf) { const c = Math.round(data[i * 6 + 5]); if (c < 0 || c >= k) return true; }
    return false;
  }

  // ---------- operators (docs/dashboard-plan.md, decision 1): an anonymous code and a training level, never a name ----------
  const LEVELS = [{ id: 'new', label: 'New' }, { id: 'training', label: 'In training' }, { id: 'certified', label: 'Certified' }];
  const OPERATOR_CODE = /^Op-\d{2,3}$/;
  // "7", "07", "op-7" or "Op-07" -> "Op-07". Anything else (a name) -> null.
  function operatorCode(v) {
    const m = /^\s*(?:op\s*-?\s*)?(\d{1,3})\s*$/i.exec(String(v == null ? '' : v));
    return m ? 'Op-' + String(Number(m[1])).padStart(2, '0') : null;
  }

  // ---------- floor layouts (docs/canvas-plan.md) ----------
  // A layout places stations on the floor: [{ id, name, role, x, y }] in flow order. A role is a station of the config
  // (its substeps, zones, QA block and model); a station id is a camera spot on this laptop. Floor units are CSS pixels
  // at 100% zoom. The built-in Class test is the config's stations in Michael's L: S1, S2 below it, then to the right.
  const FLOOR = { grid: 40, cardW: 640, dx: 760, dy: 560 };
  const CLASS_TEST = 'class-test';
  const defaultName = (id, roleLabel) => String(id).toUpperCase() + ' ' + (roleLabel || '');
  // The name without a leading station id ("S5 QA test" -> "QA test"), for a card whose badge already shows the id.
  function shortName(id, name, roleLabel) {
    const s = String(name || '').trim(), p = String(id || '').toUpperCase();
    const rest = p && s.toUpperCase().startsWith(p) && !/[A-Za-z0-9]/.test(s.charAt(p.length)) ? s.slice(p.length).replace(/^[\s:.,-]+/, '') : s;
    return rest || roleLabel || p;
  }
  function classTestLayout(cfg) {
    const stations = ((cfg && cfg.stations) || []).map((s, i) => ({ id: s.id, name: defaultName(s.id, s.label), role: s.id, x: i === 0 ? 0 : (i - 1) * FLOOR.dx, y: i === 0 ? 0 : FLOOR.dy }));
    return { id: CLASS_TEST, name: 'Class test', builtIn: true, stations };
  }
  // Zones and calibration are kept per station and role: "s2" for station s2 running its own role, "s5:s4" otherwise.
  const setupKey = (id, role) => (!role || role === id ? id : id + ':' + role);
  // The lowest free s<n> in a layout.
  function nextStationId(stations) {
    const used = {};
    for (const s of stations || []) used[s.id] = true;
    let n = 1;
    while (used['s' + n]) n++;
    return 's' + n;
  }
  // The config the page, the summary and the exports run on: one station per layout entry, a copy of its role with the
  // layout's id, name, position and order. Models are keyed by station id (a station runs its role's model), and a fail
  // reason's cause station is the first station in flow order that runs that role. Entries with an unknown role are left out.
  function applyLayout(cfg, layout) {
    if (!cfg || !layout || !Array.isArray(layout.stations)) return cfg;
    const roles = {};
    for (const s of cfg.stations || []) roles[s.id] = s;
    const stations = layout.stations.filter(ls => ls && roles[ls.role]).map((ls, i) => Object.assign(JSON.parse(JSON.stringify(roles[ls.role])),
      { id: ls.id, role: ls.role, name: ls.name || defaultName(ls.id, roles[ls.role].label), x: isNum(ls.x) ? ls.x : 0, y: isNum(ls.y) ? ls.y : 0, order: i + 1 }));
    const first = role => { const s = stations.find(x => x.role === role); return s ? s.id : null; };
    const byStation = obj => { const out = {}; if (obj && typeof obj === 'object' && !Array.isArray(obj)) for (const s of stations) if (obj[s.role]) out[s.id] = obj[s.role]; return out; };
    return Object.assign({}, cfg, {
      stations, models: byStation(cfg.models), suggestedClasses: byStation(cfg.suggestedClasses),
      failReasons: (cfg.failReasons || []).map(r => Object.assign({}, r, { cause: r.cause == null ? null : first(r.cause) })),
      layout: { id: layout.id || null, name: layout.name || '' }
    });
  }

  // ---------- QA decision (station 4) ----------
  // manual: {result, reason} or null. light: true, false or null (bulb zone not usable). bin: 'pass', 'fail' or null.
  function qaDecide(q) {
    const manual = q && q.manual, light = q ? q.light : null, bin = q ? q.bin : null;
    const result = manual && manual.result ? manual.result : (bin || 'unknown');
    const reason = result === 'fail' && manual && manual.result === 'fail' ? (manual.reason || null) : null;
    const mismatch = light != null && bin != null && light !== (bin === 'pass');
    return { result, reason, mismatch, fromManual: !!(manual && manual.result) };
  }

  // ---------- one station ----------
  // station: one entry of config.stations. opts: { holdFrames, defaults, qaGraceSec, modelClasses }.
  // update(signals, tMs) and tick(tMs) return the new events (plain objects, see docs/wire-line-process.md).
  function createStation(station, opts) {
    const o = Object.assign({ holdFrames: 3, defaults: {}, qaGraceSec: 5, modelClasses: null }, opts || {});
    const subs = station.substeps || [];
    const N = Math.max(1, Math.round(o.holdFrames) || 1);
    const defaults = Object.assign({}, DEFAULTS, o.defaults);
    let endIdx = subs.findIndex(s => s.id === station.cycleEnds);
    if (endIdx < 0) endIdx = subs.length - 1;
    const qa = station.qa || null;
    const lightIdx = qa ? subs.findIndex(s => s.id === qa.lightSubstep) : -1;
    let modelClasses = o.modelClasses || null;
    let S = fresh(0);

    function fresh(cycle) {
      return {
        pos: -1, cycle: cycle || 0, cycleStart: null, since: null, t: null, sig: null,
        cnt: {},          // hold counters per substep index: {t0, n, sum, msum, zones, kind}
        off: {},          // off[i]: the rule of substep i was false at least once since we last entered or left it
        occ: [], repeats: 0, lastConf: null, lastSource: null, lastCycleSec: null,
        light: null, lightN: 0, cycleManual: null, pending: null, qaHold: false
      };
    }
    const ev = e => Object.assign({ station: station.id }, e);
    const ruleOf = i => activeRule(subs[i], modelClasses);
    function live(i) { const ar = ruleOf(i); return !!(ar && evalRule(ar.rule, S.sig, defaults).ready); }

    function resolve(p, manual, out) {
      const d = qaDecide({ manual, light: p.light, bin: p.bin });
      const e = { type: 'qa_result', t: p.t, cycle: p.cycle, result: d.result, reason: d.reason, light: p.light, bin: p.bin, source: d.fromManual ? 'manual' : p.source };
      if (d.fromManual && isNum(manual.t)) e.manualT = manual.t;
      out.push(ev(e));
      if (d.mismatch) out.push(ev({ type: 'flag', t: p.t, cycle: p.cycle, note: MISMATCH_NOTE, light: p.light, bin: p.bin, source: p.source }));
    }
    function duePending(t, out) {
      if (S.pending && !S.qaHold && t - S.pending.t >= o.qaGraceSec * 1000) { const p = S.pending; S.pending = null; resolve(p, null, out); }
    }

    // Light: the light substep's rule held for N frames since the last cycle end. null while the bulb zone is not usable.
    function trackLight() {
      const ar = ruleOf(lightIdx), r = ar ? evalRule(ar.rule, S.sig, defaults) : null;
      if (!r || !r.ready) { S.lightN = 0; return; }
      if (S.light == null) S.light = false;
      if (r.ok) { if (++S.lightN >= N) S.light = true; } else S.lightN = 0;
    }

    // Which bin the sort went to: the anyOf member with the most signal over the hold window.
    function binOf(c, i) {
      if (!qa || subs[i].id !== qa.sortSubstep || !qa.bins) return null;
      let best = -1, bv = -1;
      c.msum.forEach((s, k) => { if (s > bv) { bv = s; best = k; } });
      const zone = best >= 0 ? c.zones[best] : null;
      return zone && qa.bins[zone] ? qa.bins[zone] : null;
    }

    // Forward moves need the rule held N frames. Going back (a repeat) and starting a cycle also need the rule
    // to have been off since we were last there, so a hand resting in a zone cannot bounce the state back and forth.
    function choose(cands) {
      let fwd = null, back = null;
      for (const i of cands) {
        if (i === S.pos) continue;
        if (S.pos < 0) { if (i !== endIdx && S.off[i] && (fwd == null || i < fwd)) fwd = i; continue; }
        if (i > S.pos) { if (fwd == null || i < fwd) fwd = i; } else if (S.off[i] && (back == null || i > back)) back = i;
      }
      return fwd != null ? fwd : back;
    }

    function transition(i, out) {
      const c = S.cnt[i], sub = subs[i], onset = c.t0, conf = round(c.sum / c.n, 3), source = c.kind;
      const from = S.pos >= 0 ? subs[S.pos].id : null;
      let move = null;
      const skipped = [];
      if (S.pos < 0) {
        if (S.pending && !S.qaHold) { const p = S.pending; S.pending = null; resolve(p, null, out); }
        S.cycle++; S.cycleStart = onset; S.occ = []; S.repeats = 0; move = 'start';
        for (let j = 0; j < i; j++) skipped.push(j);
      } else if (i > S.pos) {
        for (let j = S.pos + 1; j < i; j++) skipped.push(j);
      } else { move = 'repeat'; S.repeats++; }
      // A skipped substep only counts when it could have been seen. The bulb test is left out: a unit whose bulb
      // stays dark is reported as light: false on its qa_result, not as a skipped step.
      const missed = skipped.filter(j => j !== lightIdx && live(j));
      if (!move) move = missed.length ? 'jump' : 'next';
      out.push(ev({ type: 'substep', substep: sub.id, from, move, source, conf, t: onset, cycle: S.cycle }));
      for (const j of missed) out.push(ev({ type: 'flag', substep: subs[j].id, note: 'skipped ' + subs[j].label, source, t: onset, cycle: S.cycle }));
      if (S.pos >= 0) S.off[S.pos] = false;
      S.off[i] = false;
      S.pos = i; S.since = onset; S.lastConf = conf; S.lastSource = source; S.cnt = {};
      S.occ.push({ id: sub.id, t: onset, move });
      if (i === endIdx) {
        const dur = round((onset - S.cycleStart) / 1000, 3);
        out.push(ev({ type: 'cycle_end', substep: sub.id, source, conf, t: onset, cycle: S.cycle, dur }));
        S.lastCycleSec = dur;
        if (qa) {
          const p = { cycle: S.cycle, t: onset, light: S.light, bin: binOf(c, i), source };
          S.light = null; S.lightN = 0;
          if (S.pending) { const old = S.pending; S.pending = null; resolve(old, null, out); }
          if (S.cycleManual) { const m = S.cycleManual; S.cycleManual = null; resolve(p, m, out); } else S.pending = p;
        }
        S.pos = -1; S.off = {};
      }
    }

    function update(signals, t) {
      const out = [];
      S.sig = signals || {}; S.t = t;
      duePending(t, out);
      if (lightIdx >= 0) trackLight();
      const cands = [];
      for (let i = 0; i < subs.length; i++) {
        const ar = ruleOf(i), r = ar ? evalRule(ar.rule, S.sig, defaults) : null;
        if (!r || !r.ready || !r.ok) { delete S.cnt[i]; S.off[i] = true; continue; }
        let c = S.cnt[i];
        if (!c || c.kind !== ar.kind) c = S.cnt[i] = { t0: t, n: 0, sum: 0, msum: r.vals.map(() => 0), zones: members(ar.rule).map(m => m.zone), kind: ar.kind };
        c.n++; c.sum += r.v;
        r.vals.forEach((x, k) => { c.msum[k] += x || 0; });
        if (c.n >= N) cands.push(i);
      }
      const pick = choose(cands);
      if (pick != null) transition(pick, out);
      return out;
    }

    function tick(t) { const out = []; S.t = t; duePending(t, out); return out; }

    // Manual Pass or Fail from the page. It sets the result of the cycle that is waiting for one (ended within the
    // grace time, or a reason is being picked), else of the open cycle. Returns new events (a qa_result, maybe a flag).
    function manualQa(m) {
      const out = [];
      if (!qa || !m) return out;
      S.qaHold = false;
      if (S.pending) { const p = S.pending; S.pending = null; resolve(p, m, out); } else if (S.pos >= 0) S.cycleManual = m;
      return out;
    }
    // While someone picks a fail reason, the waiting cycle does not fall back to the bin.
    function setQaHold(on) { S.qaHold = !!on; }

    // The source changed: drop the open cycle (it was not finished), settle a waiting QA result, keep the cycle count.
    function abandon(t) {
      const out = [];
      if (S.pending) { const p = S.pending; S.pending = null; resolve(p, null, out); }
      const keep = S.cycle;
      S = fresh(keep); S.t = t == null ? null : t;
      return out;
    }
    // Session stop: settle a waiting QA result now (even if a reason was being picked).
    function flush() {
      const out = [];
      if (S.pending) { const p = S.pending; S.pending = null; S.qaHold = false; resolve(p, null, out); }
      return out;
    }
    function restart() { S = fresh(0); }
    function setModel(classes) { modelClasses = classes && classes.length ? classes.slice() : null; S.cnt = {}; }

    function state() {
      return {
        current: S.pos >= 0 ? subs[S.pos].id : null, pos: S.pos, since: S.since, inCycle: S.pos >= 0,
        cycle: S.cycle, cycleStart: S.pos >= 0 ? S.cycleStart : null, occ: S.occ.slice(), repeats: S.repeats,
        lastConf: S.lastConf, lastSource: S.lastSource, lastCycleSec: S.lastCycleSec,
        light: S.light, waitingQa: !!S.pending, t: S.t
      };
    }
    // Per substep: which rule drives it now, whether it can fire, and what it still needs.
    function rules() {
      return subs.map((s, i) => {
        const ar = ruleOf(i), r = ar ? evalRule(ar.rule, S.sig, defaults) : null;
        return {
          id: s.id, label: s.label, kind: ar ? ar.kind : null, rule: ar ? ar.rule : null, ready: !!(r && r.ready), value: r ? r.v : null,
          hasModelRule: !!s.model, missing: ar ? missingOf(ar.rule, S.sig) : [], closes: i === endIdx
        };
      });
    }
    return { update, tick, manualQa, setQaHold, abandon, flush, restart, setModel, state, rules, station, get modelClasses() { return modelClasses; } };
  }

  // ---------- zone signals from pixels ----------
  // rgba: RGBA bytes of a small frame (about 160x120). zones: {id: {x, y, w, h}} in 0..1 (only drawn zones).
  // calib: {motion: {id: baseline}, bright: {id: {off, on}}}. prevGray: the gray frame from the last call or null.
  // Returns {signals: {id: {activity, motion, brightness, bright}}, gray}. bright is null until the zone is calibrated.
  function zoneSignals(rgba, w, h, prevGray, zones, calib) {
    const n0 = w * h, gray = new Uint8Array(n0);
    for (let i = 0, j = 0; i < n0; i++, j += 4) gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    const usePrev = !!(prevGray && prevGray.length === n0);
    const out = {}, hist = new Uint32Array(256);
    for (const id of Object.keys(zones || {})) {
      const z = zones[id];
      if (!z || !(z.w > 0) || !(z.h > 0)) continue;
      const x0 = Math.max(0, Math.floor(z.x * w)), y0 = Math.max(0, Math.floor(z.y * h));
      const x1 = Math.min(w, Math.ceil((z.x + z.w) * w)), y1 = Math.min(h, Math.ceil((z.y + z.h) * h));
      hist.fill(0);
      let n = 0, dsum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x, g = gray[i];
          hist[g]++; n++;
          if (usePrev) { const d = Math.abs(g - prevGray[i]) - MOTION.noise; if (d > 0) dsum += d; }
        }
      }
      if (!n) continue;
      const motion = usePrev ? clamp01(dsum / n / MOTION.scale) : 0;
      // Brightness = mean of the brightest 10 percent of pixels, so a small bulb in a bigger zone still shows.
      const need = Math.max(1, Math.round(n * 0.1));
      let acc = 0, sum = 0;
      for (let v = 255; v >= 0 && acc < need; v--) { const take = Math.min(hist[v], need - acc); acc += take; sum += take * v; }
      const brightness = sum / acc;
      const base = calib && calib.motion && isNum(calib.motion[id]) ? calib.motion[id] : 0;
      const cb = calib && calib.bright && calib.bright[id];
      let bright = null;
      if (cb && isNum(cb.off)) {
        const span = isNum(cb.on) && cb.on - cb.off >= 8 ? cb.on - cb.off : BRIGHT_SPAN;
        bright = clamp01((brightness - cb.off) / span);
      }
      out[id] = { activity: clamp01(motion - base), motion, brightness: round(brightness, 2), bright };
    }
    return { signals: out, gray };
  }

  // Calibration from a few seconds of zoneSignals results: motion baseline = 90th percentile, brightness = mean.
  function calibrationFrom(samples) {
    const motion = {}, brightness = {}, ids = {};
    for (const s of samples || []) for (const id of Object.keys(s || {})) ids[id] = true;
    for (const id of Object.keys(ids)) {
      const ms = samples.map(s => s[id] && s[id].motion).filter(isNum).sort((a, b) => a - b);
      const bs = samples.map(s => s[id] && s[id].brightness).filter(isNum);
      if (ms.length) motion[id] = round(ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.9))], 4);
      if (bs.length) brightness[id] = round(bs.reduce((a, b) => a + b, 0) / bs.length, 2);
    }
    return { motion, brightness };
  }

  const inRect = (x, y, z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
  // Model detections ({cls, conf, nbox}) -> {zone: {'class:<name>': best confidence with the box center in the zone}}.
  function classSignals(dets, zones, classes) {
    const out = {};
    for (const id of Object.keys(zones || {})) {
      const z = zones[id], s = {};
      for (const c of classes || []) s['class:' + c] = 0;
      for (const d of dets || []) {
        const k = 'class:' + d.cls;
        if (!(k in s) || !d.nbox) continue;
        if (inRect((d.nbox[0] + d.nbox[2]) / 2, (d.nbox[1] + d.nbox[3]) / 2, z) && d.conf > s[k]) s[k] = d.conf;
      }
      out[id] = s;
    }
    return out;
  }
  // Hands (arrays of landmarks {x, y} in 0..1) -> {zone: share of one hand's landmarks inside, best hand}.
  function handPresence(hands, zones) {
    const out = {};
    for (const id of Object.keys(zones || {})) {
      let best = 0;
      for (const h of hands || []) {
        if (!h || !h.length) continue;
        let k = 0;
        for (const p of h) if (inRect(p.x, p.y, zones[id])) k++;
        best = Math.max(best, k / h.length);
      }
      out[id] = round(best, 3);
    }
    return out;
  }
  // The weaker of the last two model results, so one stray box cannot fire a substep.
  function steadyClasses(prev, cur) {
    if (!prev || !cur) return cur || null;
    const out = {};
    for (const id of Object.keys(cur)) {
      out[id] = {};
      for (const k of Object.keys(cur[id])) out[id][k] = Math.min(cur[id][k], prev[id] && isNum(prev[id][k]) ? prev[id][k] : 0);
    }
    return out;
  }
  // Pixel signals + class signals + hands. activity = max(motion activity, hand presence).
  function mergeSignals(base, cls, hands) {
    const out = {};
    for (const id of Object.keys(base || {})) {
      out[id] = Object.assign({}, base[id], cls && cls[id]);
      if (hands) { const hp = hands[id] || 0; out[id].hand = hp; out[id].activity = Math.max(out[id].activity || 0, hp); }
    }
    return out;
  }

  // ---------- step checker (Ruza's vision/live_check.py on the config's substeps) ----------
  // Per station: turns the tracker's events and the station's model results into what the operator hears and sees:
  // verified, mistake, review, and the short "Mistake cleared" note (kind cleared). Wrong order comes straight from the
  // tracker (a jump, already held for holdFrames). Model-state checks (confidence, a mustStay part gone, positionCheck) only
  // read model results taken while the view was clear (no hand, every zone still for clearSec) and vote over the last 3.
  // No inference of its own: it reads the detections the page already has. Thresholds are live_check.py's.
  const CHECK = { detectConf: 0.35, sureConf: 0.6, clearSec: 0.3, recheckSec: 1.0, votes: 3, refFrames: 10, tolerance: 0.14, stillMotion: 0.05, clearedMs: 3000 };
  const prettyClass = c => { const s = String(c).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
  const centerIn = (nb, z) => !!z && inRect((nb[0] + nb[2]) / 2, (nb[1] + nb[3]) / 2, z);
  // The best detection of a class with its box center in a zone, at or over minConf. null if none (or no zone).
  function bestIn(dets, cls, zone, minConf) {
    let best = null;
    if (!zone) return null;
    for (const d of dets || []) if (d && d.cls === cls && d.nbox && d.conf >= minConf && centerIn(d.nbox, zone) && (!best || d.conf > best.conf)) best = d;
    return best;
  }
  // A box (0..1 of the frame) relative to a zone: center x, y and size w, h as shares of the zone (live_check.py relative()).
  const relBox = (nb, z) => ({ x: ((nb[0] + nb[2]) / 2 - z.x) / z.w, y: ((nb[1] + nb[3]) / 2 - z.y) / z.h, w: (nb[2] - nb[0]) / z.w, h: (nb[3] - nb[1]) / z.h });
  const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const own = (obj, k) => !!obj && Object.prototype.hasOwnProperty.call(obj, k);

  // station: one entry of config.stations. opts: overrides for CHECK.
  // update(input) returns new verdict events. input: { t, events (what the tracker's update returned), state (its state()),
  // modelOn (this station runs a model now), frame ({id, t: capture time, dets} or null), zones ({id: rect}), hands (true,
  // false, or null when Hands is off), motion (highest zone activity, or null) }.
  function createChecker(station, opts) {
    const o = Object.assign({}, CHECK, opts || {});
    const subs = station.substeps || [], pc = station.positionCheck || null;
    const tol = pc && isNum(pc.tolerance) ? pc.tolerance : o.tolerance;
    const need = Math.floor(o.votes / 2) + 1;
    let endIdx = subs.findIndex(s => s.id === station.cycleEnds);
    if (endIdx < 0) endIdx = subs.length - 1;
    const idxOf = id => subs.findIndex(s => s.id === id);
    const zoneLabel = id => { const z = (station.zones || []).find(x => x.id === id); return z ? z.label : id; };
    let ref = null, C = fresh();
    function fresh() {
      return { show: null, cleared: null, clearSince: null, clear: false, checked: false, lastCheck: -Infinity, frames: [], lastFrame: null,
        newFrame: false, newInfo: false, pending: null, done: {}, lastOk: null, zones: {}, modelOn: false };
    }
    function verdict(kind, reason, message, idx, conf, x) {
      return { kind, reason, message, idx, substep: idx >= 0 && subs[idx] ? subs[idx].id : null, conf: isNum(conf) ? round(conf, 3) : null, box: (x && x.box) || null, zones: (x && x.zones) || [] };
    }
    const sure = (conf, kind) => (conf >= o.sureConf ? kind : 'review');   // a decision on a box under sureConf becomes a review
    // The best detection for a model rule: any member's class in that member's zone.
    function ruleBest(dets, rule) {
      let best = null;
      for (const m of members(rule)) { const d = m.class ? bestIn(dets, m.class, C.zones[m.zone], o.detectConf) : null; if (d && (!best || d.conf > best.conf)) best = d; }
      return best;
    }
    // The substep a class belongs to: the first whose model rule names it, else the current one.
    function classIdx(cls, st) { const i = subs.findIndex(s => members(s.model).some(m => m.class === cls)); return i >= 0 ? i : st.pos; }
    const nextIdx = st => (st.pos >= 0 && st.pos + 1 < subs.length ? st.pos + 1 : 0);

    // One model result against the rules, in live_check.py's order: position, missing, progress. Returns a verdict (maybe waiting).
    function snapshot(dets, st) {
      const D = (dets || []).filter(d => d && d.nbox && d.conf >= o.detectConf);
      const az = pc && ref && ref.anchor === pc.anchor ? C.zones[pc.anchor] : null;
      if (az) {
        for (const cls of pc.classes) {
          const want = own(ref.classes, cls) && isNum(ref.classes[cls].x) ? ref.classes[cls] : null, d = want ? bestIn(D, cls, az, o.detectConf) : null;
          if (!d) continue;
          const r = relBox(d.nbox, az), off = Math.max(Math.abs(r.x - want.x), Math.abs(r.y - want.y)), turned = (r.w >= r.h) !== (want.w >= want.h);
          if (turned || off > tol) return verdict(sure(d.conf, 'mistake'), turned ? 'turned' : 'wrong_position', prettyClass(cls) + (turned ? ' is turned the wrong way' : ' is in the wrong position'), classIdx(cls, st), d.conf, { box: d.nbox, zones: [pc.anchor] });
        }
      }
      for (let i = 0; i < subs.length; i++) {
        const m = subs[i].model;
        if (!C.done[i] || !m || m.mustStay !== true) continue;
        const ms = members(m).filter(x => x.class && C.zones[x.zone]);
        if (!ms.length || ms.some(x => bestIn(D, x.class, C.zones[x.zone], o.detectConf))) continue;
        return verdict('mistake', 'missing', prettyClass(ms[0].class) + ' is missing (step ' + (i + 1) + ')', i, null, { zones: ms.map(x => x.zone) });
      }
      const p = C.pending;
      if (p) {
        const d = ruleBest(D, subs[p.idx].model), conf = Math.max(p.conf || 0, d ? d.conf : 0), x = { box: d ? d.nbox : null, zones: p.zones };
        if (conf < o.sureConf) return verdict('review', 'low_confidence', subs[p.idx].label + " looks done but I'm not sure", p.idx, conf, x);
        return verdict('verified', 'progress', 'Step ' + (p.idx + 1) + ' verified: ' + subs[p.idx].label, p.idx, conf, x);
      }
      return verdict('waiting', 'waiting', 'No change yet', -1, null, null);
    }
    // live_check.py's vote: the kind most checks agree on (the newest of them), else "flickered".
    function vote(frames, st) {
      const snaps = frames.map(f => snapshot(f.dets, st)), n = k => snaps.filter(s => s.kind === k).length;
      let best = null;
      for (let i = snaps.length - 1; i >= 0; i--) if (!best || n(snaps[i].kind) > n(best.kind)) best = snaps[i];
      if (n(best.kind) >= need) return best;
      return verdict('review', 'flicker', 'Results flickered between checks, take a look', C.pending ? C.pending.idx : st.pos, null, null);
    }

    // Show a verdict and return its event. The same mistake or review again keeps showing, with no new event (so no new sound),
    // and a less sure look at a showing mistake (same message, review) does not turn it back into a review: a box whose
    // confidence hovers around sureConf would otherwise buzz on every flip. waiting after a mistake or review: "Mistake cleared".
    function apply(v, t, st, cycle, extra) {
      const bad = C.show && (C.show.kind === 'mistake' || C.show.kind === 'review');
      if (v.kind === 'waiting') {
        if (!bad) return [];
        const nx = nextIdx(st), c = verdict('cleared', 'cleared', 'Mistake cleared. Continue with ' + subs[nx].label, nx, null, null);
        C.show = null; C.cleared = Object.assign({ t, until: t + o.clearedMs }, c);
        return [event(c, t, cycle)];
      }
      if (bad && C.show.message === v.message && (C.show.kind === v.kind || (C.show.kind === 'mistake' && v.kind === 'review'))) { C.show.box = v.box || C.show.box; return []; }
      C.show = Object.assign({ t }, v); C.cleared = null;
      const e = event(v, t, cycle, extra);
      if (v.kind === 'verified') { if (C.lastOk != null) e.step_s = round((t - C.lastOk) / 1000, 2); C.lastOk = t; }
      return [e];
    }
    function event(v, t, cycle, extra) {
      return Object.assign({ type: 'verdict', station: station.id, t, cycle, substep: v.substep, kind: v.kind, reason: v.reason, message: v.message, conf: v.conf, step_s: null, cycle_s: null }, extra);
    }

    function update(inp) {
      const t = inp.t, st = inp.state || { pos: -1, cycle: 0, inCycle: false }, evs = inp.events || [], out = [];
      C.zones = inp.zones || {};
      C.modelOn = !!inp.modelOn;
      const frame = C.modelOn && inp.frame && inp.frame.dets ? inp.frame : null;
      if (!C.modelOn) C.pending = null;
      // 1) the tracker's news: wrong order and zone steps now, model steps at the next clear-view check
      for (const e of evs) {
        if (e.type !== 'substep') continue;
        const i = idxOf(e.substep);
        if (i < 0) continue;
        if (e.move === 'start') { C.done = {}; C.pending = null; C.lastOk = e.t; }
        const byModel = e.source === 'model', rule = byModel ? subs[i].model : subs[i].zones;
        const x = { box: byModel && frame ? ((ruleBest(frame.dets, rule) || {}).nbox || null) : null, zones: members(rule).map(m => m.zone) };
        const skipped = evs.filter(f => f.type === 'flag' && f.cycle === e.cycle && f.t === e.t && /^skipped /.test(f.note || '')).map(f => idxOf(f.substep)).filter(j => j >= 0);
        const ce = i === endIdx ? evs.find(f => f.type === 'cycle_end' && f.cycle === e.cycle) : null;
        if (skipped.length) {
          const j = Math.min.apply(null, skipped);
          C.pending = null;
          out.push(...apply(verdict(byModel ? sure(e.conf, 'mistake') : 'mistake', 'wrong_order', 'Wrong order: ' + subs[i].label + ' before ' + subs[j].label + ' (step ' + (j + 1) + ' skipped)', j, byModel ? e.conf : null, x), t, st, e.cycle));
        } else {
          if (C.pending) C.done[C.pending.idx] = true;   // a newer step came first: the older one counts as done (live_check.py reports the newest)
          C.pending = null;
          if (byModel && i !== endIdx) { C.pending = { idx: i, conf: e.conf, zones: x.zones }; C.newInfo = true; }
          else {
            const ok = !byModel || e.conf >= o.sureConf;
            if (ok) C.done[i] = true;
            const msg = !ok ? subs[i].label + " looks done but I'm not sure" : i === endIdx ? 'Cycle complete' : 'Step ' + (i + 1) + ' verified: ' + subs[i].label;
            out.push(...apply(verdict(ok ? 'verified' : 'review', ok ? (i === endIdx ? 'complete' : 'progress') : 'low_confidence', msg, i, byModel ? e.conf : null, x), t, st, e.cycle, ce ? { cycle_s: ce.dur } : null));
          }
        }
        if (ce) { C.done = {}; C.pending = null; }
      }
      // 2) is the view clear: no hand in the tile and every zone still, for clearSec
      const clearNow = isNum(inp.motion) && inp.motion < o.stillMotion && inp.hands !== true;
      if (!clearNow) { C.clearSince = null; C.frames = []; C.checked = false; C.newFrame = false; }
      else if (C.clearSince == null) C.clearSince = t;
      C.clear = clearNow && t - C.clearSince >= o.clearSec * 1000;
      // 3) a new model result taken while the view was clear joins the checks (and the Save correct state frames)
      if (frame && frame.id !== C.lastFrame) {
        C.lastFrame = frame.id;
        if (C.clear && !(isNum(frame.t) && frame.t < C.clearSince + o.clearSec * 1000)) { C.frames.push(frame); if (C.frames.length > o.refFrames) C.frames.shift(); C.newFrame = true; }
      }
      // 4) check once per clear spell, again when the tracker brings a model step, and every recheckSec while a problem shows
      if (C.clear) {
        const bad = C.show && (C.show.kind === 'mistake' || C.show.kind === 'review');
        const due = !C.checked || C.newInfo || (bad && t - C.lastCheck >= o.recheckSec * 1000);
        let v = null;
        if (due && !C.modelOn) v = verdict('waiting', 'waiting', 'No change yet', -1, null, null);   // nothing model-based to look at: the clear view settles it
        else if (due && C.frames.length >= o.votes && (C.newFrame || C.newInfo || !C.checked)) v = vote(C.frames.slice(-o.votes), st);
        if (v) {
          C.checked = true; C.newInfo = false; C.newFrame = false; C.lastCheck = t;
          if (v.kind === 'verified' && C.pending && v.idx === C.pending.idx) { C.done[C.pending.idx] = true; C.pending = null; }
          out.push(...apply(v, t, st, st.inCycle ? st.cycle : st.cycle + 1));
        }
      }
      return out;
    }

    // Save correct state: each positionCheck class's median box in the anchor zone over the last refFrames clear-view
    // model results (live_check.py calibration). Returns {ref} (also kept here) or {error} in plain words.
    function saveRef(t) {
      if (!pc) return { error: 'This station has no positionCheck in the config.' };
      const az = C.zones[pc.anchor];
      if (!az) return { error: 'Draw the ' + zoneLabel(pc.anchor) + ' zone first.' };
      if (!C.modelOn) return { error: 'Turn the model on first: the correct state comes from the model.' };
      if (!C.clear) return { error: 'Take your hands out of view and hold still, then press it again.' };
      const fr = C.frames.slice(-o.refFrames);
      if (fr.length < o.votes) return { error: 'Hold still a moment longer: ' + fr.length + ' of ' + o.votes + ' model results so far.' };
      const classes = {}, lost = [];
      for (const cls of pc.classes) {
        const rels = fr.map(f => bestIn(f.dets, cls, az, o.detectConf)).filter(Boolean).map(d => relBox(d.nbox, az));
        if (rels.length < Math.max(2, Math.floor(fr.length / 3))) { lost.push(prettyClass(cls)); continue; }
        const b = {};
        for (const k of ['x', 'y', 'w', 'h']) b[k] = round(median(rels.map(r => r[k])), 4);
        b.landscape = b.w >= b.h;
        classes[cls] = b;
      }
      if (lost.length) return { error: 'Could not see ' + lost.join(', ') + ' in ' + zoneLabel(pc.anchor) + '. Keep hands away and try again.' };
      ref = { anchor: pc.anchor, classes, frames: fr.length, saved: new Date(isNum(t) ? t : Date.now()).toISOString() };
      return { ref };
    }
    function setRef(r) { ref = r && r.classes && typeof r.classes === 'object' ? r : null; }

    return {
      update, saveRef, setRef, restart() { C = fresh(); }, station,
      get ref() { return ref; }, get current() { return C.show; }, get cleared() { return C.cleared; }, get clear() { return C.clear; },
      get pending() { return C.pending ? subs[C.pending.idx].id : null; }, get frames() { return C.frames.length; }
    };
  }

  // ---------- metrics over an event list ----------
  function sortEvents(events) {
    return (events || []).map((e, i) => [e, i]).filter(x => x[0] && isNum(x[0].t)).sort((a, b) => (a[0].t - b[0].t) || (a[1] - b[1])).map(x => x[0]);
  }
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length); };
  const r1 = v => (v == null ? null : round(v, 2));
  const isDetected = e => e.source !== 'manual';

  // Detected cycles of one station, rebuilt from substep and cycle_end events. A session_start or a source change
  // drops a cycle that was still open. The closing substep is a moment (zero length) that marks the cycle end.
  function detectedCycles(sorted, stationId) {
    const cycles = [];
    const flags = {}, qa = {}, verdicts = {};
    let open = null;
    for (const e of sorted) {
      if (e.type === 'session_start' || (e.type === 'source_change' && e.station === stationId)) { open = null; continue; }
      if (e.station !== stationId) continue;
      if (e.type === 'substep' && isDetected(e)) {
        if (!open || e.move === 'start') open = { cycle: e.cycle, start: e.t, occ: [], videoStart: e.videoT, videoFile: e.videoFile };
        const last = open.occ[open.occ.length - 1];
        if (last && last.end == null) last.end = e.t;
        open.occ.push({ substep: e.substep, move: e.move, source: e.source, conf: e.conf, start: e.t, end: null, videoT: e.videoT, videoFile: e.videoFile });
      } else if (e.type === 'cycle_end' && isDetected(e) && open) {
        const last = open.occ[open.occ.length - 1];
        if (last) { last.end = e.t; last.closes = true; }
        const sources = {};
        open.occ.forEach(x => { sources[x.source] = true; });
        cycles.push(Object.assign(open, { end: e.t, sec: (e.t - open.start) / 1000, cycle: e.cycle, source: Object.keys(sources).length > 1 ? 'mixed' : e.source, videoEnd: e.videoT, repeats: open.occ.filter(x => x.move === 'repeat').length }));
        open = null;
      } else if (e.type === 'flag' && isDetected(e)) {
        (flags[e.cycle] = flags[e.cycle] || []).push(e);
      } else if (e.type === 'qa_result') {
        qa[e.cycle] = e;
      } else if (e.type === 'verdict' && (e.kind === 'mistake' || e.kind === 'review')) {
        const v = verdicts[e.cycle] = verdicts[e.cycle] || { mistake: 0, review: 0 };
        v[e.kind]++;
      }
    }
    for (const c of cycles) { const v = verdicts[c.cycle] || {}; c.flags = flags[c.cycle] || []; c.qa = qa[c.cycle] || null; c.mistakes = v.mistake || 0; c.reviews = v.review || 0; }
    return { cycles, open };
  }

  function manualCycles(sorted, stationId) {
    const out = [];
    let prev = null;
    for (const e of sorted) {
      if (e.type === 'session_start') prev = null;
      if (e.station !== stationId || e.type !== 'manual' || !(e.action in CYCLE_ACTIONS)) continue;
      out.push({ t: e.t, prevT: prev, sec: prev == null ? null : (e.t - prev) / 1000, action: e.action, result: CYCLE_ACTIONS[e.action], reason: e.reason || null, videoT: e.videoT, videoFile: e.videoFile });
      prev = e.t;
    }
    return out;
  }

  // Time this station had a video source, from source_change events (or from its first detected event).
  function observedMs(sorted, stationId, now) {
    let obs = 0, from = null, saw = false, first = null;
    for (const e of sorted) {
      if (e.type === 'source_change' && e.station === stationId) {
        saw = true;
        if (from != null) obs += e.t - from;
        from = e.input && e.input !== 'none' ? e.t : null;
      } else if (e.type === 'session_end' && from != null) { obs += e.t - from; from = null; }
      if (first == null && e.station === stationId && (e.type === 'substep' || e.type === 'cycle_end') && isDetected(e)) first = e.t;
    }
    if (from != null) obs += Math.max(0, now - from);
    if (!saw) obs = first == null ? 0 : Math.max(0, now - first);
    return obs;
  }

  function reasonInfo(config, id) {
    const r = (config.failReasons || []).find(x => x.id === id);
    return r ? { cause: r.cause, defect: r.defect !== false, label: r.label } : { cause: null, defect: true, label: id || '' };
  }

  // events: any event list (one session, or the live page before a session). opts: {now, basis: 'auto'|'detected'|'manual'}.
  // Returns {stations: {id: {...}}, line: {...}}. All times in seconds.
  function summarize(events, config, opts) {
    const o = Object.assign({ basis: 'auto' }, opts || {});
    const sorted = sortEvents(events);
    const lastT = sorted.length ? sorted[sorted.length - 1].t : 0;
    const now = isNum(o.now) ? o.now : lastT;
    const sStart = sorted.find(e => e.type === 'session_start'), sEnd = sorted.find(e => e.type === 'session_end');
    const t0 = sStart ? sStart.t : (sorted.length ? sorted[0].t : now);
    const tEnd = sEnd ? sEnd.t : now;
    const stations = {}, ids = config.stations.map(s => s.id);
    for (const st of config.stations) {
      const d = detectedCycles(sorted, st.id), m = manualCycles(sorted, st.id);
      const secs = d.cycles.map(c => c.sec);
      const subAvg = {};
      for (const sub of st.substeps) {
        const per = d.cycles.map(c => c.occ.filter(x => x.substep === sub.id).reduce((a, x) => a + ((x.end == null ? x.start : x.end) - x.start) / 1000, 0));
        subAvg[sub.id] = per.length ? r1(mean(per)) : null;
      }
      const obs = observedMs(sorted, st.id, tEnd);
      const busy = secs.reduce((a, b) => a + b, 0) * 1000 + (d.open ? Math.max(0, tEnd - d.open.start) : 0);
      const det = {
        cycles: d.cycles.length, lastSec: r1(secs.length ? secs[secs.length - 1] : null), avgSec: r1(mean(secs)), stdSec: r1(sd(secs)),
        substepAvg: subAvg, idleShare: obs > 0 && (d.cycles.length || d.open) ? round(clamp01(1 - busy / obs), 3) : null,
        repeats: d.cycles.reduce((a, c) => a + c.repeats, 0), flags: d.cycles.reduce((a, c) => a + c.flags.length, 0)
      };
      const ms = m.map(x => x.sec).filter(isNum);
      const man = { cycles: m.length, lastSec: r1(ms.length ? ms[ms.length - 1] : null), avgSec: r1(mean(ms)), stdSec: r1(sd(ms)) };
      const basis = o.basis === 'detected' || o.basis === 'manual' ? o.basis : (det.cycles > 0 ? 'detected' : 'manual');
      const use = basis === 'detected' ? det : man;
      stations[st.id] = { detected: det, manual: man, basis, cycles: use.cycles, avgSec: use.avgSec, lastSec: use.lastSec, stdSec: use.stdSec, _d: d, _m: m };
    }

    // QA: every station with a qa block (two testers side by side both count)
    const qaSts = config.stations.filter(s => s.qa);
    const q = { passed: 0, failed: 0, defectFails: 0, nonDefectFails: 0, unknown: 0, awaiting: 0, failsByCause: {}, failsByReason: {} };
    for (const id of ids) q.failsByCause[id] = 0;
    q.failsByCause.unknown = 0;
    for (const qs of qaSts) {
      const s = stations[qs.id];
      // A detected cycle without a qa_result yet is still inside its grace time: counted as awaiting, not as unknown.
      const recs = s.basis === 'manual' ? s._m.map(x => ({ result: x.result, reason: x.reason })) : s._d.cycles.map(c => (c.qa ? { result: c.qa.result, reason: c.qa.reason } : { result: 'awaiting' }));
      for (const r of recs) {
        if (r.result === 'awaiting') { q.awaiting++; continue; }
        if (r.result === 'pass') q.passed++;
        else if (r.result === 'fail') {
          q.failed++;
          const info = reasonInfo(config, r.reason);
          q.failsByReason[r.reason || 'none'] = (q.failsByReason[r.reason || 'none'] || 0) + 1;
          if (info.defect) { q.defectFails++; const k = ids.indexOf(info.cause) >= 0 ? info.cause : 'unknown'; q.failsByCause[k]++; } else q.nonDefectFails++;
        } else q.unknown++;
      }
    }
    const units = qaSts.reduce((a, s) => a + stations[s.id].cycles, 0);
    const elapsedSec = Math.max(0, (tEnd - t0) / 1000);
    // Stages: stations next to each other in flow order with the same role work side by side. WIP is counted between
    // stages (null between two stations of one stage), and a station's pace is its average over the stations in its stage.
    const stages = [], stageOf = {};
    for (const st of config.stations) {
      const role = st.role || st.id, last = stages[stages.length - 1];
      if (last && last.role === role) last.ids.push(st.id); else stages.push({ role, ids: [st.id] });
      stageOf[st.id] = stages.length - 1;
    }
    const stageCycles = k => stages[k].ids.reduce((a, id) => a + stations[id].cycles, 0);
    const pace = id => (stations[id].avgSec == null ? null : stations[id].avgSec / stages[stageOf[id]].ids.length);
    const wip = [];
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = stageOf[ids[i]], b = stageOf[ids[i + 1]];
      wip.push({ from: ids[i], to: ids[i + 1], n: a === b ? null : stageCycles(a) - stageCycles(b) });
    }
    let bottleneck = null;
    for (const id of ids) { const a = pace(id); if (a != null && (bottleneck == null || a > pace(bottleneck))) bottleneck = id; }
    const cycleEnds = {};
    for (const id of ids) { cycleEnds[id] = { detected: stations[id].detected.cycles, manual: stations[id].manual.cycles }; delete stations[id]._d; delete stations[id]._m; }
    const takt = isNum(config.taktSec) ? config.taktSec : null;
    return {
      stations,
      line: {
        units, elapsedSec: r1(elapsedSec), uph: elapsedSec >= 1 ? r1(units * 3600 / elapsedSec) : null,
        tested: q.passed + q.failed, passed: q.passed, failed: q.failed, defectFails: q.defectFails, nonDefectFails: q.nonDefectFails, unknown: q.unknown, awaitingQa: q.awaiting,
        fpy: q.passed + q.defectFails > 0 ? round(q.passed / (q.passed + q.defectFails), 4) : null,
        failsByCause: q.failsByCause, failsByReason: q.failsByReason, wip, bottleneck, cycleEnds,
        mismatches: sorted.filter(e => e.type === 'flag' && e.note === MISMATCH_NOTE).length,
        taktSec: takt, overTakt: takt == null ? [] : ids.filter(id => pace(id) != null && pace(id) > takt)
      }
    };
  }

  // ---------- CSV exports ----------
  function csvCell(v) {
    if (v == null) return '';
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // keep spreadsheets from running a cell as a formula
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const csvLine = row => row.map(csvCell).join(',');
  function timeBase(sorted, meta) {
    const s = sorted.find(e => e.type === 'session_start');
    if (s) return s.t;
    if (meta && isNum(meta.startedAtMs)) return meta.startedAtMs;
    return sorted.length ? sorted[0].t : 0;
  }
  const SUBSTEP_COLS = ['session_id', 'crew', 'shift', 'station', 'cycle', 'seq', 'substep', 'label', 'move', 'source', 'start_ts', 'end_ts', 'dur_s', 'conf', 'closes_cycle', 'video_file', 'video_t'];
  const CYCLE_COLS = ['session_id', 'crew', 'shift', 'station', 'basis', 'cycle', 'source', 'start_ts', 'end_ts', 'cycle_s', 'substeps', 'repeats', 'flags', 'mistakes', 'reviews', 'result', 'reason', 'cause_station', 'defect', 'light', 'bin', 'mismatch', 'video_file', 'video_start_t', 'video_end_t', 'notes'];

  // One row per detected substep occurrence in finished cycles (repeats are separate rows).
  function substepsCsv(events, config, meta) {
    const m = meta || {}, sorted = sortEvents(events), base = timeBase(sorted, m), ts = t => round((t - base) / 1000, 3);
    const lines = [SUBSTEP_COLS.join(',')];
    for (const st of config.stations) {
      const labels = {};
      st.substeps.forEach(s => { labels[s.id] = s.label; });
      for (const c of detectedCycles(sorted, st.id).cycles) {
        c.occ.forEach((x, k) => {
          const end = x.end == null ? x.start : x.end;
          lines.push(csvLine([m.id, m.crew, m.shift, st.id, c.cycle, k + 1, x.substep, labels[x.substep] || '', x.move, x.source, ts(x.start), ts(end), round((end - x.start) / 1000, 3), x.conf, !!x.closes, x.videoFile, x.videoT]));
        });
      }
    }
    return lines.join('\n') + '\n';
  }

  // One row per finished cycle: detected cycles (with QA for the QA station) and manual cycles, kept apart by `basis`.
  function cyclesCsv(events, config, meta) {
    const m = meta || {}, sorted = sortEvents(events), base = timeBase(sorted, m), ts = t => round((t - base) / 1000, 3);
    const lines = [CYCLE_COLS.join(',')];
    for (const st of config.stations) {
      for (const c of detectedCycles(sorted, st.id).cycles) {
        const q = c.qa, info = q && q.result === 'fail' ? reasonInfo(config, q.reason) : null;
        const mismatch = st.qa ? c.flags.some(f => f.note === MISMATCH_NOTE) : null;
        const notes = c.flags.map(f => f.note).join('; ');
        lines.push(csvLine([m.id, m.crew, m.shift, st.id, 'detected', c.cycle, c.source, ts(c.start), ts(c.end), round(c.sec, 3), c.occ.length, c.repeats, c.flags.length, c.mistakes, c.reviews,
          q ? q.result : (st.qa ? 'unknown' : null), q ? q.reason : null, info ? info.cause : null, info ? info.defect : null, q ? q.light : null, q ? q.bin : null, mismatch,
          c.videoFile, c.videoStart, c.videoEnd, notes]));
      }
      manualCycles(sorted, st.id).forEach((x, k) => {
        const info = x.result === 'fail' ? reasonInfo(config, x.reason) : null;
        lines.push(csvLine([m.id, m.crew, m.shift, st.id, 'manual', k + 1, 'manual', x.prevT == null ? null : ts(x.prevT), ts(x.t), x.sec == null ? null : round(x.sec, 3), null, null, null, null, null,
          st.qa ? x.result : null, x.reason, info ? info.cause : null, info ? info.defect : null, null, null, null, x.videoFile, null, x.videoT, x.action]));
      });
    }
    return lines.join('\n') + '\n';
  }

  // One row per verdict (what the operator heard and saw), in time order across stations. Same columns as live_check.py's
  // session CSV plus session, station, ts and the video position. step is the substep's number at its station.
  const VERDICT_COLS = ['session_id', 'station', 'time', 'ts', 'cycle', 'step', 'event', 'message', 'confidence', 'step_seconds', 'cycle_seconds', 'video_file', 'video_t'];
  function verdictsCsv(events, config, meta) {
    const m = meta || {}, sorted = sortEvents(events), base = timeBase(sorted, m), ts = t => round((t - base) / 1000, 3);
    const lines = [VERDICT_COLS.join(',')];
    for (const e of sorted) {
      if (e.type !== 'verdict') continue;
      const st = config.stations.find(s => s.id === e.station), k = st && e.substep ? st.substeps.findIndex(s => s.id === e.substep) : -1;
      lines.push(csvLine([m.id, e.station, new Date(e.t).toISOString().slice(0, 19) + 'Z', ts(e.t), e.cycle, k >= 0 ? k + 1 : null, e.kind, e.message, e.conf, e.step_s, e.cycle_s, e.videoFile, e.videoT]));
    }
    return lines.join('\n') + '\n';
  }

  return {
    DEFAULTS, MOTION, MISMATCH_NOTE, EVENT_TYPES, CYCLE_ACTIONS, SUBSTEP_COLS, CYCLE_COLS, VERDICT_COLS, CHECK, LEVELS, OPERATOR_CODE, FLOOR, CLASS_TEST,
    members, activeRule, evalRule, missingOf, ruleText, checkConfig, modelFor, checkModelOutput, e2eBadClass, qaDecide, createStation,
    operatorCode, defaultName, shortName, classTestLayout, setupKey, nextStationId, applyLayout,
    zoneSignals, calibrationFrom, classSignals, handPresence, steadyClasses, mergeSignals, createChecker,
    sortEvents, detectedCycles, manualCycles, summarize, substepsCsv, cyclesCsv, verdictsCsv, csvCell
  };
});
