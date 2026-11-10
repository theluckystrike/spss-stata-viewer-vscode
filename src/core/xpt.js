'use strict';
// SAS transport (XPORT) reader, version 5 (the FDA submission format) and version 8 (LIBV8: long names and labels).
// 80-byte header records, big-endian NAMESTR records, IBM 360 floating point numbers. A file can hold several
// datasets (members): the first one is read and the others are named in info.notes.
const { Cursor, DataError } = require('./source');
const { makeDecoder } = require('./text');
const { sasFormat } = require('./dates');
const { Store, rowGuard, newDataset } = require('./dataset');

const ascii = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const LIB5 = 'HEADER RECORD*******LIBRARY HEADER RECORD!!!!!!!';
const LIB8 = 'HEADER RECORD*******LIBV8   HEADER RECORD!!!!!!!';
const MEMBER5 = 'HEADER RECORD*******MEMBER  HEADER RECORD!!!!!!!';
const MEMBER8 = 'HEADER RECORD*******MEMBV8  HEADER RECORD!!!!!!!';

function sniff(b) {
  if (!b || b.length < 48) return false;
  const h = ascii(b.subarray(0, 48));
  return h === LIB5 || h === LIB8;
}

/** IBM 360 hexadecimal float (2 to 8 bytes, big-endian) -> [value, missCode] (missCode -1 for a real value). */
function ibm(b, o, len) {
  const b0 = b[o];
  let zero = true;
  for (let i = 1; i < len; i++) if (b[o + i] !== 0) { zero = false; break; }
  if (zero) {
    if (b0 === 0x2e) return [NaN, 0];
    if (b0 === 0x5f) return [NaN, 27];
    if (b0 >= 0x41 && b0 <= 0x5a) return [NaN, b0 - 0x40];
    if ((b0 & 0x7f) === 0) return [0, -1];
  }
  const g = (i) => (i < len ? b[o + i] : 0);
  const hi = (g(1) << 16) | (g(2) << 8) | g(3);
  const lo = ((g(4) << 24) >>> 0) + (g(5) << 16) + (g(6) << 8) + g(7);
  const mant = hi * 4294967296 + lo; // 56 bits
  const exp = (b0 & 0x7f) - 64;
  let v = mant * Math.pow(2, 4 * exp - 56);
  if (b0 & 0x80) v = -v;
  return [v, -1];
}

/** Offsets (80-aligned) of every member header, found by searching the file in chunks. */
function findMembers(src, tag) {
  const out = [];
  const CH = 1 << 20;
  const t = Buffer.from(tag, 'latin1');
  for (let off = 0; off < src.size; off += CH - t.length) {
    const b = Buffer.from(src.readUpTo(off, CH));
    let i = b.indexOf(t);
    while (i >= 0) {
      const p = off + i;
      if (p % 80 === 0 && (out.length === 0 || out[out.length - 1] !== p)) out.push(p);
      i = b.indexOf(t, i + 1);
    }
    if (b.length < CH) break;
    if (out.length > 100000) break;
  }
  return out;
}

function read(src, limits) {
  if (src.size < 80 * 3) throw new DataError('This is not a SAS transport (XPORT) file (it is too short).', 'NOT_DATA');
  const first = ascii(src.read(0, 48));
  const v8 = first === LIB8;
  if (first !== LIB5 && !v8) throw new DataError('This is not a SAS transport (XPORT) file (the first record does not match).', 'NOT_DATA');
  const dec = makeDecoder('windows-1252');
  const lib2 = src.read(80, 80);
  const product = `${dec(lib2.subarray(0, 8))} ${dec(lib2.subarray(24, 32))} ${dec(lib2.subarray(32, 40))}`.replace(/\s+/g, ' ').trim();
  const members = findMembers(src, v8 ? MEMBER8 : MEMBER5);
  if (!members.length) throw new DataError('This SAS transport file has no dataset (no member header).', 'BAD_FILE');
  const ds = newDataset('xpt', v8 ? 'SAS transport (XPORT) version 8' : 'SAS transport (XPORT) version 5');
  const memberNames = members.map((m) => { try { return dec(src.read(m + 160 + 8, v8 ? 32 : 8)); } catch { return '?'; } });
  let end = members[1] !== undefined ? members[1] : src.size;
  if (members.length === 1) {
    // a file cut inside the header of a next member: that partial header is not data
    let last = Math.floor(src.size / 80) * 80;
    if (last === src.size) last -= 80;
    if (last > members[0]) {
      const tail = ascii(src.read(last, src.size - last));
      const tag = v8 ? MEMBER8 : MEMBER5;
      if (tail.length && (tag.startsWith(tail) || tail.startsWith(tag))) end = last;
    }
    if (src.size % 80) ds.warnings.push('The file ends early (its size is not a multiple of 80 bytes); the last row may be missing.');
  }
  readMember(src, ds, members[0], end, v8, dec, limits);
  ds.info.product = product;
  ds.info.byteOrder = 'big-endian, IBM floating point';
  ds.info.encoding = dec.encoding;
  ds.info.member = memberNames[0];
  if (members.length > 1) ds.info.notes.push(`This file has ${members.length} datasets (${memberNames.join(', ')}); showing ${memberNames[0]}.`);
  return ds;
}

