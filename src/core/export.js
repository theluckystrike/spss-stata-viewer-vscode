'use strict';
// Zovo Pro outputs: data export (CSV, Excel, JSON), the codebook (Markdown, HTML, CSV) and crosstab tables
// (CSV, Markdown). Pure functions over a Dataset, a cell reader (format.js) and a row index (null = all rows).
const { writeXlsx, MAX_ROWS } = require('./xlsx');
const { summarize } = require('./stats');

const MAX_JSON_ROWS = 2000000;

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowIter(ds, idx) {
  const N = idx ? idx.length : ds.store.n;
  return { N, at: idx ? (k) => idx[k] : (k) => k };
}

/** CSV of the rows in idx (labels: value labels instead of codes). Returns a Buffer (UTF-8). */
function toCsv(ds, cells, idx, { labels = false } = {}) {
  const nv = ds.variables.length;
  const { N, at } = rowIter(ds, idx);
  const chunks = [];
  let lines = [ds.variables.map((v) => csvField(v.name)).join(',')];
  for (let k = 0; k < N; k++) {
    const r = at(k);
    const parts = new Array(nv);
    for (let c = 0; c < nv; c++) parts[c] = csvField(cells.exportValue(c, r, labels));
    lines.push(parts.join(','));
    if (lines.length >= 10000) { chunks.push(Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')); lines = []; }
  }
  if (lines.length) chunks.push(Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'));
  return Buffer.concat(chunks);
}

function variableMeta(ds, cells, c) {
  const v = ds.variables[c];
  const m = cells.maps[c];
  return {
    name: v.name, label: v.label || '', type: v.type, storage: v.storage || '', format: v.format || '', measure: v.measure || '',
    missing: missingText(v) || null, valueLabels: m ? Object.fromEntries([...m.entries()].map(([k, l]) => [String(k), l])) : null,
  };
}

/** JSON: { dataset, variables, rows: [{ name: value }] }. Missing values are null. */
function toJson(ds, cells, idx, { labels = false, name = '' } = {}) {
  const nv = ds.variables.length;
  const { N, at } = rowIter(ds, idx);
  if (N > MAX_JSON_ROWS) throw new Error(`JSON export is limited to ${MAX_JSON_ROWS.toLocaleString('en-US')} rows. Filter the rows or export to CSV.`);
  const head = { dataset: { file: name, format: ds.formatLabel, rows: N, label: ds.info.fileLabel || '', values: labels ? 'value labels' : 'codes' }, variables: ds.variables.map((_, c) => variableMeta(ds, cells, c)) };
  const names = ds.variables.map((v) => JSON.stringify(v.name));
  const chunks = [Buffer.from(JSON.stringify(head, null, 2).replace(/\n}$/, ',\n  "rows": [\n'), 'utf8')];
  let lines = [];
  for (let k = 0; k < N; k++) {
    const r = at(k);
    const parts = new Array(nv);
    for (let c = 0; c < nv; c++) { const v = cells.exportValue(c, r, labels); parts[c] = `${names[c]}: ${v === null || (typeof v === 'number' && !Number.isFinite(v)) ? 'null' : JSON.stringify(v)}`; }
    lines.push(`    {${parts.join(', ')}}`);
    if (lines.length >= 10000) { chunks.push(Buffer.from(lines.join(',\n') + (k < N - 1 ? ',\n' : ''), 'utf8')); lines = []; }
  }
  chunks.push(Buffer.from(lines.join(',\n') + '\n  ]\n}\n', 'utf8'));
  return Buffer.concat(chunks);
}

/** Excel: sheet "Data" (header + rows, at most 1,048,575 rows) and sheet "Variables". */
function toXlsx(ds, cells, idx, { labels = false } = {}) {
  const nv = ds.variables.length;
  const { N, at } = rowIter(ds, idx);
  const rows = Math.min(N, MAX_ROWS - 1);
  function* data() {
    yield ds.variables.map((v) => v.name);
    for (let k = 0; k < rows; k++) {
      const r = at(k);
      const out = new Array(nv);
      for (let c = 0; c < nv; c++) out[c] = cells.exportValue(c, r, labels);
      yield out;
    }
  }
  function* vars() {
    yield ['Name', 'Label', 'Type', 'Format', 'Measure', 'Missing values', 'Value labels'];
    for (let c = 0; c < nv; c++) {
      const m = variableMeta(ds, cells, c);
      yield [m.name, m.label, m.storage || m.type, m.format, m.measure, missingText(ds.variables[c]), m.valueLabels ? Object.entries(m.valueLabels).map(([k, l]) => `${k} = ${l}`).join('; ') : ''];
    }
  }
  const buf = writeXlsx([{ name: 'Data', rows: data(), ncols: nv }, { name: 'Variables', rows: vars(), ncols: 7 }]);
  return { buffer: buf, rows, cut: N - rows };
}

function missingText(v) {
  const m = v.missing;
  if (!m) return '';
  const parts = [];
  if (m.range) parts.push(`${fmtRangeEnd(m.range[0])} thru ${fmtRangeEnd(m.range[1])}`);
  for (const x of m.values || []) parts.push(typeof x === 'string' ? `"${x}"` : String(x));
  return parts.join(', ');
}
function fmtRangeEnd(x) { return x <= -1.7e308 ? 'LOWEST' : x >= 1.7e308 ? 'HIGHEST' : String(x); }

// ---------- codebook ----------

/** Per-variable codebook entries with frequencies (labelled variables) or a numeric summary. */
function codebookEntries(ds, cells, idx) {
  return ds.variables.map((v, c) => {
    const s = summarize(ds, cells, c, idx, true);
    return { v, c, s, missingDef: missingText(v), labels: cells.maps[c] ? [...cells.maps[c].entries()] : [] };
  });
}

const num = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '' : Number.isInteger(x) ? x.toLocaleString('en-US') : x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (x) => (x === null || x === undefined ? '' : `${x.toFixed(1)}%`);
const mdEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function typeText(v) { return v.storage ? `${v.type}, ${v.storage}` : v.type; }

function codebookMarkdown(ds, cells, idx, name) {
  const E = codebookEntries(ds, cells, idx);
  const out = [`# Codebook: ${mdEsc(name)}`, '', `${mdEsc(ds.formatLabel)}. ${num(E.length ? E[0].s.rows : 0)} rows, ${num(ds.variables.length)} variables.${ds.info.fileLabel ? ` File label: ${mdEsc(ds.info.fileLabel)}.` : ''}`, ''];
  out.push('| # | Variable | Label | Type | Format | Measure | Valid | Missing |', '|---:|---|---|---|---|---|---:|---:|');
  E.forEach(({ v, s }, i) => out.push(`| ${i + 1} | ${mdEsc(v.name)} | ${mdEsc(v.label || '')} | ${mdEsc(typeText(v))} | ${mdEsc(v.format || '')} | ${v.measure || ''} | ${num(s.valid)} | ${num(s.sysmis + s.usermis + (s.empty || 0))} |`));
  for (const { v, s, missingDef } of E) {
    out.push('', `## ${mdEsc(v.name)}${v.label ? `: ${mdEsc(v.label)}` : ''}`, '');
    out.push(`- Type: ${mdEsc(typeText(v))}${v.format ? `, format ${mdEsc(v.format)}` : ''}${v.measure ? `, ${v.measure}` : ''}`);
    if (missingDef) out.push(`- Missing values: ${mdEsc(missingDef)}`);
    out.push(`- Valid: ${num(s.valid)}, missing: ${num(s.sysmis + s.usermis + (s.empty || 0))}, distinct values: ${num(s.distinct)}${s.distinctCapped ? '+' : ''}`);
    if (v.type === 'numeric' && s.valid && !s.freq) out.push(`- Mean ${s.meanText || num(s.mean, 4)}, SD ${num(s.sd, 4)}, min ${s.minText}, median ${s.medianText || num(s.median, 4)}, max ${s.maxText}`);
    if (s.freq && s.freq.length) {
      out.push('', '| Value | Label | Count | Percent | Valid percent |', '|---|---|---:|---:|---:|');
      for (const f of s.freq) out.push(`| ${mdEsc(f.code)} | ${mdEsc(f.label)}${f.missing ? ' (missing)' : ''} | ${num(f.count)} | ${pct(f.pct)} | ${pct(f.validPct)} |`);
    }
  }
  return out.join('\n') + '\n';
}

function codebookHtml(ds, cells, idx, name) {
  const E = codebookEntries(ds, cells, idx);
  const rows = E.length ? E[0].s.rows : 0;
  const parts = [`<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>Codebook: ${htmlEsc(name)}</title>
<style>body{font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;margin:24px auto;max-width:1000px;padding:0 16px;color:#1b1b1b}table{border-collapse:collapse;margin:8px 0 18px}th,td{border:1px solid #ccc;padding:3px 8px;text-align:left;vertical-align:top}td.n{text-align:right}th{background:#f2f2f2}h2{margin-top:28px;border-top:1px solid #ddd;padding-top:14px}.m{color:#666}</style></head><body>`,
    `<h1>Codebook: ${htmlEsc(name)}</h1><p>${htmlEsc(ds.formatLabel)}. ${num(rows)} rows, ${num(ds.variables.length)} variables.${ds.info.fileLabel ? ` File label: ${htmlEsc(ds.info.fileLabel)}.` : ''}</p>`,
    '<table><tr><th>#</th><th>Variable</th><th>Label</th><th>Type</th><th>Format</th><th>Measure</th><th>Valid</th><th>Missing</th></tr>'];
  E.forEach(({ v, s }, i) => parts.push(`<tr><td class="n">${i + 1}</td><td><a href="#v${i}">${htmlEsc(v.name)}</a></td><td>${htmlEsc(v.label || '')}</td><td>${htmlEsc(typeText(v))}</td><td>${htmlEsc(v.format || '')}</td><td>${htmlEsc(v.measure || '')}</td><td class="n">${num(s.valid)}</td><td class="n">${num(s.sysmis + s.usermis + (s.empty || 0))}</td></tr>`));
  parts.push('</table>');
  E.forEach(({ v, s, missingDef }, i) => {
    parts.push(`<h2 id="v${i}">${htmlEsc(v.name)}${v.label ? `: ${htmlEsc(v.label)}` : ''}</h2><ul><li>Type: ${htmlEsc(typeText(v))}${v.format ? `, format ${htmlEsc(v.format)}` : ''}${v.measure ? `, ${htmlEsc(v.measure)}` : ''}</li>`);
    if (missingDef) parts.push(`<li>Missing values: ${htmlEsc(missingDef)}</li>`);
    parts.push(`<li>Valid: ${num(s.valid)}, missing: ${num(s.sysmis + s.usermis + (s.empty || 0))}, distinct values: ${num(s.distinct)}${s.distinctCapped ? '+' : ''}</li>`);
    if (v.type === 'numeric' && s.valid && !s.freq) parts.push(`<li>Mean ${htmlEsc(s.meanText || num(s.mean, 4))}, SD ${num(s.sd, 4)}, min ${htmlEsc(s.minText)}, median ${htmlEsc(s.medianText || num(s.median, 4))}, max ${htmlEsc(s.maxText)}</li>`);
    parts.push('</ul>');
    if (s.freq && s.freq.length) {
      parts.push('<table><tr><th>Value</th><th>Label</th><th>Count</th><th>Percent</th><th>Valid percent</th></tr>');
      for (const f of s.freq) parts.push(`<tr><td>${htmlEsc(f.code)}</td><td>${htmlEsc(f.label)}${f.missing ? ' <span class="m">(missing)</span>' : ''}</td><td class="n">${num(f.count)}</td><td class="n">${pct(f.pct)}</td><td class="n">${pct(f.validPct)}</td></tr>`);
      parts.push('</table>');
    }
  });
  parts.push('</body></html>\n');
  return parts.join('\n');
}

/** Codebook CSV: one row per variable and value label (long format), with counts. */
function codebookCsv(ds, cells, idx) {
  const E = codebookEntries(ds, cells, idx);
  const out = [['variable', 'label', 'type', 'storage', 'format', 'measure', 'missing_values', 'valid', 'missing', 'distinct', 'mean', 'sd', 'min', 'max', 'value', 'value_label', 'count', 'percent'].join(',')];
  for (const { v, s, missingDef } of E) {
    const base = [v.name, v.label || '', v.type, v.storage || '', v.format || '', v.measure || '', missingDef, s.valid, s.sysmis + s.usermis + (s.empty || 0), s.distinct,
      s.mean ?? '', s.sd ?? '', s.min ?? '', s.max ?? ''];
    if (s.freq && s.freq.length) for (const f of s.freq) out.push([...base, f.code, f.label, f.count, f.pct.toFixed(4)].map(csvField).join(','));
    else out.push([...base, '', '', '', ''].map(csvField).join(','));
  }
  return out.join('\r\n') + '\r\n';
}

// ---------- crosstab outputs ----------

function ctCell(t, i, j, mode) {
  const n = t.counts[i][j];
  if (mode === 'row') return t.rowTotals[i] ? (100 * n) / t.rowTotals[i] : 0;
  if (mode === 'col') return t.colTotals[j] ? (100 * n) / t.colTotals[j] : 0;
  if (mode === 'total') return t.n ? (100 * n) / t.n : 0;
  return n;
}

function pText(p) { return p === null || p === undefined ? '' : p < 0.001 ? '< 0.001' : p.toFixed(3); }

function crosstabCsv(ct) {
  const out = [];
  for (const t of ct.tables) {
    if (ct.layer) out.push(csvField(`${ct.layer.name} = ${t.layerText}`));
    out.push([`${ct.row.name} \\ ${ct.col.name}`, ...t.colText, 'Total'].map(csvField).join(','));
    t.rowText.forEach((label, i) => {
      out.push([label, ...t.counts[i], t.rowTotals[i]].map(csvField).join(','));
      out.push([`${label} (row %)`, ...t.counts[i].map((_, j) => ctCell(t, i, j, 'row').toFixed(2)), '100.00'].map(csvField).join(','));
      out.push([`${label} (column %)`, ...t.counts[i].map((_, j) => ctCell(t, i, j, 'col').toFixed(2)), t.n ? ((100 * t.rowTotals[i]) / t.n).toFixed(2) : ''].map(csvField).join(','));
      out.push([`${label} (total %)`, ...t.counts[i].map((_, j) => ctCell(t, i, j, 'total').toFixed(2)), t.n ? ((100 * t.rowTotals[i]) / t.n).toFixed(2) : ''].map(csvField).join(','));
    });
    out.push(['Total', ...t.colTotals, t.n].map(csvField).join(','));
    out.push(csvField(chiLine(t)));
    out.push('');
  }
  return out.join('\r\n');
}

function chiLine(t) {
  if (t.chi2 === null) return `N = ${t.n}. Chi-square needs at least 2 rows and 2 columns with data.`;
  return `N = ${t.n}. Pearson chi-square = ${t.chi2.toFixed(3)}, df = ${t.df}, p = ${pText(t.p)}.${t.lowExpected ? ` ${t.lowExpected} of ${t.cellsUsed} cells have an expected count below 5.` : ''}`;
}

function crosstabMarkdown(ct, name) {
  const out = [`# Crosstab: ${mdEsc(ct.row.name)} by ${mdEsc(ct.col.name)}${ct.layer ? `, layered by ${mdEsc(ct.layer.name)}` : ''}`, '', `File: ${mdEsc(name)}. Rows used: ${ct.rowsUsed}; rows with a missing value: ${ct.missingRows}.`, ''];
  for (const t of ct.tables) {
    if (ct.layer) out.push(`## ${mdEsc(ct.layer.name)} = ${mdEsc(t.layerText)}`, '');
    out.push(`| ${mdEsc(ct.row.name)} \\ ${mdEsc(ct.col.name)} | ${t.colText.map(mdEsc).join(' | ')} | Total |`, `|---|${t.colText.map(() => '---:').join('|')}|---:|`);
    t.rowText.forEach((label, i) => {
      out.push(`| ${mdEsc(label)} | ${t.counts[i].map((n, j) => `${n} (${ctCell(t, i, j, 'row').toFixed(1)}%)`).join(' | ')} | ${t.rowTotals[i]} |`);
    });
    out.push(`| Total | ${t.colTotals.map((n) => `${n} (${t.n ? ((100 * n) / t.n).toFixed(1) : '0.0'}%)`).join(' | ')} | ${t.n} |`, '', 'Cells: count (row %).', '', chiLine(t), '');
  }
  return out.join('\n');
}

module.exports = { toCsv, toJson, toXlsx, codebookMarkdown, codebookHtml, codebookCsv, crosstabCsv, crosstabMarkdown, chiLine, pText, ctCell, missingText, csvField };
