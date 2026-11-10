'use strict';
// SPSS system files: .sav (uncompressed or bytecode compressed) and .zsav (zlib blocks of bytecode data).
// Layout from the PSPP "System File Format" documentation. Every count is checked against the bytes left before
// anything is allocated; a cut data section keeps the complete rows read so far and says so in a warning.
const zlib = require('zlib');
const { Cursor, DataError, Trunc } = require('./source');
const { makeDecoder, CODEPAGES } = require('./text');
const { spssFormat } = require('./dates');
const { Store, rowGuard, newDataset } = require('./dataset');

const FMT_NAMES = {
  1: 'A', 2: 'AHEX', 3: 'COMMA', 4: 'DOLLAR', 5: 'F', 6: 'IB', 7: 'PIBHEX', 8: 'P', 9: 'PIB', 10: 'PK', 11: 'RB',
  12: 'RBHEX', 15: 'Z', 16: 'N', 17: 'E', 20: 'DATE', 21: 'TIME', 22: 'DATETIME', 23: 'ADATE', 24: 'JDATE',
  25: 'DTIME', 26: 'WKDAY', 27: 'MONTH', 28: 'MOYR', 29: 'QYR', 30: 'WKYR', 31: 'PCT', 32: 'DOT', 33: 'CCA',
  34: 'CCB', 35: 'CCC', 36: 'CCD', 37: 'CCE', 38: 'EDATE', 39: 'SDATE', 40: 'MTIME', 41: 'YMDHMS',
};
const MEASURES = { 1: 'nominal', 2: 'ordinal', 3: 'scale' };
const ALIGN = { 0: 'left', 1: 'right', 2: 'center' };
const MAX_BLOCK = 64 * 1024 * 1024; // largest zsav block we inflate
const SYSMIS_DEFAULT = -Number.MAX_VALUE;
const HIGHEST_DEFAULT = Number.MAX_VALUE;
const LOWEST_DEFAULT = -1.7976931348623155e308; // nextafter(-DBL_MAX, 0)

function sniff(b) {
  return !!b && b.length >= 4 && b[0] === 0x24 && b[1] === 0x46 && b[2] === 0x4c && (b[3] === 0x32 || b[3] === 0x33);
}

/** Bytes without a cut UTF-8 sequence at the end (after trailing spaces and NUL padding). */
function cutPartial(b) {
  let end = b.length;
  while (end > 0 && (b[end - 1] === 0x20 || b[end - 1] === 0)) end--;
  if (end === 0 || b[end - 1] < 0x80) return b;
  let i = end - 1, k = 0;
  while (i > 0 && k < 3 && (b[i] & 0xc0) === 0x80) { i--; k++; }
  const lead = b[i];
  const len = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return end - i < len ? b.subarray(0, i) : b;
}

const ascii = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
function fmtText(code) {
  const type = (code >>> 16) & 0xff, w = (code >>> 8) & 0xff, d = code & 0xff;
  const n = FMT_NAMES[type] || `T${type}`;
  return { type, w, d, text: `${n}${w}${d ? `.${d}` : ''}` };
}

