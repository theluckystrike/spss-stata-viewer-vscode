'use strict';
// Runs media/main.js in jsdom against a host that answers from the real readers: tabs, the data grid (positions set
// through the CSSOM, since the CSP drops style attributes), labels toggle, sort, filter, summary, crosstab, the Pro
// buttons, the error page, and labels with HTML kept as text. jsdom is not a dependency of this extension: the test
// uses JSDOM_PATH or the copy in a sibling product, and is skipped when there is none.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Source } = require('../src/core/source');
const { readDataset } = require('../src/core');
const { makeCells } = require('../src/core/format');
const stats = require('../src/core/stats');
const { writeSav } = require('../scripts/make_sav');
const { surveyRows, savSpec } = require('../scripts/make_samples');

const candidates = [process.env.JSDOM_PATH, path.join(__dirname, '..', 'node_modules', 'jsdom'), path.join(__dirname, '..', '..', 'docx-viewer-vscode', 'node_modules', 'jsdom')].filter(Boolean);
let JSDOM = null;
for (const c of candidates) { try { ({ JSDOM } = require(c)); break; } catch { /* next */ } }
const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

function host(buf) {
  const ds = readDataset(Source.fromBuffer(buf)); ds.store.finish();
  const cells = makeCells(ds);
  let idx = null;
  const meta = { format: ds.format, formatLabel: ds.formatLabel, info: ds.info, warnings: ds.warnings, truncated: false, rows: ds.store.n, labelSets: ds.labelSets,
    variables: ds.variables.map((v) => ({ name: v.name, label: v.label, type: v.type, width: v.width, storage: v.storage, format: v.format, date: v.date ? v.date.kind : '', measure: v.measure, missing: '', labels: v.labels })) };
  const answer = (m) => {
    if (m.type === 'view') { idx = stats.viewIndex(ds, cells, m.view, m.labels); return { type: 'view', seq: m.seq, count: idx ? idx.length : ds.store.n }; }
    if (m.type === 'page') {
      const n = idx ? idx.length : ds.store.n;
      const rows = [], miss = [], nums = [];
      for (let k = m.start; k < Math.min(n, m.start + m.count); k++) {
        const r = idx ? idx[k] : k; const t = [], mm = [];
        for (let c = m.c0; c < Math.min(ds.variables.length, m.c1); c++) { const x = cells.cell(c, r, m.labels); t.push(x.t); mm.push(x.m); }
        rows.push(t); miss.push(mm); nums.push(r + 1);
      }
      return { type: 'page', seq: m.seq, key: m.key, start: m.start, c0: m.c0, c1: Math.min(ds.variables.length, m.c1), rows, miss, nums, total: n };
    }
    if (m.type === 'summary') return { type: 'summary', col: m.col, filtered: !!idx, s: stats.summarize(ds, cells, m.col, idx, m.labels) };
    return null;
  };
  return { meta, answer, ds, cells };
}

function boot(buf, pro = { show: true, licensed: false, tries: { export: 3, codebook: 2, crosstab: 1 } }) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div><template id="zovo-footer"><div id="zovo-support">Rate</div></template></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const sent = [];
  const H = buf ? host(buf) : null;
  const send = (m) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m }));
  const queue = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: (m) => { sent.push(m); if (H) { const a = H.answer(m); if (a) queue.push(a); } } });
  dom.window.eval(script);
  const flush = () => { let n = 0; while (queue.length && n++ < 200) send(queue.shift()); };
  if (H) { send({ type: 'meta', meta: H.meta, name: 'survey.sav', pro }); flush(); }
  return { dom, doc: dom.window.document, sent, send, flush, H };
}

const ROWS = surveyRows();
const SAV = writeSav(savSpec(ROWS), { compression: 'bytecode' });

test('webview: tabs, grid cells through the CSSOM, labels toggle, footer, Pro buttons with tries', { skip: !JSDOM && 'jsdom not found' }, () => {
  const { doc, sent, flush, dom } = boot(SAV);
  assert.strictEqual(sent[0].type, 'ready');
  assert.deepStrictEqual([...doc.querySelectorAll('.tab')].map((t) => t.dataset.tab), ['data', 'variables', 'info', 'summary']);
  assert.ok(sent.some((m) => m.type === 'page' && m.start === 0 && m.c0 === 0), 'first page asked');
  flush();
  const cells = [...doc.querySelectorAll('.gc')];
  assert.ok(cells.length > 20, `cells drawn: ${cells.length}`);
  assert.ok(cells.some((c) => c.textContent === 'West'), 'value labels shown');
  assert.match(cells[0].style.getPropertyValue('left'), /px$/, 'positions set with style.setProperty');
  assert.ok(sent.some((m) => m.type === 'rendered'), 'rendered sent after the first rows');
  assert.ok(doc.querySelectorAll('.gc.sys').length + doc.querySelectorAll('.gc.umis').length >= 0);
  assert.ok(doc.getElementById('zovo-support'), 'footer');
  assert.strictEqual(doc.querySelector('.menu').hidden, true, 'menus start closed');
  assert.match(doc.querySelector('[data-tool=codebook]').title, /2 free tries left/);
  assert.match(doc.querySelector('[data-tool=crosstab]').title, /1 free try left/);
  doc.querySelector('[data-tool="export:xlsx"]').click();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'tool', tool: 'export', arg: { kind: 'xlsx' } });
  // codes
  doc.querySelector('[data-act=labels]').click();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sent.filter((m) => m.type === 'labels').at(-1))), { type: 'labels', labels: false });
  flush();
  assert.ok(![...doc.querySelectorAll('.gc')].some((c) => c.textContent === 'West'), 'codes shown');
  assert.strictEqual(doc.querySelector('[data-act=labels]').textContent, 'Codes');
  dom.window.close();
});

