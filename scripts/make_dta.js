'use strict';
// Tiny Stata .dta writer for test fixtures and samples (releases 113, 114, 115, 117, 118, 119; both byte orders).
// writeDta(spec, { release, bigEndian }) -> Buffer
// spec = { fileLabel, timestamp, variables: [{ name, label, type: 'numeric'|'string', storage, format, labels }],
//          labelSets: { name: [[value, 'label'], ...] }, rows: [[cell, ...], ...] }
// Numeric cells: a number, NaN or null for '.', { miss: 'a' } .. { miss: 'z' } for extended missing values.
// String cells: a string, or { binary: Uint8Array } for a binary strL. storage: byte/int/long/float/double,
// strN, strL; strings default to strN with N = the longest value in bytes (strL in 117+ when over 2045).

const OLD_CODES = { byte: 251, int: 252, long: 253, float: 254, double: 255 };
const NEW_CODES = { byte: 65530, int: 65529, long: 65528, float: 65527, double: 65526 };
const SIZES = { byte: 1, int: 2, long: 4, float: 4, double: 8 };

class W {
  constructor(le) { this.le = le; this.parts = []; this.len = 0; }
  raw(b) { const x = Buffer.isBuffer(b) ? b : Buffer.from(b); this.parts.push(x); this.len += x.length; return this; }
  str(s) { return this.raw(Buffer.from(s, 'latin1')); }
  num(n, size, signed = false, float = false) {
    const b = Buffer.alloc(size);
    if (float) { if (size === 4) (this.le ? b.writeFloatLE(n) : b.writeFloatBE(n)); else (this.le ? b.writeDoubleLE(n) : b.writeDoubleBE(n)); }
    else if (size === 8) { const v = BigInt(n); this.le ? b.writeBigUInt64LE(v) : b.writeBigUInt64BE(v); }
    else if (size === 1) (signed ? b.writeInt8(n) : b.writeUInt8(n));
    else if (signed) (this.le ? b.writeIntLE(n, 0, size) : b.writeIntBE(n, 0, size));
    else (this.le ? b.writeUIntLE(n, 0, size) : b.writeUIntBE(n, 0, size));
    return this.raw(b);
  }
  fixed(s, n, enc) { const b = Buffer.alloc(n); Buffer.from(String(s || ''), enc).copy(b, 0, 0, n - 1); return this.raw(b); }
  buf() { return Buffer.concat(this.parts); }
}

function missBits(storage, code, le) {
  const b = Buffer.alloc(SIZES[storage]);
  if (storage === 'byte') b.writeInt8(101 + code);
  else if (storage === 'int') le ? b.writeInt16LE(32741 + code) : b.writeInt16BE(32741 + code);
  else if (storage === 'long') le ? b.writeInt32LE(2147483621 + code) : b.writeInt32BE(2147483621 + code);
  else if (storage === 'float') le ? b.writeUInt32LE(0x7f000000 + code * 0x800) : b.writeUInt32BE(0x7f000000 + code * 0x800);
  else { const hi = 0x7fe00000 + code * 0x100; if (le) { b.writeUInt32LE(0, 0); b.writeUInt32LE(hi, 4); } else { b.writeUInt32BE(hi, 0); b.writeUInt32BE(0, 4); } }
  return b;
}

function cellBytes(v, val, le, enc) {
  if (v.type === 'string') {
    const b = Buffer.alloc(v.width);
    Buffer.from(String(val == null ? '' : val), enc).copy(b, 0, 0, v.width);
    return b;
  }
  const st = v.storage;
  if (val == null || (typeof val === 'number' && Number.isNaN(val))) return missBits(st, 0, le);
  if (typeof val === 'object' && val.miss) return missBits(st, val.miss.charCodeAt(0) - 96, le);
  const b = Buffer.alloc(SIZES[st]);
  if (st === 'byte') b.writeInt8(val);
  else if (st === 'int') le ? b.writeInt16LE(val) : b.writeInt16BE(val);
  else if (st === 'long') le ? b.writeInt32LE(val) : b.writeInt32BE(val);
  else if (st === 'float') le ? b.writeFloatLE(val) : b.writeFloatBE(val);
  else le ? b.writeDoubleLE(val) : b.writeDoubleBE(val);
  return b;
}