/** Read the dictionary. Returns everything raw (bytes), decoded later once the encoding is known. */
function readDictionary(c, size, maxVars) {
  const recs = []; // variable records (type 2), continuations folded in
  const labelRecs = []; // { labels: [[raw8, rawLabel]], vars: [dictIndex] }
  const docs = [];
  const ext = {};
  let units = 0;
  let sawEnd = false;
  for (;;) {
    const rt = c.i32();
    if (rt === 2) {
      const type = c.i32(), hasLabel = c.i32(), nMiss = c.i32(), print = c.i32(), write = c.i32();
      const name = c.bytes(8);
      let label = null;
      if (hasLabel === 1) {
        const len = c.i32();
        if (len < 0 || len > c.left) throw new DataError(`A variable label length (${len}) is larger than the rest of the file.`);
        label = c.bytes(len);
        c.skip(((len + 3) & ~3) - len);
      } else if (hasLabel !== 0) throw new DataError(`Variable record ${recs.length + 1} has a bad label flag (${hasLabel}).`);
      if (![0, 1, 2, 3, -2, -3].includes(nMiss)) throw new DataError(`Variable record ${recs.length + 1} has a bad missing value count (${nMiss}).`);
      const miss = [];
      for (let i = 0; i < Math.abs(nMiss); i++) miss.push(c.bytes(8));
      units++;
      if (type === -1) {
        if (!recs.length) throw new DataError('The dictionary starts with a continuation record.');
        recs[recs.length - 1].units++;
        continue;
      }
      if (type < 0 || type > 255) throw new DataError(`Variable record ${recs.length + 1} has a bad type (${type}).`);
      if (recs.length >= maxVars * 4 + 1000) throw new DataError(`The file has more than ${maxVars.toLocaleString('en-US')} variables, the most this viewer reads.`);
      recs.push({ type, name, label, nMiss, miss, print, write, units: 1, dictIndex: units });
    } else if (rt === 3) {
      const n = c.i32();
      if (n < 0 || n * 16 > c.left) throw new DataError(`A value label record says ${n} labels, more than the rest of the file holds.`);
      const labels = [];
      for (let i = 0; i < n; i++) {
        const v = c.bytes(8);
        const len = c.u8();
        const lab = c.bytes(len);
        c.skip(((len + 8) & ~7) - 1 - len);
        labels.push([v, lab]);
      }
      const rt4 = c.i32();
      if (rt4 !== 4) throw new DataError('A value label record is not followed by its variable list (record type 4).');
      const nv = c.i32();
      if (nv < 0 || nv * 4 > c.left) throw new DataError(`A value label variable list says ${nv} variables, more than the rest of the file holds.`);
      const vars = [];
      for (let i = 0; i < nv; i++) vars.push(c.i32());
      labelRecs.push({ labels, vars });
    } else if (rt === 4) {
      throw new DataError('A value label variable list (record type 4) has no value labels before it.');
    } else if (rt === 6) {
      const n = c.i32();
      if (n < 0 || n * 80 > c.left) throw new DataError(`A document record says ${n} lines, more than the rest of the file holds.`);
      for (let i = 0; i < n; i++) docs.push(c.bytes(80));
    } else if (rt === 7) {
      const sub = c.i32(), sz = c.i32(), cnt = c.i32();
      if (sz < 0 || cnt < 0 || sz * cnt > c.left) throw new DataError(`An extension record (subtype ${sub}) says ${sz} x ${cnt} bytes, more than the rest of the file holds.`);
      const data = c.bytes(sz * cnt);
      if (!ext[sub]) ext[sub] = [];
      ext[sub].push({ size: sz, count: cnt, data });
    } else if (rt === 999) {
      c.i32();
      sawEnd = true;
      break;
    } else {
      throw new DataError(`Unknown record type ${rt} at offset ${c.pos - 4} in the dictionary.`);
    }
  }
  if (!sawEnd) throw new DataError('The dictionary has no end record.');
  return { recs, labelRecs, docs, ext, units, size };
}

/** Split "KEY=VALUE" entries separated by TAB or NUL bytes, as byte arrays. */
function bytePairs(data) {
  const out = [];
  let s = 0;
  for (let i = 0; i <= data.length; i++) {
    if (i < data.length && data[i] !== 0x09 && data[i] !== 0x00) continue;
    if (i > s) {
      const part = data.subarray(s, i);
      const eq = part.indexOf(0x3d);
      if (eq > 0) out.push([part.subarray(0, eq), part.subarray(eq + 1)]);
    }
    s = i + 1;
  }
  return out;
}

/** A bounded reader over the bytes of an extension record. */
function subCursor(data, le) {
  let p = 0;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    get left() { return data.length - p; },
    i32() { if (p + 4 > data.length) throw new DataError('An extension record ends early.'); const v = dv.getInt32(p, le); p += 4; return v; },
    u8() { if (p + 1 > data.length) throw new DataError('An extension record ends early.'); return data[p++]; },
    bytes(n) { if (n < 0 || p + n > data.length) throw new DataError('An extension record ends early.'); const b = data.subarray(p, p + n); p += n; return b; },
  };
}

