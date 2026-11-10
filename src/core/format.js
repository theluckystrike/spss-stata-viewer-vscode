'use strict';
// Cell text for the grid, the exports and the summaries: value labels or codes, dates, decimals from the display
// format, and the kind of missing value. Pure functions on a Dataset (dataset.js).
const dates = require('./dates');
const { missLetter } = require('./dataset');

/** Value-label lookup maps per variable (Map value -> label), built once per dataset. */
function labelMaps(ds) {
  const sets = new Map();
  for (const [name, list] of Object.entries(ds.labelSets || {})) {
    const m = new Map();
    if (Array.isArray(list)) for (const pair of list) if (Array.isArray(pair) && !m.has(pair[0])) m.set(pair[0], String(pair[1]));
    sets.set(name, m);
  }
  return ds.variables.map((v) => (v.labels && sets.has(v.labels) && sets.get(v.labels).size ? sets.get(v.labels) : null));
}

/** Number formatter for one variable: decimals from F8.2 / %9.2f / 8.2, else up to 10 significant digits. */
function numberFormatter(v, family) {
  const f = String(v.format || '');
  let m;
  if (family === 'dta') {
    m = /^%-?~?\d*\.(\d+)(fc|f|e|gc|g)/.exec(f);
    if (m && (m[2] === 'f' || m[2] === 'fc')) {
      const d = Math.min(16, Number(m[1]));
      if (m[2] === 'fc') return (x) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
      return (x) => x.toFixed(d);
    }
    if (m && m[2] === 'e') { const d = Math.min(16, Number(m[1])); return (x) => x.toExponential(d); }
    const g = /^%-?~?(\d+)\.\d*g/.exec(f);
    if (g) return widthGeneral(Math.max(4, Math.min(30, Number(g[1]))), v.storage === 'float' ? 7 : 15);
  } else {
    m = /(\d+)\.(\d+)$/.exec(f);
    if (m && !/^A/.test(f)) { const d = Math.min(16, Number(m[2])); return (x) => (Math.abs(x) < 1e21 ? x.toFixed(d) : String(x)); }
  }
  return v.storage === 'float' ? widthGeneral(30, 7) : general;
}

/** Stata %9.0g style: the most significant digits (up to maxP) that fit in w characters. */
function widthGeneral(w, maxP) {
  return (x) => {
    if (Number.isInteger(x) && Math.abs(x) < 1e15 && String(x).length <= Math.max(w, 15)) return String(x);
    for (let p = maxP; p >= 1; p--) { const t = String(Number(x.toPrecision(p))); if (t.length <= w) return t; }
    return x.toExponential(Math.max(0, Math.min(maxP, w - 6) - 1));
  };
}

function general(x) {
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x);
  const p = Number(x.toPrecision(10));
  return String(p);
}

/**
 * A cell reader for a dataset: cell(col, row, labels) -> { t: text, m: 0 value | 1 system missing | 2 user or
 * extended missing, v: raw value (number or string) }. raw(col,row) gives the value for exports (null = missing).
 */
function makeCells(ds) {
  const family = ds.format === 'dta' ? 'dta' : ds.format === 'xpt' ? 'xpt' : 'sav';
  const maps = labelMaps(ds);
  const fmts = ds.variables.map((v) => (v.type === 'string' ? null : numberFormatter(v, family)));
  const userMiss = ds.variables.map((v) => {
    const mv = v.missing;
    if (!mv || (!(mv.values && mv.values.length) && !mv.range)) return null;
    const set = new Set(mv.values || []);
    const r = mv.range;
    if (v.type === 'string') return (x) => set.has(x) || set.has(String(x).trimEnd());
    return (x) => set.has(x) || (r ? x >= r[0] && x <= r[1] : false);
  });
  const st = ds.store;
  const sysText = '.';

  /** Text of a numeric value (label when asked and known). */
  function numText(col, x, labels) {
    if (labels && maps[col]) { const l = maps[col].get(x); if (l !== undefined) return l; }
    const v = ds.variables[col];
    if (v.date) { const d = dates.display(v.date, x); if (d !== null) return d; }
    return fmts[col](x);
  }

  function cell(col, row, labels) {
    const x = st.get(col, row);
    if (st.kinds[col] === 's') {
      const s = x === undefined || x === null ? '' : x;
      const um = userMiss[col] && s !== '' && userMiss[col](s);
      if (labels && maps[col]) { const l = maps[col].get(s); if (l !== undefined) return { t: l, m: um ? 2 : 0, v: s }; }
      return { t: s, m: um ? 2 : 0, v: s };
    }
    if (Number.isNaN(x)) {
      const code = st.missCode(col, row);
      const letter = missLetter(code);
      const t = family === 'xpt' ? (letter ? `.${letter.toUpperCase()}` : sysText) : letter ? `.${letter}` : sysText;
      return { t, m: code ? 2 : 1, v: null };
    }
    const um = userMiss[col] && userMiss[col](x);
    return { t: numText(col, x, labels), m: um ? 2 : 0, v: x };
  }

  /** The value for exports: label text, formatted date, number, string; null for any missing value. */
  function exportValue(col, row, labels, keepUserMissing = true) {
    const c = cell(col, row, labels);
    if (c.m === 1 || (c.m === 2 && st.kinds[col] === 'n' && c.v === null)) return null;
    if (c.m === 2 && !keepUserMissing) return null;
    if (st.kinds[col] === 's') return c.t;
    const v = ds.variables[col];
    if ((labels && maps[col] && maps[col].has(c.v)) || v.date) return c.t;
    return c.v;
  }

  return { cell, numText, exportValue, maps, userMiss, family };
}

module.exports = { makeCells, labelMaps, general, numberFormatter };