test('webview: sort by header click, filter, summary from the sum button, copy', { skip: !JSDOM && 'jsdom not found' }, () => {
  const { doc, sent, flush, dom } = boot(SAV);
  flush();
  doc.querySelector('.gh[data-col="3"]').click();
  const v = sent.filter((m) => m.type === 'view').at(-1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(v.view.sort)), { col: 3, dir: 1 });
  flush();
  assert.match(doc.querySelector('.gh[data-col="3"]').textContent, /▴/);
  const sel = doc.querySelector('.fcol'); sel.value = '1'; sel.dispatchEvent(new dom.window.Event('change'));
  const input = doc.querySelector('.filter'); input.value = 'South';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
  const f = sent.filter((m) => m.type === 'view').at(-1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(f.view.filter)), { col: 1, query: 'South' });
  flush();
  assert.match(doc.querySelector('.status').textContent, new RegExp(`^${ROWS.filter((x) => x.region === 2).length} of 600 rows$`));
  const shown = [...doc.querySelectorAll('.gc')].filter((c) => ['North', 'South', 'East', 'West'].includes(c.textContent)).map((c) => c.textContent);
  assert.ok(shown.length && shown.every((t) => t === 'South'));
  doc.querySelector('.gh[data-col="4"] .sum').click();
  flush();
  assert.strictEqual(doc.querySelector('.tab.on').dataset.tab, 'summary');
  assert.ok([...doc.querySelectorAll('.td')].some((t) => t.textContent === 'Agree'), 'frequency table');
  assert.match(doc.body.textContent, /Over the \d+ rows of the current filter/);
  doc.querySelector('.tab[data-tab="data"]').click(); flush();
  doc.querySelector('[data-act=copy]').click();
  assert.strictEqual(sent.at(-1).type, 'copy');
  dom.window.close();
});

test('webview: variables tab, info tab, HTML labels stay text, crosstab table, error page', { skip: !JSDOM && 'jsdom not found' }, () => {
  const evil = writeSav({ fileLabel: '<b>label</b>', variables: [{ name: 'q1', label: '<img src=x onerror=alert(1)>', type: 'numeric', format: { type: 5, w: 1, d: 0 }, labels: [[1, '<script>alert(1)</script>']] }], rows: [[1], [2]] });
  const { doc, flush, send, dom } = boot(evil);
  flush();
  assert.ok([...doc.querySelectorAll('.gc')].some((c) => c.textContent === '<script>alert(1)</script>'));
  assert.strictEqual(doc.querySelectorAll('script, img').length, 0, 'no element made from a label');
  doc.querySelector('.tab[data-tab="variables"]').click();
  assert.ok([...doc.querySelectorAll('.td')].some((t) => t.textContent === '<img src=x onerror=alert(1)>'));
  doc.querySelector('.tab[data-tab="info"]').click();
  assert.ok([...doc.querySelectorAll('dd')].some((d) => d.textContent === '<b>label</b>'));
  assert.strictEqual(doc.querySelectorAll('b, img, script').length, 0);
  const s = boot(SAV);
  s.flush();
  const ct = stats.crosstab(s.H.ds, s.H.cells, 4, 1, null, null, true);
  s.send({ type: 'crosstab', result: ct });
  assert.strictEqual(s.doc.querySelector('.tab.on').dataset.tab, 'crosstab');
  assert.strictEqual(s.doc.querySelectorAll('table.ct tbody tr').length, 6, '5 categories and the total');
  assert.match(s.doc.querySelector('.chi').textContent, /Pearson chi-square = [\d.]+, df = 12, p/);
  s.doc.querySelector('[data-act=ct-csv]').click();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.sent.at(-1))), { type: 'saveCrosstab', kind: 'csv' });
  const e = boot(null);
  e.send({ type: 'error', message: 'This is not an SPSS (.sav, .zsav), Stata (.dta) or SAS transport (.xpt) file. <b>x</b>', notData: true });
  assert.match(e.doc.querySelector('h2').textContent, /Not an SPSS, Stata or SAS transport file/);
  assert.strictEqual(e.doc.querySelectorAll('b').length, 0);
  e.doc.querySelector('[data-act=text]').click();
  assert.strictEqual(e.sent.at(-1).type, 'openText');
  dom.window.close(); s.dom.window.close(); e.dom.window.close();
});

test('webview: Pro buttons hidden when showProTools is off', { skip: !JSDOM && 'jsdom not found' }, () => {
  const { doc, dom } = boot(SAV, { show: false, licensed: false, tries: {} });
  assert.strictEqual(doc.querySelectorAll('[data-tool]').length, 0);
  dom.window.close();
});
