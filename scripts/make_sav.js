'use strict';
// A small SPSS system file writer for test fixtures and the walkthrough sample (not shipped in the extension).
// writeSav(spec, opts) -> Buffer
//   spec = { fileLabel, documents: [lines], weight: 'varname', variables: [{ name, label, type: 'numeric'|'string',
//            width, format: { type, w, d } | typeCode, measure: 'nominal'|'ordinal'|'scale', alignment,
//            missing: { values, range }, labels: [[value, 'label'], ...] }], rows: [[...]] }
//   opts = { compression: 'none'|'bytecode'|'zlib', bigEndian, encoding: 'utf-8'|'windows-1252', ncases (header
//            value, -1 for unknown), case64 (write subtype 16), noEof (no 252 code at the end), blockSize (zsav),
//            product, rawBlocks: [{ usize, c }] (zsav blocks as given, for hostile tests), lieBlockSize }
const zlib = require('zlib');

const SYSMIS = -Number.MAX_VALUE;
const HIGHEST = Number.MAX_VALUE;
const LOWEST = -1.7976931348623155e308;
const MEASURE = { nominal: 1, ordinal: 2, scale: 3 };

class W {
  constructor(le) { this.le = le; this.parts = []; this.len = 0; }
  push(b) { this.parts.push(b); this.len += b.length; }
  i32(v) { const b = Buffer.alloc(4); this.le ? b.writeInt32LE(v) : b.writeInt32BE(v); this.push(b); }
  i64(v) { const b = Buffer.alloc(8); this.le ? b.writeBigInt64LE(BigInt(v)) : b.writeBigInt64BE(BigInt(v)); this.push(b); }
  f64(v) { const b = Buffer.alloc(8); this.le ? b.writeDoubleLE(v) : b.writeDoubleBE(v); this.push(b); }
  u8(v) { this.push(Buffer.from([v & 255])); }
  bytes(b) { this.push(Buffer.from(b)); }
  padded(b, n, fill = 0x20) { const o = Buffer.alloc(n, fill); Buffer.from(b).copy(o, 0, 0, Math.min(n, b.length)); this.push(o); }
  out() { return Buffer.concat(this.parts); }
}

