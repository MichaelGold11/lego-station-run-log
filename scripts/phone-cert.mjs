// Certificates for the iPhone camera page (https://<laptop>:4174/phone). iPhone Safari only opens the camera on a
// secure page, so the phone listener needs HTTPS. This makes them with openssl, free and local:
//   ca.crt, ca.key          a root CA for this laptop. Kept: a phone that trusted it once keeps trusting it.
//   server.crt, server.key  the listener's certificate, signed by that CA, for this laptop's current names and addresses.
// Apple's rules for a trusted server certificate: every name in subjectAltName, serverAuth EKU, RSA 2048 and SHA-256,
// at most 397 days. The server certificate is reissued (same CA) when the laptop's addresses change.
// The CA is name-constrained (critical): it can only vouch for *.local, localhost, loopback and private addresses
// (10/8, 172.16/12, 192.168/16, fc00::/7). So a phone that trusts it cannot be fooled about any real website, even by
// someone holding ca.key. A certificate that names anything outside that list fails as a whole, so the server
// certificate leaves out public addresses (a hotspot's global IPv6, a public IPv4): links by those addresses still
// open after the phone taps through the warning, and the .local link is the trusted one.
// The files live in <data>/phone-cert/ (git-ignored). ca.key never leaves the laptop.
//
//   node scripts/phone-cert.mjs           make or check the certificates, print the phone links
//   node scripts/phone-cert.mjs --renew   reissue the server certificate now (same CA)
//   DATA_DIR=/tmp/x ...                   another data folder, like npm start
//   OPENSSL=/path/to/openssl ...          a specific openssl (else PATH, Homebrew, or the one in Git for Windows)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEAF_DAYS = 397, CA_DAYS = 3650, RENEW_DAYS = 30;

let opensslBin;
export function findOpenssl() {
  if (opensslBin !== undefined) return opensslBin;
  const cands = [process.env.OPENSSL, 'openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/usr/bin/openssl',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'].filter(Boolean);
  opensslBin = null;
  for (const c of cands) {
    try { if (spawnSync(c, ['version'], { stdio: 'ignore', timeout: 5000 }).status === 0) { opensslBin = c; break; } } catch (e) { /* next */ }
  }
  return opensslBin;
}

// ---------- this laptop's names and addresses ----------
// Interfaces a phone on the same Wi-Fi cannot reach: VPN tunnels (utun, Tailscale, WireGuard), Apple's peer links, VMs.
const SKIP_IFACE = /^(lo|utun|tun|tap|wg|ipsec|ppp|gif|stf|awdl|llw|anpi|nan|ap\d|zt|tailscale|zerotier|docker|veth|vmnet|vboxnet|vethernet)/i;
function v4Ok(a) {
  const [x, y] = a.split('.').map(Number);
  if (x === 127 || (x === 169 && y === 254)) return false;    // loopback, link-local
  if (a.startsWith('192.0.0.')) return false;    // 192.0.0.x: the IPv4 placeholder (CLAT) an IPv6-only hotspot hands out
  if (x === 100 && y >= 64 && y < 128) return false;    // 100.64/10: carrier NAT and Tailscale
  return true;
}
function v6Ok(a) { const s = a.toLowerCase(); return s !== '::1' && !/^fe[89ab]/.test(s) && !s.startsWith('::ffff:'); }
// macOS marks short-lived IPv6 addresses in ifconfig (Node does not show the flags): temporary (privacy, changes daily),
// clat46 (the IPv4 translator), deprecated, detached. Those are left out so the certificate and the links stay stable.
function macV6Flags() {
  const out = {};
  if (process.platform !== 'darwin') return out;
  try {
    const r = spawnSync('/sbin/ifconfig', [], { encoding: 'utf8', timeout: 5000 });
    for (const m of String(r.stdout || '').matchAll(/inet6 ([0-9a-f:]+)(?:%\S+)? prefixlen \d+([^\n]*)/gi)) out[m[1].toLowerCase()] = m[2];
  } catch (e) { /* no ifconfig: keep them all */ }
  return out;
}
// [{ address, family: 4 | 6, iface, kind: 'ipv4' | 'ipv6' | 'ula' }], best first: private IPv4 on Wi-Fi or Ethernet,
// other IPv4, global IPv6, then unique-local IPv6 (fd00::/8, home routers).
export function lanAddresses() {
  const flags = macV6Flags(), out = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    if (SKIP_IFACE.test(iface)) continue;
    for (const a of list || []) {
      if (a.internal) continue;
      const fam = a.family === 'IPv4' || a.family === 4 ? 4 : 6;
      if (fam === 4 ? !v4Ok(a.address) : !v6Ok(a.address)) continue;
      if (fam === 6 && /\b(temporary|clat46|deprecated|detached)\b/.test(flags[a.address.toLowerCase()] || '')) continue;
      const priv = fam === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      const kind = fam === 4 ? 'ipv4' : /^f[cd]/i.test(a.address) ? 'ula' : 'ipv6';
      out.push({ address: fam === 6 ? a.address.toLowerCase() : a.address, family: fam, iface, kind, rank: (fam === 4 ? (priv ? 0 : 1) : kind === 'ipv6' ? 2 : 3) + (/^(en|eth|wl|wi-?fi|ethernet)/i.test(iface) ? 0 : 0.5) });
    }
  }
  const seen = new Set();
  return out.sort((a, b) => a.rank - b.rank).filter(a => !seen.has(a.address) && seen.add(a.address)).map(({ rank, ...a }) => a);
}
// The laptop's Bonjour name (<LocalHostName>.local): phones find it on the network even when its address changes.
export function localNames() {
  const names = [];
  const add = n => { n = String(n || '').trim().replace(/\.local\.?$/i, '').toLowerCase(); if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(n) && !names.includes(n + '.local')) names.push(n + '.local'); };
  if (process.platform === 'darwin') { try { add(spawnSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 5000 }).stdout); } catch (e) { /* none */ } }
  add(os.hostname().split('.')[0]);
  return names;
}

