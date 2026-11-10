'use strict';
// Column summaries, frequencies, sort and filter indexes, and crosstabs with a chi-square test.
// Bounded: distinct values are tracked up to MAX_DISTINCT, crosstab categories up to MAX_CATS.

const MAX_DISTINCT = 100000;
const MAX_CATS = 200;
const MAX_LAYERS = 50;

/** Summary of one column over the rows in idx (all rows when idx is null). */
function summarize(ds, cells, col, idx, labels = true) {
  const v = ds.variables[col];
  const st = ds.store;
  const N = idx ? idx.length : st.n;
  const at = idx ? (k) => idx[k] : (k) => k;
  const out = { name: v.name, label: v.label || '', type: v.type, rows: N, valid: 0, sysmis: 0, usermis: 0, distinct: 0, distinctCapped: false, top: [], freq: null };
  const counts = new Map();
  if (st.kinds[col] === 'n') {
    let n = 0, mean = 0, m2 = 0, min = Infinity, max = -Infinity, sum = 0;
    const vals = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const r = at(k);
      const c = cells.cell(col, r, false);
      if (c.m === 1 || c.v === null) { if (c.m === 2) out.usermis++; else out.sysmis++; countKey(counts, missKey(c.t), out); continue; }
      if (c.m === 2) { out.usermis++; countKey(counts, c.v, out); continue; }
      const x = c.v;
      vals[n] = x;
      n++; sum += x;
      const d = x - mean; mean += d / n; m2 += d * (x - mean);
      if (x < min) min = x; if (x > max) max = x;
      countKey(counts, x, out);
    }
    out.valid = n;
    if (n) {
      out.mean = mean; out.sum = sum; out.min = min; out.max = max;
      out.sd = n > 1 ? Math.sqrt(m2 / (n - 1)) : null;
      const sorted = vals.subarray(0, n).sort();
      out.median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      out.p25 = quantile(sorted, 0.25); out.p75 = quantile(sorted, 0.75);
      out.minText = cells.numText(col, min, false); out.maxText = cells.numText(col, max, false);
      if (v.date) { out.meanText = cells.numText(col, mean, false); out.medianText = cells.numText(col, out.median, false); }
    }
  } else {
    let empty = 0;
    for (let k = 0; k < N; k++) {
      const c = cells.cell(col, at(k), false);
      if (c.v === '') { empty++; countKey(counts, '', out); continue; }
      if (c.m === 2) out.usermis++; else out.valid++;
      countKey(counts, c.v, out);
    }
    out.empty = empty;
  }
  out.distinct = counts.size;
  const entries = [...counts.entries()];
  entries.sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  const textOf = (key) => keyText(cells, col, key, labels);
  out.top = entries.slice(0, 10).map(([key, n]) => ({ value: textOf(key), code: codeText(cells, col, key), count: n, pct: N ? (100 * n) / N : 0 }));
  const map = cells.maps[col];
  if (map || counts.size <= 50) {
    const validN = N - out.sysmis - out.usermis - (out.empty || 0);
    const keys = new Set(counts.keys());
    if (map) for (const k of map.keys()) keys.add(k);
    const list = [...keys].sort(cmp);
    let cum = 0;
    out.freq = list.map((key) => {
      const n = counts.get(key) || 0;
      const isMiss = typeof key === 'string' && key.startsWith('\u0000') || (cells.userMiss[col] && key !== '' && cells.userMiss[col](key)) || key === '';
      if (!isMiss) cum += n;
      return { code: codeText(cells, col, key), label: map && map.has(key) ? map.get(key) : '', count: n, pct: N ? (100 * n) / N : 0, validPct: !isMiss && validN ? (100 * n) / validN : null, cumPct: !isMiss && validN ? (100 * cum) / validN : null, missing: !!isMiss };
    });
  }
  return out;
}

