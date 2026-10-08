// Loads the standard check from the app file, so `runlog.mjs` and the tests use the exact code the
// web app runs. The block between the BEGIN/END standard-check markers in
// app/lego-station-run-log.html is self-contained and defines `StandardCheck`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'lego-station-run-log.html');

export function loadStandardCheck(file = APP) {
  const html = fs.readFileSync(file, 'utf8');
  const m = html.match(/\/\/ ===== BEGIN standard-check =====([\s\S]*?)\/\/ ===== END standard-check =====/);
  if (!m) throw new Error(`No standard-check block in ${file}. Keep the BEGIN/END markers around StandardCheck.`);
  return new Function(m[1] + '\nreturn StandardCheck;')();
}

export const StandardCheck = loadStandardCheck();