/**
 * NAMESTR positions (npos) are the layout the spec defines. Some writers store the rows in variable order while their
 * npos values say otherwise. When npos differs from the variable-order layout, the text columns of the first rows
 * decide: the layout whose text columns hold clearly more printable text is used, and a note says so.
 */
function chooseLayout(src, vars, dataStart, dataLen, obsLen, ds) {
  let seq = 0;
  const seqPos = vars.map((v) => { const p = seq; seq += v.width; return p; });
  if (vars.every((v, i) => v.pos === seqPos[i]) || seq !== obsLen || !vars.some((v) => v.type === 'string')) return;
  const rows = Math.min(50, Math.floor(dataLen / obsLen));
  if (!rows) return;
  const b = src.read(dataStart, rows * obsLen);
  const score = (pos) => {
    let good = 0, all = 0;
    for (let r = 0; r < rows; r++) vars.forEach((v, i) => {
      if (v.type !== 'string') return;
      for (let k = 0; k < v.width; k++) { const x = b[r * obsLen + pos[i] + k]; all++; if ((x >= 0x20 && x < 0x7f) || x >= 0xa0) good++; }
    });
    return all ? good / all : 0;
  };
  const sNpos = score(vars.map((v) => v.pos)), sSeq = score(seqPos);
  if (sSeq > sNpos + 0.2) {
    vars.forEach((v, i) => { v.pos = seqPos[i]; });
    ds.info.notes.push('The variable positions in this file do not match its rows; the rows were read in variable order.');
  }
}

