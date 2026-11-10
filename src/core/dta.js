'use strict';
// Stata .dta reader: releases 113, 114, 115 (Stata 8 to 12, binary header) and 117, 118, 119 (Stata 13 and later,
// tagged sections, strL values). Every count is checked against the bytes left in the file before anything is
// allocated; a file that ends early keeps the complete rows read so far and says so in warnings.
const { Cursor, DataError, Trunc } = require('./source');
const { makeDecoder } = require('./text');
const { stataFormat } = require('./dates');
const { Store, rowGuard, newDataset } = require('./dataset');

const OLD = new Set([113, 114, 115]);
const NEW = new Set([117, 118, 119]);
const VERSIONS = { 113: 'Stata 8 or 9', 114: 'Stata 10 or 11', 115: 'Stata 12', 117: 'Stata 13', 118: 'Stata 14 or later', 119: 'Stata 15 or later, more than 32,767 variables' };
const MAGIC_NEW = '<stata_dta>';
const ascii = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };

/** True when the first bytes look like a Stata .dta file (any release; old releases get a clear message). */
function sniff(b) {
  if (!b || b.length < 4) return false;
  if (b.length >= 11 && ascii(b.subarray(0, 11)) === MAGIC_NEW) return true;
  return b[0] >= 102 && b[0] <= 115 && (b[1] === 1 || b[1] === 2) && b[2] === 1;
}

// Numeric storage types: [name, bytes]
const OLD_TYPES = { 251: ['byte', 1], 252: ['int', 2], 253: ['long', 4], 254: ['float', 4], 255: ['double', 8] };
const NEW_TYPES = { 65530: ['byte', 1], 65529: ['int', 2], 65528: ['long', 4], 65527: ['float', 4], 65526: ['double', 8] };
const STRL = 32768;

function expectTag(c, tag) {
  const b = c.bytes(tag.length);
  if (ascii(b) !== tag) throw new DataError(`This Stata file is damaged: "${tag}" expected at offset ${c.pos - tag.length}.`);
}
function peekIs(c, tag) {
  if (c.left < tag.length) return false;
  return ascii(c.src.read(c.pos, tag.length)) === tag;
}

/** Reads a numeric cell; returns [value, missCode] where missCode is -1 for a real value. */
function numReader(kind, le) {
  switch (kind) {
    case 'byte': return (dv, o) => { const v = dv.getInt8(o); return v >= 101 ? [NaN, Math.min(26, v - 101)] : [v, -1]; };
    case 'int': return (dv, o) => { const v = dv.getInt16(o, le); return v >= 32741 ? [NaN, Math.min(26, v - 32741)] : [v, -1]; };
    case 'long': return (dv, o) => { const v = dv.getInt32(o, le); return v >= 2147483621 ? [NaN, Math.min(26, v - 2147483621)] : [v, -1]; };
    case 'float': return (dv, o) => {
      const bits = dv.getUint32(o, le);
      if (bits >= 0x7f000000 && bits < 0x80000000) return [NaN, Math.min(26, (bits - 0x7f000000) >>> 11)];
      return [dv.getFloat32(o, le), -1];
    };
    default: return (dv, o) => {
      const hi = le ? dv.getUint32(o + 4, true) : dv.getUint32(o, false);
      if (hi >= 0x7fe00000 && hi < 0x80000000) return [NaN, Math.min(26, (hi - 0x7fe00000) >>> 8)];
      return [dv.getFloat64(o, le), -1];
    };
  }
}

function read(src, limits) {
  if (src.size < 4) throw new DataError('This is not a Stata .dta file (it is too short).', 'NOT_DATA');
  const head = src.readUpTo(0, 11);
  if (head.length >= 11 && ascii(head) === MAGIC_NEW) return readNew(src, limits);
  const rel = head[0];
  if (OLD.has(rel) && (head[1] === 1 || head[1] === 2) && head[2] === 1) return readOld(src, limits, rel);
  if (rel >= 102 && rel <= 112 && (head[1] === 1 || head[1] === 2)) throw new DataError(`This is a Stata .dta file of release ${rel} (Stata 7 or older). Releases 113 to 119 (Stata 8 and later) can be read; save it again in a newer Stata.`, 'UNSUPPORTED');
  throw new DataError('This is not a Stata .dta file (the first bytes do not match).', 'NOT_DATA');
}

