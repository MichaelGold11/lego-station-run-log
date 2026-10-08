// Tests for the standard check and the guards around it. Run with `npm test` (no dependencies).
// The standard is the real Run 1 (data/runs/run-001.json); each case changes a copy of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StandardCheck } from './standard-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRun = id => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'runs', id + '.json'), 'utf8'));
const STD = Object.assign({ id: 'run-001' }, readRun('run-001'));
const clone = o => JSON.parse(JSON.stringify(o));

// A run that does exactly what the standard does, every step 0.1 s later and a different video.
function goodRun() {
  const r = clone(STD);
  r.id = 'run-test';
  r.status = 'NORMAL';
  r.video = { assetId: 'other-video', sha256: 'b'.repeat(64) };
  r.elements = r.elements.map(e => Object.assign(e, { start: +(e.start + 0.1).toFixed(2), end: +(e.end + 0.1).toFixed(2), flagType: 'none', flag: '' }));
  r.finalState = { matchesBaseline: 'yes', note: '' };
  return r;
}
const without = (r, key) => Object.assign(r, { elements: r.elements.filter(e => e.key !== key) });
const el = (r, key) => r.elements.find(e => e.key === key);

test('same steps in the same order: NORMAL, no issues', () => {
  const c = StandardCheck.compare(goodRun(), STD);
  assert.equal(c.status, 'NORMAL');
  assert.deepEqual(c.issues, []);
  assert.deepEqual(c.timing, []);
  assert.equal(c.copied, false);
});

test('missing step is a deviation, even when the analysis said NORMAL', () => {
  const c = StandardCheck.compare(without(goodRun(), 'seat_blue'), STD);
  assert.equal(c.status, 'POSSIBLE_DEVIATION');
  assert.equal(c.raised, true);
  assert.ok(c.issues.includes('Missing: Press blue slope down'), c.issues.join(' | '));
  assert.equal(c.steps.find(s => s.key === 'seat_blue').chip, 'Missing');
});

test('steps out of order are flagged', () => {
  const r = goodRun();
  // Blue slope picked and placed before the pink brick.
  const pinkKeys = ['pick_pink', 'place_pink', 'seat_pink'], blueKeys = ['pick_blue', 'carry_blue', 'orient_blue', 'seat_blue'];
  let t = 0.5;
  for (const k of [...blueKeys, ...pinkKeys]) { const e = el(r, k); const d = e.end - e.start; e.start = +t.toFixed(2); e.end = +(t + d).toFixed(2); t += d; }
  const c = StandardCheck.compare(r, STD);
  assert.equal(c.status, 'POSSIBLE_DEVIATION');
  assert.ok(c.issues.some(x => x.startsWith('Out of order:')), c.issues.join(' | '));
});

test('a repeated step is flagged', () => {
  const r = goodRun();
  const seat = el(r, 'seat_pink');
  r.elements.push(Object.assign(clone(seat), { start: seat.end, end: seat.end + 0.4 }));
  const c = StandardCheck.compare(r, STD);
  assert.equal(c.status, 'POSSIBLE_DEVIATION');
  assert.ok(c.issues.includes('Repeated ×2: Press pink brick down'), c.issues.join(' | '));
});

test('an extra step is flagged', () => {
  const r = goodRun();
  r.elements.push({ key: 'other', label: 'Dropped blue slope and picked it up again', kind: 'other', start: 3.3, end: 3.7, observed: '', flagType: 'note', flag: 'Dropped part' });
  const c = StandardCheck.compare(r, STD);
  assert.equal(c.status, 'POSSIBLE_DEVIATION');
  assert.ok(c.issues.some(x => x.startsWith('Extra step: Dropped blue slope')), c.issues.join(' | '));
});

test('a step done a different way (method) is flagged', () => {
  const std = clone(STD);
  el(std, 'hold_plate').method = { hand: 'left', offTable: 'no' };
  const r = goodRun();
  el(r, 'hold_plate').method = { hand: 'left', offTable: 'yes' };
  const c = StandardCheck.compare(r, std);
  assert.equal(c.status, 'POSSIBLE_DEVIATION');
  assert.ok(c.issues.includes('Done differently: Hold the base plate'), c.issues.join(' | '));
  // "unclear" is never compared
  el(r, 'hold_plate').method = { hand: 'unclear', offTable: 'unclear' };
  assert.equal(StandardCheck.compare(r, std).status, 'NORMAL');
});

