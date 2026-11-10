'use strict';
// One worker thread per open file. It reads the dataset once and keeps it, then answers page, sort, filter, summary,
// copy, export, codebook and crosstab requests. The extension host (session.js) kills it when a request takes too
// long or it runs out of memory, so a hostile or huge file can never block or crash the editor.
const { parentPort } = require('worker_threads');
const { Source } = require('./core/source');
const { readDataset } = require('./core');
const { makeCells } = require('./core/format');
const stats = require('./core/stats');
const ex = require('./core/export');

const MAX_PAGE_ROWS = 500;
const MAX_PAGE_COLS = 400;
const MAX_COPY_CELLS = 5000000;

let ds = null, cells = null, idx = null, view = { filter: null, sort: null }, name = '';

function meta() {
  const labelSets = {};
  for (const [k, list] of Object.entries(ds.labelSets || {})) labelSets[k] = Array.isArray(list) ? list.slice(0, 5000).map(([v, l]) => [v, String(l)]) : [];
  return {
    format: ds.format, formatLabel: ds.formatLabel, info: ds.info, warnings: ds.warnings.slice(0, 200), truncated: !!ds.truncated,
    rows: ds.store.n,
    variables: ds.variables.map((v) => ({ name: v.name, label: v.label || '', type: v.type, width: v.width, storage: v.storage || '', format: v.format || '', date: v.date ? v.date.kind : '', measure: v.measure || '', missing: ex.missingText(v), labels: v.labels && labelSets[v.labels] ? v.labels : null })),
    labelSets,
  };
}

const count = () => (idx ? idx.length : ds.store.n);
const rowAt = (k) => (idx ? idx[k] : k);

function page({ start = 0, count: n = 100, c0 = 0, c1 = MAX_PAGE_COLS, labels = true }) {
  const total = count();
  const s = Math.max(0, Math.min(total, Math.floor(start)));
  const e = Math.min(total, s + Math.max(0, Math.min(MAX_PAGE_ROWS, Math.floor(n))));
  const a = Math.max(0, Math.min(ds.variables.length, Math.floor(c0)));
  const b = Math.min(ds.variables.length, a + Math.max(0, Math.min(MAX_PAGE_COLS, Math.floor(c1) - a)));
  const rows = [], miss = [], nums = [];
  for (let k = s; k < e; k++) {
    const r = rowAt(k);
    const t = new Array(b - a), m = new Array(b - a);
    for (let c = a; c < b; c++) { const x = cells.cell(c, r, labels); t[c - a] = x.t; m[c - a] = x.m || (x.v === '' && ds.store.kinds[c] === 's' ? 0 : 0); }
    rows.push(t); miss.push(m); nums.push(r + 1);
  }
  return { start: s, c0: a, c1: b, rows, miss, nums, total };
}

/** TSV of rows [k0, k1) and columns [c0, c1) of the current view, with a header row of names. */
function copy({ k0 = 0, k1 = 0, c0 = 0, c1 = 0, labels = true, header = true }) {
  const s = Math.max(0, Math.min(count(), k0)), e = Math.max(s, Math.min(count(), k1));
  const a = Math.max(0, Math.min(ds.variables.length, c0)), b = Math.max(a, Math.min(ds.variables.length, c1));
  if ((e - s) * (b - a) > MAX_COPY_CELLS) throw new Error(`Copy is limited to ${MAX_COPY_CELLS.toLocaleString('en-US')} cells. Export the data instead.`);
  const clean = (t) => String(t).replace(/[\t\r\n]+/g, ' ');
  const lines = [];
  if (header) lines.push(ds.variables.slice(a, b).map((v) => clean(v.name)).join('\t'));
  for (let k = s; k < e; k++) {
    const r = rowAt(k);
    const parts = [];
    for (let c = a; c < b; c++) { const x = cells.cell(c, r, labels); parts.push(x.m === 1 ? '' : clean(x.t)); }
    lines.push(parts.join('\t'));
  }
  return { text: lines.join('\n'), rows: e - s, cols: b - a };
}

function run(job) {
  switch (job.op) {
    case 'open': {
      const src = job.buffer ? Source.fromBuffer(new Uint8Array(job.buffer)) : Source.fromFile(job.file);
      try { ds = readDataset(src, job.limits, job.name || ''); } finally { src.close(); }
      ds.store.finish();
      cells = makeCells(ds); idx = null; view = { filter: null, sort: null }; name = job.name || '';
      return meta();
    }
    case 'view': {
      const v = job.view || {};
      const next = { filter: v.filter && String(v.filter.query || '').trim() ? { col: Number(v.filter.col), query: String(v.filter.query) } : null, sort: v.sort ? { col: Number(v.sort.col), dir: v.sort.dir < 0 ? -1 : 1 } : null };
      idx = stats.viewIndex(ds, cells, next, job.labels !== false, Date.now() + 25000);
      view = next;
      return { count: count(), view };
    }
    case 'page': return page(job);
    case 'copy': return copy(job);
    case 'summary': {
      const col = Number(job.col);
      if (!Number.isInteger(col) || col < 0 || col >= ds.variables.length) throw new Error('Unknown variable.');
      return { col, filtered: !!idx, s: stats.summarize(ds, cells, col, idx, job.labels !== false) };
    }
    case 'export': {
      const labels = !!job.labels;
      let buf, extra = {};
      if (job.kind === 'csv') buf = ex.toCsv(ds, cells, idx, { labels });
      else if (job.kind === 'json') buf = ex.toJson(ds, cells, idx, { labels, name });
      else if (job.kind === 'xlsx') { const r = ex.toXlsx(ds, cells, idx, { labels }); buf = r.buffer; extra = { cut: r.cut }; }
      else throw new Error('Unknown export format.');
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return { __transfer: ab, rows: count(), bytes: buf.length, ...extra };
    }
    case 'codebook': {
      const text = job.kind === 'html' ? ex.codebookHtml(ds, cells, null, name) : job.kind === 'csv' ? ex.codebookCsv(ds, cells, null) : ex.codebookMarkdown(ds, cells, null, name);
      return { text, variables: ds.variables.length };
    }
    case 'crosstab': {
      const layer = job.layer === null || job.layer === undefined || job.layer === '' ? null : Number(job.layer);
      return stats.crosstab(ds, cells, Number(job.row), Number(job.col), layer, idx, job.labels !== false);
    }
    case 'crosstabText': return { text: job.kind === 'csv' ? ex.crosstabCsv(job.result) : ex.crosstabMarkdown(job.result, name) };
    default: throw new Error(`unknown job ${job.op}`);
  }
}

parentPort.on('message', (msg) => {
  try {
    if (msg.job.op !== 'open' && !ds) throw new Error('The file is not loaded.');
    const result = run(msg.job);
    if (result && result.__transfer) {
      const ab = result.__transfer; delete result.__transfer; result.buffer = ab;
      parentPort.postMessage({ id: msg.id, ok: true, result }, [ab]);
    } else parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e), code: e && e.code });
  }
});