function finishVar(v, ds) {
  v.date = v.type === 'numeric' ? stataFormat(v.format) : null;
  v.measure = '';
  v.missing = null;
  if (!v.labels) v.labels = null;
  ds.variables.push(v);
}

// ---------------------------------------------------------------- releases 113-115
function readOld(src, limits, rel) {
  const ds = newDataset('dta', `Stata .dta release ${rel} (${VERSIONS[rel]})`);
  const le = src.read(1, 1)[0] === 2;
  const c = new Cursor(src, 4, le);
  const dec = makeDecoder('windows-1252');
  const K = c.u16();
  const N = c.u32();
  const fileLabel = dec(c.bytes(81));
  const ts = dec(c.bytes(18));
  const fmtLen = rel === 113 ? 12 : 49;
  const per = 1 + 33 + 2 + fmtLen + 33 + 81;
  if (K * per + 2 > c.left) throw new DataError(`This Stata file says it has ${K} variables, but it ends before their descriptions.`, 'TRUNC');
  const types = Array.from(c.bytes(K));
  const names = []; for (let i = 0; i < K; i++) names.push(dec(c.bytes(33)));
  c.skip(2 * (K + 1));
  const fmts = []; for (let i = 0; i < K; i++) fmts.push(dec(c.bytes(fmtLen)));
  const lbls = []; for (let i = 0; i < K; i++) lbls.push(dec(c.bytes(33)));
  const vlabels = []; for (let i = 0; i < K; i++) vlabels.push(dec(c.bytes(81)));
  // expansion fields: type byte + int32 length, until 0/0
  for (let guard = 0; ; guard++) {
    const t = c.u8(); const len = c.u32();
    if (t === 0 && len === 0) break;
    if (len > c.left) throw new Trunc(c.pos, len, src.size);
    c.skip(len);
    if (guard > 1e6) throw new DataError('Too many expansion fields.');
  }
  const cols = [];
  for (let i = 0; i < K; i++) {
    const t = types[i];
    let v;
    if (OLD_TYPES[t]) v = { name: names[i], label: vlabels[i], type: 'numeric', width: OLD_TYPES[t][1], storage: OLD_TYPES[t][0], format: fmts[i], labels: lbls[i] || null };
    else if (t >= 1 && t <= 244) v = { name: names[i], label: vlabels[i], type: 'string', width: t, storage: `str${t}`, format: fmts[i], labels: null };
    else throw new DataError(`Variable ${i + 1} has an unknown Stata storage type (${t}).`);
    finishVar(v, ds);
    cols.push(v);
  }
  Object.assign(ds.info, { rows: N, fileLabel, created: ts, release: String(rel), byteOrder: le ? 'little-endian (LOHI)' : 'big-endian (HILO)', encoding: 'windows-1252', product: 'Stata' });
  const dataStart = c.pos;
  const rw = readRows(src, ds, cols, dataStart, N, le, dec, limits, null);
  // value labels after the data
  const vlStart = dataStart + N * rw;
  if (vlStart >= src.size) { if (vlStart > src.size) ds.warnings.push('Value labels could not be read: the file ends before them.'); return done(ds); }
  try { readOldLabels(src, vlStart, le, dec, ds); } catch (e) { ds.warnings.push(`Value labels could not be read: ${e.message}`); }
  return done(ds);
}

function readOldLabels(src, start, le, dec, ds) {
  const c = new Cursor(src, start, le);
  let n = 0;
  while (c.left >= 4 + 33 + 3) {
    const len = c.u32();
    const name = dec(c.bytes(33));
    c.skip(3);
    if (len > c.left) { ds.warnings.push(`Value label set "${name}" is cut at the end of the file.`); return; }
    const t = c.bytes(len);
    ds.labelSets[name] = parseTable(t, le, dec, name, ds);
    if (++n > 1e6) return;
  }
}