// ---------- the certificates ----------
// What the CA may vouch for (its nameConstraints), and the same test in code for the server certificate's names.
const CA_CONSTRAINTS = 'critical, permitted;DNS:.local, permitted;DNS:localhost, permitted;IP:127.0.0.0/255.0.0.0, permitted;IP:10.0.0.0/255.0.0.0, '
  + 'permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff, permitted;IP:fc00::/fe00::';
const NC_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e]);    // id-ce-nameConstraints (2.5.29.30): an older CA without it is replaced
export const nameAllowed = n => /^localhost$|^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/i.test(n);
export function ipAllowed(ip) {
  const s = String(ip).toLowerCase();
  if (s.includes(':')) return s === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(s);
  const [a, b] = s.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
const readCert = f => { try { return new crypto.X509Certificate(fs.readFileSync(f)); } catch (e) { return null; } };
const expiresSoon = c => new Date(c.validTo).getTime() - Date.now() < RENEW_DAYS * 86400000;
const stamp = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
function run(bin, args, what) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error('openssl could not ' + what + ': ' + String(r.stderr || r.error || '').trim().split('\n').slice(-2).join(' '));
}

// names: DNS names, ips: addresses (the ones the CA may not vouch for are left out and listed in `outside`).
// Returns { key, cert, caPem, caDer, caFingerprint, names, ips, outside, validTo, created, reissued, dir }.
// Throws with a message a person can act on (openssl missing, a write that failed).
export function ensurePhoneCert(dir, opts) {
  const o = opts || {};
  const allNames = ['localhost', ...(o.names || localNames())], allIps = ['127.0.0.1', '::1', ...(o.ips || lanAddresses().map(a => a.address))];
  const names = allNames.filter(nameAllowed), ips = allIps.filter(ipAllowed), outside = [...allNames, ...allIps].filter(x => !nameAllowed(x) && !ipAllowed(x));
  const f = n => path.join(dir, n);
  fs.mkdirSync(dir, { recursive: true });
  let ca = readCert(f('ca.crt')), leaf = readCert(f('server.crt')), created = false, reissued = false;
  const caOk = ca && fs.existsSync(f('ca.key')) && !expiresSoon(ca) && ca.raw.includes(NC_OID);
  const leafOk = caOk && leaf && fs.existsSync(f('server.key')) && leaf.verify(ca.publicKey) && !expiresSoon(leaf)
    && names.every(n => leaf.checkHost(n)) && ips.every(ip => leaf.checkIP(ip));
  if (!caOk || !leafOk || o.renew) {
    const bin = findOpenssl();
    if (!bin) throw new Error('openssl was not found, so the iPhone page has no certificate. Mac: brew install openssl. Windows: it comes with Git for Windows. Or set OPENSSL to its path.');
    const host = (localNames()[0] || os.hostname() || 'laptop').replace(/[^A-Za-z0-9.-]/g, '').slice(0, 40);
    if (!caOk) {
      // A new CA: phones that trusted the old one must install this one (only on the first start, or after 10 years).
      fs.writeFileSync(f('ca.cnf'), ['[req]', 'prompt = no', 'distinguished_name = dn', 'x509_extensions = v3_ca', '[dn]', 'CN = Wire line phone cameras (' + host + ')', 'O = LEGO Station Run Log',
        '[v3_ca]', 'basicConstraints = critical, CA:TRUE, pathlen:0', 'keyUsage = critical, keyCertSign, cRLSign', 'subjectKeyIdentifier = hash',
        'nameConstraints = ' + CA_CONSTRAINTS, ''].join('\n'));
      try {
        run(bin, ['genrsa', '-out', f('ca.key'), '2048'], 'make the CA key');
        run(bin, ['req', '-new', '-x509', '-key', f('ca.key'), '-sha256', '-days', String(CA_DAYS), '-config', f('ca.cnf'), '-out', f('ca.crt')], 'make the CA certificate');
      } finally { fs.rmSync(f('ca.cnf'), { force: true }); }
      created = true;
      ca = readCert(f('ca.crt'));
    }
    if (!fs.existsSync(f('server.key'))) run(bin, ['genrsa', '-out', f('server.key'), '2048'], 'make the server key');
    const san = [...names.map((n, i) => 'DNS.' + (i + 1) + ' = ' + n), ...ips.map((ip, i) => 'IP.' + (i + 1) + ' = ' + ip)];
    fs.writeFileSync(f('server.cnf'), ['[req]', 'prompt = no', 'distinguished_name = dn', '[dn]', 'CN = ' + (names[1] || 'localhost'), 'O = LEGO Station Run Log',
      '[v3_leaf]', 'basicConstraints = critical, CA:FALSE', 'keyUsage = critical, digitalSignature, keyEncipherment', 'extendedKeyUsage = serverAuth',
      'subjectAltName = @alt', 'subjectKeyIdentifier = hash', 'authorityKeyIdentifier = keyid, issuer', '[alt]', ...san, ''].join('\n'));
    try {
      run(bin, ['req', '-new', '-key', f('server.key'), '-config', f('server.cnf'), '-out', f('server.csr')], 'make the certificate request');
      const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
      const base = ['x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-set_serial', '0x' + serial.toString('hex'), '-sha256', '-extfile', f('server.cnf'), '-extensions', 'v3_leaf', '-out', f('server.crt')];
      // Start an hour back so a phone whose clock runs a little behind still accepts it. Older openssl (and LibreSSL)
      // have no -not_before: then it starts now.
      try { run(bin, [...base, '-not_before', stamp(Date.now() - 3600000), '-not_after', stamp(Date.now() + (LEAF_DAYS - 1) * 86400000)], 'sign'); }
      catch (e) { run(bin, [...base, '-days', String(LEAF_DAYS)], 'sign the server certificate'); }
    } finally { for (const n of ['server.cnf', 'server.csr']) fs.rmSync(f(n), { force: true }); }
    for (const n of ['ca.key', 'server.key']) { try { fs.chmodSync(f(n), 0o600); } catch (e) { /* Windows */ } }
    reissued = true;
    leaf = readCert(f('server.crt'));
    if (!leaf || !leaf.verify(ca.publicKey)) throw new Error('openssl made a server certificate that does not check out against the CA in ' + dir + '.');
  }
  return { dir, key: fs.readFileSync(f('server.key')), cert: fs.readFileSync(f('server.crt')), caPem: fs.readFileSync(f('ca.crt')), caDer: ca.raw, caFingerprint: ca.fingerprint256, names, ips, outside, validTo: leaf.validTo, created, reissued };
}

// ---------- command line ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
  const port = Number(process.env.PHONE_PORT) || 4174;
  try {
    const c = ensurePhoneCert(path.join(DATA, 'phone-cert'), { renew: process.argv.includes('--renew') });
    console.log((c.created ? 'Made a new CA and a server certificate' : c.reissued ? 'Reissued the server certificate (same CA)' : 'Certificates are up to date') + ' in ' + c.dir);
    console.log('Valid until ' + c.validTo + '. Names: ' + c.names.join(', ') + '. Addresses: ' + c.ips.join(', '));
    if (c.outside.length) console.log('Not in the certificate (public addresses; phones get a warning to tap through there): ' + c.outside.join(', '));
    console.log('CA fingerprint (SHA-256): ' + c.caFingerprint + ' (it can only vouch for .local names, localhost and private addresses)');
    const hosts = [...localNames(), ...lanAddresses().map(a => (a.family === 6 ? '[' + a.address + ']' : a.address))];
    console.log('An iPhone can download the CA at ' + hosts.map(h => 'https://' + h + ':' + port + '/ca.crt').join(' or ') + ' while npm start runs.');
  } catch (e) { console.error(e.message); process.exit(1); }
}