test('an element flagged "deviation" by the analysis is an issue', () => {
  const r = goodRun();
  Object.assign(el(r, 'place_pink'), { flagType: 'deviation', flag: 'Brick placed one stud row lower' });
  const c = StandardCheck.compare(r, STD);
  assert.equal(c.status, 'POSSIBLE_DEVIATION');
  assert.ok(c.steps.find(s => s.key === 'place_pink').detail.includes('one stud row lower'));
});

test('a different finished build is an issue', () => {
  const r = goodRun();
  r.finalState.matchesBaseline = 'no';
  assert.equal(StandardCheck.compare(r, STD).status, 'POSSIBLE_DEVIATION');
});

test('unclear steps stay NORMAL', () => {
  const r = goodRun();
  Object.assign(el(r, 'seat_blue'), { flagType: 'unclear', flag: 'Hands hide the press' });
  const c = StandardCheck.compare(r, STD);
  assert.equal(c.status, 'NORMAL');
  assert.equal(c.unclear, 1);
});

test('big timing differences are listed but not counted by default', () => {
  const r = goodRun();
  el(r, 'seat_pink').end += 1.5; // 1.4 s -> 2.9 s
  const c = StandardCheck.compare(r, STD);
  assert.equal(StandardCheck.TIMING.countsAsDeviation, false);
  assert.equal(c.status, 'NORMAL');
  assert.equal(c.timing.length, 1);
  assert.match(c.timing[0], /^Press pink brick down: 2\.90 s vs 1\.40 s in the standard \(\+1\.50 s\)$/);
  // Small differences are not listed.
  const r2 = goodRun();
  el(r2, 'seat_pink').end += 0.2;
  assert.deepEqual(StandardCheck.compare(r2, STD).timing, []);
});

test('timing can be switched to count as a deviation', () => {
  const r = goodRun();
  el(r, 'seat_pink').end += 1.5;
  const c = StandardCheck.compare(r, STD, { timing: { countsAsDeviation: true } });
  assert.equal(c.status, 'POSSIBLE_DEVIATION');
  assert.ok(c.issues.includes('Too slow: Press pink brick down'));
});

test('steps copied from the standard are not a check: INSUFFICIENT_INFORMATION', () => {
  const r = clone(STD);
  r.id = 'run-copy'; r.status = 'NORMAL'; r.video = { assetId: 'other-video' };
  const c = StandardCheck.compare(r, STD);
  assert.equal(c.copied, true);
  assert.equal(c.status, 'INSUFFICIENT_INFORMATION');
});

test('two different recordings with identical steps and times are caught', () => {
  const a = goodRun(), b = goodRun();
  b.id = 'run-test-2'; b.video = { assetId: 'third-video', sha256: 'c'.repeat(64) };
  assert.equal(StandardCheck.findCopy(b, [STD, a]), a);
  // The same recording analyzed twice is not a copy.
  b.video = clone(a.video);
  assert.equal(StandardCheck.findCopy(b, [STD, a]), null);
  // A genuinely different timing is not a copy.
  const c = goodRun(); c.id = 'run-test-3'; c.video = { assetId: 'fourth' }; el(c, 'release').end += 0.05;
  assert.equal(StandardCheck.findCopy(c, [STD, a]), null);
});

test('real runs: Run 2 matches with timing listed; Run 3 is a deviation (plate held in the air)', () => {
  const r2 = Object.assign({ id: 'run-002-8ybd' }, readRun('run-002-8ybd'));
  const c2 = StandardCheck.compare(r2, STD);
  assert.equal(c2.status, 'NORMAL');
  assert.ok(c2.timing.some(x => x.startsWith('Press blue slope down')), c2.timing.join(' | '));
  const r3 = Object.assign({ id: 'run-003-w0te' }, readRun('run-003-w0te'));
  const c3 = StandardCheck.compare(r3, STD);
  assert.equal(c3.status, 'POSSIBLE_DEVIATION');
  assert.ok(c3.issues.includes('Done differently: Hold the base plate'), c3.issues.join(' | '));
});