/** A value label table: n, txtlen, off[n], val[n], txt. */
function parseTable(t, le, dec, name, ds) {
  const out = [];
  if (t.length < 8) { ds.warnings.push(`Value label set "${name}" is damaged.`); return out; }
  const dv = new DataView(t.buffer, t.byteOffset, t.length);
  const n = dv.getInt32(0, le), txtlen = dv.getInt32(4, le);
  if (n < 0 || txtlen < 0 || 8 + 8 * n + txtlen > t.length) { ds.warnings.push(`Value label set "${name}" is damaged (its counts do not fit).`); return out; }
  const txt = t.subarray(8 + 8 * n, 8 + 8 * n + txtlen);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const off = dv.getInt32(8 + 4 * i, le), val = dv.getInt32(8 + 4 * n + 4 * i, le);
    if (off < 0 || off >= txtlen) { bad++; continue; }
    let e = txt.indexOf(0, off); if (e < 0) e = txtlen;
    out.push([val, dec(txt.subarray(off, e), { nul: false, trim: false })]);
  }
  if (bad) ds.warnings.push(`Value label set "${name}": ${bad} label${bad === 1 ? '' : 's'} pointed outside the label text and were skipped.`);
  return out;
}

/**
 * Reads the data rows. cols[i] = variable; strl: null or a function (bytes) => string key for strL columns.
 * Returns the row width in bytes.
 */
function readRows(src, ds, cols, dataStart, N, le, dec, limits, strl) {
  const K = cols.length;
  const offs = []; let rw = 0;
  const readers = cols.map((v) => {
    offs.push(rw);
    const w = v.storage === 'strL' ? 8 : v.width;
    rw += w;
    if (v.storage === 'strL') return { s: 'L' };
    if (v.type === 'string') return { s: 'S', w };
    return { s: 'N', f: numReader(v.storage, le) };
  });
  const store = new Store(cols);
  ds.store = store;
  if (K === 0 || rw === 0 || N <= 0) { if (N > 0 && K === 0) ds.warnings.push('The file has rows but no variables.'); store.finish(); return rw; }
  const avail = Math.max(0, src.size - dataStart);
  const fit = Math.floor(avail / rw);
  let rows = N;
  if (fit < N) { rows = fit; ds.warnings.push(`The file ends early: ${N.toLocaleString('en-US')} rows stated, ${fit.toLocaleString('en-US')} complete rows read.`); ds.truncated = true; }
  const guard = rowGuard(limits, K);
  const chunkRows = Math.max(1, Math.floor((1 << 20) / rw));
  let r = 0;
  outer: while (r < rows) {
    const nr = Math.min(chunkRows, rows - r);
    const b = src.read(dataStart + r * rw, nr * rw);
    const dv = new DataView(b.buffer, b.byteOffset, b.length);
    for (let k = 0; k < nr; k++) {
      if (!guard.ok(store)) { ds.truncated = true; ds.warnings.push(guard.why()); break outer; }
      const row = store.addRow();
      const base = k * rw;
      for (let i = 0; i < K; i++) {
        const R = readers[i], o = base + offs[i];
        if (R.s === 'N') {
          const [v, m] = R.f(dv, o);
          if (m >= 0) store.setMiss(i, row, m); else store.setNum(i, row, v);
        } else if (R.s === 'S') {
          store.setStr(i, row, dec(b.subarray(o, o + R.w), { nul: true, trim: false }));
        } else {
          store.setStr(i, row, strl(b.subarray(o, o + 8)));
        }
      }
    }
    r += nr;
  }
  return rw;
}

function done(ds) {
  if (ds.store) ds.store.finish();
  // keep only label sets that exist; variables keep the name
  return ds;
}

/**
 * Releases 118 and 119 store UTF-8, but files converted from older releases sometimes keep Latin-1 text. Text that
 * is not valid UTF-8 is read as windows-1252 (one note in warnings), as Stata's own unicode translate would.
 */
function utf8WithFallback(ds) {
  const loose = makeDecoder('utf-8');
  const latin = makeDecoder('windows-1252');
  let strict;
  try { strict = new TextDecoder('utf-8', { fatal: true }); } catch { strict = null; }
  let noted = false;
  const fn = (bytes, opts) => {
    const s = loose(bytes, opts);
    if (!strict || s.indexOf('\ufffd') < 0) return s;
    try { strict.decode(bytes); return s; } catch { /* not UTF-8 */ }
    if (!noted) { noted = true; ds.warnings.push('Some text in this file is not UTF-8; it was read as windows-1252 (Latin-1).'); }
    return latin(bytes, opts);
  };
  fn.encoding = 'utf-8';
  return fn;
}

