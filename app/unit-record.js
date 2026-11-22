// The unit record: one dialog for one unit row of LineEngine.lineUnits. A browser global, no dependencies.
// UnitRecord.open(row, { sessionId, captures }) shows the S2 and S3 step timelines (seconds), the mistakes with their text,
// a "Play at" link per station's video at the unit's moment, and the unit's photos (LineEngine.unitPhotos when it is loaded).
// UnitRecord.close() closes it. Escape and the Close button close it too. Used by /line and /insights.
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const secs = v => (v == null || !isFinite(v) ? '--' : Number(v).toFixed(1) + ' s');
  const clock = v => { if (v == null || !isFinite(v)) return '--'; const s = Math.round(v); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const STAGE = { s2: 'At S2', waiting_s3: 'Waiting for S3', s3: 'At S3', done: 'Done', needs_review: 'Needs review' };
  const STN = { s2: 'S2', s3: 'S3' };
  const CSS = `
.ur-dlg{border:1px solid var(--line-2,#c5c9c5);border-radius:10px;padding:0;background:var(--surface,#fcfcfb);color:var(--ink,#15181b);font-family:var(--f-ui,system-ui,sans-serif);font-size:14px;width:min(760px,calc(100vw - 16px));max-height:calc(100vh - 16px);box-shadow:0 12px 40px rgba(0,0,0,.3)}
.ur-dlg::backdrop{background:rgba(0,0,0,.45)}
.ur-in{display:flex;flex-direction:column;max-height:calc(100vh - 18px)}
.ur-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line,#dcdfdc);flex-wrap:wrap}
.ur-head h2{margin:0;font-size:20px;font-weight:700}
.ur-head .ur-sub{color:var(--muted,#767b83);font-size:13px;flex:1 1 140px}
.ur-x{border:1px solid var(--line-2,#c5c9c5);background:var(--surface-2,#f3f4f2);border-radius:6px;padding:5px 12px;cursor:pointer;font:inherit;color:inherit;min-height:34px}
.ur-body{overflow:auto;padding:12px 16px 16px;display:grid;gap:14px}
.ur-body h3{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted,#767b83)}
.ur-st{border:1px solid var(--line,#dcdfdc);border-radius:8px;padding:8px 10px}
.ur-st .ur-sh{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px}
.ur-st .ur-sh b{font-size:15px}
.ur-mono{font-family:var(--f-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums}
.ur-steps{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.ur-steps li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:3px 6px;border-radius:4px;background:var(--surface-2,#f3f4f2)}
.ur-play{color:var(--accent-2,#8a4321);font-weight:600;text-decoration:underline;white-space:nowrap}
.ur-bad{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.ur-bad li{padding:5px 8px;border-radius:6px;border:1px solid color-mix(in srgb,var(--crit,#d03b3b) 50%,transparent);background:color-mix(in srgb,var(--crit,#d03b3b) 8%,transparent);color:var(--crit-ink,#b02e2e)}
.ur-bad li.ur-rv{border-color:color-mix(in srgb,var(--warn,#fab219) 70%,transparent);background:color-mix(in srgb,var(--warn,#fab219) 12%,transparent);color:var(--warn-ink,#7a5200)}
.ur-ph{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.ur-ph figure{margin:0;font-size:11.5px;color:var(--muted,#767b83)}
.ur-ph img{width:100%;display:block;border-radius:6px;border:1px solid var(--line,#dcdfdc);background:var(--sunk,#e4e7e4);aspect-ratio:4/3;object-fit:cover}
.ur-none{color:var(--muted,#767b83)}
@media (max-width:520px){.ur-head{padding:10px 12px}.ur-body{padding:10px 12px 14px}}
`;
  let dlg = null, styled = false;
  function videoUrl(sessionId, info) {
    if (!sessionId || !info || !info.station || info.videoT == null) return null;
    const m = /-(\d+)\.\w+$/.exec(info.videoFile || ''), part = m ? Number(m[1]) : 1;
    return '/api/sessions/' + encodeURIComponent(sessionId) + '/video/' + encodeURIComponent(info.station) + (part > 1 ? '?part=' + part : '') + '#t=' + info.videoT;
  }
  const photoUrl = (sessionId, c) => '/api/sessions/' + encodeURIComponent(sessionId) + '/captures/' + encodeURIComponent(c.id) + '.jpg';
  function photosOf(row, captures) {
    const LE = root.LineEngine || (root.__line && root.__line.LE);
    if (LE && LE.unitPhotos) return LE.unitPhotos(row, captures);
    return (captures || []).filter(c => c && c.unit != null && c.unit === row.unit);
  }
  function station(row, k, sessionId) {
    const info = row[k], name = STN[k];
    if (!info) return `<div class="ur-st"><div class="ur-sh"><b>${name}</b><span class="ur-none">This unit has not reached ${name}.</span></div></div>`;
    const url = videoUrl(sessionId, info);
    const steps = info.steps && info.steps.length
      ? '<ul class="ur-steps">' + info.steps.map(s => `<li><span>${esc(s.label)}</span><span class="ur-mono">${secs(s.sec)}</span></li>`).join('') + '</ul>'
      : '<div class="ur-none">No steps recorded here.</div>';
    return `<div class="ur-st"><div class="ur-sh"><b>${name}</b><span class="ur-mono">${secs(info.sec)}${info.end == null ? ' so far' : ''}</span>` +
      (url ? `<a class="ur-play" href="${esc(url)}" target="_blank" rel="noopener" aria-label="Play the ${name} video at this unit">Play at ${clock(info.videoT)}</a>` : '') + '</div>' + steps + '</div>';
  }
  function mistakes(row, sessionId) {
    const items = [];
    for (const k of ['s2', 's3']) for (const m of (row.mistakes && row.mistakes[k]) || []) {
      const url = videoUrl(sessionId, { station: row[k] && row[k].station, videoT: m.videoT, videoFile: m.videoFile || (row[k] && row[k].videoFile) });
      items.push(`<li class="${m.kind === 'review' ? 'ur-rv' : ''}"><b>${STN[k]}${m.kind === 'review' ? ' needs review' : ''}:</b> ${esc(m.message || (m.code ? m.code.replace(/_/g, ' ') : 'Mistake'))}${url ? ` <a class="ur-play" href="${esc(url)}" target="_blank" rel="noopener">Play at ${clock(m.videoT)}</a>` : ''}</li>`);
    }
    return items.length ? '<ul class="ur-bad">' + items.join('') + '</ul>' : '<div class="ur-none">No mistakes on this unit.</div>';
  }
  function photos(row, captures, sessionId) {
    if (!sessionId) return '<div class="ur-none">Photos need a saved session.</div>';
    const list = photosOf(row, captures);
    if (!list.length) return '<div class="ur-none">No photos for this unit.</div>';
    return '<div class="ur-ph">' + list.map(c => `<figure><img src="${esc(photoUrl(sessionId, c))}" alt="Photo at ${esc((c.station || '').toUpperCase())}" loading="lazy">${esc((c.station || '').toUpperCase())}${c.reason ? ', ' + esc(c.reason) : ''}</figure>`).join('') + '</div>';
  }
  function close() { if (dlg) { if (dlg.open) dlg.close(); dlg.remove(); dlg = null; } }
  function open(row, opts) {
    if (!row || typeof document === 'undefined') return null;
    const o = opts || {}, sid = o.sessionId || null;
    if (!styled) { const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); styled = true; }
    close();
    dlg = document.createElement('dialog');
    dlg.className = 'ur-dlg';
    dlg.setAttribute('aria-label', 'Unit ' + (row.no || ''));
    dlg.innerHTML = `<div class="ur-in"><div class="ur-head"><h2>Unit ${esc(row.no)}</h2><span class="ur-sub">${esc(STAGE[row.stage] || row.stage)}${row.totalSec != null ? ', ' + clock(row.totalSec) + ' in all' : ''}</span><button class="ur-x" type="button">Close</button></div>` +
      `<div class="ur-body"><section><h3>Steps</h3><div style="display:grid;gap:8px">${station(row, 's2', sid)}${station(row, 's3', sid)}</div></section>` +
      `<section><h3>Mistakes</h3>${mistakes(row, sid)}</section><section><h3>Photos</h3><div class="ur-photos">${photos(row, o.captures, sid)}</div></section></div></div>`;
    dlg.querySelector('.ur-x').onclick = close;
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector('.ur-x').focus();
    return dlg;
  }
  // Photos can arrive after the dialog opened: fill them in without redrawing the rest.
  function setPhotos(row, captures, sessionId) {
    const el = dlg && dlg.querySelector('.ur-photos');
    if (el) el.innerHTML = photos(row, captures, sessionId);
  }
  root.UnitRecord = { open, close, setPhotos };
})(typeof window !== 'undefined' ? window : globalThis);
