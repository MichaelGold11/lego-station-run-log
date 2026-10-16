// Hand landmarks for /line, off the page's main thread. One HandLandmarker (IMAGE mode, CPU) serves every station:
// the page sends one small frame at a time and waits for the answer, so calls never overlap.
// Classic worker: MediaPipe loads its wasm with importScripts, which module workers do not have.
/* global importScripts */
self.exports = {};
self.module = { exports: self.exports };
let lm = null;

self.onmessage = async e => {
  const m = e.data || {};
  if (m.type === 'init') {
    try {
      importScripts('/vendor/mediapipe/vision_bundle.cjs');
      const mp = self.exports;
      const files = await mp.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      lm = await mp.HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'CPU' },
        runningMode: 'IMAGE', numHands: 2, minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4
      });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err && err.message || err) });
    }
    return;
  }
  if (m.type === 'detect') {
    let hands = [], error = null;
    const t0 = performance.now();
    try {
      const r = lm.detect(m.bitmap);
      hands = ((r && r.landmarks) || []).map(h => h.map(p => ({ x: p.x, y: p.y })));
    } catch (err) { error = String(err && err.message || err); }
    try { m.bitmap.close(); } catch (err) { /* already closed */ }
    self.postMessage({ type: 'hands', id: m.id, hands, ms: performance.now() - t0, error });
  }
};