// ---------------------------------------------------------------- releases 117-119
function readNew(src, limits) {
  const c = new Cursor(src, 0, true);
  expectTag(c, '<stata_dta><header><release>');
  const relTxt = ascii(c.bytes(3));
  const rel = Number(relTxt);
  if (!NEW.has(rel)) throw new DataError(`This Stata file has release "${relTxt}"; releases 113 to 119 can be read.`, 'UNSUPPORTED');
  expectTag(c, '</release><byteorder>');
  const bo = ascii(c.bytes(3));
  if (bo !== 'LSF' && bo !== 'MSF') throw new DataError('This Stata file has an unknown byte order.');
  c.le = bo === 'LSF';
  const ds = newDataset('dta', `Stata .dta release ${rel} (${VERSIONS[rel]})`);
  const dec = rel >= 118 ? utf8WithFallback(ds) : makeDecoder('windows-1252');
  expectTag(c, '</byteorder><K>');
  const K = rel === 119 ? c.u32() : c.u16();
  expectTag(c, '</K><N>');
  const N = rel === 117 ? c.u32() : c.u64();
  expectTag(c, '</N><label>');
  const labLen = rel === 117 ? c.u8() : c.u16();
  const fileLabel = dec(c.bytes(labLen));
  expectTag(c, '</label><timestamp>');
  const tsLen = c.u8();
  const ts = dec(c.bytes(tsLen));
  expectTag(c, '</timestamp></header><map>');
  c.skip(14 * 8);
  expectTag(c, '</map>');
  const L = { ...(limits || {}) };
  if (K > (L.maxVars || 100000)) throw new DataError(`This Stata file has ${K.toLocaleString('en-US')} variables; up to ${(L.maxVars || 100000).toLocaleString('en-US')} can be shown.`, 'TOO_BIG');
  const nameLen = rel === 117 ? 33 : 129, fmtLen = rel === 117 ? 49 : 57, vlLen = rel === 117 ? 81 : 321;
  if (K * (2 + nameLen + 2 + fmtLen + nameLen + vlLen) > c.left) throw new DataError(`This Stata file says it has ${K.toLocaleString('en-US')} variables, but it ends before their descriptions.`, 'TRUNC');
  expectTag(c, '<variable_types>');
  const types = []; for (let i = 0; i < K; i++) types.push(c.u16());
  expectTag(c, '</variable_types><varnames>');
  const names = []; for (let i = 0; i < K; i++) names.push(dec(c.bytes(nameLen)));
  expectTag(c, '</varnames><sortlist>');
  const sortAt = c.pos;
  c.skip(2 * (K + 1));
  if (!peekIs(c, '</sortlist>')) { c.pos = sortAt; c.skip(4 * (K + 1)); }
  expectTag(c, '</sortlist><formats>');
  const fmts = []; for (let i = 0; i < K; i++) fmts.push(dec(c.bytes(fmtLen)));
  expectTag(c, '</formats><value_label_names>');
  const lbls = []; for (let i = 0; i < K; i++) lbls.push(dec(c.bytes(nameLen)));
  expectTag(c, '</value_label_names><variable_labels>');
  const vlabels = []; for (let i = 0; i < K; i++) vlabels.push(dec(c.bytes(vlLen)));
  expectTag(c, '</variable_labels><characteristics>');
  for (let guard = 0; peekIs(c, '<ch>'); guard++) {
    c.skip(4);
    const len = c.u32();
    if (len > c.left) throw new Trunc(c.pos, len, src.size);
    c.skip(len);
    expectTag(c, '</ch>');
    if (guard > 1e6) throw new DataError('Too many characteristics.');
  }
  expectTag(c, '</characteristics><data>');
  const cols = [];
  let hasStrl = false;
  for (let i = 0; i < K; i++) {
    const t = types[i];
    let v;
    if (NEW_TYPES[t]) v = { name: names[i], label: vlabels[i], type: 'numeric', width: NEW_TYPES[t][1], storage: NEW_TYPES[t][0], format: fmts[i], labels: lbls[i] || null };
    else if (t >= 1 && t <= 2045) v = { name: names[i], label: vlabels[i], type: 'string', width: t, storage: `str${t}`, format: fmts[i], labels: null };
    else if (t === STRL) { v = { name: names[i], label: vlabels[i], type: 'string', width: 8, storage: 'strL', format: fmts[i], labels: null }; hasStrl = true; }
    else throw new DataError(`Variable ${i + 1} has an unknown Stata storage type (${t}).`);
    finishVar(v, ds);
    cols.push(v);
  }
  Object.assign(ds.info, { rows: N, fileLabel, created: ts, release: String(rel), byteOrder: c.le ? 'little-endian (LSF)' : 'big-endian (MSF)', encoding: rel >= 118 ? 'UTF-8' : 'windows-1252', product: 'Stata' });
  const dataStart = c.pos;
  const le = c.le;
  const vlen = rel === 117 ? 4 : rel === 118 ? 2 : 3;
  // strL cells first hold a key "v:o"; they are replaced after the strls section is read.
  const keyOf = (b) => {
    let v = 0, o = 0;
    if (le) { for (let i = vlen - 1; i >= 0; i--) v = v * 256 + b[i]; for (let i = 7; i >= vlen; i--) o = o * 256 + b[i]; }
    else { for (let i = 0; i < vlen; i++) v = v * 256 + b[i]; for (let i = vlen; i < 8; i++) o = o * 256 + b[i]; }
    return v === 0 && o === 0 ? '' : `\u0000${v}:${o}`;
  };
  const rw = readRows(src, ds, cols, dataStart, N, le, dec, limits, keyOf);
  const afterData = dataStart + N * rw;
  let tail = null;
  if (afterData + 7 > src.size) {
    ds.warnings.push(hasStrl ? 'Long strings (strL) and value labels could not be read: the file ends before them.' : 'Value labels could not be read: the file ends before them.');
  } else {
    tail = new Cursor(src, afterData, le);
    try {
      expectTag(tail, '</data><strls>');
    } catch (e) { ds.warnings.push(`Long strings (strL) and value labels could not be read: ${e.message}`); tail = null; }
  }
  const gso = new Map();
  if (tail) {
    try {
      readGso(tail, rel, dec, gso, ds, limits);
      expectTag(tail, '</strls><value_labels>');
      let n = 0;
      while (peekIs(tail, '<lbl>')) {
        tail.skip(5);
        const len = tail.u32();
        const name = dec(tail.bytes(nameLen));
        tail.skip(3);
        if (len > tail.left) { ds.warnings.push(`Value label set "${name}" is cut at the end of the file.`); break; }
        ds.labelSets[name] = parseTable(tail.bytes(len), le, dec, name, ds);
        expectTag(tail, '</lbl>');
        if (++n > 1e6) break;
      }
    } catch (e) { ds.warnings.push(`Part of the end of the file could not be read: ${e.message}`); }
  }
  if (hasStrl) resolveStrl(ds, cols, gso);
  return done(ds);
}