/** Byte stream for the data section: plain file bytes, or inflated zsav blocks. take(n) gives n bytes or null. */
function fileStream(src, start) {
  let pos = start;
  let chunk = new Uint8Array(0), p = 0;
  const CH = 1 << 20;
  return {
    need(n) {
      if (chunk.length - p >= n) return true;
      const rest = chunk.subarray(p);
      const more = src.readUpTo(pos, Math.max(CH, n));
      pos += more.length;
      const c2 = new Uint8Array(rest.length + more.length);
      c2.set(rest); c2.set(more, rest.length);
      chunk = c2; p = 0;
      return chunk.length >= n;
    },
    get chunk() { return chunk; }, get p() { return p; }, adv(n) { p += n; },
    get exhausted() { return p >= chunk.length && pos >= src.size; },
    warning: '',
  };
}

function zStream(src, c, le, warnings) {
  const zc = new Cursor(src, c.pos, le);
  const zheaderOfs = zc.i64(), ztrailerOfs = zc.i64(), ztrailerLen = zc.i64();
  if (zheaderOfs !== c.pos) warnings.push('The zlib header offset does not match its position; reading on.');
  if (ztrailerOfs < zc.pos || ztrailerOfs > src.size || ztrailerLen < 24 || ztrailerOfs + ztrailerLen > src.size) throw new DataError('The zlib trailer of this .zsav file points outside the file.');
  const tc = new Cursor(src, ztrailerOfs, le);
  tc.i64(); tc.i64();
  const blockSize = tc.i32();
  const nBlocks = tc.i32();
  if (nBlocks < 0 || 24 + nBlocks * 24 > ztrailerLen) throw new DataError(`The zlib trailer says ${nBlocks} blocks, more than it holds.`);
  const blocks = [];
  for (let i = 0; i < nBlocks; i++) blocks.push({ uofs: tc.i64(), cofs: tc.i64(), usize: tc.i32(), csize: tc.i32() });
  let bi = 0;
  let chunk = new Uint8Array(0), p = 0, done = false;
  const st = {
    warning: '',
    need(n) {
      while (chunk.length - p < n && !done) {
        if (bi >= blocks.length) { done = true; break; }
        const b = blocks[bi++];
        if (b.usize < 0 || b.csize < 0 || b.cofs < 0 || b.cofs + b.csize > src.size) { st.warning = `zlib block ${bi} points outside the file; the rows before it are shown.`; done = true; break; }
        if (b.usize > MAX_BLOCK) { st.warning = `zlib block ${bi} says ${b.usize} bytes, more than the ${MAX_BLOCK / 1048576} MB this viewer inflates; the rows before it are shown.`; done = true; break; }
        let out;
        try {
          out = zlib.inflateSync(src.read(b.cofs, b.csize), { maxOutputLength: Math.max(1, b.usize) });
        } catch (e) {
          st.warning = `zlib block ${bi} could not be inflated (${e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError ? 'it inflates to more than its stated size' : 'damaged data'}); the rows before it are shown.`;
          done = true; break;
        }
        if (out.length !== b.usize) { st.warning = `zlib block ${bi} inflates to ${out.length} bytes, not the ${b.usize} its trailer states; the rows before it are shown.`; done = true; break; }
        const rest = chunk.subarray(p);
        const c2 = new Uint8Array(rest.length + out.length);
        c2.set(rest); c2.set(out, rest.length);
        chunk = c2; p = 0;
      }
      return chunk.length - p >= n;
    },
    get chunk() { return chunk; }, get p() { return p; }, adv(n) { p += n; },
    get exhausted() { return p >= chunk.length && (done || bi >= blocks.length); },
  };
  st.blockSize = blockSize;
  return st;
}

