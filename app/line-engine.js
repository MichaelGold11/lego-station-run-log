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
  // Model rules may use zone "frame": the whole camera view, no box to draw.
  const FRAME_ZONE = 'frame';
  const MOTION = { noise: 6, scale: 32 };      // per-pixel gray diff noise floor, and the mean diff that counts as motion 1.0
  const BRIGHT_SPAN = 60;                        // without a "Bulb on" calibration, a rise of 60 gray levels counts as bright 1.0
  const MISMATCH_NOTE = 'quality mismatch, review the video';
  const EVENT_TYPES = ['substep', 'cycle_end', 'qa_result', 'flag', 'manual', 'session_start', 'session_end', 'source_change', 'verdict', 'operator', 'unit'];
  const CYCLE_ACTIONS = { cycle_done: 'unknown', pass: 'pass', fail: 'fail' };   // manual actions that close a manual cycle

  const clamp01 = v => Math.max(0, Math.min(1, v));
  const round = (v, d) => { const k = Math.pow(10, d == null ? 3 : d); return Math.round(v * k) / k; };
  const isNum = v => typeof v === 'number' && isFinite(v);

  // ---------- rules ----------
  // A rule is {zone, signal, min} or {zone, class, min} or {anyOf: [rule, ...]}. min falls back to the config defaults.
  const members = rule => (rule ? (Array.isArray(rule.anyOf) ? rule.anyOf : [rule]) : []);
  // count: 2 reads the second-best box of the class ("two closed connectors"), so a rule can need more than one.
  const sigKey = m => (m.class ? 'class:' + m.class + (m.count > 1 ? '#' + m.count : '') : (m.signal || 'activity'));
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

  // How long a rule must stay on before it fires, given its member values now: a member's own holdSec, else the rule's.
  function holdOf(rule, vals, defaults) {
    const ms = members(rule);
    let hs = Infinity;
    ms.forEach((m, k) => { const x = vals && vals[k]; if (isNum(x) && x >= memberMin(m, defaults)) hs = Math.min(hs, isNum(m.holdSec) ? m.holdSec : (rule.holdSec || 0)); });
    return hs === Infinity ? (rule.holdSec || 0) : hs;
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
    return members(rule).map(m => (m.class ? 'model sees ' + (m.count > 1 ? m.count + ' x ' : '') + m.class + ' in ' + (m.zone === FRAME_ZONE ? 'the whole view' : zl(m.zone)) : (m.signal === 'bright' ? zl(m.zone) + ' goes bright' : 'activity in ' + zl(m.zone)))).join(' or ');
  }

  // Problems in a line config (the team edits it by hand). Returns a list of plain sentences; empty means fine.
  function checkConfig(cfg) {
    const errs = [];
    if (!cfg || !Array.isArray(cfg.stations) || !cfg.stations.length) return ['The config has no stations.'];
    const seenSt = {}, seenSub = {};
    for (const st of cfg.stations) {
      if (st.assembly != null) { const a = st.assembly; if (typeof a !== 'object' || !a.class || !a.closed || !a.open || !Array.isArray(a.wires) || !a.wires.length) errs.push(st.id + ': assembly needs class, closed, open and wires.'); }
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
            if (!zones[m.zone] && !(kind === 'model' && m.zone === FRAME_ZONE)) errs.push(sub.id + ' (' + kind + ' rule) uses zone "' + m.zone + '", which ' + st.id + ' does not have.');
            if (m.count != null && !(Number.isInteger(m.count) && m.count >= 1 && m.count <= 3)) errs.push(sub.id + ': count must be 1, 2 or 3.');
            if (kind === 'model' && !m.class) errs.push(sub.id + ': a model rule needs a class.');
            if (m !== sub[kind] && m.holdSec != null && !(isNum(m.holdSec) && m.holdSec >= 0)) errs.push(sub.id + ': holdSec must be a number of seconds, 0 or more.');
            if (kind === 'zones' && m.signal && m.signal !== 'activity' && m.signal !== 'bright') errs.push(sub.id + ': signal "' + m.signal + '" is not activity or bright.');
          }
        }
        if (sub.model && sub.model.mustStay != null && typeof sub.model.mustStay !== 'boolean') errs.push(sub.id + ': mustStay must be true or false.');
        if (sub.after != null && !st.substeps.slice(0, st.substeps.indexOf(sub)).some(x => x.id === sub.after)) errs.push(sub.id + ': after must name an earlier substep of ' + st.id + '.');
        if (sub.optional != null && typeof sub.optional !== 'boolean') errs.push(sub.id + ': optional must be true or false.');
        if (sub.once != null && typeof sub.once !== 'boolean') errs.push(sub.id + ': once must be true or false.');
        for (const kind of ['zones', 'model']) if (sub[kind] && sub[kind].holdSec != null && !(isNum(sub[kind].holdSec) && sub[kind].holdSec >= 0)) errs.push(sub.id + ': holdSec must be a number of seconds, 0 or more.');
        if (sub.standardSec != null && !(isNum(sub.standardSec) && sub.standardSec > 0)) errs.push(sub.id + ': standardSec must be a number of seconds above 0.');
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
      if (st.perUnit != null && !(Number.isInteger(st.perUnit) && st.perUnit >= 1)) errs.push(st.id + ': perUnit must be a whole number of 1 or more (cycles per unit).');
      const ut = st.unitTracker;
      if (ut != null) {
        if (typeof ut !== 'object' || Array.isArray(ut)) errs.push(st.id + ': unitTracker must look like { "enabled": true, "departMs": 2000 }.');
        else {
          if (ut.enabled != null && typeof ut.enabled !== 'boolean') errs.push(st.id + ': unitTracker enabled must be true or false.');
          for (const k of ['departMs', 'enterMs']) if (ut[k] != null && !(isNum(ut[k]) && ut[k] >= 0 && ut[k] <= 60000)) errs.push(st.id + ': unitTracker ' + k + ' must be a number of milliseconds from 0 to 60000.');
          if (ut.presentConf != null && !(isNum(ut.presentConf) && ut.presentConf > 0 && ut.presentConf <= 1)) errs.push(st.id + ': unitTracker presentConf must be a number above 0 and at most 1.');
          if (ut.startNeedsEmpty != null && typeof ut.startNeedsEmpty !== 'boolean') errs.push(st.id + ': unitTracker startNeedsEmpty must be true or false.');
          if (ut.newUnitNeedsEmpty != null && typeof ut.newUnitNeedsEmpty !== 'boolean') errs.push(st.id + ': unitTracker newUnitNeedsEmpty must be true or false.');
          if (ut.presenceClasses != null && (!Array.isArray(ut.presenceClasses) || ut.presenceClasses.some(c => typeof c !== 'string' || !c))) errs.push(st.id + ': unitTracker presenceClasses must be a list of class names.');
          if (ut.enabled && !st.arrival) errs.push(st.id + ': unitTracker needs the station to name its arrival substep.');
          if (ut.from != null) {
            const up = (cfg.stations || []).find(x => x && x.id === ut.from);
            if (typeof ut.from !== 'string' || ut.from === st.id) errs.push(st.id + ': unitTracker from must name another station.');
            else if (!up) errs.push(st.id + ': unitTracker from "' + ut.from + '" is not a station in this config.');
            else if (ut.enabled && !(up.unitTracker && up.unitTracker.enabled)) errs.push(st.id + ': unitTracker from "' + ut.from + '" needs that station\'s unitTracker enabled too.');
          }
        }
      }
      if (st.arrival != null && !st.substeps.some(s => s.id === st.arrival)) errs.push(st.id + ': arrival "' + st.arrival + '" is not one of its substeps.');
      if (st.qa) {
        for (const k of ['lightSubstep', 'sortSubstep']) if (st.qa[k] && !st.substeps.some(s => s.id === st.qa[k])) errs.push(st.id + ': qa.' + k + ' "' + st.qa[k] + '" is not one of its substeps.');
        for (const z of Object.keys(st.qa.bins || {})) if (!zones[z]) errs.push(st.id + ': qa bin zone "' + z + '" is not one of its zones.');
      }
    }
    for (const r of cfg.failReasons || []) if (r.cause != null && !seenSt[r.cause]) errs.push('Fail reason ' + r.id + ' names cause station "' + r.cause + '", which does not exist.');
    if (cfg.sounds != null && (typeof cfg.sounds !== 'object' || Array.isArray(cfg.sounds) || (cfg.sounds.verified != null && typeof cfg.sounds.verified !== 'boolean'))) errs.push('sounds must look like { "verified": true }.');
    if (cfg.taktSec != null && !(isNum(cfg.taktSec) && cfg.taktSec > 0)) errs.push('taktSec must be a number of seconds above 0, or null.');
    const db = cfg.dashboard;
    if (db != null) {
      if (typeof db !== 'object' || Array.isArray(db)) errs.push('dashboard must look like { "slowFactor": 1.3, "photoConf": 0.6, "reviewDays": 7, "mediaCapMB": 1024 }.');
      else {
        if (db.slowFactor != null && !(isNum(db.slowFactor) && db.slowFactor > 1)) errs.push('dashboard.slowFactor must be a number above 1.');
        if (db.photoConf != null && !(isNum(db.photoConf) && db.photoConf > 0 && db.photoConf <= 1)) errs.push('dashboard.photoConf must be a number above 0 and at most 1.');
        for (const k of ['reviewDays', 'mediaCapMB']) if (db[k] != null && !(isNum(db[k]) && db[k] > 0)) errs.push('dashboard.' + k + ' must be a number above 0.');
      }
    }
    if (cfg.model) errs.push(...modelShapeErrors('model', cfg.model));
    if (cfg.models != null) {
      if (typeof cfg.models !== 'object' || Array.isArray(cfg.models)) errs.push('models must be an object keyed by station id: { "s1": { "file": "/models/<name>.onnx", "classes": [...] } }.');
      else for (const id of Object.keys(cfg.models)) {
        if (!seenSt[id]) { errs.push('models: "' + id + '" is not a station id.'); continue; }
        if (cfg.models[id]) errs.push(...modelShapeErrors('models.' + id, cfg.models[id]));
      }
    }
    if (cfg.capture != null) errs.push(...captureErrors(cfg.capture));
    return errs;
  }

  // The capture block: { enabled, stallSec, sampleSec, maxPerSession, maxPerStation, reviewDays, mediaCapMB }. Optional;
  // every key falls back to CAPTURE_DEFAULTS.
  const CAPTURE_DEFAULTS = { enabled: true, stallSec: 12, sampleSec: 25, maxPerSession: 120, maxPerStation: 40, reviewDays: 7, mediaCapMB: 1024 };
  const CAPTURE_WHOLE = ['maxPerSession', 'maxPerStation'];
  function captureErrors(c) {
    if (typeof c !== 'object' || Array.isArray(c)) return ['capture must look like { "enabled": true, "stallSec": 12, "sampleSec": 25, "maxPerSession": 120, "maxPerStation": 40, "reviewDays": 7, "mediaCapMB": 1024 }.'];
    const e = [];
    if (c.enabled != null && typeof c.enabled !== 'boolean') e.push('capture.enabled must be true or false.');
    for (const k of Object.keys(CAPTURE_DEFAULTS)) {
      if (k === 'enabled' || c[k] == null) continue;
      if (!(isNum(c[k]) && c[k] > 0)) e.push('capture.' + k + ' must be a number above 0.');
      else if (CAPTURE_WHOLE.includes(k) && !Number.isInteger(c[k])) e.push('capture.' + k + ' must be a whole number.');
    }
    return e;
  }
  // The capture settings with every missing or invalid key replaced by its default.
  function captureDefaults(cfg) {
    const c = cfg && cfg.capture && typeof cfg.capture === 'object' && !Array.isArray(cfg.capture) ? cfg.capture : {}, out = {};
    for (const [k, d] of Object.entries(CAPTURE_DEFAULTS)) {
      if (k === 'enabled') out[k] = typeof c[k] === 'boolean' ? c[k] : d;
      else out[k] = isNum(c[k]) && c[k] > 0 && (!CAPTURE_WHOLE.includes(k) || Number.isInteger(c[k])) ? c[k] : d;
    }
    return out;
  }

  // ---------- capture triggers (the page calls this for each station a few times a second) ----------
  const CAPTURE_DEDUPE_MS = 1500;     // no second frame from one station inside this
  const CAPTURE_STALL_EVERY_MS = 10000;   // once a cycle has stalled, one frame this often
  // When the next random "nothing happening" frame is due: one per sampleSec window, at a random point in it. rng is
  // injected (Math.random in the page) so tests are exact.
  function nextSampleDue(from, settings, rng) {
    const s = settings || CAPTURE_DEFAULTS, ms = (isNum(s.sampleSec) && s.sampleSec > 0 ? s.sampleSec : CAPTURE_DEFAULTS.sampleSec) * 1000;
    const r = typeof rng === 'function' ? rng() : 0.5;
    return from + ms * Math.min(1, Math.max(0, isNum(r) ? r : 0.5));
  }
  // Which reason to capture one station's frame for right now, or null. Pure: the page keeps the state and updates it
  // after a capture (lastAt, total, stationCount, lastStallAt, sampleDue = nextSampleDue(...), claimed[cycle + ':' + step]).
  // state: { recording (a session records), hasVideo, total, stationCount (captures so far), lastAt (ms of this station's
  //   last capture, or null), cycleActive, stepAt (ms the current step began), lastStallAt, sampleDue (ms or null),
  //   claimed ({ "<cycle>:<step>": true }), pend: { manual, unsure, cycleEnd, cycleStart, claim: { step, cycle } } }
  // Priority: manual, unsure, cycle_end, cycle_start, claim, stalled, sample. A manual frame skips the 1.5 s dedupe.
  function captureWanted(state, now, settings) {
    const s = Object.assign({}, CAPTURE_DEFAULTS, settings || {}), st = state || {}, p = st.pend || {};
    if (s.enabled === false || !st.recording || !st.hasVideo) return null;
    if ((st.total || 0) >= s.maxPerSession || (st.stationCount || 0) >= s.maxPerStation) return null;
    if (p.manual) return 'manual';
    if (isNum(st.lastAt) && now - st.lastAt < CAPTURE_DEDUPE_MS) return null;
    if (p.unsure) return 'unsure';
    if (p.cycleEnd) return 'cycle_end';
    if (p.cycleStart) return 'cycle_start';
    if (p.claim && !(st.claimed && st.claimed[p.claim.cycle + ':' + p.claim.step])) return 'claim';
    if (st.cycleActive && isNum(st.stepAt) && now - st.stepAt >= s.stallSec * 1000 && !(isNum(st.lastStallAt) && now - st.lastStallAt < CAPTURE_STALL_EVERY_MS)) return 'stalled';
    if (isNum(st.sampleDue) && now >= st.sampleDue) return 'sample';
    return null;
  }

  // One model entry: { file: "/models/<name>.onnx", classes: [unique strings], imgsz }.
  function modelShapeErrors(name, m) {
    const e = [], ex = name + ' must look like { "file": "/models/<name>.onnx", "classes": [...], "imgsz": 640 }.';
    if (typeof m !== 'object' || Array.isArray(m) || typeof m.file !== 'string' || !/^\/models\/[A-Za-z0-9_.-]+\.onnx$/.test(m.file) || !Array.isArray(m.classes)) return [ex];
    if (!m.classes.length || m.classes.some(c => typeof c !== 'string' || !c)) e.push(name + ': classes must be a non-empty list of names.');
    else if (new Set(m.classes).size !== m.classes.length) e.push(name + ': classes must not repeat a name.');
    // version is optional: it names the trained model (a string or number) and is stamped on every capture.
    if (m.version != null && !((typeof m.version === 'string' && m.version.trim() && m.version.length <= 40) || (isNum(m.version) && m.version >= 0))) e.push(name + ': version must be a short text or a number (for example "2026-11-02" or 3).');
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
  // The spot nearest (x, y) where a new card (width FLOOR.cardW, height h, default 520: room for its Setup panel) does not cover
  // any of rects ({x, y, w, h}), with a margin of one grid step. Searches rings of 200 by 160 around (x, y); snaps to the grid.
  function freeSpot(rects, x, y, h) {
    const w = FLOOR.cardW, m = FLOOR.grid, hh = h || 520, snap = v => Math.round(v / FLOOR.grid) * FLOOR.grid;
    const free = (px, py) => rects.every(r => px + w + m <= r.x || r.x + r.w + m <= px || py + hh + m <= r.y || r.y + r.h + m <= py);
    for (let ring = 0; ring <= 12; ring++) {
      const cand = [];
      for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) if (Math.max(Math.abs(i), Math.abs(j)) === ring) cand.push([x + i * 200, y + j * 160]);
      cand.sort((a, c) => Math.hypot(a[0] - x, a[1] - y) - Math.hypot(c[0] - x, c[1] - y));
      for (const [px, py] of cand) if (free(px, py)) return [snap(px), snap(py)];
    }
    return [x, y];
  }
  // Delayed layout saves, one pending save per layout id: scheduling a save for one layout does not cancel another's.
  // timers is { set, clear } (setTimeout and clearTimeout in the page).
  function saveScheduler(timers) {
    const pending = {};
    return {
      later(id, fn, ms) { timers.clear(pending[id]); pending[id] = timers.set(() => { delete pending[id]; fn(); }, ms); },
      cancel(id) { timers.clear(pending[id]); delete pending[id]; },
      pending: () => Object.keys(pending),
    };
  }
  // A new station takes its role's id when free ("s2"), then "s2_2", "s2_3" (so footage is saved as <role>.mp4). A missing or
  // unusable role id (too long, odd characters) falls back to the lowest free s<n>. Ids already in saved layouts are never changed.
  function nextStationId(stations, role) {
    const used = {};
    for (const s of stations || []) used[s.id] = true;
    const ID = /^[a-z][a-z0-9_]{0,15}$/;
    if (typeof role === 'string' && ID.test(role)) {
      if (!used[role]) return role;
      for (let n = 2; n < 1000; n++) {
        const suf = '_' + n, id = role.slice(0, 16 - suf.length) + suf;
        if (!used[id]) return id;
      }
    }
    let n = 1;
    while (used['s' + n]) n++;
    return 's' + n;
  }
  // The zone ids a substep's rules point at (its zones rule and its model rule).
  function ruleZones(sub) {
    const out = [];
    for (const m of members(sub.zones).concat(members(sub.model))) if (m.zone && out.indexOf(m.zone) < 0) out.push(m.zone);
    return out;
  }
  // The substeps that can never fire because every zone their rules point at is undrawn. drawn: array or object of zone ids.
  // A substep with no zone rule at all is not listed. Each entry: the substep plus missing: [zone ids].
  function unobserved(station, drawn) {
    const have = Array.isArray(drawn) ? drawn : Object.keys(drawn || {});
    const out = [];
    for (const sub of (station && station.substeps) || []) {
      const zs = ruleZones(sub);
      if (zs.length && zs.every(z => have.indexOf(z) < 0)) out.push(Object.assign({}, sub, { missing: zs }));
    }
    return out;
  }
  const NO_DATA = 'no data: ';
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
    const arrIdx = station.arrival ? subs.findIndex(s => s.id === station.arrival) : -1;
    const afterIdx = subs.map(s => (s.after ? subs.findIndex(x => x.id === s.after) : -1));
    let modelClasses = o.modelClasses || null;
    let S = fresh(0);

    function fresh(cycle) {
      return {
        pos: -1, cycle: cycle || 0, cycleStart: null, since: null, t: null, sig: null,
        cnt: {},          // hold counters per substep index: {t0, n, sum, msum, zones, kind}
        off: {},          // off[i]: the rule of substep i was false at least once since we last entered or left it
        occ: [], arrived: false, repeats: 0, lastConf: null, lastSource: null, lastCycleSec: null,
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
    // The arrival substep counts once per cycle: once entered, it is never a repeat target until the next cycle. So does a
    // substep marked "once": S2's open connector stays open while the wires are arranged, and a hand passing over it
    // must not read as opening it again (2026-11-22 S2 run: open and arrange bounced back and forth ten times a unit).
    // A substep with "after" waits until that earlier substep happened in this cycle. S2: the connector sits closed before
    // work starts, so seeing it closed only ends a cycle once it was seen open. If the earlier step cannot be seen at all
    // right now (its zone or signal is missing), nothing waits for it.
    function waiting(i) {
      const a = afterIdx[i];
      return a >= 0 && live(a) && !(S.pos >= 0 && S.occ.some(o => o.id === subs[a].id));
    }

    function choose(cands) {
      let fwd = null, back = null;
      for (const i of cands) {
        if (i === S.pos || waiting(i)) continue;
        if (S.pos < 0) { if (i !== endIdx && S.off[i] && (fwd == null || i < fwd)) fwd = i; continue; }
        if (i > S.pos) { if (fwd == null || i < fwd) fwd = i; } else if (S.off[i] && !(i === arrIdx && S.arrived) && !(subs[i].once && S.occ.some(o => o.id === subs[i].id)) && (back == null || i > back)) back = i;
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
        S.cycle++; S.cycleStart = onset; S.occ = []; S.arrived = false; S.repeats = 0; move = 'start';
        for (let j = 0; j < i; j++) skipped.push(j);
      } else if (i > S.pos) {
        for (let j = S.pos + 1; j < i; j++) skipped.push(j);
      } else { move = 'repeat'; S.repeats++; }
      // A skipped substep only counts when it could have been seen. The bulb test is left out: a unit whose bulb
      // stays dark is reported as light: false on its qa_result, not as a skipped step.
      // A substep that already happened in this cycle was not skipped (S2: the arrival re-firing, then the close, must not read as
      // "open skipped" when the connector was opened earlier in the cycle). A new cycle has an empty S.occ, so nothing is excused there.
      // "optional": a step the camera may miss (S3 black wire on a dark table) is ticked when seen, never flagged when not.
      const missed = skipped.filter(j => j !== lightIdx && !subs[j].optional && live(j) && !S.occ.some(o => o.id === subs[j].id));
      if (!move) move = missed.length ? 'jump' : 'next';
      out.push(ev({ type: 'substep', substep: sub.id, from, move, source, conf, t: onset, cycle: S.cycle }));
      for (const j of missed) out.push(ev({ type: 'flag', substep: subs[j].id, note: 'skipped ' + subs[j].label, source, t: onset, cycle: S.cycle }));
      if (S.pos >= 0) S.off[S.pos] = false;
      S.off[i] = false;
      if (i === arrIdx) S.arrived = true;
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
        S.pos = -1; S.off = {}; S.arrived = false;
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
        // holdSec on a rule: it must also have stayed on this long (S3 model: two closed connectors for 3 s = unit done).
        // holdSec on an anyOf member applies to that member only: the shortest hold among the members that are on now wins
        // (S2 close: unit_complete counts at once, a plain closed connector only after 3 s).
        const hs = holdOf(ar.rule, r.vals, defaults);
        if (c.n >= N && !(hs > 0 && t - c.t0 < hs * 1000)) cands.push(i);
      }
      const pick = choose(cands);
      if (pick != null) transition(pick, out);
      return out;
    }

    function tick(t) { const out = []; S.t = t; duePending(t, out); return out; }
    // Outside a session: keep the frame so rules() can say what is ready, and track nothing. No hold counts and no "off"
    // marks, so a part already in view when tracking starts still has to leave before it can start a cycle.
    function idle(signals, t) { S.sig = signals || {}; S.t = t; }

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
    return { update, tick, idle, manualQa, setQaHold, abandon, flush, restart, setModel, state, rules, station, get modelClasses() { return modelClasses; } };
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
  // Also 'class:<name>#2' and '#3' (the second and third best box of that class), and a 'frame' zone that is the whole view.
  function classSignals(dets, zones, classes) {
    const out = {};
    const all = Object.assign({ [FRAME_ZONE]: { x: 0, y: 0, w: 1, h: 1 } }, zones || {});
    for (const id of Object.keys(all)) {
      const z = all[id], s = {}, confs = {};
      for (const c of classes || []) { s['class:' + c] = 0; confs[c] = []; }
      for (const d of dets || []) {
        if (!confs[d.cls] || !d.nbox) continue;
        if (inRect((d.nbox[0] + d.nbox[2]) / 2, (d.nbox[1] + d.nbox[3]) / 2, z)) confs[d.cls].push(d.conf);
      }
      for (const c of Object.keys(confs)) {
        const a = confs[c].sort((x, y) => y - x);
        s['class:' + c] = a[0] || 0; s['class:' + c + '#2'] = a[1] || 0; s['class:' + c + '#3'] = a[2] || 0;
      }
      out[id] = s;
    }
    return out;
  }
  // A finished unit (station.assembly): all clamps closed and every wire in the connector. "Closed" alone is not enough, because
  // the connector looks closed between wires. The model cannot see a black wire once it is clamped, so that one is read from the
  // pixels. Measured on the S2 recordings of 2026-10-29 and 2026-11-05: docs/wire-line-process.md, "When a unit counts as done".
  const ASSEMBLY = { closed: 0.6, open: 0.4, wire: 0.4, endTol: 1.5, ringIn: 1.5, ringOut: 3.2, rings: 8, arc: 75, dark: 0.55, sat: 0.35, minDark: 0.5 };
  const trackedClasses = (station, classes) => (station && station.assembly ? classes.concat(station.assembly.class) : classes);
  function geom(d, W, H) { const [a, b, c, e] = d.nbox; return { x0: a * W, y0: b * H, x1: c * W, y1: e * H, cx: (a + c) / 2 * W, cy: (b + e) / 2 * H, w: (c - a) * W, h: (e - b) * H }; }
  // A wire box's possible ends: the middles of its short edges when it is thin, else its corners (the wire runs corner to corner).
  function wireEnds(b) {
    if (b.w > 3 * b.h) return [[b.x0, b.cy], [b.x1, b.cy]];
    if (b.h > 3 * b.w) return [[b.cx, b.y0], [b.cx, b.y1]];
    return [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]];
  }
  // Share of the arcs around the connector, on the side the wires leave, that cross a dark colorless line. px(x, y) -> [r, g, b] or null.
  function darkLine(px, c, dir, o) {
    const R = Math.max(c.w, c.h) / 2, a0 = Math.atan2(dir[1], dir[0]), half = o.arc * Math.PI / 180;
    let hits = 0;
    for (let k = 0; k < o.rings; k++) {
      const r = R * (o.ringIn + (o.ringOut - o.ringIn) * k / (o.rings - 1)), n = Math.max(24, Math.round(2 * half * r)), cols = [];
      for (let i = 0; i <= n; i++) { const a = a0 - half + 2 * half * i / n, p = px(c.cx + r * Math.cos(a), c.cy + r * Math.sin(a)); if (p) cols.push(p); }
      if (cols.length < 8) continue;
      const med = cols.map(p => Math.max(p[0], p[1], p[2])).sort((x, y) => x - y)[cols.length >> 1];
      if (cols.some(p => { const v = Math.max(p[0], p[1], p[2]), m = Math.min(p[0], p[1], p[2]); return v < med * o.dark && (v - m) / (v || 1) < o.sat; })) hits++;
    }
    return hits / o.rings;
  }
  // One model result -> a detection of spec.class on the connector when the unit is finished, else null.
  function unitCheck(dets, px, W, H, spec) {
    const o = ASSEMBLY, best = (cls, min) => (dets || []).filter(d => d.cls === cls && d.conf >= min && d.nbox).sort((a, b) => b.conf - a.conf)[0] || null;
    const closed = best(spec.closed, o.closed);
    if (!closed || best(spec.open, o.open)) return null;
    const c = geom(closed, W, H), R = Math.max(c.w, c.h) / 2, far = [];
    for (const cls of spec.wires) {
      const w = best(cls, o.wire);
      if (!w) return null;
      const b = geom(w, W, H), dist = e => Math.hypot(e[0] - c.cx, e[1] - c.cy);
      if (Math.min.apply(null, wireEnds(b).map(dist)) / R > o.endTol) return null;
      far.push([[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].sort((p, q) => dist(q) - dist(p))[0]);
    }
    const mx = far.reduce((a, p) => a + p[0], 0) / far.length, my = far.reduce((a, p) => a + p[1], 0) / far.length;
    if (spec.darkWire && darkLine(px, c, [mx - c.cx, my - c.cy], o) < o.minDark) return null;
    return { cls: spec.class, conf: closed.conf, nbox: closed.nbox, box: closed.box, derived: true };
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
    if (cls && cls[FRAME_ZONE] && !out[FRAME_ZONE]) out[FRAME_ZONE] = Object.assign({}, cls[FRAME_ZONE]);
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
      if (inp.idle) return out;    // outside a session: Save correct state keeps its frames, but nothing is judged and nothing sounds
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
      // The unit is complete and frozen in view: whatever mistake or review is showing goes away (the checker is not run again until it leaves).
      dismiss() { const had = !!(C.show && (C.show.kind === 'mistake' || C.show.kind === 'review')); C.show = null; C.cleared = null; C.pending = null; return had; },
      get ref() { return ref; }, get current() { return C.show; }, get cleared() { return C.cleared; }, get clear() { return C.clear; },
      get pending() { return C.pending ? subs[C.pending.idx].id : null; }, get frames() { return C.frames.length; }
    };
  }

  // ---------- unit tracker: one live state machine per station ----------
  // Counts units as they pass through a station, by order (unit k is the k-th unit in; no marker on the unit).
  // waiting (work area empty) -> in_progress (a unit arrived: it takes the next number, #001, #002, ...) -> complete (the step
  // checker closed its cycle) -> the unit leaves (out of view for departMs) or the next unit arrives -> waiting / in_progress.
  // A unit that leaves before it is complete is recorded as incomplete and flagged needsReview; it is never counted as done.
  // Pure: no clock, no page. The page feeds it the signals it already has. The key presses stay the ground truth;
  // manual() records them so the tracker can show how often it disagrees. Config: station.unitTracker (see UNIT_TRACKER).
  const UNIT_TRACKER = { enabled: false, departMs: 2000, enterMs: 500, presentConf: 0.35, startNeedsEmpty: true, newUnitNeedsEmpty: false, presenceClasses: [], from: null };
  const unitNo = n => '#' + String(n).padStart(3, '0');
  const unlinkedNo = n => '?' + String(n).padStart(2, '0');
  const unitTrackerOn = st => !!(st && st.unitTracker && st.unitTracker.enabled);
  // The hand-off between stations (S2 -> S3): a unit keeps ONE number down the line. A station whose unitTracker names `from` does not
  // number its own units: each arrival takes the next unit that left the `from` station, in order (a FIFO queue, no marker on the unit).
  // An arrival with nothing queued is an unlinked unit (?01, ?02, ...): flagged for review, and the order of the real numbers is not touched.
  function createUnitLink(config) {
    const from = {}, up = {};
    for (const st of (config && config.stations) || []) if (unitTrackerOn(st) && st.unitTracker.from) { from[st.id] = st.unitTracker.from; up[st.unitTracker.from] = true; }
    let queue = {}, cur = {};
    return {
      from, up,
      reset(id) { queue[id] = []; cur[id] = null; },
      watch(id, c) { cur[id] = c; },
      // Upstream: a unit left (it is waiting for the next station). A unit the downstream station already claimed is not queued twice.
      push(id, u) { if (!u.claimed) (queue[id] = queue[id] || []).push(u); },
      // Downstream: the next unit from `id`. When the queue is empty, a finished unit still debouncing its departure upstream is claimed
      // (the unit already reached the next station: S2 only has not decided it left yet).
      claim(id) {
        const q = queue[id] || [];
        if (q.length) return q.shift();
        const c = cur[id];
        if (c && c.done && !c.claimed) { c.claimed = true; return { unit: c.unit, no: c.no, result: 'complete', needsReview: false }; }
        return null;
      },
      length(id) { return (queue[id] || []).length; },
      peek(id) { const q = queue[id] || []; return q.length ? q[0] : null; }
    };
  }
  // input: { t, present (a unit is in view; null = unknown, keep the last answer), hand (true while a hand is in view), complete (true while the
  // unit-complete signal holds), events (what the tracker and checker emitted since the last call) }. Returns unit events.
  // Complete = the step checker closed its cycle (cycle_end); on S2 that is the unit_complete detector, on S3 all its steps done. The
  // departure debounce (departMs) then decides when it left. opts.link: a createUnitLink() shared by the stations of one line.
  function createUnitTracker(station, opts) {
    const o = Object.assign({}, UNIT_TRACKER, station && station.unitTracker, opts || {});
    const link = o.link || null, arrival = station && station.arrival;
    let phase = 'waiting', n = 0, cur = null, units = [], needEmpty = !!o.startNeedsEmpty, lastPresent = false, unlinkedN = 0;
    let presentSince = null, absentSince = null, manual = [], t0 = null;
    const sid = station && station.id;
    const upId = link && link.from[sid] || null, isUp = !!(link && link.up[sid]);
    if (link) link.reset(sid);
    const base = (action, t, extra) => Object.assign({ type: 'unit', station: sid, action, t, unit: cur ? cur.unit : n, no: cur ? cur.no : unitNo(n) }, extra);
    function begin(t, out) {
      n++;
      let unit = n, no = unitNo(n), unlinked = false, fromResult = null;
      if (upId) {
        const u = link.claim(upId);
        if (u) { unit = u.unit; no = u.no; fromResult = u.result || null; }
        else { unlinkedN++; unit = null; no = unlinkedNo(unlinkedN); unlinked = true; }
      }
      cur = { unit, no, station: sid, start: t, end: null, completeT: null, steps: [], mistakes: 0, reviews: 0, result: null, needsReview: unlinked, ended: null, unlinked, fromResult, done: false, claimed: false };
      if (isUp) link.watch(sid, cur);
      phase = 'in_progress'; presentSince = null; absentSince = null;
      out.push(base('start', t, upId ? { from: upId, unlinked } : {}));
    }
    function markComplete(t) { phase = 'complete'; cur.completeT = t; cur.done = true; }
    function finish(t, ended, out, reset) {
      const complete = phase === 'complete';
      cur.end = t; cur.ended = ended; cur.result = complete ? 'complete' : 'incomplete'; cur.needsReview = cur.unlinked || !complete;
      const steps = cur.steps.map((s, i) => ({ id: s.id, t: s.t, sec: round(((i + 1 < cur.steps.length ? cur.steps[i + 1].t : (cur.completeT != null ? cur.completeT : t)) - s.t) / 1000, 3) }));
      cur.steps = steps;
      const rec = Object.assign({}, cur);
      units.push(rec);
      // A unit that left upstream waits in the queue for the next station (unless the session ended with it still on the bench).
      if (isUp && ended !== 'session_stopped') link.push(sid, { unit: rec.unit, no: rec.no, result: rec.result, needsReview: rec.needsReview, claimed: cur.claimed });
      if (isUp) link.watch(sid, null);
      out.push(base('end', t, { start: rec.start, end: rec.end, sec: round((rec.end - rec.start) / 1000, 3), completeT: rec.completeT, result: rec.result, needsReview: rec.needsReview, ended, steps, mistakes: rec.mistakes, reviews: rec.reviews, reset: !!reset, unlinked: rec.unlinked, from: upId, fromResult: rec.fromResult }));
      cur = null; phase = 'waiting'; presentSince = null; absentSince = null;
    }
    function take(events) {
      let arrived = false;
      for (const e of events || []) {
        if (!e || (e.station != null && e.station !== sid)) continue;
        if (e.type === 'substep' && e.source !== 'manual') {
          if (arrival && e.substep === arrival && e.move !== 'repeat' && phase === 'complete' && e.t > (cur.completeT || 0)) {
            // newUnitNeedsEmpty: the finished unit's own wires are still in view, so this arrival is not a new unit; the next one starts only after it left.
            if (!o.newUnitNeedsEmpty) arrived = true;
            continue;
          }
          if (cur && e.move !== 'repeat') cur.steps.push({ id: e.substep, t: e.t });
        } else if (e.type === 'cycle_end' && e.source !== 'manual' && cur && phase === 'in_progress') markComplete(e.t);
        else if (e.type === 'verdict' && cur && (e.kind === 'mistake' || e.kind === 'review')) cur[e.kind === 'mistake' ? 'mistakes' : 'reviews']++;
      }
      return arrived;
    }
    // The arrival substep of this station (a non-repeat one) in a batch of events: the unit has arrived, whatever the presence says yet.
    const arrivalIn = events => { for (const e of events || []) if (e && e.type === 'substep' && e.source !== 'manual' && (e.station == null || e.station === sid) && arrival && e.substep === arrival && e.move !== 'repeat') return e; return null; };
    function update(input) {
      const x = input || {}, t = x.t, out = [];
      if (t0 == null) t0 = t;
      if (x.present != null) lastPresent = !!x.present;
      const present = lastPresent, occupied = present || !!x.hand;
      if (phase === 'waiting') {
        if (needEmpty) { if (!present) needEmpty = false; return out; }
        // The number is given the moment the unit arrives: the arrival step, or the unit staying in view for enterMs (counted from when it showed).
        const arr = arrivalIn(x.events);
        if (present) { if (presentSince == null) presentSince = t; } else presentSince = null;
        if (arr || (present && t - presentSince >= o.enterMs)) { begin(arr ? Math.min(arr.t, presentSince == null ? arr.t : presentSince) : presentSince, out); take(x.events); }
        if (cur && x.complete && phase === 'in_progress') markComplete(t);
        return out;
      }
      const arrived = take(x.events);
      if (phase === 'in_progress' && x.complete && cur.completeT == null) markComplete(t);
      if (arrived) {          // the next unit's wires came in while the finished one was still in view
        finish(t, 'new_unit', out, false);
        begin(t, out); cur.steps.push({ id: arrival, t });
        return out;
      }
      if (occupied) absentSince = null;
      else {
        if (absentSince == null) absentSince = t;
        if (t - absentSince >= o.departMs) finish(absentSince, 'departed', out, true);
      }
      return out;
    }
    // The session stopped: close the open unit (complete if it was done, else incomplete and flagged).
    function stop(t) { const out = []; if (cur) finish(t, 'session_stopped', out, false); return out; }
    // A key press (the answer key): the k-th press is matched to the k-th complete unit.
    function noteManual(t) { manual.push(t); }
    function state() {
      const done = units.filter(u => u.result === 'complete').length + (phase === 'complete' ? 1 : 0);
      const inc = units.filter(u => u.result === 'incomplete').length;
      const nx = upId ? link.peek(upId) : null;
      return { phase, unit: cur ? cur.unit : null, no: cur ? cur.no : null, next: upId ? (nx ? nx.no : null) : unitNo(n + 1), counted: n, completed: done, incomplete: inc,
        manual: manual.length, disagreements: Math.abs(done - manual.length), needsReview: units.filter(u => u.needsReview).length,
        start: cur ? cur.start : null, units: units.slice(), current: cur ? Object.assign({}, cur) : null, waitingEmpty: needEmpty,
        from: upId, queue: isUp ? link.length(sid) : 0, queueFrom: upId ? link.length(upId) : 0, unlinked: unlinkedN, unlinkedNow: !!(cur && cur.unlinked) };
    }
    function restart() { phase = 'waiting'; n = 0; unlinkedN = 0; cur = null; units = []; needEmpty = !!o.startNeedsEmpty; lastPresent = false; presentSince = null; absentSince = null; manual = []; if (link) link.reset(sid); }
    // True while the finished unit is still in view and newUnitNeedsEmpty is on: the station's step engine and checker must sit out (see stepStation).
    const holding = () => !!(o.newUnitNeedsEmpty && phase === 'complete');
    // True while a unit is being worked (a number was given and it has not ended): wrong order before that is the wires arriving, not a mistake.
    const active = () => phase !== 'waiting';
    return { update, stop, noteManual, state, restart, holding, active, config: o };
  }
  // The one place the page and the replay decide whether a station's step engine may run this frame: not while its tracker holds a
  // finished unit that has not left (its wires are still in view, they must not start cycle 2). Returns { held, events }.
  function stepStation(eng, ut, signals, t) {
    if (ut && ut.holding && ut.holding()) { eng.idle(signals, t); return { held: true, events: [] }; }
    return { held: false, events: eng.update(signals, t) };
  }
  // What the step checker is shown: while the tracker has no unit in progress, the engine's "skipped" flags are left out, so no wrong-order
  // mistake is raised for wires that are still arriving (the engine's own events and log are untouched). No tracker: everything passes.
  function checkerEvents(events, ut) {
    if (!ut || !ut.active || ut.active() || ut.holding()) return events;
    return events.filter(e => !(e && e.type === 'flag' && /^skipped /.test(e.note || '')));
  }
  // The number on a flow-strip link: units waiting between two stages. Blank (null) when the upstream station has no camera or source (nothing
  // counts there, so the downstream count would read as a negative pile), and never below zero.
  function wipShown(n, upstreamHasSource) { return !isNum(n) || !upstreamHasSource ? null : Math.max(0, n); }
  // Presence for the live page and the replay: a unit is in view when a presence class is detected anywhere at presentConf or more.
  function unitPresent(dets, cfg) {
    const c = cfg || {}, min = isNum(c.presentConf) ? c.presentConf : UNIT_TRACKER.presentConf, set = c.presenceClasses || [];
    return (dets || []).some(d => d && set.indexOf(d.cls) >= 0 && d.conf >= min);
  }
  // The unit events of a session for one station, as rows: the end events, plus a still-open start as an unfinished row.
  function trackedUnits(events, stationId) {
    const sorted = sortEvents(events), out = [], open = {};
    for (const e of sorted) {
      if (e.type !== 'unit' || (stationId && e.station !== stationId)) continue;
      if (e.action === 'start') open[e.station] = e;
      else if (e.action === 'end') { const s0 = open[e.station]; delete open[e.station]; out.push(s0 ? Object.assign({}, e, { videoFile: s0.videoFile != null ? s0.videoFile : e.videoFile, videoStartT: s0.videoT != null ? s0.videoT : null }) : e); }
    }
    for (const e of Object.values(open)) out.push({ type: 'unit', station: e.station, action: 'open', t: e.t, unit: e.unit, no: e.no, start: e.t, end: null, result: null, needsReview: true, ended: null, steps: [], mistakes: 0, reviews: 0, videoFile: e.videoFile || null, videoStartT: e.videoT != null ? e.videoT : null });
    return out.sort((a, b) => (a.start - b.start) || ((a.unit || 0) - (b.unit || 0)));
  }
  // One row per unit for the whole line: the unit's number is the key, and each tracked station adds its own columns (arrival, end, steps,
  // mistakes), so S2 and S3 sit on one row. Unlinked units (an S3 arrival with nothing from S2) get their own rows, numbered ?01, ?02.
  const STATION_UNIT_COLS = ['arrive_ts', 'end_ts', 'dur_s', 'complete_ts', 'result', 'ended', 'steps', 'mistakes', 'reviews', 'video_file', 'video_t'];
  const TRACKED_COLS = ['session_id', 'crew', 'shift', 'unit_no', 'unit', 'needs_review'];
  const trackedCols = config => TRACKED_COLS.concat([].concat(...config.stations.filter(unitTrackerOn).map(st => STATION_UNIT_COLS.map(c => st.id + '_' + c))));
  function unitRows(events, config) {
    const sorted = sortEvents(events), tr = config.stations.filter(unitTrackerOn), byNo = {}, order = [];
    for (const st of tr) for (const u of trackedUnits(sorted, st.id)) {
      const key = u.unit != null ? 'n' + u.unit : 'u' + u.no + ':' + st.id;
      if (!byNo[key]) { byNo[key] = { no: u.no, unit: u.unit, at: u.start, stations: {} }; order.push(byNo[key]); }
      byNo[key].stations[st.id] = u;
      if (u.start < byNo[key].at) byNo[key].at = u.start;
    }
    return order.sort((a, b) => (a.unit != null && b.unit != null ? a.unit - b.unit : a.unit != null ? -1 : b.unit != null ? 1 : a.at - b.at));
  }
  // One row per unit across the line, for the live board. Stations by role: the tracked station with no `from` is "s2" (upstream), the one with
  // `from` (or role DONE_ROLE) is "s3" (downstream; its completion makes the unit done). Stage: needs_review (unlinked, or stopped mid-cycle),
  // s3, done, s2, waiting_s3 (left s2, not claimed). Done is only ever S3's: with no S3 station a unit that left S2 stays waiting_s3. Mistakes are the verdict
  // events (kind mistake or review) of that station inside the unit's start-to-end window there (open window runs to `now`).
  // Order: needs_review first, then in-line units (s3, waiting_s3, s2; oldest first), then done, newest first.
  function lineUnits(events, config, opts) {
    const sorted = sortEvents(events), now = opts && isNum(opts.now) ? opts.now : (sorted.length ? sorted[sorted.length - 1].t : 0), stopped = !!(opts && opts.stopped);
    const tr = ((config && config.stations) || []).filter(unitTrackerOn);
    const down = tr.filter(st => st.unitTracker.from || (st.role || st.id) === DONE_ROLE), up = tr.filter(st => down.indexOf(st) < 0);
    const roleOf = {}; for (const st of up) roleOf[st.id] = 's2'; for (const st of down) roleOf[st.id] = 's3';
    const sec = (a, b) => (isNum(a) && isNum(b) ? round((b - a) / 1000, 3) : null);
    // Pair each station's start with its end (one unit at a time per station); a start without an end is open.
    const open = {}, recs = [];
    for (const e of sorted) {
      if (e.type !== 'unit' || !roleOf[e.station]) continue;
      if (e.action === 'start') open[e.station] = e;
      else if (e.action === 'end') {
        const s0 = open[e.station]; delete open[e.station];
        recs.push({ role: roleOf[e.station], station: e.station, unit: e.unit, no: e.no, start: e.start != null ? e.start : e.t, end: e.end != null ? e.end : e.t, completeT: e.completeT, result: e.result, unlinked: !!e.unlinked, needsReview: !!e.needsReview, ended: e.ended, videoFile: (s0 && s0.videoFile) || e.videoFile || null, videoT: s0 && s0.videoT != null ? s0.videoT : (e.videoT != null ? e.videoT : null), videoEndT: e.videoT != null && s0 ? e.videoT : null });
      }
    }
    for (const e of Object.values(open)) recs.push({ role: roleOf[e.station], station: e.station, unit: e.unit, no: e.no, start: e.t, end: null, completeT: null, result: null, unlinked: !!e.unlinked, needsReview: false, ended: null, videoFile: e.videoFile || null, videoT: e.videoT != null ? e.videoT : null, videoEndT: null });
    const by = {}, list = [];
    for (const r of recs) {
      const key = r.unit != null ? 'n' + r.unit : 'u' + r.no + ':' + r.station;
      if (!by[key]) { by[key] = { no: r.no, unit: r.unit, s2: null, s3: null }; list.push(by[key]); }
      by[key][r.role] = r;
    }
    const verdicts = sorted.filter(e => e.type === 'verdict' && (e.kind === 'mistake' || e.kind === 'review'));
    const stationInfo = r => {
      if (!r) return null;
      const hi = r.end != null ? r.end : now;
      const msgs = verdicts.filter(v => v.station === r.station && v.t >= r.start && (r.end != null ? v.t < r.end : v.t <= hi))
        .map(v => ({ kind: v.kind, code: v.reason || null, message: v.message || null, t: v.t, videoT: v.videoT != null ? v.videoT : null, videoFile: v.videoFile || null }));
      // Steps: the station's substep events inside the window (repeats left out); a step runs to the next one, the last to the window end.
      const stCfg = tr.find(x => x.id === r.station), label = id => { const s = ((stCfg && stCfg.substeps) || []).find(x => x.id === id); return s ? s.label : id; };
      const evs = sorted.filter(e => e.type === 'substep' && e.station === r.station && e.move !== 'repeat' && e.t >= r.start && (r.end != null ? e.t < r.end : e.t <= hi));
      // Consecutive events with the same step key are one step (W1 1): start of the first, end of the last.
      const grp = []; for (const e of evs) { if (grp.length && grp[grp.length - 1].substep === e.substep) continue; grp.push(e); }
      const steps = grp.map((e, i) => { const nx = i + 1 < grp.length ? grp[i + 1].t : hi; return { key: e.substep, label: label(e.substep), start: e.t, end: nx, sec: sec(e.t, nx) }; });
      return { station: r.station, start: r.start, end: r.end, sec: sec(r.start, hi), result: r.result, ended: r.ended, steps, mistakes: msgs.filter(m => m.kind === 'mistake').length, reviews: msgs.filter(m => m.kind === 'review').length, messages: msgs,
        videoFile: r.videoFile, videoT: r.videoT, videoEndT: r.videoEndT };
    };
    const rows = list.map(u => {
      const a = u.s2, b = u.s3;
      const incomplete = [a, b].some(r => r && r.end != null && r.result === 'incomplete');
      const review = !!(b && b.unlinked) || !!(a && a.unlinked) || incomplete;
      let stage, since;
      if (review) { stage = 'needs_review'; since = Math.max(...[a, b].filter(Boolean).map(r => (r.end != null ? r.end : r.start))); }
      else if (b) { if (b.end == null) { stage = 's3'; since = b.start; } else { stage = 'done'; since = b.end; } }
      else if (a && a.end == null) { stage = 's2'; since = a.start; }
      else { stage = 'waiting_s3'; since = a.end; }   // left S2: waiting for S3 (also with no S3 on the floor: done is only ever S3's)
      const first = a || b, last = b || a, s2sec = a ? sec(a.start, a.end != null ? a.end : now) : null;
      const waitSec = a && a.end != null ? sec(a.end, b ? b.start : now) : null, s3sec = b ? sec(b.start, b.end != null ? b.end : now) : null;
      const fin = stage === 'done' || (stage === 'needs_review' && last.end != null);
      const mkS2 = stationInfo(a), mkS3 = stationInfo(b);
      if (stopped && stage !== 'done' && !(b && b.end != null && b.result === 'complete')) {   // C1 codex must-fix: a row S3 finished complete keeps its stage and result
        // After Stop: every unit not done at S3 is incomplete. cutOff: the Stop did it (it was in the line, or its open unit ended session_stopped).
        // A unit flagged before Stop (unlinked, or ended incomplete at a station on its own) keeps needsReview and is not cut off.
        const cutOff = stage !== 'needs_review' || [a, b].some(r => r && r.ended === 'session_stopped');
        const flagged = !!(b && b.unlinked) || !!(a && a.unlinked) || [a, b].some(r => r && r.end != null && r.result === 'incomplete' && r.ended !== 'session_stopped');
        return { no: u.no, unit: u.unit, stage: 'incomplete', cutOff, stageSec: sec(since, now), s2Sec: s2sec, waitSec, s3Sec: s3sec, totalSec: sec(first.start, fin ? last.end : now), start: first.start,
          needsReview: flagged, result: 'incomplete', s2: mkS2, s3: mkS3, mistakes: { s2: mkS2 ? mkS2.messages : [], s3: mkS3 ? mkS3.messages : [] } };
      }
      return { no: u.no, unit: u.unit, stage, stageSec: stage === 'done' ? null : sec(since, now), s2Sec: s2sec, waitSec, s3Sec: s3sec, totalSec: sec(first.start, fin ? last.end : now), start: first.start,
        needsReview: stage === 'needs_review', result: incomplete ? 'incomplete' : (last.end != null ? last.result : null), s2: mkS2, s3: mkS3,
        mistakes: { s2: mkS2 ? mkS2.messages : [], s3: mkS3 ? mkS3.messages : [] } };
    });
    const rank = { needs_review: 0, incomplete: 0, s3: 1, waiting_s3: 1, s2: 1, done: 2 };
    return rows.sort((x, y) => (rank[x.stage] - rank[y.stage]) || (x.stage === 'done' ? y.start - x.start : x.start - y.start));
  }
  // Tiles and alerts of the units board from lineUnits rows (pure). now: the clock; runStart: when the run began (units per hour).
  // inProgress.total counts the four in-line stages (s2, waiting_s3, s3, needs_review); incomplete rows (after Stop) are counted in incomplete and incompleteCutOff, never in progress or done. Alerts, problems first: review, wrong_order, stuck.
  function lineUnitStats(rows, opts) {
    const o = opts || {}, list = rows || [], now = isNum(o.now) ? o.now : null, runStart = isNum(o.runStart) ? o.runStart : null;
    const inProgress = { total: 0, s2: 0, waiting_s3: 0, s3: 0, needs_review: 0 };
    for (const r of list) if (r.stage !== 'done' && r.stage !== 'incomplete') { inProgress[r.stage]++; inProgress.total++; }
    const incompleteRows = list.filter(r => r.stage === 'incomplete');
    const done = list.filter(r => r.stage === 'done');
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null), avg = a => (a.length ? round(mean(a), 1) : null);
    const times = k => list.map(r => r[k]).filter(x => x && x.end != null && x.result !== 'incomplete' && isNum(x.sec)).map(x => x.sec);
    const stations = { s2: { avgSec: avg(times('s2')), n: times('s2').length }, s3: { avgSec: avg(times('s3')), n: times('s3').length } };
    const trueAvg = { s2: mean(times('s2')), s3: mean(times('s3')) };   // unrounded, for the stuck test (C1 6)
    const bottleneck = stations.s2.n && stations.s3.n && stations.s2.avgSec !== stations.s3.avgSec ? (stations.s2.avgSec > stations.s3.avgSec ? 's2' : 's3') : null;
    const el = now != null && runStart != null ? (now - runStart) / 1000 : null;
    const unitsPerHour = el != null && el >= 60 ? round(done.length / (el / 3600), 1) : null;
    const right = done.filter(r => ['s2', 's3'].every(k => !r[k] || (r[k].mistakes === 0 && r[k].reviews === 0)) && !r.needsReview).length;
    const rightFirstTime = { n: right, of: done.length, pct: done.length ? Math.round(100 * right / done.length) : null };
    const al = { review: [], wrong_order: [], stuck: [] }, who = r => r.no, STN = { s2: 'S2', s3: 'S3' };
    for (const r of list) {
      if (r.needsReview) {
        const k = r.s3 && r.s3.result === 'incomplete' ? 's3' : r.s2 && r.s2.result === 'incomplete' ? 's2' : r.s3 ? 's3' : 's2';
        al.review.push({ kind: 'review', unit: r.unit, no: r.no, station: r[k].station, stage: r.stage, sec: r.stageSec, message: 'Unit ' + who(r) + ' needs review at ' + STN[k] });
      }
      if (r.stage !== 'done' && r.stage !== 'incomplete') for (const k of ['s2', 's3']) for (const m of (r[k] ? r[k].messages : [])) if (m.kind === 'mistake' && m.code === 'wrong_order') {
        al.wrong_order.push({ kind: 'wrong_order', unit: r.unit, no: r.no, station: r[k].station, stage: r.stage, sec: now != null ? round((now - m.t) / 1000, 1) : null, message: 'Unit ' + who(r) + ' at ' + STN[k] + ': ' + (m.message || 'wrong order') });
      }
      if ((r.stage === 's2' || r.stage === 's3') && stations[r.stage].n >= 3 && isNum(r.stageSec) && r.stageSec > 2 * trueAvg[r.stage]) {
        const k = r.stage;
        al.stuck.push({ kind: 'stuck', unit: r.unit, no: r.no, station: r[k].station, stage: r.stage, sec: r.stageSec, message: 'Unit ' + who(r) + ' stuck at ' + STN[k] + ' for ' + Math.round(r.stageSec) + ' s, average ' + Math.round(stations[k].avgSec) + ' s' });
      }
    }
    return { done: done.length, inProgress, incomplete: incompleteRows.length, incompleteCutOff: incompleteRows.filter(r => r.cutOff).length, avgUnitSec: avg(done.map(r => r.totalSec).filter(isNum)), stations, bottleneck, unitsPerHour, rightFirstTime, alerts: [].concat(al.review, al.wrong_order, al.stuck) };
  }
  // The photos of one unit row: captures stamped with its unit, else (older sessions) by station and time inside that station's window. Oldest first.
  function unitPhotos(row, captures) {
    if (!row) return [];
    const wins = ['s2', 's3'].map(k => row[k]).filter(Boolean);
    const inWin = c => wins.some(w => c.station === w.station && isNum(c.t) && c.t >= w.start && (w.end == null ? (!isNum(w.sec) || c.t <= w.start + w.sec * 1000) : c.t < w.end));
    return (captures || []).filter(c => c && (c.unit != null ? row.unit != null && c.unit === row.unit : inWin(c))).map((c, i) => [c, i]).sort((a, b) => ((a[0].t || 0) - (b[0].t || 0)) || (a[1] - b[1])).map(x => x[0]);
  }
  function trackedUnitsCsv(events, config, meta) {
    const m = meta || {}, sorted = sortEvents(events), base = timeBase(sorted, m), ts = t => (t == null ? null : round((t - base) / 1000, 3));
    const tr = config.stations.filter(unitTrackerOn), lines = [trackedCols(config).join(',')];
    for (const r of unitRows(sorted, config)) {
      const review = tr.some(st => r.stations[st.id] && r.stations[st.id].needsReview);
      const cells = [m.id, m.crew, m.shift, r.no, r.unit, review];
      for (const st of tr) {
        const u = r.stations[st.id];
        if (!u) { cells.push(...STATION_UNIT_COLS.map(() => null)); continue; }
        cells.push(ts(u.start), ts(u.end), u.end != null ? round((u.end - u.start) / 1000, 3) : null, ts(u.completeT), u.result || 'open', u.ended, (u.steps || []).map(x => x.id + ':' + x.sec).join('|'), u.mistakes, u.reviews, u.videoFile || null, u.videoStartT != null ? u.videoStartT : null);
      }
      lines.push(csvLine(cells));
    }
    return lines.join('\n') + '\n';
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

  const DONE_ROLE = 's3';   // a unit is done when a station with this role completes it
  const perUnitOf = st => (st && Number.isInteger(st.perUnit) && st.perUnit >= 1 ? st.perUnit : 1);

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
      // Steps the session started without a drawn zone (the page's "no data" flags): no average, not a 0.
      const noData = sorted.filter(e => e.type === 'flag' && e.station === st.id && e.substep && typeof e.note === 'string' && e.note.startsWith(NO_DATA)).map(e => e.substep);
      for (const id of noData) if (id in subAvg) subAvg[id] = null;
      const obs = observedMs(sorted, st.id, tEnd);
      const busy = secs.reduce((a, b) => a + b, 0) * 1000 + (d.open ? Math.max(0, tEnd - d.open.start) : 0);
      const det = {
        cycles: d.cycles.length, lastSec: r1(secs.length ? secs[secs.length - 1] : null), avgSec: r1(mean(secs)), stdSec: r1(sd(secs)),
        substepAvg: subAvg, idleShare: obs > 0 && (d.cycles.length || d.open) ? round(clamp01(1 - busy / obs), 3) : null,
        repeats: d.cycles.reduce((a, c) => a + c.repeats, 0), flags: d.cycles.reduce((a, c) => a + c.flags.length, 0)
      };
      // A station with a unit tracker counts units, not step-engine cycles: a complete unit (departed, or still in view with its cycle closed).
      // (A session with no unit events from this station, e.g. recorded before the tracker, keeps the cycle count.)
      let trackedOpen = null;
      if (unitTrackerOn(st) && sorted.some(e => e.type === 'unit' && e.station === st.id)) {
        const tu = trackedUnits(sorted, st.id), isDone = u => u.result === 'complete' || (u.action === 'open' && d.cycles.some(c => c.end >= u.start));
        det.cycles = tu.filter(isDone).length;
        trackedOpen = tu.filter(u => u.action === 'open' && !isDone(u)).length;
      }
      const ms = m.map(x => x.sec).filter(isNum);
      const man = { cycles: m.length, lastSec: r1(ms.length ? ms[ms.length - 1] : null), avgSec: r1(mean(ms)), stdSec: r1(sd(ms)) };
      const basis = o.basis === 'detected' || o.basis === 'manual' ? o.basis : (det.cycles > 0 ? 'detected' : 'manual');
      const use = basis === 'detected' ? det : man;
      const per = perUnitOf(st);
      // Units being worked on right now (started, not finished): an open tracker unit whose cycle has not closed, else an open cycle (or a part-built unit).
      const working = trackedOpen != null ? trackedOpen : Math.ceil((use.cycles + (d.open ? 1 : 0)) / per) - Math.floor(use.cycles / per);
      stations[st.id] = { detected: det, manual: man, basis, unobserved: noData.filter((id, k) => noData.indexOf(id) === k), cycles: use.cycles, avgSec: use.avgSec, lastSec: use.lastSec, stdSec: use.stdSec,
        perUnit: per, units: Math.floor(use.cycles / per), working, unitSec: use.avgSec == null ? null : r1(use.avgSec * per), _d: d, _m: m };
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
    const elapsedSec = Math.max(0, (tEnd - t0) / 1000);
    // Stages: stations next to each other in flow order with the same role work side by side. WIP is counted between
    // stages (null between two stations of one stage), and a station's pace is its average over the stations in its stage.
    const stages = [], stageOf = {};
    for (const st of config.stations) {
      const role = st.role || st.id, last = stages[stages.length - 1];
      if (last && last.role === role) last.ids.push(st.id); else stages.push({ role, ids: [st.id] });
      stageOf[st.id] = stages.length - 1;
    }
    const stageUnits = k => stages[k].ids.reduce((a, id) => a + stations[id].units, 0);
    const pace = id => (stations[id].unitSec == null ? null : stations[id].unitSec / stages[stageOf[id]].ids.length);
    // A unit is done when an S3-role station completes it (the S3 stage; side-by-side S3 stations add up). A floor with no S3 station has no
    // done count (null). QA (S4) tests units that are already done: its tested, passed and failed numbers are separate.
    // The count is the station's units: tracker units when its unit tracker has events (incomplete and needsReview units never count), else cycles / perUnit.
    const doneIds = config.stations.filter(s => (s.role || s.id) === DONE_ROLE).map(s => s.id);
    let units = doneIds.length ? doneIds.reduce((a, id) => a + stations[id].units, 0) : null;
    const countedAt = doneIds.slice();
    // C2: with a tracked S3 station the line count comes from the one board result (lineUnits rows through lineUnitStats), the same numbers as the board's
    // tiles and alerts: done = complete at S3, an unlinked or flagged unit is to review (not done), and after Stop (opts.stopped) nothing is in progress.
    // No tracked S3 station (or none with unit events): the old event count stays.
    const trackedS3 = config.stations.filter(s => unitTrackerOn(s) && (s.unitTracker.from || (s.role || s.id) === DONE_ROLE));
    const anyTracked = config.stations.some(s => unitTrackerOn(s) && sorted.some(e => e.type === 'unit' && e.station === s.id));   // a session with no unit events (recorded before the tracker) keeps the cycle count
    let tr = null;
    if (anyTracked) {
      const rows = lineUnits(sorted, config, { now, stopped: !!o.stopped }), st = lineUnitStats(rows, { now });
      tr = { rows, st };
      if (trackedS3.length) units = st.done;
    }
    // Units in progress (WIP): started at the first station in flow order and not yet done at S3. A unit being worked on counts as started.
    const wip = [];
    let wipUnits = null, wipStarted = null;
    const wipBy = [], wipUnknown = [];
    if (stages.length) {
      const startedOf = k => stageUnits(k) + stages[k].ids.reduce((a, id) => a + stations[id].working, 0);
      const doneStage = stages.findIndex(g => g.role === DONE_ROLE);
      // Stations from the first one up to the S3 stage need a camera or source, or the count is unknown (the same rule as LineEngine.wipShown).
      const hasSource = id => sorted.some(e => e.station === id && (e.type === 'unit' || e.type === 'substep' || e.type === 'cycle_end' || (e.type === 'source_change' && e.input && e.input !== 'none')));
      const lastK = doneStage >= 0 ? doneStage : stages.length - 1;
      for (let k = 0; k <= lastK; k++) for (const id of stages[k].ids) if (!hasSource(id)) wipUnknown.push(id);
      wipStarted = startedOf(0);
      for (let k = 0; k <= lastK; k++) {
        const working = stages[k].ids.reduce((a, id) => a + stations[id].working, 0);
        const waiting = k < lastK ? Math.max(0, stageUnits(k) - startedOf(k + 1)) : 0;
        wipBy.push({ role: stages[k].role, ids: stages[k].ids.slice(), working, waitingForNext: waiting });
      }
      // No S3 station: nothing is ever done, so every started unit is in progress. Null only when a station's count is unknown.
      if (!wipUnknown.length) wipUnits = Math.max(0, wipStarted - (doneStage >= 0 ? units : 0));
      if (tr) {
        // Tracked: each in-line row counts once, at the station it is at (waiting_s3 waits after its S2 station; to review sits at its last station).
        for (const g of wipBy) { g.working = 0; g.waitingForNext = 0; }
        for (const r of tr.rows) {
          if (r.stage === 'done' || r.stage === 'incomplete' || o.stopped) continue;   // after Stop nothing is in progress (a row flagged unlinked stays to review in the alerts, not in WIP)
          const rec = r.stage === 'waiting_s3' ? r.s2 : r.stage === 's2' ? r.s2 : (r.s3 || r.s2), g = rec && wipBy[stageOf[rec.station]];
          if (g) { if (r.stage === 'waiting_s3') g.waitingForNext++; else g.working++; }
        }
        wipStarted = tr.rows.length;
        wipUnits = o.stopped ? 0 : tr.st.inProgress.total;   // tracker mode: the rows decide, wipUnknown (legacy count) does not
      }
    }
    // Work in progress counts units (a station with perUnit 3 hands over one unit every 3 cycles), between stages.
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = stageOf[ids[i]], b = stageOf[ids[i + 1]];
      let n = a === b ? null : stageUnits(a) - stageUnits(b);
      if (tr && n != null) {
        // Tracked: the pair out of the tracked S2 station is its waiting_s3 queue, out of S3 the done units not yet taken on; after Stop every pair is 0.
        const fromUp = tr.rows.some(r => r.s2 && r.s2.station === ids[i]), fromDown = trackedS3.some(x => x.id === ids[i]);
        if (o.stopped) n = 0;
        else if (fromUp && trackedS3.some(x => x.id === ids[i + 1])) n = tr.st.inProgress.waiting_s3;
        else if (fromDown) n = Math.max(0, tr.st.done - stageUnits(b));
      }
      wip.push({ from: ids[i], to: ids[i + 1], n });
    }
    // The bottleneck is the station with the longest time per unit (averaged over its stage), not per cycle.
    let bottleneck = null;
    for (const id of ids) { const a = pace(id); if (a != null && (bottleneck == null || a > pace(bottleneck))) bottleneck = id; }
    const cycleEnds = {};
    for (const id of ids) { cycleEnds[id] = { detected: stations[id].detected.cycles, manual: stations[id].manual.cycles }; delete stations[id]._d; delete stations[id]._m; }
    const takt = isNum(config.taktSec) ? config.taktSec : null;
    return {
      stations,
      line: {
        units, countedAt, wipUnits, wipStarted, wipBy, wipUnknown, elapsedSec: r1(elapsedSec), uph: units != null && elapsedSec >= 1 ? r1(units * 3600 / elapsedSec) : null,
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

  // ---------- units: link the stations by order ----------
  // Unit k is the k-th unit out of every station: the first perUnit cycles of a station make unit 1, the next perUnit
  // unit 2, and so on (S1 cuts three wires per unit). No marker is read, so this holds as long as nobody reorders or
  // sets aside units. Each station uses its detected cycles if it has any, else the manual presses (as the dashboard's
  // Auto count). wait_s is the time from the previous station finishing the unit to this station's arrival substep
  // (the k-th time that substep was detected), else to the start of its first cycle for the unit.
  function linkUnits(events, config) {
    const sorted = sortEvents(events);
    const per = {}, maxUnits = [];
    for (const st of config.stations) {
      const d = detectedCycles(sorted, st.id).cycles, m = manualCycles(sorted, st.id);
      const basis = d.length ? 'detected' : 'manual';
      const cyc = basis === 'detected'
        ? d.map(c => ({ start: c.start, end: c.end, sec: c.sec, mistakes: c.mistakes, reviews: c.reviews, result: c.qa ? c.qa.result : null, reason: c.qa ? c.qa.reason : null, videoFile: c.videoFile, videoT: c.videoStart }))
        : m.map(x => ({ start: x.prevT, end: x.t, sec: x.sec, mistakes: null, reviews: null, result: st.qa ? x.result : null, reason: x.reason, videoFile: x.videoFile, videoT: x.videoT }));
      const arrivals = st.arrival ? sorted.filter(e => e.type === 'substep' && e.station === st.id && e.substep === st.arrival && isDetected(e)).map(e => e.t) : [];
      const n = perUnitOf(st);
      per[st.id] = { st, basis, cyc, arrivals, n };
      maxUnits.push(Math.ceil(cyc.length / n), arrivals.length);
    }
    const total = Math.max(0, ...maxUnits);
    const units = [];
    for (let k = 0; k < total; k++) {
      const u = { unit: k + 1, stations: {}, result: null, reason: null };
      let prevEnd = null;
      for (const st of config.stations) {
        const p = per[st.id], part = p.cyc.slice(k * p.n, (k + 1) * p.n), done = part.length === p.n;
        const arrival = p.arrivals[k] != null ? p.arrivals[k] : null;
        const start = part.length ? (part[0].start != null ? part[0].start : arrival) : arrival;
        const end = done ? part[part.length - 1].end : null;
        const secs = part.map(c => c.sec).filter(isNum);
        const sum = key => (p.basis === 'detected' ? part.reduce((a, c) => a + (c[key] || 0), 0) : null);
        const seen = arrival != null ? arrival : start;
        u.stations[st.id] = {
          basis: p.basis, cycles: part.length, done, start, end, arrival,
          workSec: done && secs.length === part.length ? round(secs.reduce((a, b) => a + b, 0), 3) : null,
          waitSec: prevEnd != null && seen != null ? round((seen - prevEnd) / 1000, 3) : null,
          mistakes: sum('mistakes'), reviews: sum('reviews'), videoFile: part.length ? part[0].videoFile : null, videoT: part.length ? part[0].videoT : null
        };
        if (st.qa && done) { u.result = part[part.length - 1].result || 'unknown'; u.reason = part[part.length - 1].reason || null; }
        prevEnd = end;
      }
      const ids = config.stations.map(s => s.id), firstStart = u.stations[ids[0]].start, lastEnd = u.stations[ids[ids.length - 1]].end;
      u.leadSec = firstStart != null && lastEnd != null ? round((lastEnd - firstStart) / 1000, 3) : null;
      const at = ids.find(id => !u.stations[id].done);
      u.status = at ? 'at ' + at : 'done';
      units.push(u);
    }
    return units;
  }

  function unitCols(config) {
    const cols = ['session_id', 'crew', 'shift', 'unit', 'status'];
    for (const st of config.stations) cols.push(st.id + '_basis', st.id + '_cycles', st.id + '_start_ts', st.id + '_end_ts', st.id + '_work_s', st.id + '_wait_s', st.id + '_mistakes', st.id + '_reviews', st.id + '_video_file', st.id + '_video_t');
    cols.push('result', 'reason', 'cause_station', 'defect', 'lead_s');
    // Appended (older readers ignore them): the auto unit number and what the unit tracker saw, for stations that have a tracker.
    const tr = config.stations.filter(unitTrackerOn);
    if (tr.length) { cols.push('unit_no'); for (const st of tr) cols.push(st.id + '_unit_no', st.id + '_unit_result', st.id + '_unit_ended', st.id + '_unit_review'); }
    return cols;
  }

  // One row per unit, linked across the stations by order (see linkUnits).
  function unitsCsv(events, config, meta) {
    const m = meta || {}, sorted = sortEvents(events), base = timeBase(sorted, m), ts = t => (t == null ? null : round((t - base) / 1000, 3));
    const lines = [unitCols(config).join(',')];
    const tr = config.stations.filter(unitTrackerOn), done = {};
    for (const st of tr) done[st.id] = trackedUnits(sorted, st.id).filter(x => x.result === 'complete');
    for (const u of linkUnits(sorted, config)) {
      const row = [m.id, m.crew, m.shift, u.unit, u.status];
      for (const st of config.stations) {
        const x = u.stations[st.id];
        row.push(x.basis, x.cycles, ts(x.start), ts(x.end), x.workSec, x.waitSec, x.mistakes, x.reviews, x.videoFile, x.videoT);
      }
      const info = u.result === 'fail' ? reasonInfo(config, u.reason) : null;
      row.push(u.result, u.reason, info ? info.cause : null, info ? info.defect : null, u.leadSec);
      if (tr.length) {
        const recs = tr.map(st => done[st.id][u.unit - 1] || null), first = recs.find(Boolean);
        row.push(first ? first.no : null);
        for (const r of recs) row.push(r ? r.no : null, r ? r.result : null, r ? r.ended : null, r ? !!r.needsReview : null);
      }
      lines.push(csvLine(row));
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

  // ---------- standard setup views ----------
  // A role in the standard file holds its main view (zones, aspect, ...) and optional otherViews for other shapes of video.
  // Zones are fractions of the frame, so each view only fits the shape (width / height) it was drawn on.
  function standardViews(role, zoneIds) {
    const out = [];
    if (!role || typeof role !== 'object') return out;
    const ids = Array.isArray(zoneIds) ? zoneIds : null;
    const add = (v, main, index) => {
      if (!v || typeof v !== 'object' || !v.zones || typeof v.zones !== 'object') return;
      const zones = {};
      for (const k of Object.keys(v.zones)) {
        const b = v.zones[k];
        if (b && (!ids || ids.includes(k))) zones[k] = { x: b.x, y: b.y, w: b.w, h: b.h };
      }
      if (!Object.keys(zones).length) return;
      out.push({ zones, aspect: v.aspect > 0 ? v.aspect : null, source: v.source || null, updatedAt: v.updatedAt || null, main, index });
    };
    add(role, true, -1);
    if (Array.isArray(role.otherViews)) role.otherViews.slice(0, 8).forEach((v, i) => add(v, false, i));
    return out;
  }
  // The view for a live shape: the nearest aspect (by ratio). fits: within 10% of it (or the view records no aspect).
  function pickStandardView(role, zoneIds, aspect) {
    const views = standardViews(role, zoneIds);
    if (!views.length) return null;
    if (!(aspect > 0)) return { view: views[0], fits: true };
    const withA = views.filter(v => v.aspect), pool = withA.length ? withA : views;
    let best = pool[0], bd = Infinity;
    for (const v of pool) {
      const d = v.aspect ? Math.abs(Math.log(aspect / v.aspect)) : Infinity;
      if (d < bd) { bd = d; best = v; }
    }
    return { view: best, fits: !best.aspect || Math.abs(aspect / best.aspect - 1) <= 0.1 };
  }
  // The same boxes (same zone ids, every x, y, w, h within half a thousandth).
  function sameZones(a, b) {
    if (!a || !b) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => b[k] && a[k] && ['x', 'y', 'w', 'h'].every(f => Math.abs(a[k][f] - b[k][f]) <= 0.0005));
  }

  return {
    DEFAULTS, MOTION, MISMATCH_NOTE, EVENT_TYPES, CYCLE_ACTIONS, SUBSTEP_COLS, CYCLE_COLS, VERDICT_COLS, CHECK, LEVELS, OPERATOR_CODE, FLOOR, CLASS_TEST,
    members, activeRule, evalRule, missingOf, ruleText, checkConfig, captureDefaults, CAPTURE_DEFAULTS, captureWanted, nextSampleDue, modelFor, checkModelOutput, e2eBadClass, qaDecide, createStation,
    operatorCode, defaultName, shortName, classTestLayout, setupKey, nextStationId, freeSpot, saveScheduler, applyLayout,
    zoneSignals, calibrationFrom, classSignals, trackedClasses, unitCheck, ASSEMBLY, handPresence, steadyClasses, mergeSignals, createChecker, createUnitTracker, createUnitLink, stepStation, checkerEvents, wipShown, unitRows, lineUnits, lineUnitStats, unitPhotos, unitPresent, unitNo, unitTrackerOn, UNIT_TRACKER, trackedUnits, trackedUnitsCsv, TRACKED_COLS,
    standardViews, pickStandardView, sameZones, sortEvents, ruleZones, unobserved, NO_DATA, detectedCycles, manualCycles, summarize, substepsCsv, cyclesCsv, verdictsCsv, linkUnits, unitCols, unitsCsv, csvCell
  };
});
