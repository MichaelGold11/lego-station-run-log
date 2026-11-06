// npm run go: start the server if it is not running, then open Chrome on the QR code. It exits by itself.
// npm run stop: stop the server that go started.
// PORT, DATA_DIR and PHONE_PORT work like npm start. NO_BROWSER=1 prints the link and opens nothing.
//   node scripts/go.mjs [--station s2]   or   node scripts/go.mjs stop

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 4173;
const PIDFILE = path.join(DATA, 'server.pid');
const LOG = path.join(DATA, 'server.log');
const args = process.argv.slice(2);
const sIdx = args.indexOf('--station');
const station = sIdx >= 0 && args[sIdx + 1] ? args[sIdx + 1] : (readStation() || 's2');

function readStation() {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(DATA, 'meta', 'wire-line-layouts.json'), 'utf8'));
    const l = (f.layouts || []).find(x => x.id === f.active);
    return l && l.stations && l.stations[0] && l.stations[0].id;
  } catch (e) { return null; }
}

function answers() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/line/config', timeout: 1500 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function stop() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(PIDFILE, 'utf8')); } catch (e) { /* none */ }
  if (!pid) { console.log(await answers() ? 'A server answers on port ' + PORT + ' but go did not start it, so it is left running.' : 'No server to stop.'); return; }
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/t', '/f']);
    else process.kill(pid, 'SIGTERM');
    console.log('Stopped the server (pid ' + pid + ').');
  } catch (e) { console.log('The server was not running.'); }
  try { fs.unlinkSync(PIDFILE); } catch (e) { /* gone */ }
}

async function go() {
  if (await answers()) console.log('The server is already running on port ' + PORT + '.');
  else {
    fs.mkdirSync(DATA, { recursive: true });
    const out = fs.openSync(LOG, 'a');
    const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true, env: process.env });
    child.unref();
    fs.writeFileSync(PIDFILE, String(child.pid));
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(500); up = await answers(); }
    if (!up) { console.error('The server did not start in 20 seconds. Read ' + LOG); process.exit(1); }
    console.log('Started the server on port ' + PORT + ' (log: ' + LOG + ').');
  }
  const url = 'http://localhost:' + PORT + '/line?phone=' + encodeURIComponent(station);
  if (process.env.NO_BROWSER === '1') { console.log('Would open: ' + url); return; }
  let opened = false;
  if (process.platform === 'darwin') opened = spawnSync('open', ['-a', 'Google Chrome', url]).status === 0;
  else if (process.platform === 'win32') opened = spawnSync('cmd', ['/c', 'start', '', 'chrome', url], { windowsHide: true }).status === 0;
  else opened = spawnSync('xdg-open', [url]).status === 0;
  console.log(opened ? 'Opened Chrome on ' + url : 'Could not open Chrome. Open this link in Chrome: ' + url);
}

(args[0] === 'stop' ? stop() : go()).then(() => process.exit(0));
