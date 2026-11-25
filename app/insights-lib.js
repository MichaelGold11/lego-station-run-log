// Assembly Insights: turns recorded wire line sessions into what a plant manager needs (where to look, is it real,
// is it a pattern, did the fix work). Pure functions, no DOM. Browser: window.InsightsLib. Node: module.exports.
//
// Two steps, so every page uses one calculation (the dashboard field guide's "one definition everywhere"):
//   digestSession(): one session's events -> its cycles per station and its observations (server side, needs LineEngine)
//   rollup(): many digests + review decisions + a period -> every number on /insights (Overview, Stations, Trends)
// makeDemo() builds a simulated week through the same digest shape, so Simulation and Camera run the same code.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InsightsLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MISMATCH_NOTE = 'quality mismatch, review the video';
  const NO_DATA = 'no data: ';
  const SLOW_PCT = 10;            // coral only past 10% slower than reference (field guide)
  const MIN_REF_CYCLES = 5;       // a station's own median needs at least this many cycles to be a reference
  const MIN_FA_REVIEWS = 5;       // only name a checkpoint's false-alarm rate with 5+ reviews (audit, HIGH)
  const PHOTO_WINDOW_MS = 4000;

  const KIND = {
    wrong_order: 'Steps out of order', missing: 'Missing part', wrong_position: 'Part in the wrong position',
    turned: 'Part turned the wrong way', low_confidence: 'Camera unsure', flicker: 'Camera unsure',
    skipped: 'Step skipped', mismatch: 'QA result does not match', qa_fail: 'Failed pull test', mistake: 'Possible mistake'
  };
  const STATES = ['needs_review', 'action_required', 'resolved', 'dismissed', 'closed'];
  const STATE_LABEL = { needs_review: 'Needs Review', action_required: 'Action Required', resolved: 'Resolved', dismissed: 'Dismissed', closed: 'Closed, no remaining issue' };
  const PLANS = { self: "I'll address it", assist: 'Request assistance', defer: 'Defer for follow-up' };

  const isNum = v => typeof v === 'number' && isFinite(v);
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
  const stationName = st => st.name || ((st.id || '').toUpperCase() + ' ' + (st.label || '')).trim();
  // Display parts of a station: code is the leading S<n> of its floor name, else the id uppercased; desc is the rest of the name,
  // or the role label when nothing is left (a floor name that is just "S2"). The id stays the key for links and routes.
  function stationParts(id, name, roleLabel) {
    const nm = String(name || '').trim(), m = /^(S\d+)(?![A-Za-z0-9])[\s:.,-]*(.*)$/i.exec(nm);
    const code = m ? m[1].toUpperCase() : String(id || '').toUpperCase();
    const desc = (m ? m[2] : nm).trim() || String(roleLabel || '').trim();
    return { code, desc, full: desc ? code + ' \u00b7 ' + desc : code };
  }
  const shortLabel = l => { let t = String(l || '').split(':')[0].replace(/^(the|a)\s+/i, ''); if (t.length > 34) t = t.slice(0, 34).replace(/\s+\S*$/, '') + '…'; return t; };

  // ---------- one session -> digest ----------
  // input: { id, doc (session.json), events, captures (captures.jsonl rows), config (the session's config with its layout applied) }
  function digestSession(input, LineEngine) {
    const { id, doc, config } = input;
    const sorted = LineEngine.sortEvents(input.events || []);
    const caps = (input.captures || []).filter(c => c && isNum(c.t));
    const stations = {}, observations = [];
    for (const st of config.stations || []) {
      const d = LineEngine.detectedCycles(sorted, st.id);
      const cycles = d.cycles.map(c => {
        const subs = {};
        for (const x of c.occ) subs[x.substep] = r1((subs[x.substep] || 0) + ((x.end == null ? x.start : x.end) - x.start) / 1000);
        return { t: c.end, sec: r1(c.sec), cycle: c.cycle, subs, mistakes: c.mistakes || 0 };
      });
      const unobserved = [];
      for (const e of sorted) if (e.type === 'flag' && e.station === st.id && typeof e.note === 'string' && e.note.startsWith(NO_DATA) && e.substep && unobserved.indexOf(e.substep) < 0) unobserved.push(e.substep);
      stations[st.id] = {
        name: stationName(st), roleLabel: st.label || '', role: st.role || st.id, qa: !!st.qa,
        steps: (st.substeps || []).map(s => ({ id: s.id, label: s.label, short: shortLabel(s.label), standardSec: isNum(s.standardSec) ? s.standardSec : null })),
        cycles, unobserved, active: sorted.some(e => e.station === st.id && (e.type === 'substep' || e.type === 'verdict'))
      };
    }
    const stIds = Object.keys(stations);
    const reasonLabel = r => { const f = (config.failReasons || []).find(x => x.id === r); return f ? f.label : (r || 'no reason given'); };

    // The order the camera saw this cycle's steps, up to the moment of the observation.
    function seenOrder(sid, cycle, t) {
      const out = [];
      for (const e of sorted) {
        if (e.t > t) break;
        if (e.type === 'substep' && e.station === sid && e.cycle === cycle && e.source !== 'manual' && out[out.length - 1] !== e.substep) out.push(e.substep);
      }
      return out.filter((s, i) => out.indexOf(s) === i);
    }
    function photoFor(sid, t) {
      let best = null;
      for (const c of caps) {
        if (c.station !== sid) continue;
        const dt = Math.abs(c.t - t);
        if (dt > PHOTO_WINDOW_MS) continue;
        const score = dt - (c.reason === 'unsure' ? 2000 : 0);
        if (!best || score < best.score) best = { score, c };
      }
      return best ? '/api/sessions/' + id + '/captures/' + best.c.id + '.jpg' : null;
    }
    function add(e, kind, message, extra) {
      const st = stations[e.station];
      if (!st) return;
      const step = e.substep ? st.steps.find(s => s.id === e.substep) : null;
      observations.push(Object.assign({
        id: id + '~' + e.station + '~' + Math.round(e.t), session: id, station: e.station, substep: e.substep || null,
        checkpoint: e.station + ':' + (e.substep || kind), checkpointLabel: step ? step.short : KIND[kind] || kind,
        kind, title: KIND[kind] || 'Observation', message: message || '', t: e.t, cycle: isNum(e.cycle) ? e.cycle : null,
        conf: isNum(e.conf) ? Math.round(e.conf * 100) : null,
        expected: st.steps.map(s => s.id), seen: isNum(e.cycle) ? seenOrder(e.station, e.cycle, e.t) : [],
        photo: photoFor(e.station, e.t), videoT: isNum(e.videoT) ? e.videoT : null
      }, extra || {}));
    }
    const mistakeTimes = sorted.filter(e => e.type === 'verdict' && e.kind === 'mistake').map(e => ({ s: e.station, t: e.t }));
    for (const e of sorted) {
      if (!stIds.includes(e.station)) continue;
      if (e.type === 'verdict' && (e.kind === 'mistake' || e.kind === 'review')) add(e, KIND[e.reason] ? e.reason : (e.kind === 'review' ? 'low_confidence' : 'mistake'), e.message);
      else if (e.type === 'flag' && e.note === MISMATCH_NOTE) add(e, 'mismatch', 'The QA result and the earlier stations disagree. Review the video.');
      else if (e.type === 'flag' && /^skipped /.test(e.note || '') && e.source !== 'manual' && !mistakeTimes.some(m => m.s === e.station && Math.abs(m.t - e.t) <= 1500)) add(e, 'skipped', 'Skipped: ' + e.note.slice(8));
      else if (e.type === 'qa_result' && e.result === 'fail') add(e, 'qa_fail', reasonLabel(e.reason), { cause: (config.failReasons || []).find(x => x.id === e.reason) ? (config.failReasons.find(x => x.id === e.reason).cause || null) : null });
    }
    let qa = { passed: 0, failed: 0, defectFails: 0 }, wipAtEnd = null;
    try { const s = LineEngine.summarize(input.events || [], config); qa = { passed: s.line.passed, failed: s.line.failed, defectFails: s.line.defectFails }; wipAtEnd = s.line.wipUnits == null ? null : s.line.wipUnits; } catch (e) { /* keep zeros */ }
    const order = (doc.layout && Array.isArray(doc.layout.stations)) ? doc.layout.stations.slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map(s => s.id).filter(s => stIds.includes(s)) : stIds;
    let units = [];
    try { units = LineEngine.lineUnits(input.events || [], config, Object.assign({ now: sorted.length ? sorted[sorted.length - 1].t : 0 }, doc.endedAtMs ? { stopped: true } : {})); } catch (e) { /* keep none */ }
    return {
      id, units, title: doc.title || id, startedAtMs: doc.startedAtMs || (sorted[0] && sorted[0].t) || 0, endedAtMs: doc.endedAtMs || null,
      layoutName: doc.layout && doc.layout.name || null, order, stations, observations, qa, wipAtEnd
    };
  }

  // ---------- one run at a time ----------
  // The page shows one session (a run). runList is every session newest first, scopeRuns picks the digests a view is
  // computed from: one run id, or 'all' for the old whole-laptop aggregate. An unknown id falls back to the newest.
  function runList(digests) {
    return (digests || []).slice().sort((a, b) => (b.startedAtMs - a.startedAtMs) || (a.id < b.id ? 1 : -1)).map(d => ({
      id: d.id, title: d.title, startedAtMs: d.startedAtMs, endedAtMs: d.endedAtMs, units: (d.units || []).length, stations: Object.keys(d.stations || {}).filter(k => d.stations[k].active || d.stations[k].cycles.length)
    }));
  }
  function scopeRuns(digests, runId) {
    if (runId === 'all') return digests || [];
    const list = runList(digests), pick = list.find(r => r.id === runId) || list[0];
    const d = pick && (digests || []).find(x => x.id === pick.id);
    return d ? [ranOnly(d)] : [];
  }
  // A run shows only the stations that did something in it (a step seen, a cycle, a flag, or a QA result).
  function ranOnly(d) {
    const qaRan = (d.qa && (d.qa.passed || d.qa.failed)) > 0;
    const ran = k => { const s = d.stations[k]; return s.active || s.cycles.length || d.observations.some(o => o.station === k) || (s.qa && qaRan); };
    const keep = Object.keys(d.stations).filter(ran);
    if (keep.length === Object.keys(d.stations).length) return d;
    const stations = {}; for (const k of keep) stations[k] = d.stations[k];
    return Object.assign({}, d, { stations, order: (d.order || []).filter(k => stations[k]) });
  }

  // ---------- review state ----------
  function stateOf(review) { return review && STATES.includes(review.state) ? review.state : 'needs_review'; }
  // A decision -> the next review record (the life of a flag: Flagged, Reviewed, Action Required, Resolved).
  function decide(review, action, now) {
    const r = Object.assign({ state: 'needs_review', plan: null, result: null, history: [] }, review || {});
    r.history = (r.history || []).slice();
    const log = text => r.history.push({ at: now, text });
    switch (action.type) {
      case 'confirm': r.state = 'action_required'; log('Confirmed: the camera was right'); break;
      case 'dismiss': r.state = 'dismissed'; log('No issue found: closed as a false alarm'); break;
      case 'unable': log('Unable to verify: left for another review'); break;
      case 'plan': r.plan = action.plan; log('Plan: ' + (PLANS[action.plan] || action.plan)); break;
      case 'corrected': r.result = 'corrected'; if (action.verified) { r.state = 'resolved'; log('Issue corrected and verified: resolved'); } else log('Issue corrected, not verified yet'); break;
      case 'verify': r.state = 'resolved'; log('Fix verified: resolved'); break;
      case 'handoff': r.result = 'handoff'; log('Handed off: follow-up stays open'); break;
      case 'no_remaining': r.state = 'closed'; r.result = 'no_remaining'; log('Closed: no remaining issue'); break;
      case 'other': r.result = 'other'; log('Other outcome' + (action.note ? ': ' + action.note : '')); break;
      case 'reopen': r.state = 'needs_review'; r.plan = null; r.result = null; log('Reopened'); break;
      default: return r;
    }
    return r;
  }

  // ---------- many digests -> the whole page ----------
  // opts: { from, to (ms, inclusive range for "this period"), now, refSec: { station: sec } override (simulation) }
  function rollup(digests, reviews, opts) {
    const o = Object.assign({ from: -Infinity, to: Infinity }, opts || {});
    reviews = reviews || {};
    const inP = t => t >= o.from && t <= o.to;
    // Station list: flow order of the newest session first, then any others seen.
    const meta = {}, order = [];
    const newestFirst = digests.slice().sort((a, b) => b.startedAtMs - a.startedAtMs);
    for (const d of newestFirst) for (const sid of d.order.concat(Object.keys(d.stations))) {
      if (!meta[sid]) { meta[sid] = d.stations[sid]; }
      if (order.indexOf(sid) < 0 && d.order.indexOf(sid) >= 0) order.push(sid);
    }
    for (const sid of Object.keys(meta)) if (order.indexOf(sid) < 0) order.push(sid);
    const inPeriod = digests.filter(d => inP(d.startedAtMs) || (d.endedAtMs && inP(d.endedAtMs)));

    const allCycles = sid => [].concat(...digests.map(d => (d.stations[sid] ? d.stations[sid].cycles : [])));
    const periodCycles = sid => [].concat(...digests.map(d => (d.stations[sid] ? d.stations[sid].cycles.filter(c => inP(c.t)) : [])));

    // Observations with their review state, in the period.
    const obs = [].concat(...digests.map(d => d.observations)).filter(x => inP(x.t)).sort((a, b) => a.t - b.t).map(x => {
      const rv = reviews[x.id] || null;
      return Object.assign({}, x, { stationName: meta[x.station] ? meta[x.station].name : x.station, state: stateOf(rv), plan: rv && rv.plan || null, result: rv && rv.result || null, history: rv && rv.history || [] });
    });
    const isOpen = x => x.state === 'needs_review' || x.state === 'action_required';
    const confirmed = x => x.state === 'action_required' || x.state === 'resolved' || x.state === 'closed';

    const stations = order.map(sid => {
      const m = meta[sid], steps = m.steps;
      const all = allCycles(sid), per = periodCycles(sid);
      const std = steps.length && steps.every(s => isNum(s.standardSec)) ? steps.reduce((a, s) => a + s.standardSec, 0) : null;
      let refSec = o.refSec && isNum(o.refSec[sid]) ? o.refSec[sid] : std, refSource = refSec != null ? 'standard' : null;
      if (refSec == null && all.length >= MIN_REF_CYCLES) { refSec = r1(median(all.map(c => c.sec))); refSource = 'median'; }
      const avgSec = r1(mean(per.map(c => c.sec)));
      const pacePct = refSec && avgSec != null ? Math.round((avgSec / refSec - 1) * 100) : null;
      const timeLostSec = refSec ? per.reduce((a, c) => a + Math.max(0, c.sec - refSec), 0) : null;
      const mine = obs.filter(x => x.station === sid);
      const review = mine.filter(x => x.state === 'needs_review').length, action = mine.filter(x => x.state === 'action_required').length;
      // Steps: median in the period vs each step's reference (its standard, else its own all-time median).
      const stepRows = steps.map(s => {
        const vals = per.map(c => c.subs[s.id]).filter(isNum), allVals = all.map(c => c.subs[s.id]).filter(isNum);
        const ref = isNum(s.standardSec) ? s.standardSec : (allVals.length >= MIN_REF_CYCLES ? r1(median(allVals)) : null);
        const med = r1(median(vals));
        const flags = mine.filter(x => x.substep === s.id);
        return { id: s.id, label: s.label, short: s.short, medianSec: med, refSec: ref, refSource: isNum(s.standardSec) ? 'standard' : (ref != null ? 'median' : null),
          pct: ref && med != null ? Math.round((med / ref - 1) * 100) : null, flags: flags.length, open: flags.filter(isOpen).length };
      });
      // Main issue: the checkpoint with the most open observations (repeated = "Recurring").
      const byCp = {};
      for (const x of mine.filter(isOpen)) byCp[x.checkpoint] = byCp[x.checkpoint] || { n: 0, title: x.title, label: x.checkpointLabel };
      for (const x of mine.filter(isOpen)) byCp[x.checkpoint].n++;
      const top = Object.values(byCp).sort((a, b) => b.n - a.n)[0] || null;
      const lastUnobserved = (newestFirst.find(d => d.stations[sid]) || { stations: {} }).stations[sid];
      return {
        id: sid, name: m.name, role: m.role, code: stationParts(sid, m.name, m.roleLabel).code, desc: stationParts(sid, m.name, m.roleLabel).desc, full: stationParts(sid, m.name, m.roleLabel).full, qa: m.qa, cycles: per.length, avgSec, refSec, refSource, pacePct,
        slow: pacePct != null && pacePct > SLOW_PCT, timeLostSec: timeLostSec == null ? null : Math.round(timeLostSec),
        review, action, observations: mine.length, steps: stepRows,
        mainIssue: top ? (top.n > 1 ? 'Recurring ' + top.title.toLowerCase() : top.title) + (top.label && top.label !== top.title ? ' · ' + top.label : '') : null,
        status: action ? 'action' : review ? 'review' : 'clear',
        unobserved: lastUnobserved ? lastUnobserved.unobserved.map(id => (steps.find(s => s.id === id) || { short: id }).short) : []
      };
    });

    // Line: a unit is done when an S3-role station completes it (cycles of the S3 stations, as the Stations tab counts them). No S3 station: null.
    // QA tests units that are already done. WIP: units still in progress when each session ended (the engine's line.wipUnits), summed; null if no session knows it.
    const doneSts = stations.filter(s => s.role === 's3');
    const units = doneSts.length ? doneSts.reduce((a, s) => a + s.cycles, 0) : null;
    const wips = inPeriod.map(d => d.wipAtEnd).filter(isNum);
    const wipUnits = wips.length ? wips.reduce((a, b) => a + b, 0) : null;
    const qa = inPeriod.reduce((a, d) => ({ passed: a.passed + d.qa.passed, failed: a.failed + d.qa.failed, defectFails: a.defectFails + d.qa.defectFails }), { passed: 0, failed: 0, defectFails: 0 });
    const paced = stations.filter(s => s.pacePct != null && s.cycles);
    const totalRef = paced.reduce((a, s) => a + s.refSec * s.cycles, 0), totalAct = paced.reduce((a, s) => a + s.avgSec * s.cycles, 0);
    let bottleneck = null;
    for (const s of stations) if (s.avgSec != null && (!bottleneck || s.avgSec > bottleneck.avgSec)) bottleneck = s;
    const open = { review: obs.filter(x => x.state === 'needs_review').length, action: obs.filter(x => x.state === 'action_required').length };
    const oldestOpen = obs.filter(x => x.state === 'needs_review')[0] || null;
    const closedToday = obs.filter(x => !isOpen(x) && x.history.length && x.history[x.history.length - 1].at >= startOfDay(o.now || Date.now())).length;
    const line = {
      units, wipUnits, doneAt: doneSts.map(s => s.id), sessions: inPeriod.length, cycles: stations.reduce((a, s) => a + s.cycles, 0),
      pacePct: totalRef ? Math.round((totalAct / totalRef - 1) * 100) : null,
      timeLostMin: paced.length ? r1(stations.reduce((a, s) => a + (s.timeLostSec || 0), 0) / 60) : null,
      fpy: qa.passed + qa.defectFails > 0 ? Math.round(qa.passed / (qa.passed + qa.defectFails) * 100) : null, qa,
      bottleneck: bottleneck ? { id: bottleneck.id, name: bottleneck.name, code: bottleneck.code, desc: bottleneck.desc, avgSec: bottleneck.avgSec } : null,
      open, oldestOpenMin: oldestOpen ? Math.round(((o.now || Date.now()) - oldestOpen.t) / 60000) : null, closedToday
    };

    // Focus: open flags first, then being past 10% slower (the field guide's "look here first").
    // A station's open review flags count less when most of its past flags were false alarms ("is it real?").
    for (const s of stations) {
      const mine = obs.filter(x => x.station === s.id), rev = mine.filter(x => x.state === 'dismissed' || confirmed(x));
      s.falseAlarmPct = rev.length >= MIN_FA_REVIEWS ? Math.round(mine.filter(x => x.state === 'dismissed').length / rev.length * 100) : null;
    }
    const focus = stations.slice().sort((a, b) => score(b) - score(a))[0] || null;
    function score(s) { return s.review * (s.falseAlarmPct == null ? 1 : 1 - s.falseAlarmPct / 100) + s.action * 1.5 + (s.slow ? 5 : 0) + (s.pacePct || 0) / 100; }

    // Hours: one cell = one station in one hour of the day.
    const hours = {};
    for (const x of obs) { const h = new Date(x.t).getHours(), k = x.station + '|' + h; hours[k] = hours[k] || { station: x.station, hour: h, n: 0, review: 0 }; hours[k].n++; if (x.state === 'needs_review') hours[k].review++; }
    const hourList = Object.values(hours);
    const hourRange = hourList.length ? [Math.min(...hourList.map(h => h.hour)), Math.max(...hourList.map(h => h.hour))] : null;

    // Checkpoints: where observations concentrate, per 100 cycles of their station.
    const cps = {};
    for (const x of obs) {
      const c = cps[x.checkpoint] = cps[x.checkpoint] || { id: x.checkpoint, station: x.station, label: x.checkpointLabel, title: x.title, n: 0, unreviewed: 0, confirmed: 0, falseAlarm: 0 };
      c.n++; if (x.state === 'needs_review') c.unreviewed++; else if (x.state === 'dismissed') c.falseAlarm++; else if (confirmed(x)) c.confirmed++;
    }
    const checkpoints = Object.values(cps).map(c => {
      const st = stations.find(s => s.id === c.station), reviewed = c.confirmed + c.falseAlarm;
      return Object.assign(c, { per100: st && st.cycles ? r1(c.n / st.cycles * 100) : null, reviewed, faRate: reviewed >= MIN_FA_REVIEWS ? Math.round(c.falseAlarm / reviewed * 100) : null });
    }).sort((a, b) => (b.per100 || 0) - (a.per100 || 0) || b.n - a.n);
    const reviewedAll = obs.filter(x => x.state === 'dismissed' || confirmed(x));
    const faTop = checkpoints.filter(c => c.faRate != null).sort((a, b) => b.faRate - a.faRate)[0] || null;
    const camera = {
      reviewed: reviewedAll.length, falseAlarms: obs.filter(x => x.state === 'dismissed').length,
      faRate: reviewedAll.length ? Math.round(obs.filter(x => x.state === 'dismissed').length / reviewedAll.length * 100) : null, top: faTop
    };

    // Days: cycle time vs reference and flags per 100 cycles, per station per local date.
    const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const dayMap = {};
    for (const s of stations) for (const c of periodCycles(s.id)) { const k = dayKey(c.t); const dd = dayMap[k] = dayMap[k] || { day: k, cycles: {}, secs: {}, flags: 0 }; dd.cycles[s.id] = (dd.cycles[s.id] || 0) + 1; (dd.secs[s.id] = dd.secs[s.id] || []).push(c.sec); }
    for (const x of obs) { const k = dayKey(x.t); (dayMap[k] = dayMap[k] || { day: k, cycles: {}, secs: {}, flags: 0 }).flags++; }
    const days = Object.values(dayMap).sort((a, b) => (a.day < b.day ? -1 : 1)).map(d => {
      const pct = {};
      for (const s of stations) { const a = d.secs[s.id]; pct[s.id] = a && s.refSec ? Math.round((mean(a) / s.refSec - 1) * 100) : null; }
      const cyc = Object.values(d.cycles).reduce((a, b) => a + b, 0);
      return { day: d.day, cycles: d.cycles, pct, flags: d.flags, per100: cyc ? r1(d.flags / cyc * 100) : null };
    });

    // Trend: first half of the period against the second half (needs 2+ days with cycles).
    const trend = trendOf(stations, days, obs);
    return { stations, line, focus: focus && (focus.review || focus.action || focus.slow) ? focus.id : null, observations: obs, hours: hourList, hourRange, checkpoints, camera, days, trend, headline: headline(line, stations, focus) };
  }

  function trendOf(stations, days, obs) {
    const withCycles = days.filter(d => Object.keys(d.cycles).length);
    if (withCycles.length < 2) return null;
    const half = Math.ceil(withCycles.length / 2), a = withCycles.slice(0, half), b = withCycles.slice(half);
    const per100 = set => { const c = set.reduce((x, d) => x + Object.values(d.cycles).reduce((p, q) => p + q, 0), 0); return c ? r1(set.reduce((x, d) => x + d.flags, 0) / c * 100) : null; };
    const st = stations.map(s => {
      const pa = a.map(d => d.pct[s.id]).filter(isNum), pb = b.map(d => d.pct[s.id]).filter(isNum);
      const fa = obs.filter(x => x.station === s.id && a.some(d => d.day === dayKeyOf(x.t))).length, fb = obs.filter(x => x.station === s.id && b.some(d => d.day === dayKeyOf(x.t))).length;
      const ca = a.reduce((x, d) => x + (d.cycles[s.id] || 0), 0), cb = b.reduce((x, d) => x + (d.cycles[s.id] || 0), 0);
      return { id: s.id, name: s.name, code: s.code, desc: s.desc, full: s.full, paceFrom: pa.length ? Math.round(mean(pa)) : null, paceTo: pb.length ? Math.round(mean(pb)) : null, flagsFrom: ca ? r1(fa / ca * 100) : null, flagsTo: cb ? r1(fb / cb * 100) : null };
    });
    const worst = st.filter(s => s.paceFrom != null && s.paceTo != null).sort((x, y) => (y.paceTo - y.paceFrom) - (x.paceTo - x.paceFrom))[0] || null;
    return { stations: st, flagsFrom: per100(a), flagsTo: per100(b), worst };
  }
  function dayKeyOf(t) { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

  function headline(line, stations, focus) {
    const parts = [];
    parts.push(line.units == null ? 'No units done (no S3 station)' : line.units + (line.units === 1 ? ' unit done' : ' units done'));
    if (line.pacePct != null) parts.push(Math.abs(line.pacePct) + '% ' + (line.pacePct >= 0 ? 'slower' : 'faster') + ' than reference');
    const n = line.open.review + line.open.action;
    parts.push(n + (n === 1 ? ' flag open' : ' flags open'));
    let s = parts.join(', ') + '.';
    if (focus && (focus.review || focus.action || focus.slow)) s += ' ' + focus.code + ' ' + focus.desc + ' is the one to look at.';
    else if (stations.length) s += ' Nothing needs you right now.';
    return s;
  }

  // ---------- simulation: a week on the four-station line, through the same digest shape ----------
  function makeDemo(config, now) {
    let seed = 20261015;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const sts = (config.stations || []).slice(0, 4);
    const base = { s1: 10, s2: 16, s3: 14, s4: 8 }, refSec = {};
    sts.forEach((s, i) => { refSec[s.id] = base[s.id] || 10 + i * 2; });
    const drift = { s1: [3, 3], s2: [5, 15], s3: [7, 7], s4: [4, 4] };
    const digests = [], reviews = {};
    const today = startOfDay(now);
    for (let day = 6; day >= 0; day--) {
      const t0 = today - day * 86400000 + 7 * 3600000, f = (6 - day) / 6;
      const id = 'demo-' + (6 - day), stations = {}, observations = [];
      for (const s of sts) {
        const dr = drift[s.id] || [4, 4], pct = dr[0] + (dr[1] - dr[0]) * f;
        const cycles = [], n = day === 0 ? 120 : 130 + Math.round(rnd() * 25);
        const steps = (s.substeps || []).map(x => ({ id: x.id, label: x.label, short: shortLabel(x.label), standardSec: null }));
        for (let k = 0; k < n; k++) {
          const t = t0 + k * (day === 0 ? 3.75 : 6.5) * 60000 / 3 + rnd() * 30000;
          const sec = r1(refSec[s.id] * (1 + pct / 100) * (0.9 + rnd() * 0.2)), subs = {};
          steps.forEach((x, j) => { subs[x.id] = r1(sec / steps.length * (j === 2 && s.id === 's2' ? 1.4 : 0.9)); });
          cycles.push({ t, sec, cycle: k + 1, subs, mistakes: 0 });
          let kind = null, sub = null;
          if (s.id === 's2' && rnd() < 0.016 + 0.034 * f) { kind = 'wrong_order'; sub = (s.substeps[2] || s.substeps[0]).id; }
          else if (s.id === 's4' && rnd() < 0.045) { kind = 'low_confidence'; sub = (s.substeps[s.substeps.length - 1]).id; }
          else if (s.id === 's3' && rnd() < 0.012) { kind = 'missing'; sub = (s.substeps[1] || s.substeps[0]).id; }
          if (kind) {
            const exp = steps.map(x => x.id), seen = kind === 'wrong_order' ? [exp[2], exp[0], exp[1]].filter(Boolean) : exp.slice(0, 2);
            observations.push({ id: id + '~' + s.id + '~' + Math.round(t), session: id, station: s.id, substep: sub, checkpoint: s.id + ':' + sub,
              checkpointLabel: (steps.find(x => x.id === sub) || {}).short, kind, title: KIND[kind], conf: kind === 'low_confidence' ? 48 + Math.round(rnd() * 10) : null,
              message: kind === 'wrong_order' ? 'Wrong order: the wires were arranged before the connector was open' : kind === 'missing' ? 'The new lever connector is missing' : 'Pull test looks done but the camera is not sure',
              t, cycle: k + 1, expected: exp, seen, photo: null, videoT: null, demo: true });
          }
        }
        stations[s.id] = { name: stationName(s), role: s.role || s.id, qa: s.id === 's4', steps, cycles, unobserved: [], active: true };
      }
      // Earlier days are mostly reviewed: S4's camera-unsure flags are mostly false alarms.
      for (const x of observations) {
        if (day === 0 && rnd() < 0.8) continue;
        const fa = x.kind === 'low_confidence' ? rnd() < 0.84 : rnd() < 0.3;
        if (fa) { reviews[x.id] = decide(null, { type: 'dismiss' }, x.t + 3600000); continue; }
        const c = decide(decide(null, { type: 'confirm' }, x.t + 1800000), { type: 'plan', plan: rnd() < 0.5 ? 'assist' : 'self' }, x.t + 1900000);
        reviews[x.id] = day <= 1 && rnd() < 0.6 ? c : decide(c, { type: 'corrected', verified: true }, x.t + 5400000);
      }
      digests.push({ id, title: 'Simulated shift ' + (7 - day), startedAtMs: t0, endedAtMs: t0 + 8 * 3600000, layoutName: 'Manual Assembly Cell A', order: sts.map(s => s.id), stations, observations, qa: { passed: 0, failed: 0, defectFails: 0 } });
    }
    return { digests, reviews, refSec };
  }

  return { KIND, STATES, STATE_LABEL, PLANS, SLOW_PCT, MIN_FA_REVIEWS, digestSession, stationParts, decide, stateOf, rollup, runList, scopeRuns, makeDemo, median };
});