function writeSav(spec, opts = {}) {
  const le = !opts.bigEndian;
  const enc = (opts.encoding || 'utf-8').toLowerCase();
  const encode = (s) => (enc === 'utf-8' ? Buffer.from(String(s), 'utf8') : Buffer.from(String(s), 'latin1'));
  const comp = opts.compression || 'bytecode';
  const compCode = comp === 'none' ? 0 : comp === 'bytecode' ? 1 : 2;
  const vars = spec.variables;
  const rows = spec.rows || [];

  // short names
  const used = new Set();
  const shortOf = (base) => {
    let s = String(base).toUpperCase().replace(/[^A-Z0-9_@#$.]/g, '_').slice(0, 8) || 'V';
    if (!/^[A-Z@]/.test(s)) s = `V${s}`.slice(0, 8);
    let k = 0, cand = s;
    while (used.has(cand)) { k++; const suf = String(k); cand = s.slice(0, 8 - suf.length) + suf; }
    used.add(cand);
    return cand;
  };

  // records: one per segment
  const recs = []; // { v, seg, alloc, units, short, first }
  let units = 0;
  for (const v of vars) {
    v._short = shortOf(v.name);
    if (v.type === 'string') {
      const w = v.width;
      if (w > 255) {
        const nseg = Math.ceil(w / 252);
        for (let j = 0; j < nseg; j++) {
          const alloc = j < nseg - 1 ? 255 : w - j * 252;
          const short = j === 0 ? v._short : shortOf(`${v._short.slice(0, 5)}${j}`);
          recs.push({ v, seg: j, alloc, units: Math.ceil(alloc / 8), short, first: j === 0, dict: units + 1 });
          units += Math.ceil(alloc / 8);
        }
      } else {
        recs.push({ v, seg: 0, alloc: w, units: Math.ceil(w / 8), short: v._short, first: true, dict: units + 1 });
        units += Math.ceil(w / 8);
      }
    } else {
      recs.push({ v, seg: 0, alloc: 0, units: 1, short: v._short, first: true, dict: units + 1 });
      units += 1;
    }
    v._dict = recs.find((r) => r.v === v).dict;
  }

  const w = new W(le);
  // header
  w.bytes(compCode === 2 ? '$FL3' : '$FL2');
  w.padded(Buffer.from(`@(#) SPSS DATA FILE ${opts.product || 'zovo test writer'}`), 60);
  w.i32(2);
  w.i32(units);
  w.i32(compCode);
  const wv = spec.weight ? vars.find((v) => v.name === spec.weight) : null;
  w.i32(wv ? wv._dict : 0);
  w.i32(opts.ncases !== undefined ? opts.ncases : rows.length);
  w.f64(100);
  w.padded(Buffer.from('10 Nov 26'), 9);
  w.padded(Buffer.from('13:30:00'), 8);
  w.padded(encode(spec.fileLabel || ''), 64);
  w.padded(Buffer.alloc(0), 3);

  // variable records
  for (const r of recs) {
    const v = r.v;
    const isStr = v.type === 'string';
    w.i32(2);
    w.i32(isStr ? r.alloc : 0);
    const label = r.first && v.label ? encode(v.label) : null;
    w.i32(label ? 1 : 0);
    let missRaw = [];
    let nMiss = 0;
    if (r.first && v.missing) {
      if (!isStr) {
        const m = v.missing;
        const f = (x) => (x === -Infinity ? LOWEST : x === Infinity ? HIGHEST : x);
        if (m.range) { nMiss = m.values && m.values.length ? -3 : -2; missRaw.push(f(m.range[0]), f(m.range[1])); if (nMiss === -3) missRaw.push(f(m.values[0])); }
        else { nMiss = m.values.length; missRaw = m.values.map(f); }
      } else if (v.width <= 8) {
        nMiss = v.missing.values.length; missRaw = v.missing.values;
      }
    }
    w.i32(nMiss);
    let fmt;
    if (isStr) fmt = (1 << 16) | (Math.min(255, r.alloc) << 8);
    else {
      const f = typeof v.format === 'number' ? { type: v.format, w: 11, d: 0 } : (v.format || { type: 5, w: 8, d: 2 });
      fmt = (f.type << 16) | (f.w << 8) | f.d;
    }
    w.i32(fmt); w.i32(fmt);
    w.padded(Buffer.from(r.short), 8);
    if (label) { w.i32(label.length); w.push(label); const pad = ((label.length + 3) & ~3) - label.length; if (pad) w.push(Buffer.alloc(pad, 0x20)); }
    for (const m of missRaw) { if (isStr) w.padded(encode(m), 8); else w.f64(m); }
    for (let k = 1; k < r.units; k++) { w.i32(2); w.i32(-1); w.i32(0); w.i32(0); w.i32(0); w.i32(0); w.padded(Buffer.alloc(0), 8); }
  }

  // value labels (numeric and short strings)
  const longLabels = [];
  for (const v of vars) {
    if (!v.labels || !v.labels.length) continue;
    if (v.type === 'string' && v.width > 8) { longLabels.push(v); continue; }
    w.i32(3); w.i32(v.labels.length);
    for (const [val, lab] of v.labels) {
      if (v.type === 'string') w.padded(encode(val), 8); else w.f64(val);
      const lb = encode(lab).subarray(0, 255);
      w.u8(lb.length); w.push(lb);
      const pad = ((lb.length + 8) & ~7) - 1 - lb.length;
      if (pad) w.push(Buffer.alloc(pad, 0x20));
    }
    w.i32(4); w.i32(1); w.i32(v._dict);
  }

  // documents
  if (spec.documents && spec.documents.length) {
    w.i32(6); w.i32(spec.documents.length);
    for (const line of spec.documents) w.padded(encode(line), 80);
  }

  const ext = (sub, size, count, data) => { w.i32(7); w.i32(sub); w.i32(size); w.i32(count); w.push(data); };
  const ints = (arr) => { const b = Buffer.alloc(arr.length * 4); arr.forEach((x, i) => (le ? b.writeInt32LE(x, i * 4) : b.writeInt32BE(x, i * 4))); return b; };
  const dbls = (arr) => { const b = Buffer.alloc(arr.length * 8); arr.forEach((x, i) => (le ? b.writeDoubleLE(x, i * 8) : b.writeDoubleBE(x, i * 8))); return b; };
  ext(3, 4, 8, ints([20, 0, 0, -1, 1, 1, le ? 2 : 1, enc === 'utf-8' ? 65001 : 1252]));
  ext(4, 8, 3, dbls([SYSMIS, HIGHEST, LOWEST]));
  const disp = [];
  for (const r of recs) {
    const v = r.v;
    disp.push(MEASURE[v.measure] || (v.type === 'string' ? 1 : 3), 8, v.alignment === 'left' ? 0 : v.alignment === 'center' ? 2 : (v.type === 'string' ? 0 : 1));
  }
  ext(11, 4, disp.length, ints(disp));
  const ln = encode(vars.map((v) => `${v._short}=${v.name}`).join('\t'));
  ext(13, 1, ln.length, ln);
  const vlsVars = vars.filter((v) => v.type === 'string' && v.width > 255);
  if (vlsVars.length) {
    const t = Buffer.from(vlsVars.map((v) => `${v._short}=${String(v.width).padStart(5, '0')}\0\t`).join(''), 'latin1');
    ext(14, 1, t.length, t);
  }
  if (opts.case64) { const b = Buffer.alloc(16); le ? (b.writeBigInt64LE(1n, 0), b.writeBigInt64LE(BigInt(rows.length), 8)) : (b.writeBigInt64BE(1n, 0), b.writeBigInt64BE(BigInt(rows.length), 8)); ext(16, 8, 2, b); }
  const encName = Buffer.from(enc === 'utf-8' ? 'UTF-8' : 'windows-1252');
  ext(20, 1, encName.length, encName);
  if (longLabels.length) {
    const sw = new W(le);
    for (const v of longLabels) {
      const nm = encode(v._short); sw.i32(nm.length); sw.push(nm); sw.i32(v.width); sw.i32(v.labels.length);
      for (const [val, lab] of v.labels) { const vb = encode(val); sw.i32(vb.length); sw.push(vb); const lb = encode(lab); sw.i32(lb.length); sw.push(lb); }
    }
    const b = sw.out(); ext(21, 1, b.length, b);
  }
  const longMiss = vars.filter((v) => v.type === 'string' && v.width > 8 && v.missing && v.missing.values.length);
  if (longMiss.length) {
    const sw = new W(le);
    for (const v of longMiss) {
      const nm = encode(v._short); sw.i32(nm.length); sw.push(nm); sw.u8(v.missing.values.length); sw.i32(8);
      for (const m of v.missing.values) sw.padded(encode(m), 8);
    }
    const b = sw.out(); ext(22, 1, b.length, b);
  }
  w.i32(999); w.i32(0);

  // case data as 8-byte units
  const caseUnits = (row) => {
    const out = [];
    vars.forEach((v, vi) => {
      const val = row[vi];
      if (v.type !== 'string') {
        const b = Buffer.alloc(8);
        const x = typeof val === 'number' && !Number.isNaN(val) ? val : SYSMIS;
        le ? b.writeDoubleLE(x) : b.writeDoubleBE(x);
        out.push({ num: true, x, b });
        return;
      }
      const full = Buffer.alloc(Math.max(v.width, 1) + 260, 0x20);
      encode(val == null ? '' : val).copy(full, 0, 0, v.width);
      const segs = recs.filter((r) => r.v === v);
      for (const s of segs) {
        const seg = Buffer.alloc(s.units * 8, 0x20);
        full.copy(seg, 0, s.seg * 252, s.seg * 252 + s.alloc);
        for (let k = 0; k < s.units; k++) out.push({ num: false, b: seg.subarray(k * 8, k * 8 + 8) });
      }
    });
    return out;
  };

  let data;
  if (compCode === 0) {
    const parts = [];
    for (const row of rows) for (const u of caseUnits(row)) parts.push(u.b);
    data = Buffer.concat(parts);
  } else {
    const parts = [];
    let cmds = [], raws = [];
    const flush = () => { while (cmds.length < 8) cmds.push(0); parts.push(Buffer.from(cmds)); for (const r of raws) parts.push(r); cmds = []; raws = []; };
    const emit = (code, raw) => { cmds.push(code); if (raw) raws.push(raw); if (cmds.length === 8) flush(); };
    for (const row of rows) for (const u of caseUnits(row)) {
      if (u.num) {
        if (u.x === SYSMIS) emit(255);
        else if (Number.isInteger(u.x) && u.x >= -99 && u.x <= 151) emit(u.x + 100);
        else emit(253, u.b);
      } else if (u.b.every((c) => c === 0x20)) emit(254);
      else emit(253, u.b);
    }
    if (!opts.noEof) emit(252);
    if (cmds.length) flush();
    data = Buffer.concat(parts);
  }

  if (compCode !== 2) { w.push(data); return w.out(); }
  // zsav: zheader, blocks, ztrailer
  const zheaderOfs = w.len;
  const bs = opts.blockSize || 0x3ff000;
  const blocks = opts.rawBlocks ? opts.rawBlocks.map((b) => ({ u: { length: b.usize }, c: b.c })) : [];
  for (let o = 0; !opts.rawBlocks && (o < data.length || (o === 0 && !blocks.length)); o += bs) {
    const u = data.subarray(o, o + bs);
    blocks.push({ u, c: zlib.deflateSync(u) });
    if (!data.length) break;
  }
  let pos = zheaderOfs + 24;
  for (const b of blocks) { b.cofs = pos; pos += b.c.length; }
  const ztrailerOfs = pos;
  const ztrailerLen = 24 + 24 * blocks.length;
  w.i64(zheaderOfs); w.i64(ztrailerOfs); w.i64(ztrailerLen);
  for (const b of blocks) w.push(b.c);
  w.i64(-100); w.i64(0); w.i32(bs); w.i32(blocks.length);
  let uofs = zheaderOfs;
  for (const b of blocks) { w.i64(uofs); w.i64(b.cofs); w.i32(opts.lieBlockSize ? b.u.length + 1000 : b.u.length); w.i32(b.c.length); uofs += b.u.length; }
  return w.out();
}

module.exports = { writeSav, SYSMIS };

if (require.main === module) {
  const spec = { fileLabel: 'demo', variables: [{ name: 'id', type: 'numeric', format: { type: 5, w: 4, d: 0 } }, { name: 'name', type: 'string', width: 10 }], rows: [[1, 'a'], [2, 'b']] };
  require('fs').writeFileSync(process.argv[2] || 'demo.sav', writeSav(spec));
}