function read(src, limits) {
  const head = src.readUpTo(0, 176);
  if (!sniff(head)) throw new DataError('This is not an SPSS system file (.sav): it does not start with $FL2 or $FL3.', 'NOT_DATA');
  if (head.length < 176) throw new DataError('The file ends inside the 176-byte SPSS header.', 'TRUNC');
  const hv = new DataView(head.buffer, head.byteOffset, 176);
  let le;
  const lcL = hv.getInt32(64, true), lcB = hv.getInt32(64, false);
  if (lcL === 2 || lcL === 3) le = true;
  else if (lcB === 2 || lcB === 3) le = false;
  else throw new DataError(`The header has an unknown layout code (${lcL}).`);
  const zsav = head[3] === 0x33;
  const ds = newDataset(zsav ? 'zsav' : 'sav', '');
  const c = new Cursor(src, 4, le);
  const prod = c.bytes(60);
  c.i32(); // layout code
  const nominal = c.i32();
  const compression = c.i32();
  const weightIndex = c.i32();
  const ncases = c.i32();
  const bias = c.f64();
  const cdate = ascii(c.bytes(9)), ctime = ascii(c.bytes(8));
  const flabel = c.bytes(64);
  c.skip(3);
  if (![0, 1, 2].includes(compression)) throw new DataError(`Unknown compression code ${compression} in the header.`);
  if (compression === 2 && !zsav) ds.warnings.push('The header says zlib compression but the file starts with $FL2.');

  const guard = rowGuard(limits, 1);
  const maxVars = guard.limits.maxVars;
  let dict;
  try { dict = readDictionary(c, src.size, maxVars); } catch (e) {
    if (e instanceof Trunc) throw new DataError('The file ends inside the variable dictionary: it is cut or damaged.', 'TRUNC');
    throw e;
  }

  // extension records
  const ext = dict.ext;
  let sysmis = SYSMIS_DEFAULT, highest = HIGHEST_DEFAULT, lowest = LOWEST_DEFAULT;
  if (ext[4] && ext[4][0].size === 8 && ext[4][0].count >= 3) {
    const dv = new DataView(ext[4][0].data.buffer, ext[4][0].data.byteOffset, 24);
    sysmis = dv.getFloat64(0, le); highest = dv.getFloat64(8, le); lowest = dv.getFloat64(16, le);
  }
  let encName = '';
  if (ext[20]) encName = ascii(ext[20][0].data).replace(/\0.*$/, '').trim();
  if (!encName && ext[3] && ext[3][0].size === 4 && ext[3][0].count >= 8) {
    const cp = new DataView(ext[3][0].data.buffer, ext[3][0].data.byteOffset, 32).getInt32(28, le);
    encName = CODEPAGES[cp] || '';
  }
  if (!encName) encName = 'windows-1252';
  const dec0 = makeDecoder(encName);
  const utf8 = dec0.encoding === 'utf-8';
  // SPSS cuts strings at a byte width, which can split the last UTF-8 character: drop that partial character.
  const dec = utf8 ? Object.assign((b, o) => dec0(cutPartial(b), o), { encoding: dec0.encoding }) : dec0;

  let rows = ncases >= 0 ? ncases : null;
  if (ext[16] && ext[16][0].size === 8 && ext[16][0].count === 2) {
    const dv = new DataView(ext[16][0].data.buffer, ext[16][0].data.byteOffset, 16);
    const n64 = dv.getBigInt64(8, le);
    if (n64 >= 0n && n64 <= BigInt(Number.MAX_SAFE_INTEGER) && (rows === null || rows === -1 || ncases < 0)) rows = Number(n64);
  }

  // long names and very long strings
  const longNames = new Map();
  // split at the byte level: a short name can end in the middle of a UTF-8 character, and its key must match
  if (ext[13]) for (const [k, v] of bytePairs(ext[13][0].data)) longNames.set(dec(k).toUpperCase(), dec(v, { nul: false }));
  const vls = new Map();
  if (ext[14]) for (const [k, v] of bytePairs(ext[14][0].data).map(([a, b]) => [dec(a), ascii(b).replace(/\0/g, '')])) {
    const w = parseInt(v, 10);
    if (w > 0 && w <= 32767) vls.set(k.toUpperCase(), w);
  }
  const recs = dict.recs;
  const display = ext[11] && ext[11][0].size === 4 ? ext[11][0] : null;
  let per = 0;
  if (display) {
    if (display.count === recs.length * 3) per = 3;
    else if (display.count === recs.length * 2) per = 2;
    else ds.warnings.push('The variable display record does not match the number of variables; measure levels are not shown.');
  }
  const ddv = display ? new DataView(display.data.buffer, display.data.byteOffset, display.data.byteLength) : null;

  // build variables (merging very long string segments)
  const vars = [];
  let fixedUnits = false;
  const byDict = new Map(); // dictIndex -> variable index
  let unitPos = 0;
  for (let i = 0; i < recs.length;) {
    const r = recs[i];
    const short = dec(r.name);
    const shortU = short.toUpperCase();
    const segs = [];
    let width;
    const w = vls.get(shortU);
    if (r.type > 0 && w && w > 255) {
      const nseg = Math.ceil(w / 252);
      if (i + nseg > recs.length) throw new DataError(`The very long string ${short} needs ${nseg} segments, more than the dictionary has.`);
      for (let j = 0; j < nseg; j++) segs.push(recs[i + j]);
      width = w;
    } else {
      segs.push(r);
      width = r.type;
    }
    const v = {
      name: longNames.get(shortU) || short,
      shortName: short,
      label: r.label ? dec(r.label, { nul: false }) : '',
      type: r.type === 0 ? 'numeric' : 'string',
      width: r.type === 0 ? 8 : width,
      storage: '', format: '', date: null, measure: '', alignment: '', displayWidth: 0,
      missing: null, labels: null,
    };
    const pf = fmtText(r.print);
    if (v.type === 'string') v.format = `A${width}`;
    else { v.format = pf.text; v.date = spssFormat(pf.type); }
    v.storage = v.format;
    if (per) {
      const m = ddv.getInt32(i * per * 4, le);
      v.measure = MEASURES[m] || '';
      if (per === 3) { v.displayWidth = ddv.getInt32(i * per * 4 + 4, le); v.alignment = ALIGN[ddv.getInt32(i * per * 4 + 8, le)] || ''; } else v.alignment = ALIGN[ddv.getInt32(i * per * 4 + 4, le)] || '';
    }
    // missing values in the variable record
    if (r.nMiss) {
      const m = { values: [], range: null };
      if (v.type === 'numeric') {
        const f = (b) => { const x = new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, le); return x === lowest ? -Infinity : x === highest ? Infinity : x; };
        let k = 0;
        if (r.nMiss < 0) { m.range = [f(r.miss[0]), f(r.miss[1])]; k = 2; }
        for (; k < r.miss.length; k++) m.values.push(f(r.miss[k]));
      } else {
        for (const b of r.miss) m.values.push(dec(b, { nul: false }));
      }
      v.missing = m;
    }
    // data plan: offsets of the segments in the case
    v._segs = [];
    for (let j = 0; j < segs.length; j++) {
      const s = segs[j];
      const alloc = s.type === 0 ? 8 : s.type;
      byDict.set(s.dictIndex, vars.length);
      v._segs.push({ off: unitPos * 8, bytes: alloc, use: j < segs.length - 1 ? 252 : (segs.length > 1 ? width - 252 * j : alloc) });
      const need = s.type === 0 ? 1 : Math.ceil(s.type / 8);
      if (s.units < need) { fixedUnits = true; }
      unitPos += Math.max(s.units, need);
    }
    vars.push(v);
    if (vars.length > maxVars) throw new DataError(`The file has more than ${maxVars.toLocaleString('en-US')} variables, the most this viewer reads.`);
    i += segs.length;
  }
  const caseBytes = unitPos * 8;
  if (fixedUnits) ds.warnings.push('Some string variables have no continuation records in the dictionary; their width was used instead.');
  if (nominal > 0 && nominal !== unitPos && !fixedUnits) ds.warnings.push(`The header says ${nominal} values per case, the dictionary has ${unitPos}; the dictionary is used.`);
  if (!vars.length) throw new DataError('The file has no variables.');

  // value labels (record types 3 and 4)
  let setNo = 0;
  for (const lr of dict.labelRecs) {
    const targets = [];
    for (const di of lr.vars) { const vi = byDict.get(di); if (vi === undefined) { ds.warnings.push(`A value label set names variable position ${di}, which does not exist.`); continue; } targets.push(vi); }
    if (!targets.length) continue;
    const isStr = vars[targets[0]].type === 'string';
    const key = `L${++setNo}`;
    ds.labelSets[key] = lr.labels.map(([raw, lab]) => [isStr ? dec(raw) : new DataView(raw.buffer, raw.byteOffset, 8).getFloat64(0, le), dec(lab, { nul: false })]);
    for (const vi of targets) vars[vi].labels = key;
  }
  const byName = new Map();
  for (let i = 0; i < vars.length; i++) { byName.set(vars[i].name.toUpperCase(), i); byName.set(vars[i].shortName.toUpperCase(), i); }
  // long string value labels (subtype 21)
  for (const rec of ext[21] || []) {
    try {
      const sc = subCursor(rec.data, le);
      while (sc.left > 0) {
        const nl = sc.i32(); if (nl < 0) throw new DataError('bad name length');
        const nm = dec(sc.bytes(nl));
        sc.i32(); // width
        const n = sc.i32();
        if (n < 0 || n * 8 > sc.left) throw new DataError('bad label count');
        const labs = [];
        for (let k = 0; k < n; k++) {
          const vl = sc.i32(); if (vl < 0) throw new DataError('bad value length');
          const val = dec(sc.bytes(vl));
          const ll = sc.i32(); if (ll < 0) throw new DataError('bad label length');
          labs.push([val, dec(sc.bytes(ll), { nul: false })]);
        }
        const vi = byName.get(nm.toUpperCase());
        if (vi === undefined) continue;
        const key = `L${++setNo}`;
        ds.labelSets[key] = labs;
        vars[vi].labels = key;
      }
    } catch (e) { ds.warnings.push('A long string value label record is damaged; the labels read before it are shown.'); }
  }
  // long string missing values (subtype 22)
  for (const rec of ext[22] || []) {
    try {
      const sc = subCursor(rec.data, le);
      while (sc.left > 0) {
        const nl = sc.i32(); if (nl < 0) throw new DataError('bad name length');
        const nm = dec(sc.bytes(nl));
        const n = sc.u8();
        const vl = sc.i32(); if (vl < 0 || vl > 4096) throw new DataError('bad value length');
        const values = [];
        for (let k = 0; k < n; k++) values.push(dec(sc.bytes(vl)));
        const vi = byName.get(nm.toUpperCase());
        if (vi !== undefined) vars[vi].missing = { values, range: null };
      }
    } catch (e) { ds.warnings.push('A long string missing value record is damaged.'); }
  }

  // info
  ds.info.product = dec(prod).replace(/^@\(#\)\s*/, '');
  ds.info.fileLabel = dec(flabel);
  ds.info.created = `${cdate.trim()} ${ctime.trim()}`.trim();
  ds.info.encoding = dec.encoding;
  ds.info.compression = compression === 0 ? 'none' : compression === 1 ? 'bytecode' : 'zlib';
  ds.info.byteOrder = le ? 'little-endian' : 'big-endian';
  ds.info.rows = rows;
  ds.info.notes = dict.docs.map((b) => dec(b, { nul: false })).filter((s, i, a) => s || i < a.length - 1);
  if (weightIndex > 0) { const vi = byDict.get(weightIndex); ds.info.weight = vi !== undefined ? vars[vi].name : ''; }
  ds.formatLabel = zsav ? 'SPSS .zsav, zlib compressed' : `SPSS .sav, ${compression === 1 ? 'bytecode compressed' : 'uncompressed'}`;

  // data
  const store = new Store(vars);
  const g = rowGuard(limits, vars.length);
  let st;
  try {
    st = compression === 2 ? zStream(src, c, le, ds.warnings) : fileStream(src, c.pos);
  } catch (e) {
    if (e instanceof Trunc) throw new DataError('The zlib header or trailer of this .zsav file is cut.', 'TRUNC');
    throw e;
  }
  const row = new Uint8Array(Math.max(8, caseBytes));
  const rdv = new DataView(row.buffer);
  const plan = vars.map((v) => ({ num: v.type === 'numeric', off: v._segs[0].off, segs: v._segs, width: v.width }));
  const strBuf = new Uint8Array(32768);
  const SPACES = 0x20;
  // bytecode state
  let cmd = null, ci = 8, eof = false, partial = false;
  const fillCompressed = () => {
    for (let u = 0; u < unitPos; u++) {
      let code;
      for (;;) {
        if (ci >= 8) {
          if (!st.need(8)) { if (u > 0 || st.chunk.length - st.p > 0) partial = true; eof = true; return false; }
          cmd = st.chunk.slice(st.p, st.p + 8); st.adv(8); ci = 0;
        }
        code = cmd[ci++];
        if (code !== 0) break;
      }
      const o = u * 8;
      if (code === 252) { if (u > 0) partial = true; eof = true; return false; }
      if (code === 253) {
        if (!st.need(8)) { partial = true; eof = true; return false; }
        row.set(st.chunk.subarray(st.p, st.p + 8), o); st.adv(8);
      } else if (code === 254) {
        row.fill(SPACES, o, o + 8);
      } else if (code === 255) {
        rdv.setFloat64(o, sysmis, le);
      } else {
        rdv.setFloat64(o, code - bias, le);
      }
    }
    return true;
  };
  const fillPlain = () => {
    if (!st.need(caseBytes)) { if (st.chunk.length - st.p > 0) partial = true; eof = true; return false; }
    row.set(st.chunk.subarray(st.p, st.p + caseBytes)); st.adv(caseBytes);
    return true;
  };
  const fill = compression === 0 ? fillPlain : fillCompressed;
  const nv = plan.length;
  // short ASCII cells skip the TextDecoder (most string cells in survey data)
  const decCell = (b) => {
    let end = b.length;
    const z = b.indexOf(0); if (z >= 0) end = z;
    while (end > 0 && b[end - 1] === 0x20) end--;
    if (end > 64) return dec(b);
    for (let i = 0; i < end; i++) if (b[i] >= 0x80) return dec(b);
    return end === 0 ? '' : String.fromCharCode.apply(null, b.subarray(0, end));
  };
  try {
    while (!eof) {
      if (rows !== null && store.n >= rows) break;
      if (!g.ok(store)) { ds.truncated = true; ds.warnings.push(g.why()); break; }
      if (!fill()) break;
      const r = store.addRow();
      for (let k = 0; k < nv; k++) {
        const p = plan[k];
        if (p.num) {
          const x = rdv.getFloat64(p.off, le);
          store.cols[k][r] = x === sysmis ? NaN : x;
        } else if (p.segs.length === 1) {
          store.setStr(k, r, decCell(row.subarray(p.off, p.off + p.width)));
        } else {
          let n = 0;
          for (const s of p.segs) { const take = Math.min(s.use, s.bytes); strBuf.set(row.subarray(s.off, s.off + take), n); n += take; }
          store.setStr(k, r, dec(strBuf.subarray(0, Math.min(n, p.width))));
        }
      }
    }
  } catch (e) {
    if (!(e instanceof Trunc)) throw e;
    partial = true;
  }
  if (partial) ds.warnings.push(`The data section ends in the middle of a row; the ${store.n.toLocaleString('en-US')} complete rows before it are shown.`);
  if (st.warning) ds.warnings.push(st.warning);
  if (rows !== null && store.n < rows && !ds.truncated) ds.warnings.push(`The header says ${rows.toLocaleString('en-US')} rows; ${store.n.toLocaleString('en-US')} were found.`);
  for (const v of vars) delete v._segs;
  ds.variables = vars;
  ds.store = store.finish();
  return ds;
}

module.exports = { read, sniff, FMT_NAMES, cutPartial };
