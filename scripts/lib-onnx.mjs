// Shared onnxruntime-web loader for node scripts (ingest-footage.mjs, eval-model.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Opens one .onnx file. Returns { ort, sess, classes, size }. Single-threaded wasm, the same setup the page's node proof used.
export async function openOnnx(file, classes, size) {
  if (!fs.existsSync(file)) throw new Error('Model file not found: ' + file);
  const ort = await import(pathToFileURL(path.join(ROOT, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs')).href);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = path.join(ROOT, 'node_modules/onnxruntime-web/dist/');
  const sess = await ort.InferenceSession.create(fs.readFileSync(file), { executionProviders: ['wasm'] });
  return { ort, sess, classes, size: size || 640 };
}
