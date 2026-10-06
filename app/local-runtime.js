// Local stand-in for the claude.ai artifact runtime.
// The app calls window.claude.use('db' | 'assets' | 'user' | 'downloads' | 'sample' | 'mcp').
// On claude.ai the platform answers; when server.mjs serves the page, this file answers
// with the same shapes, backed by the JSON files in data/.
(() => {
  'use strict';
  window.RUNLOG_LOCAL = true;
  const POLL_MS = 1500;
  const err = (code, message) => ({ code, message });

  async function api(method, url, body, headers) {
    let res;
    try {
      res = await fetch(url, { method, body, headers, cache: 'no-store' });
    } catch (e) {
      throw err('unavailable', 'The local server is not answering. Run "npm start" in the repo folder.');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw err(json.code || 'unavailable', json.message || ('HTTP ' + res.status));
    return json;
  }
  const deepFreeze = o => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
    return o;
  };
  const meta = { fromCache: false, hasPendingWrites: false };
  const docSnap = (id, exists, data) => ({ id, exists, data: () => (exists ? data : undefined), metadata: meta });

  // One polling loop serves every subscription; a write triggers an immediate refresh.
  const subs = new Set();
  let timer = 0;
  async function pollAll() {
    clearTimeout(timer);
    await Promise.all([...subs].map(s => s.poll().catch(() => {})));
    if (subs.size) timer = setTimeout(pollAll, POLL_MS);
  }
  function subscribe(sub) {
    subs.add(sub);
    sub.poll().catch(() => {});
    if (subs.size === 1) timer = setTimeout(pollAll, POLL_MS);
    return () => { subs.delete(sub); };
  }
  const afterWrite = () => { setTimeout(pollAll, 0); };

  function docRef(path) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length % 2) throw new TypeError('A document path needs an even number of segments: ' + path);
    const id = parts[parts.length - 1];
    const url = '/api/db/' + parts.map(encodeURIComponent).join('/');
    const ref = {
      id, path,
      async get() { const r = await api('GET', url); return docSnap(id, r.exists, r.exists ? deepFreeze(r.data) : undefined); },
      async set(data) { await api('PUT', url, JSON.stringify(data), { 'Content-Type': 'application/json' }); afterWrite(); },
      async update(data) { await api('PATCH', url, JSON.stringify(data), { 'Content-Type': 'application/json' }); afterWrite(); },
      async delete() { await api('DELETE', url); afterWrite(); },
      collection(sub) { return collRef(path + '/' + sub); },
      onSnapshot(next, onErr) {
        let last = null, failed = false;
        return subscribe({
          async poll() {
            try {
              const r = await api('GET', url);
              const json = r.exists ? JSON.stringify(r.data) : '';
              if (json === last) return;
              last = json; failed = false;
              next(docSnap(id, r.exists, r.exists ? deepFreeze(r.data) : undefined));
            } catch (e) { if (!failed && onErr) { failed = true; onErr(e); } }
          }
        });
      }
    };
    return ref;
  }

  function collRef(path) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length % 2 === 0) throw new TypeError('A collection path needs an odd number of segments: ' + path);
    const url = '/api/db/' + parts.map(encodeURIComponent).join('/');
    const query = {
      path,
      where() { return query; }, orderBy() { return query; }, limit() { return query; },
      doc(id) { return docRef(path + '/' + (id || Math.random().toString(36).slice(2, 12))); },
      async add(data) { const r = query.doc(); await r.set(data); return r; },
      async get() {
        const r = await api('GET', url);
        const docs = r.docs.map(d => docSnap(d.id, true, deepFreeze(d.data)));
        return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta };
      },
      onSnapshot(next, onErr) {
        const cache = new Map();
        let first = true, failed = false;
        return subscribe({
          async poll() {
            let r;
            try { r = await api('GET', url); } catch (e) { if (!failed && onErr) { failed = true; onErr(e); } return; }
            failed = false;
            let changed = first || r.docs.length !== cache.size;
            const seen = new Set();
            const docs = r.docs.map(d => {
              seen.add(d.id);
              const json = JSON.stringify(d.data);
              const hit = cache.get(d.id);
              if (hit && hit.json === json) return hit.snap;
              changed = true;
              const snap = docSnap(d.id, true, deepFreeze(d.data));
              cache.set(d.id, { json, snap });
              return snap;
            });
            for (const k of [...cache.keys()]) if (!seen.has(k)) { cache.delete(k); changed = true; }
            if (!changed) return;
            first = false;
            next({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta });
          }
        });
      }
    };
    return query;
  }

  const db = Object.freeze({ doc: docRef, collection: collRef });

  const assets = Object.freeze({
    async upload(blob, options) {
      const type = (options && options.type) || blob.type || 'application/octet-stream';
      const headers = { 'Content-Type': type };
      if (blob.name) headers['X-Filename'] = encodeURIComponent(blob.name);
      return api('POST', '/api/assets', blob, headers);
    },
    async delete(ref) { const id = String(ref).replace(/^.*\/_blob\//, ''); return api('DELETE', '/api/assets/' + id); },
    async list() { return { assets: [], usage: { files: 0, bytes: 0, maxFiles: 0, maxBytes: 0 } }; }
  });

  const user = Object.freeze({
    isOwner: async () => true, canEdit: async () => true, can: async () => true,
    id: async () => 'local', me: async () => ({ id: 'local', name: 'You', guest: false }),
    profiles: async () => ({}), name: async () => 'You'
  });

  const downloads = Object.freeze({
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return { status: 'saved' };
    }
  });

  // Claude in the page (sample) and Claude Code Remote (mcp) only exist on claude.ai.
  // Locally, your own coding agent does the analysis (see AGENTS.md).
  const caps = { db, assets, user, downloads, sample: null, mcp: null };
  window.claude = Object.freeze({
    use: name => new Promise(resolve => setTimeout(() => resolve(Object.prototype.hasOwnProperty.call(caps, name) ? caps[name] : null), 0))
  });
})();