function countKey(map, key, out) {
  const c = map.get(key);
  if (c !== undefined) map.set(key, c + 1);
  else if (map.size < MAX_DISTINCT) map.set(key, 1);
  else out.distinctCapped = true;
}
const missKey = (t) => `\u0000${t}`; // missing values sort and print apart from real strings
function cmp(a, b) {
  const ta = typeof a, tb = typeof b;
  if (ta !== tb) return ta === 'number' ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function keyText(cells, col, key, labels) {
  if (typeof key === 'string' && key.startsWith('\u0000')) return key.slice(1);
  if (typeof key === 'number') return cells.numText(col, key, labels);
  if (labels && cells.maps[col] && cells.maps[col].has(key)) return cells.maps[col].get(key);
  return key;
}
function codeText(cells, col, key) {
  if (typeof key === 'string' && key.startsWith('\u0000')) return key.slice(1);
  if (typeof key === 'number') return cells.numText(col, key, false);
  return key;
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------- sort and filter ----------

/**
 * Parse a filter query. Plain text matches any part of the cell text (case-insensitive). On a numeric column,
 * "> 3", ">= 3", "< 3", "<= 3", "= 3", "!= 3" compare the value, and "a..b" is a range. "missing" and "not missing"
 * match missing values.
 */
function parseFilter(q) {
  const s = String(q || '').trim();
  if (!s) return null;
  if (s.length > 1000) throw new Error('The filter is longer than 1,000 characters.');
  if (/^missing$/i.test(s)) return { kind: 'missing' };
  if (/^(not missing|!missing)$/i.test(s)) return { kind: 'notmissing' };
  let m = /^(>=|<=|!=|<>|>|<|==|=)\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i.exec(s);
  if (m) return { kind: 'cmp', op: m[1] === '<>' ? '!=' : m[1] === '==' ? '=' : m[1], num: Number(m[2]), text: s.toLowerCase() };
  m = /^(-?(?:\d+\.?\d*|\.\d+))\s*\.\.\s*(-?(?:\d+\.?\d*|\.\d+))$/.exec(s);
  if (m) return { kind: 'range', lo: Number(m[1]), hi: Number(m[2]) };
  return { kind: 'text', text: s.toLowerCase() };
}

function matcher(ds, cells, col, query, labels) {
  const f = parseFilter(query);
  if (!f) return null;
  const isNum = ds.store.kinds[col] === 'n';
  if (f.kind === 'missing') return (r) => { const c = cells.cell(col, r, false); return c.m !== 0 || c.v === ''; };
  if (f.kind === 'notmissing') return (r) => { const c = cells.cell(col, r, false); return c.m === 0 && c.v !== ''; };
  if ((f.kind === 'cmp' || f.kind === 'range') && isNum) {
    const st = ds.store;
    return (r) => {
      const x = st.get(col, r);
      if (Number.isNaN(x)) return false;
      if (f.kind === 'range') return x >= f.lo && x <= f.hi;
      switch (f.op) { case '>': return x > f.num; case '>=': return x >= f.num; case '<': return x < f.num; case '<=': return x <= f.num; case '!=': return x !== f.num; default: return x === f.num; }
    };
  }
  const t = f.kind === 'text' ? f.text : f.kind === 'cmp' ? f.text : String(query).trim().toLowerCase();
  return (r) => cells.cell(col, r, labels).t.toLowerCase().includes(t);
}

/** Row index for a view: { filter: { col, query } | null, sort: { col, dir: 1 | -1 } | null }. */
function viewIndex(ds, cells, view, labels, deadline = Infinity) {
  const st = ds.store;
  let idx;
  const f = view && view.filter && Number.isInteger(view.filter.col) && view.filter.col >= 0 && view.filter.col < ds.variables.length ? matcher(ds, cells, view.filter.col, view.filter.query, labels) : null;
  if (f) {
    const tmp = new Int32Array(st.n);
    let k = 0;
    for (let r = 0; r < st.n; r++) {
      if (f(r)) tmp[k++] = r;
      if ((r & 65535) === 0 && Date.now() > deadline) throw Object.assign(new Error('Filtering took too long and was stopped.'), { code: 'TIMEOUT' });
    }
    idx = tmp.slice(0, k);
  } else if (view && view.sort) {
    idx = new Int32Array(st.n);
    for (let r = 0; r < st.n; r++) idx[r] = r;
  } else return null; // natural order
  const s = view && view.sort;
  if (s && Number.isInteger(s.col) && s.col >= 0 && s.col < ds.variables.length) {
    const col = st.cols[s.col], dir = s.dir < 0 ? -1 : 1, isNum = st.kinds[s.col] === 'n';
    const miss = st.miss[s.col];
    if (isNum) {
      idx.sort((a, b) => {
        const x = col[a], y = col[b];
        const xn = Number.isNaN(x), yn = Number.isNaN(y);
        if (xn || yn) { if (xn && yn) { const d = (miss ? miss[a] - miss[b] : 0); return d || a - b; } return xn ? 1 : -1; } // missing last
        return x < y ? -dir : x > y ? dir : a - b;
      });
    } else {
      idx.sort((a, b) => { const x = col[a] || '', y = col[b] || ''; if (x === '' || y === '') { if (x === y) return a - b; return x === '' ? 1 : -1; } return x < y ? -dir : x > y ? dir : a - b; });
    }
  }
  return idx;
}

// ---------- crosstab ----------

/** Categories of a column (distinct valid values), at most max. */
function categories(ds, cells, col, idx, max) {
  const st = ds.store;
  const seen = new Map();
  const N = idx ? idx.length : st.n;
  for (let k = 0; k < N; k++) {
    const r = idx ? idx[k] : k;
    const c = cells.cell(col, r, false);
    if (c.m !== 0 || c.v === '' || c.v === null) continue;
    if (!seen.has(c.v)) {
      if (seen.size >= max) {
        const e = new Error(`${ds.variables[col].name} has more than ${max} different values. A crosstab needs ${max} or fewer: pick a variable with categories, such as one with value labels.`);
        e.code = 'TOO_MANY';
        throw e;
      }
      seen.set(c.v, seen.size);
    }
  }
  const keys = [...seen.keys()].sort(cmp);
  return keys;
}

/** Upper regularized incomplete gamma Q(a, x), for chi-square p-values. */
function gammaQ(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  const lg = lgamma(a);
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 1000; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - lg));
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.min(1, Math.exp(-x + a * Math.log(x) - lg) * h);
}
function lgamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function chiSquareP(chi2, df) { return df > 0 ? gammaQ(df / 2, chi2 / 2) : null; }

