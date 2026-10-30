// Test helper: reads a store-only zip (end record, central directory, local headers) into [{ name, data, ... }].
// Used by the capture tests to check the zip the server and app/capture-lib.js write.
export function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let e = buf.length - 22;
  if (dv.getUint32(e, true) !== 0x06054b50) return null;
  const n = dv.getUint16(e + 10, true), cdSize = dv.getUint32(e + 12, true), cdOff = dv.getUint32(e + 16, true);
  const files = [];
  let p = cdOff;
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), cs = dv.getUint32(p + 20, true), us = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true);
    const name = Buffer.from(buf.subarray(p + 46, p + 46 + nl)).toString('utf8');
    if (dv.getUint32(off, true) !== 0x04034b50) return null;
    const lnl = dv.getUint16(off + 26, true), lel = dv.getUint16(off + 28, true), start = off + 30 + lnl + lel;
    files.push({ name, method, crc, size: us, csize: cs, data: Buffer.from(buf.subarray(start, start + cs)) });
    p += 46 + nl;
  }
  return { files, count: n, cdEnd: cdOff + cdSize, cdOff };
}
