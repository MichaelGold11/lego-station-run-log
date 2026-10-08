#!/usr/bin/env node
// Command-line helper for people and coding agents working on the LEGO Station Run Log.
// It does the mechanical parts (files, ffmpeg, timestamps, validation) so an agent only has to
// look at frames and judge what happened. Run `node scripts/runlog.mjs help` for the list.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StandardCheck } from './standard-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// RUNLOG_DATA points the helper at another data folder (the tests use a temporary copy).
const DATA = process.env.RUNLOG_DATA ? path.resolve(process.env.RUNLOG_DATA) : path.join(ROOT, 'data');
const RUNS = path.join(DATA, 'runs');
const ASSETS = path.join(DATA, 'assets');
const SETTINGS = path.join(DATA, 'meta', 'settings.json');
const WORK = path.join(ROOT, 'work');

const KINDS = ['reach', 'position', 'press', 'release', 'hold', 'idle', 'other'];
const FLAGS = ['none', 'note', 'unclear', 'deviation'];
const STATUSES = ['NORMAL', 'POSSIBLE_DEVIATION', 'INSUFFICIENT_INFORMATION'];
const MATCHES = ['yes', 'no', 'unclear'];
const sha256File = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ---------- small helpers ----------
const die = msg => { console.error('Error: ' + msg); process.exit(1); };
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const r2 = n => Math.round(n * 100) / 100;
const fin = n => typeof n === 'number' && Number.isFinite(n);
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(f + '.tmp', f);
}
function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i]; else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) die(`${cmd} is not installed or not on PATH (${r.error.code}). See README: Requirements.`);
  if (r.status !== 0) die(`${cmd} failed:\n${(r.stderr || '').trim().slice(-1500)}`);
  return r.stdout;
}
function probe(file) {
  const out = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:stream_side_data=rotation:format=duration', '-of', 'json', file]));
  const st = (out.streams || [])[0] || {};
  const rot = Math.abs(Number(((st.side_data_list || [])[0] || {}).rotation) || 0);
  const [n, d] = String(st.r_frame_rate || '0/1').split('/').map(Number);
  let w = st.width, h = st.height;
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  return { durationS: r2(Number(out.format && out.format.duration) || 0), width: w, height: h, fps: d ? Math.round(n / d * 100) / 100 : null };
}
function fontOpt() {
  const c = ['C:/Windows/Fonts/arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'];
  const f = c.find(p => fs.existsSync(p));
  return f ? `fontfile='${f.replace(/:/g, '\\:')}':` : '';
}
const newAssetId = () => crypto.randomBytes(16).toString('hex');
function assetFile(id) {
  if (!id || !fs.existsSync(ASSETS)) return null;
  const f = fs.readdirSync(ASSETS).find(n => n.startsWith(id + '.'));
  return f ? path.join(ASSETS, f) : null;
}