function labelTable(pairs, le, enc) {
  const txt = []; const offs = []; let p = 0;
  for (const [, l] of pairs) { const b = Buffer.concat([Buffer.from(String(l), enc), Buffer.alloc(1)]); offs.push(p); txt.push(b); p += b.length; }
  const w = new W(le);
  w.num(pairs.length, 4, true).num(p, 4, true);
  for (const o of offs) w.num(o, 4, true);
  for (const [v] of pairs) w.num(v, 4, true);
  w.raw(Buffer.concat(txt));
  return w.buf();
}

function prepare(spec, release, enc) {
  const maxStr = release >= 117 ? 2045 : 244;
  return spec.variables.map((v, i) => {
    const o = { ...v };
    if (o.type === 'string') {
      if (o.storage === 'strL' && release >= 117) { o.width = 8; return o; }
      if (o.storage === 'strL') delete o.storage;
      let w = 1;
      if (o.storage && /^str\d+$/.test(o.storage)) w = Number(o.storage.slice(3));
      else for (const r of spec.rows) { const c = r[i]; if (c != null && typeof c !== 'object') w = Math.max(w, Buffer.byteLength(String(c), enc)); }
      if (w > maxStr) { if (release >= 117) { o.storage = 'strL'; o.width = 8; return o; } w = maxStr; }
      o.storage = `str${w}`; o.width = w;
      return o;
    }
    o.storage = o.storage || 'double';
    o.width = SIZES[o.storage];
    return o;
  });
}

