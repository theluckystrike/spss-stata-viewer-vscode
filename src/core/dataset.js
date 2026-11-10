'use strict';
// The one data model every reader returns (sav.js, dta.js, xpt.js), and the shared row store.
//
// Dataset = {
//   format: 'sav' | 'zsav' | 'dta' | 'xpt',
//   formatLabel: 'SPSS .sav, bytecode compressed' | 'Stata .dta release 118' | ...,
//   info: { rows (count stated in the file or null), fileLabel, created, encoding, compression, product,
//           release, byteOrder, weight (variable name or ''), notes: [document lines], member (xpt) },
//   variables: [{
//     name, label, type: 'numeric' | 'string', width (string bytes, or storage bytes for numbers),
//     storage ('double', 'float', 'long', 'int', 'byte', 'str12', 'strL', 'F8.2' ...), format (display format text),
//     date: descriptor from dates.js or null, measure: 'nominal' | 'ordinal' | 'scale' | '',
//     missing: { values: [..], range: [lo, hi] | null } | null   (SPSS user-missing definitions),
//     labels: name of a set in labelSets, or null,
//   }],
//   labelSets: { [name]: [[value, label], ...] }  (value: number for numeric variables, string for string ones),
//   store: Store (below), warnings: [text], truncated: boolean (rows were cut by a limit; warnings say why)
// }
// A numeric cell is a Number; NaN is the system missing value ('.' in Stata and SAS). Stata .a-.z and SAS .A-.Z ._
// are NaN plus a code in store.miss (1-26 = a-z, 27 = _). A string cell is a JS string.

const DEFAULT_LIMITS = { maxCells: 40e6, maxStringChars: 200e6, maxMs: 60000, maxVars: 100000 };

class Store {
  constructor(vars) {
    this.n = 0;
    this.cap = 1024;
    this.kinds = vars.map((v) => (v.type === 'string' ? 's' : 'n'));
    this.cols = this.kinds.map((k) => (k === 's' ? [] : new Float64Array(this.cap)));
    this.miss = this.kinds.map(() => null);
    this.chars = 0;
  }
  grow() {
    const cap = this.cap * 2;
    this.cols = this.cols.map((c, i) => { if (this.kinds[i] === 's') return c; const a = new Float64Array(cap); a.set(c); return a; });
    this.miss = this.miss.map((m) => { if (!m) return m; const a = new Uint8Array(cap); a.set(m); return a; });
    this.cap = cap;
  }
  /** Start a new row; returns its index. */
  addRow() { if (this.n >= this.cap) this.grow(); return this.n++; }
  setNum(col, row, v) { this.cols[col][row] = v; }
  setStr(col, row, s) { this.cols[col][row] = s; this.chars += s.length; }
  setMiss(col, row, code) {
    this.cols[col][row] = NaN;
    if (!code) return;
    if (!this.miss[col]) this.miss[col] = new Uint8Array(this.cap);
    this.miss[col][row] = code;
  }
  /** Drop rows from n on (a row that was cut in the middle). */
  truncate(n) {
    if (n >= this.n) return;
    for (let i = 0; i < this.kinds.length; i++) if (this.kinds[i] === 's') this.cols[i].length = n;
    this.n = n;
  }
  /** Shrink the numeric arrays to n rows (less memory once reading is done). */
  finish() {
    this.cols = this.cols.map((c, i) => (this.kinds[i] === 's' ? c : c.slice(0, this.n)));
    this.miss = this.miss.map((m) => (m ? m.slice(0, this.n) : m));
    this.cap = this.n;
    return this;
  }
  get(col, row) { return this.cols[col][row]; }
  missCode(col, row) { const m = this.miss[col]; return m ? m[row] : 0; }
}

/** Letter for a missing code (1-26 = a-z, 27 = _), '' for the system missing value. */
function missLetter(code) { return code >= 1 && code <= 26 ? String.fromCharCode(96 + code) : code === 27 ? '_' : ''; }

/**
 * Row-limit helper for readers: call ok(store, nvars, started) before each row; false when a limit is reached
 * (the reader stops, sets truncated and pushes the warning returned by why()).
 */
function rowGuard(limits, nvars) {
  const L = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const t0 = Date.now();
  const maxRows = Math.max(1, Math.floor(L.maxCells / Math.max(1, nvars)));
  let reason = '';
  return {
    limits: L,
    ok(store) {
      if (store.n >= maxRows) { reason = `Only the first ${store.n.toLocaleString('en-US')} rows were read (limit of ${L.maxCells.toLocaleString('en-US')} cells).`; return false; }
      if (store.chars > L.maxStringChars) { reason = `Only the first ${store.n.toLocaleString('en-US')} rows were read (limit of ${Math.round(L.maxStringChars / 1e6)} million characters of text).`; return false; }
      if ((store.n & 1023) === 0 && Date.now() - t0 > L.maxMs) { reason = `Only the first ${store.n.toLocaleString('en-US')} rows were read (time limit of ${Math.round(L.maxMs / 1000)} s).`; return false; }
      return true;
    },
    why: () => reason,
  };
}

function newDataset(format, formatLabel) {
  return { format, formatLabel, info: { rows: null, fileLabel: '', created: '', encoding: '', compression: '', product: '', release: '', byteOrder: '', weight: '', notes: [] }, variables: [], labelSets: {}, store: null, warnings: [], truncated: false };
}

module.exports = { Store, rowGuard, newDataset, missLetter, DEFAULT_LIMITS };