function readGso(c, rel, dec, gso, ds, limits) {
  const maxChars = (limits && limits.maxStringChars) || 200e6;
  let chars = 0;
  for (let n = 0; c.left >= 3 && ascii(c.src.read(c.pos, 3)) === 'GSO'; n++) {
    c.skip(3);
    const v = c.u32();
    const o = rel === 117 ? c.u32() : c.u64();
    const t = c.u8();
    const len = c.u32();
    if (len > c.left) throw new Trunc(c.pos, len, c.src.size);
    const b = c.bytes(len);
    chars += len;
    if (chars > maxChars) { ds.warnings.push('Some long strings (strL) were not read: their total size is over the text limit.'); c.skip(0); continue; }
    let s;
    if (t === 130) s = dec(len && b[len - 1] === 0 ? b.subarray(0, len - 1) : b, { nul: false, trim: false });
    else {
      s = b.indexOf(0) >= 0 ? `[binary data, ${len.toLocaleString('en-US')} bytes]` : dec(b, { nul: false, trim: false });
    }
    gso.set(`\u0000${v}:${o}`, s);
    if (n > 1e8) break;
  }
}

function resolveStrl(ds, cols, gso) {
  const st = ds.store;
  let missingRefs = 0;
  for (let i = 0; i < cols.length; i++) {
    if (cols[i].storage !== 'strL') continue;
    const col = st.cols[i];
    for (let r = 0; r < st.n; r++) {
      const k = col[r];
      if (!k) continue;
      const s = gso.get(k);
      if (s === undefined) { missingRefs++; col[r] = ''; } else { col[r] = s; st.chars += s.length; }
    }
  }
  if (missingRefs) ds.warnings.push(`${missingRefs.toLocaleString('en-US')} long string (strL) value${missingRefs === 1 ? '' : 's'} point to text that is not in the file and are shown empty.`);
}

module.exports = { read, sniff };