/**
 * Crosstab of rowCol by colCol (optional layerCol), over the rows in idx (all rows when null).
 * Returns { row, col, layer, tables: [{ layerValue, layerText, rowKeys, colKeys, rowText, colText, counts, rowTotals,
 * colTotals, n, chi2, df, p, lowExpected, cellsTotal }], missingRows }.
 */
function crosstab(ds, cells, rowCol, colCol, layerCol, idx, labels = true) {
  const vars = ds.variables;
  const st = ds.store;
  for (const c of [rowCol, colCol, layerCol]) if (c !== null && c !== undefined && (!Number.isInteger(c) || c < 0 || c >= vars.length)) throw new Error('Unknown variable.');
  if (rowCol === colCol) throw new Error('Pick two different variables.');
  const rowKeys = categories(ds, cells, rowCol, idx, MAX_CATS);
  const colKeys = categories(ds, cells, colCol, idx, MAX_CATS);
  const layerKeys = layerCol === null || layerCol === undefined ? [null] : categories(ds, cells, layerCol, idx, MAX_LAYERS);
  const ri = new Map(rowKeys.map((k, i) => [k, i])), ci = new Map(colKeys.map((k, i) => [k, i])), li = new Map(layerKeys.map((k, i) => [k, i]));
  const grids = layerKeys.map(() => rowKeys.map(() => new Array(colKeys.length).fill(0)));
  let missingRows = 0;
  const N = idx ? idx.length : st.n;
  for (let k = 0; k < N; k++) {
    const r = idx ? idx[k] : k;
    const a = cells.cell(rowCol, r, false), b = cells.cell(colCol, r, false);
    let L = 0;
    if (layerKeys[0] !== null) { const l = cells.cell(layerCol, r, false); if (l.m !== 0 || l.v === '' || l.v === null) { missingRows++; continue; } L = li.get(l.v); }
    if (a.m !== 0 || b.m !== 0 || a.v === '' || b.v === '' || a.v === null || b.v === null) { missingRows++; continue; }
    grids[L][ri.get(a.v)][ci.get(b.v)]++;
  }
  const text = (col, key) => (typeof key === 'number' ? cells.numText(col, key, labels) : labels && cells.maps[col] && cells.maps[col].has(key) ? cells.maps[col].get(key) : key);
  const code = (col, key) => (typeof key === 'number' ? cells.numText(col, key, false) : key);
  const tables = layerKeys.map((lk, L) => {
    const counts = grids[L];
    const rowTotals = counts.map((r) => r.reduce((s, x) => s + x, 0));
    const colTotals = colKeys.map((_, j) => counts.reduce((s, r) => s + r[j], 0));
    const n = rowTotals.reduce((s, x) => s + x, 0);
    let chi2 = 0, low = 0, cellsUsed = 0;
    const rUsed = rowTotals.filter((x) => x > 0).length, cUsed = colTotals.filter((x) => x > 0).length;
    if (n > 0) {
      for (let i = 0; i < rowKeys.length; i++) for (let j = 0; j < colKeys.length; j++) {
        if (!rowTotals[i] || !colTotals[j]) continue;
        const e = (rowTotals[i] * colTotals[j]) / n;
        cellsUsed++;
        if (e < 5) low++;
        chi2 += ((counts[i][j] - e) ** 2) / e;
      }
    }
    const df = (rUsed - 1) * (cUsed - 1);
    return {
      layerValue: lk, layerText: lk === null ? '' : text(layerCol, lk),
      rowText: rowKeys.map((k) => text(rowCol, k)), colText: colKeys.map((k) => text(colCol, k)),
      rowCodes: rowKeys.map((k) => code(rowCol, k)), colCodes: colKeys.map((k) => code(colCol, k)),
      counts, rowTotals, colTotals, n,
      chi2: df > 0 ? chi2 : null, df, p: df > 0 ? chiSquareP(chi2, df) : null, lowExpected: low, cellsUsed,
    };
  });
  return {
    row: { index: rowCol, name: vars[rowCol].name, label: vars[rowCol].label || '' },
    col: { index: colCol, name: vars[colCol].name, label: vars[colCol].label || '' },
    layer: layerCol === null || layerCol === undefined ? null : { index: layerCol, name: vars[layerCol].name, label: vars[layerCol].label || '' },
    tables, missingRows, rowsUsed: N - missingRows,
  };
}

module.exports = { summarize, parseFilter, matcher, viewIndex, crosstab, gammaQ, chiSquareP, MAX_CATS, MAX_LAYERS, MAX_DISTINCT };