function writeDta(spec, { release = 118, bigEndian = false } = {}) {
  const le = !bigEndian;
  const enc = release >= 118 ? 'utf8' : 'latin1';
  const vars = prepare(spec, release, enc);
  const K = vars.length, N = spec.rows.length;
  const sets = spec.labelSets || {};
  if (release < 117) {
    const w = new W(le);
    w.num(release, 1).num(le ? 2 : 1, 1).num(1, 1).num(0, 1).num(K, 2).num(N, 4);
    w.fixed(spec.fileLabel, 81, enc).fixed(spec.timestamp || ' 1 Jan 2026 10:00', 18, enc);
    for (const v of vars) w.num(v.type === 'string' ? v.width : OLD_CODES[v.storage], 1);
    for (const v of vars) w.fixed(v.name, 33, enc);
    for (let i = 0; i <= K; i++) w.num(0, 2);
    for (const v of vars) w.fixed(v.format || (v.type === 'string' ? `%${v.width}s` : '%9.0g'), release === 113 ? 12 : 49, enc);
    for (const v of vars) w.fixed(v.labels || '', 33, enc);
    for (const v of vars) w.fixed(v.label || '', 81, enc);
    w.num(0, 1).num(0, 4);
    for (const r of spec.rows) vars.forEach((v, i) => w.raw(cellBytes(v, r[i], le, enc)));
    for (const [name, pairs] of Object.entries(sets)) {
      const t = labelTable(pairs, le, enc);
      w.num(t.length, 4).fixed(name, 33, enc).raw(Buffer.alloc(3)).raw(t);
    }
    return w.buf();
  }
  const nameLen = release === 117 ? 33 : 129, fmtLen = release === 117 ? 49 : 57, vlLen = release === 117 ? 81 : 321;
  const vlen = release === 117 ? 4 : release === 118 ? 2 : 3;
  const w = new W(le);
  const map = new Array(14).fill(0);
  w.str('<stata_dta><header><release>').str(String(release)).str('</release><byteorder>').str(le ? 'LSF' : 'MSF').str('</byteorder><K>');
  w.num(K, release === 119 ? 4 : 2).str('</K><N>').num(N, release === 117 ? 4 : 8).str('</N><label>');
  const lab = Buffer.from(spec.fileLabel || '', enc);
  w.num(lab.length, release === 117 ? 1 : 2).raw(lab).str('</label><timestamp>');
  const ts = spec.timestamp === '' ? Buffer.alloc(0) : Buffer.from(spec.timestamp || ' 1 Jan 2026 10:00', enc);
  w.num(ts.length, 1).raw(ts).str('</timestamp></header>');
  map[1] = w.len;
  const mapAt = w.parts.length;
  w.str('<map>').raw(Buffer.alloc(14 * 8)).str('</map>');
  map[2] = w.len; w.str('<variable_types>'); for (const v of vars) w.num(v.storage === 'strL' ? 32768 : v.type === 'string' ? v.width : NEW_CODES[v.storage], 2); w.str('</variable_types>');
  map[3] = w.len; w.str('<varnames>'); for (const v of vars) w.fixed(v.name, nameLen, enc); w.str('</varnames>');
  map[4] = w.len; w.str('<sortlist>'); for (let i = 0; i <= K; i++) w.num(0, release === 119 ? 4 : 2); w.str('</sortlist>');
  map[5] = w.len; w.str('<formats>'); for (const v of vars) w.fixed(v.format || (v.type === 'string' ? `%${Math.min(v.width, 2045)}s` : '%9.0g'), fmtLen, enc); w.str('</formats>');
  map[6] = w.len; w.str('<value_label_names>'); for (const v of vars) w.fixed(v.labels || '', nameLen, enc); w.str('</value_label_names>');
  map[7] = w.len; w.str('<variable_labels>'); for (const v of vars) w.fixed(v.label || '', vlLen, enc); w.str('</variable_labels>');
  map[8] = w.len; w.str('<characteristics>');
  if (spec.characteristic) { const ch = Buffer.from(spec.characteristic, enc); w.str('<ch>').num(ch.length, 4).raw(ch).str('</ch>'); }
  w.str('</characteristics>');
  map[9] = w.len; w.str('<data>');
  const gsos = [];
  spec.rows.forEach((r, ri) => vars.forEach((v, i) => {
    if (v.storage !== 'strL') { w.raw(cellBytes(v, r[i], le, enc)); return; }
    const c = r[i];
    const empty = c == null || c === '';
    const vv = empty ? 0 : i + 1, oo = empty ? 0 : ri + 1;
    const b = Buffer.alloc(8);
    if (le) { b.writeUIntLE(vv, 0, vlen); b.writeUIntLE(oo, vlen, 8 - vlen); } else { b.writeUIntBE(vv, 0, vlen); b.writeUIntBE(oo, vlen, 8 - vlen); }
    w.raw(b);
    if (!empty) gsos.push([vv, oo, c]);
  }));
  w.str('</data>');
  map[10] = w.len; w.str('<strls>');
  for (const [vv, oo, c] of gsos) {
    const bin = typeof c === 'object' && c.binary;
    const data = bin ? Buffer.from(c.binary) : Buffer.concat([Buffer.from(String(c), enc), Buffer.alloc(1)]);
    w.str('GSO').num(vv, 4).num(oo, release === 117 ? 4 : 8).num(bin ? 129 : 130, 1).num(data.length, 4).raw(data);
  }
  w.str('</strls>');
  map[11] = w.len; w.str('<value_labels>');
  for (const [name, pairs] of Object.entries(sets)) {
    const t = labelTable(pairs, le, enc);
    w.str('<lbl>').num(t.length, 4).fixed(name, nameLen, enc).raw(Buffer.alloc(3)).raw(t).str('</lbl>');
  }
  w.str('</value_labels>');
  map[12] = w.len; w.str('</stata_dta>');
  map[13] = w.len;
  const m = new W(le); m.str('<map>'); for (const x of map) m.num(x, 8); m.str('</map>');
  w.parts[mapAt] = m.buf().subarray(0, 5); w.parts[mapAt + 1] = m.buf().subarray(5, 5 + 112);
  return w.buf();
}

module.exports = { writeDta };