test('the app script parses and contains the shared block', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app', 'lego-station-run-log.html'), 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(code));
  assert.match(code, /const procedureCheck = \(run, ref\) => StandardCheck\.compare\(run, ref\)/);
  assert.doesNotMatch(code, /els\.length \? els : templateElements\(\)/, 'empty analysis must not fall back to the standard');
});

// ---------- command-line guards, on a temporary copy of the run files ----------
function tempData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlog-test-'));
  fs.cpSync(path.join(ROOT, 'data', 'runs'), path.join(dir, 'runs'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'data', 'meta'), path.join(dir, 'meta'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'));
  return dir;
}
const runlog = (dir, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'runlog.mjs'), ...args], { env: Object.assign({}, process.env, { RUNLOG_DATA: dir }), encoding: 'utf8' });
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));

test('finish refuses a result whose steps copy the standard', () => {
  const dir = tempData();
  const id = 'run-004-test';
  writeJson(path.join(dir, 'runs', id + '.json'), { number: 4, label: '', condition: '', createdAt: '2026-10-07T00:00:00Z', video: { assetId: 'nope', durationS: 9 }, status: 'INSUFFICIENT_INFORMATION', statusNote: '', elements: [], processData: [], limitations: [], source: { method: 'agent' }, analysis: { state: 'running', mode: 'full' }, compareToRunId: 'run-001' });
  const res = { cycle: STD.cycle, status: 'NORMAL', statusNote: 'Compared with Run 1: same.', differences: [], elements: STD.elements.map(e => ({ key: e.key, label: e.label, kind: e.kind, start: e.start, end: e.end, observed: e.observed || 'seen', flagType: 'none', flag: '' })), finalState: { matchesBaseline: 'yes', note: 'Same build.' }, processData: [], limitations: [] };
  const rf = path.join(dir, 'result.json'); writeJson(rf, res);
  const out = runlog(dir, 'finish', id, rf);
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stderr, /exactly the same as in run-001/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'runs', id + '.json'), 'utf8')).analysis.state, 'running', 'run must be untouched');
});

test('finish raises a NORMAL verdict when a step is missing', () => {
  const dir = tempData();
  const id = 'run-004-test';
  const r = without(goodRun(), 'seat_blue');
  delete r.id;
  Object.assign(r, { number: 4, analysis: { state: 'queued', mode: 'compare' }, compareToRunId: 'run-001' });
  r.elements.forEach(e => { e.observed = e.observed || 'seen'; });
  writeJson(path.join(dir, 'runs', id + '.json'), r);
  const res = { status: 'NORMAL', statusNote: 'Compared with Run 1: looks the same.', differences: [], finalState: { matchesBaseline: 'yes', note: 'Same build.' }, elements: r.elements.map(() => ({ flagType: 'none', flag: '' })) };
  const rf = path.join(dir, 'result.json'); writeJson(rf, res);
  const out = runlog(dir, 'finish', id, rf, '--compare', '--compare-to', 'run-001');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'runs', id + '.json'), 'utf8'));
  assert.equal(saved.status, 'POSSIBLE_DEVIATION');
  assert.match(saved.statusNote, /^Standard check: Missing: Press blue slope down/);
  assert.deepEqual(saved.check.issues, ['Missing: Press blue slope down']);
});

test('validate flags a saved status that the step data contradicts', () => {
  const dir = tempData();
  const f = path.join(dir, 'runs', 'run-003-w0te.json');
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  r.status = 'NORMAL';
  writeJson(f, r);
  const out = runlog(dir, 'validate', 'run-003-w0te');
  assert.equal(out.status, 1);
  assert.match(out.stdout, /standard check against run-001 gives POSSIBLE_DEVIATION/);
});

test('add refuses a recording that is already a run', () => {
  const dir = tempData();
  const vid = path.join(dir, 'clip.mov');
  fs.writeFileSync(vid, 'same bytes');
  const f = path.join(dir, 'runs', 'run-002-8ybd.json');
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  r.video.sha256 = crypto.createHash('sha256').update('same bytes').digest('hex');
  writeJson(f, r);
  const out = runlog(dir, 'add', vid);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /already run-002-8ybd/);
});