// ---------- runs ----------
function allRuns() {
  if (!fs.existsSync(RUNS)) return [];
  return fs.readdirSync(RUNS).filter(n => n.endsWith('.json')).map(n => ({ id: n.slice(0, -5), ...readJson(path.join(RUNS, n)) }))
    .sort((a, b) => (a.number || 0) - (b.number || 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
}
const runFile = id => path.join(RUNS, id + '.json');
function loadRun(id) {
  if (!id) die('Give a run id. `node scripts/runlog.mjs list` shows them.');
  const f = runFile(id);
  if (!fs.existsSync(f)) die(`No run "${id}". \`node scripts/runlog.mjs list\` shows the ids.`);
  return readJson(f);
}
const saveRun = (id, data) => writeJson(runFile(id), data);
const hasEls = r => Array.isArray(r.elements) && r.elements.length > 0;
const settings = () => (fs.existsSync(SETTINGS) ? readJson(SETTINGS) : {});
function referenceFor(id, explicit) {
  const runs = allRuns().filter(r => r.id !== id && hasEls(r));
  const pick = rid => runs.find(r => r.id === rid);
  const self = fs.existsSync(runFile(id)) ? readJson(runFile(id)) : {};
  return pick(explicit) || pick(self.compareToRunId) || pick(settings().baselineRunId) || runs[0] || null;
}
// A finished run (the reference included) with exactly these steps and times but another recording.
function copiedFrom(run) {
  return StandardCheck.findCopy(run, allRuns().filter(r => r.id !== run.id && hasEls(r)));
}
function videoPath(run) {
  const f = run.video && assetFile(run.video.assetId);
  if (!f) die('This run has no stored video in data/assets.');
  return f;
}
const cycleTime = r => (r.cycle && fin(r.cycle.start) && fin(r.cycle.end) ? r2(r.cycle.end - r.cycle.start) : null);

// ---------- commands ----------
const commands = {};

commands.help = () => {
  console.log(`LEGO Station Run Log helper. Usage: node scripts/runlog.mjs <command> [...]

  list                               All runs with their state, cycle time and status
  next                               Id of the oldest queued run (prints nothing if none)
  add <video> [--label T] [--condition T] [--compare-to RUN]
                                     Store a video (re-encoded to H.264, max 1920 px) and queue a run
  reference <run> [--compare-to RUN] The run this one is compared with, and its elements
  claim <run>                        Mark a queued run as being analyzed (sets startedAt)
  sheets <run> [--step 0.1] [--from S] [--to S] [--cols 10] [--rows 5] [--width 180]
                                     Contact sheets of timestamped frames, written to work/<run>/
  frames <run> <t> [<t> ...] [--crop w:h:x:y] [--width N]
                                     Full-size frames (or crops) at those times, written to work/<run>/
  stills <run> <t> [<t> ...]         Save step frames (640 px) as assets; prints {"t": "assetId"}
  closeup <run> <t> --crop w:h:x:y   Save a close-up crop of the finished assembly as an asset
  finish <run> <result.json> [--agent NAME] [--compare]
                                     Validate an analysis result and write it into the run
  fail <run> "<note>"                Mark the analysis as failed with a note a person can act on
  validate [<run> ...]               Check run files against the format in AGENTS.md
  delete <run> --yes                 Delete a run and the video and frames only it uses
  prune [--yes]                      List (or with --yes, delete) stored files no run uses`);
};

commands.list = () => {
  const runs = allRuns();
  const base = settings().baselineRunId;
  if (!runs.length) return console.log('No runs yet.');
  for (const r of runs) {
    const st = (r.analysis && r.analysis.state && r.analysis.state !== 'done') ? r.analysis.state.toUpperCase() : (hasEls(r) ? 'done' : 'empty');
    const ct = cycleTime(r);
    console.log([r.id.padEnd(16), ('Run ' + r.number).padEnd(8), st.padEnd(8), (ct == null ? '-' : ct.toFixed(2) + ' s').padEnd(8), (r.status || '').padEnd(25), r.id === base ? 'BASELINE' : '', r.label || ''].join(' ').trimEnd());
  }
};

commands.next = () => {
  const q = allRuns().filter(r => r.analysis && r.analysis.state === 'queued').sort((a, b) => String(a.analysis.requestedAt || a.createdAt).localeCompare(String(b.analysis.requestedAt || b.createdAt)));
  if (q.length) console.log(q[0].id);
};

commands.add = ({ pos, opt }) => {
  const src = pos[0];
  if (!src || !fs.existsSync(src)) die('Give the path to a video file.');
  if (opt['compare-to'] && !allRuns().some(r => r.id === opt['compare-to'] && hasEls(r))) die(`--compare-to "${opt['compare-to']}" is not a finished run.`);
  const sha256 = sha256File(src);
  const same = allRuns().find(r => r.video && r.video.sha256 === sha256);
  if (same && !opt.force) die(`This exact video is already ${same.id} (Run ${same.number}). Record a new cycle, or use --force to add it again.`);
  fs.mkdirSync(ASSETS, { recursive: true });
  const assetId = newAssetId();
  const out = path.join(ASSETS, assetId + '.mp4');
  console.log('Re-encoding the video to H.264 (keeps the repo small and plays in every browser)...');
  run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', src, '-vf', "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out]);
  const meta = probe(out);
  const number = allRuns().reduce((m, r) => Math.max(m, r.number || 0), 0) + 1;
  const id = 'run-' + String(number).padStart(3, '0') + '-' + crypto.randomBytes(2).toString('hex');
  const t = now();
  saveRun(id, {
    number, label: String(opt.label === true ? '' : opt.label || ''), condition: String(opt.condition === true ? '' : opt.condition || ''), createdAt: t,
    video: { assetId, fileName: path.basename(src), sha256, ...meta },
    status: 'INSUFFICIENT_INFORMATION', statusNote: '', elements: [], processData: [], limitations: [],
    source: { method: 'agent' }, analysis: { state: 'queued', mode: 'full', requestedAt: t },
    compareToRunId: opt['compare-to'] || (referenceFor(id) || {}).id || ''
  });
  console.log(`Queued ${id} (Run ${number}): ${meta.durationS} s, ${meta.width}x${meta.height}, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
  console.log(id);
};

commands.reference = ({ pos, opt }) => {
  const id = pos[0]; loadRun(id);
  const ref = referenceFor(id, opt['compare-to']);
  if (!ref) return console.log('No finished run to compare with yet. This run will be the first reference.');
  console.log(`Reference: ${ref.id} (Run ${ref.number}${ref.id === settings().baselineRunId ? ', baseline' : ''})`);
  console.log(`Cycle ${ref.cycle.start}-${ref.cycle.end} s (${cycleTime(ref)} s). Video ${ref.video && ref.video.width}x${ref.video && ref.video.height}.`);
  console.log('key | kind | label | start-end (s) | duration (s) | what the reference showed (to compare methods; never copy it)');
  for (const e of ref.elements) console.log([e.key, e.kind, e.label, `${e.start.toFixed(2)}-${e.end.toFixed(2)}`, (e.end - e.start).toFixed(2), e.observed || ''].join(' | '));
  if (ref.finalState && ref.finalState.note) console.log('Finished state: ' + ref.finalState.note);
  const fsf = ref.finalState && assetFile(ref.finalState.closeupAssetId || ref.finalState.frameAssetId);
  if (fsf) console.log('Finished-state image: ' + fsf);
};

commands.claim = ({ pos, opt }) => {
  const id = pos[0]; const r = loadRun(id);
  const st = r.analysis && r.analysis.state;
  if (st !== 'queued' && !opt.force) die(`${id} is "${st || 'not queued'}", not queued. Use --force to claim it anyway.`);
  r.analysis = Object.assign({}, r.analysis, { state: 'running', startedAt: now() });
  saveRun(id, r);
  const v = r.video || {};
  console.log(`Claimed ${id} (mode: ${r.analysis.mode || 'full'})`);
  console.log(`Video: ${v.durationS} s, ${v.width}x${v.height} px (crop coordinates use these pixels), file ${assetFile(v.assetId) || 'missing'}`);
};

commands.sheets = ({ pos, opt }) => {
  const id = pos[0]; const r = loadRun(id); const v = videoPath(r);
  const step = Number(opt.step) || 0.1, cols = Number(opt.cols) || 10, rows = Number(opt.rows) || 5, width = Number(opt.width) || 180;
  const dir = path.join(WORK, id); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.startsWith('sheet_')) fs.unlinkSync(path.join(dir, f));
  const pre = opt.from ? ['-ss', String(opt.from)] : [];
  const lim = opt.to ? ['-t', String(Number(opt.to) - (Number(opt.from) || 0))] : [];
  const fsz = Math.max(12, Math.round(width / 11));
  const vf = `fps=1/${step},scale=${width}:-2,drawtext=${fontOpt()}text='%{pts\\:hms}':x=3:y=3:fontsize=${fsz}:fontcolor=yellow:box=1:boxcolor=black@0.65,tile=${cols}x${rows}:padding=2:color=black`;
  // -copyts keeps the real video time on each label when --from is used.
  run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...pre, ...lim, '-copyts', '-i', v, '-vf', vf, '-q:v', '3', path.join(dir, 'sheet_%02d.jpg')]);
  const files = fs.readdirSync(dir).filter(f => f.startsWith('sheet_')).sort();
  const per = cols * rows * step;
  console.log(`${files.length} sheet(s), ${cols}x${rows} frames each, one frame every ${step} s (each sheet covers ${r2(per)} s). Labels are hh:mm:ss.mmm video time, read left to right, top to bottom.`);
  files.forEach((f, i) => console.log(`${path.join(dir, f)}  (from ${r2((Number(opt.from) || 0) + i * per)} s)`));
};

commands.frames = ({ pos, opt }) => {
  const id = pos[0]; const r = loadRun(id); const v = videoPath(r);
  const times = pos.slice(1).map(Number).filter(fin);
  if (!times.length) die('Give one or more times in seconds.');
  const dir = path.join(WORK, id); fs.mkdirSync(dir, { recursive: true });
  const filters = [];
  if (opt.crop) filters.push('crop=' + opt.crop);
  if (opt.width) filters.push(`scale=${Number(opt.width)}:-2`);
  for (const t of times) {
    const out = path.join(dir, `frame_${t.toFixed(2)}${opt.crop ? '_crop' : ''}.jpg`);
    run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(t), '-i', v, '-frames:v', '1', ...(filters.length ? ['-vf', filters.join(',')] : []), '-q:v', '2', out]);
    console.log(out);
  }
};

function saveStill(v, t, vf) {
  const id = newAssetId();
  run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(t), '-i', v, '-frames:v', '1', '-vf', vf, '-q:v', '4', path.join(ASSETS, id + '.jpg')]);
  return id;
}
commands.stills = ({ pos }) => {
  const id = pos[0]; const r = loadRun(id); const v = videoPath(r);
  const times = pos.slice(1).map(Number).filter(fin);
  if (!times.length) die('Give one or more times in seconds.');
  const out = {};
  for (const t of times) out[r2(t).toFixed(2)] = saveStill(v, t, 'scale=640:640:force_original_aspect_ratio=decrease');
  console.log(JSON.stringify(out, null, 2));
};

commands.closeup = ({ pos, opt }) => {
  const id = pos[0]; const r = loadRun(id); const v = videoPath(r);
  const t = Number(pos[1]);
  if (!fin(t) || !opt.crop) die('Usage: closeup <run> <t> --crop w:h:x:y');
  console.log(saveStill(v, t, `crop=${opt.crop},scale=480:-2:flags=lanczos`));
};

// ---------- validation ----------
function checkResult(res, run, ref, mode) {
  const errs = [], warn = [];
  const dur = (run.video && run.video.durationS) || Infinity;
  const inRange = t => fin(t) && t >= 0 && t <= dur + 0.05;
  if (!STATUSES.includes(res.status)) errs.push(`status must be one of ${STATUSES.join(', ')}`);
  if (typeof res.statusNote !== 'string' || !res.statusNote.trim()) errs.push('statusNote must explain the status in a sentence or two');
  if (!Array.isArray(res.differences) || res.differences.some(x => typeof x !== 'string')) errs.push('differences must be a list of strings ([] when there are none)');
  const fsx = res.finalState || {};
  if (!MATCHES.includes(fsx.matchesBaseline)) errs.push(`finalState.matchesBaseline must be one of ${MATCHES.join(', ')}`);
  if (typeof fsx.note !== 'string' || !fsx.note.trim()) errs.push('finalState.note must describe the finished assembly');
  const els = Array.isArray(res.elements) ? res.elements : null;
  if (!els || !els.length) errs.push('elements must be a non-empty list');
  if (mode === 'full') {
    if (!res.cycle || !inRange(res.cycle.start) || !inRange(res.cycle.end) || res.cycle.end <= res.cycle.start) errs.push(`cycle needs start < end, both within 0-${dur} s`);
    for (const k of ['processData', 'limitations']) if (!Array.isArray(res[k]) || res[k].some(x => typeof x !== 'string')) errs.push(`${k} must be a list of strings`);
    if (fsx.frameAssetId && !assetFile(fsx.frameAssetId)) errs.push(`finalState.frameAssetId ${fsx.frameAssetId} is not in data/assets`);
    if (fsx.closeupAssetId && !assetFile(fsx.closeupAssetId)) errs.push(`finalState.closeupAssetId ${fsx.closeupAssetId} is not in data/assets`);
  }
  const refEls = ref ? new Map(ref.elements.map(e => [e.key, e])) : new Map();
  (els || []).forEach((e, i) => {
    const at = `elements[${i}] (${e && e.key})`;
    if (!e || typeof e !== 'object') return errs.push(`${at} is not an object`);
    if (!FLAGS.includes(e.flagType)) errs.push(`${at}.flagType must be one of ${FLAGS.join(', ')}`);
    if (typeof e.flag !== 'string') errs.push(`${at}.flag must be a string ("" when there is no flag)`);
    if (e.flagType !== 'none' && !String(e.flag || '').trim()) errs.push(`${at} has flagType ${e.flagType} but no flag text`);
    if (mode !== 'full') return;
    if (typeof e.key !== 'string' || !e.key) errs.push(`${at}.key is missing (use "other" for something new)`);
    if (!KINDS.includes(e.kind)) errs.push(`${at}.kind must be one of ${KINDS.join(', ')}`);
    if (typeof e.label !== 'string' || !e.label.trim()) errs.push(`${at}.label is missing`);
    if (!inRange(e.start) || !inRange(e.end) || e.end < e.start) errs.push(`${at} needs 0 <= start <= end <= ${dur}`);
    if (typeof e.observed !== 'string' || !e.observed.trim()) errs.push(`${at}.observed must say what is visibly seen`);
    if (e.observed && e.observed.length > 240) warn.push(`${at}.observed is long (${e.observed.length} chars, aim for under 200)`);
    if (e.method !== undefined) {
      if (!e.method || typeof e.method !== 'object') errs.push(`${at}.method must be an object like {"hand": "right", "offTable": "no"}`);
      else for (const [f, v] of Object.entries(e.method)) {
        const def = StandardCheck.METHOD[f];
        if (!def) errs.push(`${at}.method.${f} is not a known field (${Object.keys(StandardCheck.METHOD).join(', ')})`);
        else if (![...def.values, 'unclear'].includes(v)) errs.push(`${at}.method.${f} must be one of ${[...def.values, 'unclear'].join(', ')}`);
      }
    }
    if (e.frameAssetId && !assetFile(e.frameAssetId)) errs.push(`${at}.frameAssetId ${e.frameAssetId} is not in data/assets (leave it out and finish saves one)`);
    const re = refEls.get(e.key);
    if (e.key !== 'other' && ref && !re) warn.push(`${at}.key "${e.key}" is not in the reference; use "other" for new elements`);
    if (re && (re.label !== e.label || re.kind !== e.kind)) warn.push(`${at} reuses key "${e.key}" but changes its label or kind (reference: "${re.label}", ${re.kind})`);
  });
  if (mode === 'full' && res.status === 'POSSIBLE_DEVIATION' && !(els || []).some(e => e.flagType === 'deviation') && fsx.matchesBaseline !== 'no')
    errs.push('status is POSSIBLE_DEVIATION but no element is flagged "deviation" and the finished state matches; flag what deviates');
  return { errs, warn };
}

commands.finish = ({ pos, opt }) => {
  const id = pos[0]; const run = loadRun(id);
  const file = pos[1];
  if (!file || !fs.existsSync(file)) die('Give the path to the result JSON file.');
  let res;
  try { res = readJson(file); } catch (e) { die('The result file is not valid JSON: ' + e.message); }
  const compare = !!opt.compare || (run.analysis && run.analysis.mode === 'compare' && hasEls(run));
  const ref = referenceFor(id, res.comparedToRunId || opt['compare-to']);
  if (compare && !hasEls(run)) die('--compare needs a run that already has elements.');
  if (compare) {
    if (!Array.isArray(res.elements) || res.elements.length !== run.elements.length) die(`Compare-only: give elements in the same order as the run (${run.elements.length} of them), each with flagType and flag.`);
  }
  const { errs, warn } = checkResult(res, run, ref, compare ? 'compare' : 'full');
  warn.forEach(w => console.log('Warning: ' + w));
  if (errs.length) { console.error('Not written. Fix these and run finish again:\n- ' + errs.join('\n- ')); process.exit(1); }
  const copy = copiedFrom(Object.assign({}, run, { id, elements: compare ? run.elements : res.elements }));
  if (copy) die(`Not written: every step and time is exactly the same as in ${copy.id} (Run ${copy.number}), a different recording. Time this video from its own frames.`);
  const t = now();
  const agent = typeof opt.agent === 'string' ? opt.agent : 'Claude Code';
  const out = Object.assign({}, run);
  out.status = res.status; out.statusNote = res.statusNote.trim(); out.differences = res.differences;
  out.comparedToRunId = ref ? ref.id : '';
  if (compare) {
    out.elements = run.elements.map((e, i) => Object.assign({}, e, { flagType: res.elements[i].flagType, flag: res.elements[i].flag }));
    out.finalState = Object.assign({}, run.finalState, { matchesBaseline: res.finalState.matchesBaseline, note: res.finalState.note });
    out.analysis = Object.assign({}, run.analysis, { state: 'done', mode: 'compare', finishedAt: t });
  } else {
    // Save a frame for every element (and the finished state) the agent did not pick one for.
    const v = videoPath(run); const dur = (run.video && run.video.durationS) || 0;
    const clamp = x => Math.max(0, Math.min(x, Math.max(0, dur - 0.05)));
    const small = 'scale=640:640:force_original_aspect_ratio=decrease';
    let made = 0;
    for (const e of res.elements) if (!e.frameAssetId) { e.frameT = r2(clamp(fin(e.frameT) ? e.frameT : (e.start + e.end) / 2)); e.frameAssetId = saveStill(v, e.frameT, small); made++; }
    if (!res.finalState.frameAssetId) { res.finalState.frameT = r2(clamp(fin(res.finalState.frameT) ? res.finalState.frameT : res.cycle.end + 0.2)); res.finalState.frameAssetId = saveStill(v, res.finalState.frameT, small); made++; }
    if (made) console.log(`Saved ${made} step frame(s): element midpoints and cycle end + 0.2 s, unless you gave a frameT.`);
    out.cycle = { start: r2(res.cycle.start), end: r2(res.cycle.end) };
    out.elements = res.elements.map(e => {
      const o = { key: e.key, label: e.label.trim(), kind: e.kind, start: r2(e.start), end: r2(e.end), observed: e.observed.trim(), flagType: e.flagType, flag: (e.flag || '').trim(), frameAssetId: e.frameAssetId };
      if (fin(e.frameT)) o.frameT = r2(e.frameT);
      return o;
    }).sort((a, b) => a.start - b.start || a.end - b.end);
    const fsx = res.finalState;
    out.finalState = { matchesBaseline: fsx.matchesBaseline, note: fsx.note.trim(), frameAssetId: fsx.frameAssetId };
    if (fin(fsx.frameT)) out.finalState.frameT = r2(fsx.frameT);
    if (fsx.closeupAssetId) out.finalState.closeupAssetId = fsx.closeupAssetId;
    out.processData = res.processData; out.limitations = res.limitations;
    const meta = probe(v);
    out.video = Object.assign({}, run.video, meta);
    out.source = { method: agent === 'Claude Code' ? 'claude-code' : 'agent', agent, note: agent + ', frame by frame at 0.1 s steps', frameIntervalS: 0.1, analyzedAt: t };
    out.analysis = Object.assign({}, run.analysis, { state: 'done', mode: 'full', finishedAt: t });
  }
  if (out.analysis.note) delete out.analysis.note;
  if (ref) {
    const chk = StandardCheck.compare(out, ref);
    out.status = chk.status;
    if (chk.raised) out.statusNote = 'Standard check: ' + chk.issues.join('; ') + '. ' + out.statusNote;
    out.check = { against: ref.id, status: chk.status, issues: chk.issues, timing: chk.timing, checkedAt: t };
    if (chk.raised) console.log(`Standard check changed the status from ${chk.reported} to ${chk.status}.`);
    chk.issues.forEach(x => console.log('Issue: ' + x));
    chk.timing.forEach(x => console.log('Timing: ' + x + (chk.timingCounts ? '' : ' (listed, not a deviation)')));
  }
  saveRun(id, out);
  console.log(`Wrote ${id}: ${out.status}, cycle ${cycleTime(out)} s, compared with ${out.comparedToRunId || 'nothing'}.`);
};

commands.fail = ({ pos }) => {
  const id = pos[0]; const r = loadRun(id);
  const note = pos.slice(1).join(' ').trim();
  if (!note) die('Give a short note a person can act on.');
  r.analysis = Object.assign({}, r.analysis, { state: 'failed', note, finishedAt: now() });
  saveRun(id, r);
  console.log(`Marked ${id} as failed: ${note}`);
};

function assetIdsOf(r) {
  const ids = [r.video && r.video.assetId, r.finalState && r.finalState.frameAssetId, r.finalState && r.finalState.closeupAssetId];
  for (const e of r.elements || []) ids.push(e.frameAssetId);
  return ids.filter(Boolean);
}

commands.delete = ({ pos, opt }) => {
  const id = pos[0]; const r = loadRun(id);
  if (!opt.yes) die(`This permanently deletes ${id} (Run ${r.number}${r.label ? ', ' + r.label : ''}) and its video and frames. Run again with --yes to confirm.`);
  const keep = new Set(allRuns().filter(x => x.id !== id).flatMap(assetIdsOf));
  let n = 0;
  for (const a of assetIdsOf(r)) { const f = assetFile(a); if (f && !keep.has(a)) { fs.unlinkSync(f); n++; } }
  fs.unlinkSync(runFile(id));
  if (settings().baselineRunId === id) writeJson(SETTINGS, Object.assign(settings(), { baselineRunId: '', updatedAt: now() }));
  console.log(`Deleted ${id} and ${n} file(s).`);
};

commands.prune = ({ opt }) => {
  const runs = allRuns();
  if (runs.some(r => r.analysis && ['queued', 'running'].includes(r.analysis.state)) && !opt.force) die('A run is queued or being analyzed, and its frames may not be linked yet. Try again when it is done, or use --force.');
  const used = new Set(runs.flatMap(assetIdsOf));
  const orphans = fs.existsSync(ASSETS) ? fs.readdirSync(ASSETS).filter(n => !used.has(n.split('.')[0])) : [];
  if (!opt.yes) { console.log(`${orphans.length} file(s) in data/assets are not used by any run.${orphans.length ? ' Run again with --yes to delete them.' : ''}`); return; }
  orphans.forEach(n => fs.unlinkSync(path.join(ASSETS, n)));
  console.log(`Deleted ${orphans.length} unused file(s).`);
};

commands.validate = ({ pos }) => {
  const ids = pos.length ? pos : allRuns().map(r => r.id);
  let bad = 0;
  for (const id of ids) {
    const r = loadRun(id);
    if (!hasEls(r)) { console.log(`${id}: no elements yet (${(r.analysis && r.analysis.state) || 'not analyzed'})`); continue; }
    const ref = referenceFor(id, r.comparedToRunId);
    const res = Object.assign({ differences: [] }, r);
    const { errs, warn } = checkResult(res, r, ref, 'full');
    if (!fs.existsSync(path.join(ASSETS)) || !assetFile(r.video && r.video.assetId)) errs.push('video file missing from data/assets');
    const copy = copiedFrom(Object.assign({ id }, r));
    if (copy) errs.push(`steps and times are an exact copy of ${copy.id}, a different recording`);
    if (ref && id !== settings().baselineRunId) {
      const chk = StandardCheck.compare(r, ref);
      if (chk.status !== r.status) errs.push(`status is ${r.status} but the standard check against ${ref.id} gives ${chk.status}${chk.issues.length ? ' (' + chk.issues.join('; ') + ')' : ''}`);
    }
    if (errs.length) bad++;
    console.log(`${id}: ${errs.length ? 'PROBLEMS' : 'ok'}${warn.length ? ` (${warn.length} warning${warn.length > 1 ? 's' : ''})` : ''}`);
    errs.forEach(e => console.log('  - ' + e));
    warn.forEach(w => console.log('  ~ ' + w));
  }
  if (bad) process.exit(1);
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !commands[cmd]) { commands.help(); process.exit(cmd ? 1 : 0); }
commands[cmd](parseArgs(rest));