function readMember(src, ds, at, end, v8, dec, limits) {
  const c = new Cursor(src, at, false);
  const mh = ascii(c.bytes(80));
  const nsLen = Number(mh.slice(74, 78)) || 140;
  if (nsLen !== 140 && nsLen !== 136) throw new DataError(`This SAS transport file has an unknown NAMESTR length (${nsLen}).`);
  c.skip(80); // DSCRPTR header
  const m1 = c.bytes(80);
  const m2 = c.bytes(80);
  const name = dec(m1.subarray(8, v8 ? 40 : 16));
  const created = dec(m1.subarray(64, 80));
  const label = dec(m2.subarray(32, 72));
  const nh = ascii(c.bytes(80));
  if (!/NAMSTV8|NAMESTR/.test(nh)) throw new DataError('This SAS transport file is damaged: the NAMESTR header is missing.');
  const K = Number(nh.slice(54, 58));
  if (!Number.isFinite(K) || K < 0) throw new DataError('This SAS transport file is damaged: the variable count is not a number.');
  const nsBytes = K * nsLen;
  if (nsBytes > end - c.pos) throw new DataError(`This SAS transport file says it has ${K} variables, but it ends before their descriptions.`, 'TRUNC');
  const ns = c.bytes(nsBytes);
  c.pos = at + 80 * 5 + Math.ceil(nsBytes / 80) * 80;
  const dv = new DataView(ns.buffer, ns.byteOffset, ns.length);
  const vars = [];
  let obsLen = 0;
  for (let i = 0; i < K; i++) {
    const o = i * nsLen;
    const ntype = dv.getInt16(o, false), nlng = dv.getInt16(o + 4, false);
    const nname = dec(ns.subarray(o + 8, o + 16)), nlabel = dec(ns.subarray(o + 16, o + 56)), nform = dec(ns.subarray(o + 56, o + 64));
    const nfl = dv.getInt16(o + 64, false), nfd = dv.getInt16(o + 66, false);
    const npos = dv.getInt32(o + 84, false);
    const longName = v8 && nsLen === 140 ? dec(ns.subarray(o + 88, o + 120)) : '';
    const num = ntype === 1;
    if (ntype !== 1 && ntype !== 2) throw new DataError(`Variable ${i + 1} has an unknown type (${ntype}).`);
    if (nlng < 1 || (num && (nlng < 2 || nlng > 8)) || npos < 0) throw new DataError(`Variable ${nname || i + 1} has an impossible length or position.`);
    obsLen = Math.max(obsLen, npos + nlng);
    const format = nform ? `${nform}${nfl > 0 ? nfl : ''}.${nfd > 0 ? nfd : ''}` : '';
    vars.push({ name: longName || nname, label: nlabel, type: num ? 'numeric' : 'string', width: nlng, storage: num ? `num${nlng}` : `char${nlng}`,
      format, date: num ? sasFormat(nform) : null, measure: '', missing: null, labels: null, pos: npos });
  }
  // v8: long labels (LABELV8 / LABELV9 records) between NAMESTR and OBS
  let hdr = ascii(c.bytes(80));
  if (v8 && /LABELV[89]/.test(hdr)) {
    const isV9 = hdr.includes('LABELV9');
    const n = Number(hdr.slice(48, 80).trim()) || 0;
    let bytes = 0;
    for (let i = 0; i < n && i < K; i++) {
      const h = c.bytes(isV9 ? 10 : 6); const hv = new DataView(h.buffer, h.byteOffset, h.length);
      const idx = hv.getInt16(0, false) - 1, nl = hv.getInt16(2, false), ll = hv.getInt16(4, false);
      const fl = isV9 ? hv.getInt16(6, false) + hv.getInt16(8, false) : 0;
      const nm = dec(c.bytes(nl)), lb = dec(c.bytes(ll)); c.skip(fl);
      bytes += (isV9 ? 10 : 6) + nl + ll + fl;
      if (vars[idx]) { if (nm) vars[idx].name = nm; if (lb) vars[idx].label = lb; }
    }
    c.skip((80 - (bytes % 80)) % 80);
    hdr = ascii(c.bytes(80));
  }
  if (!/OBS     HEADER|OBSV8   HEADER/.test(hdr)) throw new DataError('This SAS transport file is damaged: the OBS header is missing.');
  const dataStart = c.pos;
  const dataLen = Math.max(0, end - dataStart);
  chooseLayout(src, vars, dataStart, dataLen, obsLen, ds);
  let n = obsLen > 0 ? Math.floor(dataLen / obsLen) : 0;
  // the last 80-byte record is padded with spaces: drop "rows" made only of that padding
  while (n > 0 && dataStart + (n - 1) * obsLen >= end - 80) {
    const b = src.read(dataStart + (n - 1) * obsLen, obsLen);
    if (b.every((x) => x === 0x20)) n--; else break;
  }
  for (const v of vars) ds.variables.push(v);
  Object.assign(ds.info, { rows: n, fileLabel: label, created, release: v8 ? 'XPORT version 8' : 'XPORT version 5', member: name });
  const store = new Store(vars);
  ds.store = store;
  const guard = rowGuard(limits, Math.max(1, K));
  const chunkRows = obsLen > 0 ? Math.max(1, Math.floor((1 << 20) / obsLen)) : 1;
  let r = 0;
  outer: while (r < n) {
    const nr = Math.min(chunkRows, n - r);
    const b = src.read(dataStart + r * obsLen, nr * obsLen);
    for (let k = 0; k < nr; k++) {
      if (!guard.ok(store)) { ds.truncated = true; ds.warnings.push(guard.why()); break outer; }
      const row = store.addRow();
      const base = k * obsLen;
      for (let i = 0; i < K; i++) {
        const v = vars[i], o = base + v.pos;
        if (v.type === 'numeric') {
          const [x, m] = ibm(b, o, v.width);
          if (m >= 0) store.setMiss(i, row, m); else store.setNum(i, row, x);
        } else store.setStr(i, row, dec(b.subarray(o, o + v.width), { nul: false, trim: true }));
      }
    }
    r += nr;
  }
  for (const v of vars) delete v.pos;
  store.finish();
}

module.exports = { read, sniff, ibm };
