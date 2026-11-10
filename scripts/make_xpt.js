'use strict';
// Tiny SAS transport (XPORT version 5) writer for test fixtures.
// writeXpt(spec, { v8 }) -> Buffer. spec = { members: [member, ...] } or one member (v8: names up to 32 characters,
// labels over 40 characters in a LABELV8 section; npos: [..] in a member overrides the stored positions):
//   member = { name, label, variables: [{ name, label, type: 'numeric'|'string', length, format }], rows: [[...]] }
// Numeric cells: a number, NaN or null for '.', { miss: 'A' } .. { miss: 'Z' } or { miss: '_' }.

const pad = (s, n) => String(s || '').slice(0, n).padEnd(n, ' ');
const rec = (s) => Buffer.from(pad(s, 80), 'latin1');
const LIB = 'HEADER RECORD*******LIBRARY HEADER RECORD!!!!!!!000000000000000000000000000000  ';
const STAMP = '10NOV26:10:00:00';

/** IBM 360 double, cut to len bytes. */
function ibmBytes(x, len = 8) {
  const b = Buffer.alloc(8);
  if (x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x))) { b[0] = 0x2e; return b.subarray(0, len); }
  if (typeof x === 'object' && x.miss) { b[0] = x.miss.charCodeAt(0); return b.subarray(0, len); }
  if (x === 0) return b.subarray(0, len);
  const neg = x < 0;
  const a = Math.abs(x);
  let e = Math.floor(Math.log2(a) / 4) + 1;
  let frac = a / Math.pow(16, e);
  while (frac >= 1) { e++; frac /= 16; }
  while (frac < 1 / 16) { e--; frac *= 16; }
  let mant = Math.round(frac * Math.pow(2, 56));
  if (mant >= Math.pow(2, 56)) { e++; mant = Math.round(frac / 16 * Math.pow(2, 56)); }
  if (e + 64 > 127) throw new Error(`${x} is too large for an IBM float`);
  if (e + 64 < 0) return b.subarray(0, len);
  b[0] = (e + 64) | (neg ? 0x80 : 0);
  const hi = Math.floor(mant / 4294967296), lo = mant - hi * 4294967296;
  b[1] = (hi >>> 16) & 0xff; b[2] = (hi >>> 8) & 0xff; b[3] = hi & 0xff;
  b.writeUInt32BE(lo >>> 0, 4);
  return b.subarray(0, len);
}

function member(m, v8) {
  const vars = m.variables.map((v) => ({ ...v, length: v.length || (v.type === 'string' ? 8 : 8) }));
  const parts = [];
  parts.push(rec(`HEADER RECORD*******${v8 ? 'MEMBV8 ' : 'MEMBER '} HEADER RECORD!!!!!!!000000000000000001600000000140  `));
  parts.push(rec(`HEADER RECORD*******${v8 ? 'DSCPTV8' : 'DSCRPTR'} HEADER RECORD!!!!!!!000000000000000000000000000000  `));
  parts.push(rec(v8 ? `SAS     ${pad(m.name, 32)}SASDATA 9.4     X64_10HO${STAMP}` : `SAS     ${pad(m.name, 8)}SASDATA 9.4     X64_10HO${' '.repeat(24)}${STAMP}`));
  parts.push(rec(`${STAMP}${' '.repeat(16)}${pad(m.label, 40)}${pad('', 8)}`));
  parts.push(rec(`HEADER RECORD*******${v8 ? 'NAMSTV8' : 'NAMESTR'} HEADER RECORD!!!!!!!000000${String(m.namestrCount !== undefined ? m.namestrCount : vars.length).padStart(4, '0')}00000000000000000000  `));
  const ns = Buffer.alloc(vars.length * 140);
  let pos = 0;
  vars.forEach((v, i) => {
    const o = i * 140;
    ns.writeInt16BE(v.type === 'string' ? 2 : 1, o);
    ns.writeInt16BE(0, o + 2);
    ns.writeInt16BE(v.length, o + 4);
    ns.writeInt16BE(i + 1, o + 6);
    ns.write(pad(v.name, 8), o + 8, 'latin1');
    ns.write(pad(v.label, 40), o + 16, 'latin1');
    const f = /^([A-Z$]*?)(\d*)\.?(\d*)$/i.exec(v.format || '') || ['', '', '', ''];
    ns.write(pad(f[1], 8), o + 56, 'latin1');
    ns.writeInt16BE(Number(f[2]) || 0, o + 64);
    ns.writeInt16BE(Number(f[3]) || 0, o + 66);
    ns.write(pad('', 8), o + 72, 'latin1');
    ns.writeInt32BE(m.npos ? m.npos[i] : pos, o + 84);
    if (v8) { ns.write(pad(v.name, 32), o + 88, 'latin1'); ns.writeInt16BE(Buffer.byteLength(v.label || '', 'latin1'), o + 120); }
    v.pos = pos; pos += v.length;
  });
  parts.push(ns, Buffer.alloc((80 - (ns.length % 80)) % 80, 0x20));
  const longLabels = v8 ? vars.map((v, i) => [i, v]).filter(([, v]) => (v.label || '').length > 40) : [];
  if (longLabels.length) {
    parts.push(rec(`HEADER RECORD*******LABELV8 HEADER RECORD!!!!!!!${longLabels.length}`));
    const lb = Buffer.concat(longLabels.map(([i, v]) => { const h = Buffer.alloc(6); h.writeInt16BE(i + 1, 0); h.writeInt16BE(v.name.length, 2); h.writeInt16BE(v.label.length, 4); return Buffer.concat([h, Buffer.from(v.name + v.label, 'latin1')]); }));
    parts.push(lb, Buffer.alloc((80 - (lb.length % 80)) % 80, 0x20));
  }
  parts.push(rec(`HEADER RECORD*******${v8 ? 'OBSV8  ' : 'OBS    '} HEADER RECORD!!!!!!!000000000000000000000000000000  `));
  const rows = [];
  for (const r of m.rows) {
    const b = Buffer.alloc(pos, 0x20);
    vars.forEach((v, i) => {
      if (v.type === 'string') b.write(pad(r[i], v.length), v.pos, 'latin1');
      else ibmBytes(r[i], v.length).copy(b, v.pos);
    });
    rows.push(b);
  }
  const data = Buffer.concat(rows);
  parts.push(data, Buffer.alloc((80 - (data.length % 80)) % 80, 0x20));
  return Buffer.concat(parts);
}

function writeXpt(spec, { v8 = false } = {}) {
  const members = spec.members || [spec];
  return Buffer.concat([
    rec(v8 ? LIB.replace('LIBRARY', 'LIBV8  ') : LIB),
    rec(`SAS     SAS     SASLIB  9.4     X64_10HO${' '.repeat(24)}${STAMP}`),
    rec(STAMP),
    ...members.map((m) => member(m, v8)),
  ]);
}

module.exports = { writeXpt, ibmBytes };
