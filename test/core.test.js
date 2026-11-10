'use strict';
// Cell text, summaries, sort and filter, crosstab and chi-square, and the Pro outputs (CSV, JSON, XLSX, codebook),
// on datasets written by the test writers in scripts/.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');
const { Source } = require('../src/core/source');
const { readDataset, detect } = require('../src/core');
const { makeCells } = require('../src/core/format');
const stats = require('../src/core/stats');
const ex = require('../src/core/export');
const { writeXlsx, crc32, colName } = require('../src/core/xlsx');
const dates = require('../src/core/dates');
const { writeSav } = require('../scripts/make_sav');
const { writeDta } = require('../scripts/make_dta');
const { writeXpt } = require('../scripts/make_xpt');
const { surveyRows, savSpec, dtaSpec } = require('../scripts/make_samples');

const load = (buf) => { const ds = readDataset(Source.fromBuffer(buf)); ds.store.finish(); return { ds, cells: makeCells(ds) }; };
const ROWS = surveyRows();
const SAV = load(writeSav(savSpec(ROWS), { compression: 'bytecode' }));
const DTA = load(writeDta(dtaSpec(ROWS), { release: 118 }));

/** Minimal unzip for the XLSX checks (stored or deflated entries). */
function unzip(buf) {
  const out = {};
  let p = buf.readUInt32LE(buf.length - 22 + 16);
  const n = buf.readUInt16LE(buf.length - 22 + 10);
  for (let i = 0; i < n; i++) {
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42), csize = buf.readUInt32LE(p + 20), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lnl = buf.readUInt16LE(off + 26), lex = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnl + lex, off + 30 + lnl + lex + csize);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.strictEqual(crc32(raw), crc, `crc of ${name}`);
    out[name] = raw.toString('utf8');
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

test('detect: magic bytes pick the reader, not the file name', () => {
  assert.strictEqual(detect(writeSav(savSpec(ROWS.slice(0, 3))).subarray(0, 512)), 'sav');
  assert.strictEqual(detect(writeDta(dtaSpec(ROWS.slice(0, 3)), { release: 117 }).subarray(0, 512)), 'dta');
  assert.strictEqual(detect(writeDta(dtaSpec(ROWS.slice(0, 3)), { release: 114 }).subarray(0, 512)), 'dta');
  assert.strictEqual(detect(Buffer.from('hello world, this is text')), null);
  assert.throws(() => readDataset(Source.fromBuffer(Buffer.from('PK\x03\x04 not a data file'))), (e) => e.code === 'NOT_DATA' && /ZIP/.test(e.message));
  assert.throws(() => readDataset(Source.fromBuffer(Buffer.alloc(0))), (e) => e.code === 'NOT_DATA');
});

test('cells: value labels or codes, user-missing and extended missing, dates and decimals', () => {
  for (const { ds, cells } of [SAV, DTA]) {
    const r = 3;
    assert.strictEqual(cells.cell(1, r, true).t, 'West');
    assert.strictEqual(cells.cell(1, r, false).t, '4');
    assert.strictEqual(cells.cell(8, r, true).t, '2026-10-21');
    assert.match(cells.cell(6, r, true).t, /^\d+\.\d\d$/, 'income keeps 2 decimals');
    assert.strictEqual(ds.variables[9].type, 'string');
  }
  // the SPSS user-missing code 8 ("Don't know") is m=2 with its label; Stata .b is m=2 too
  const k = ROWS.findIndex((x) => x.sat === 8);
  assert.deepStrictEqual([SAV.cells.cell(4, k, true).t, SAV.cells.cell(4, k, true).m], ["Don't know", 2]);
  assert.deepStrictEqual([DTA.cells.cell(4, k, true).t, DTA.cells.cell(4, k, true).m], ['.b', 2]);
  const j = ROWS.findIndex((x) => Number.isNaN(x.income));
  assert.deepStrictEqual([SAV.cells.cell(6, j, true).t, SAV.cells.cell(6, j, true).m], ['.', 1]);
  assert.strictEqual(SAV.cells.exportValue(6, j, true), null);
  assert.strictEqual(SAV.cells.exportValue(1, 3, true), 'West');
  assert.strictEqual(SAV.cells.exportValue(1, 3, false), 4);
});

test('dates: SPSS, Stata and SAS epochs and Stata periods', () => {
  assert.strictEqual(dates.display(dates.spssFormat(20), 12219379200), '1970-01-01');
  assert.strictEqual(dates.display(dates.spssFormat(22), 12219379200 + 3661.5), '1970-01-01 01:01:01.500');
  assert.strictEqual(dates.display(dates.spssFormat(21), 3725), '01:02:05');
  assert.strictEqual(dates.display(dates.spssFormat(25), 90061), '1 01:01:01');
  assert.strictEqual(dates.display(dates.stataFormat('%td'), 0), '1960-01-01');
  assert.strictEqual(dates.display(dates.stataFormat('%tdCCYY-NN-DD'), -1), '1959-12-31');
  assert.strictEqual(dates.display(dates.stataFormat('%tc'), 86400000), '1960-01-02 00:00:00');
  assert.strictEqual(dates.display(dates.stataFormat('%tm'), 13), '1961m2');
  assert.strictEqual(dates.display(dates.stataFormat('%tq'), -1), '1959q4');
  assert.strictEqual(dates.display(dates.stataFormat('%ty'), 2026), '2026');
  assert.strictEqual(dates.display(dates.sasFormat('DATE9'), 0), '1960-01-01');
  assert.strictEqual(dates.display(dates.sasFormat('DATETIME20'), 86400), '1960-01-02 00:00:00');
  assert.strictEqual(dates.display(dates.sasFormat('BEST12'), 3), null);
  assert.strictEqual(dates.display(dates.stataFormat('%td'), Infinity), null);
  assert.strictEqual(dates.display(dates.stataFormat('%td'), 1e300), null);
});

test('summary: valid, missing, mean, sd, median and frequencies with valid percent', () => {
  const s = stats.summarize(SAV.ds, SAV.cells, 4, null, true);
  const valid = ROWS.filter((x) => x.sat !== 8);
  assert.strictEqual(s.valid, valid.length);
  assert.strictEqual(s.usermis, ROWS.length - valid.length);
  const mean = valid.reduce((a, x) => a + x.sat, 0) / valid.length;
  assert.ok(Math.abs(s.mean - mean) < 1e-12);
  const sd = Math.sqrt(valid.reduce((a, x) => a + (x.sat - mean) ** 2, 0) / (valid.length - 1));
  assert.ok(Math.abs(s.sd - sd) < 1e-12);
  const agree = s.freq.find((f) => f.label === 'Agree');
  assert.strictEqual(agree.count, ROWS.filter((x) => x.sat === 4).length);
  assert.ok(Math.abs(agree.validPct - (100 * agree.count) / valid.length) < 1e-9);
  assert.strictEqual(s.freq.at(-1).cumPct, null, 'missing rows have no cumulative percent');
  assert.ok(Math.abs(s.freq.filter((f) => !f.missing).at(-1).cumPct - 100) < 1e-9);
  const t = stats.summarize(SAV.ds, SAV.cells, 9, null, true);
  assert.strictEqual(t.empty, ROWS.filter((x) => x.comment === '').length);
  assert.ok(t.top.length > 0);
  const d = stats.summarize(SAV.ds, SAV.cells, 8, null, true);
  assert.match(d.minText, /^2026-09-0\d$/);
});

test('filter and sort: text, comparisons, ranges, missing; missing values sort last', () => {
  const { ds, cells } = SAV;
  const ix = (filter, sort, labels = true) => stats.viewIndex(ds, cells, { filter, sort }, labels);
  assert.strictEqual(ix({ col: 1, query: 'west' }).length, ROWS.filter((x) => x.region === 4).length);
  assert.strictEqual(ix({ col: 1, query: 'west' }, null, false).length, 0, 'codes do not contain "west"');
  assert.strictEqual(ix({ col: 3, query: '>= 65' }).length, ROWS.filter((x) => x.age >= 65).length);
  assert.strictEqual(ix({ col: 3, query: '30..39' }).length, ROWS.filter((x) => x.age >= 30 && x.age <= 39).length);
  assert.strictEqual(ix({ col: 6, query: 'missing' }).length, ROWS.filter((x) => Number.isNaN(x.income)).length);
  assert.strictEqual(ix({ col: 6, query: 'not missing' }).length, ROWS.filter((x) => !Number.isNaN(x.income)).length);
  const sorted = ix(null, { col: 6, dir: 1 });
  const vals = [...sorted].map((r) => ds.store.get(6, r));
  const firstNaN = vals.findIndex(Number.isNaN);
  assert.ok(vals.slice(firstNaN).every(Number.isNaN), 'missing last');
  for (let i = 1; i < firstNaN; i++) assert.ok(vals[i - 1] <= vals[i]);
  const desc = [...ix(null, { col: 6, dir: -1 })].map((r) => ds.store.get(6, r));
  assert.ok(desc[0] >= desc[1]);
  const both = ix({ col: 1, query: 'north' }, { col: 3, dir: 1 });
  assert.ok([...both].every((r) => ds.store.get(1, r) === 1));
  assert.strictEqual(stats.viewIndex(ds, cells, { filter: null, sort: null }, true), null);
  assert.throws(() => stats.parseFilter('x'.repeat(1001)), /1,000/);
});

test('chi-square p-values match the table values', () => {
  assert.ok(Math.abs(stats.chiSquareP(3.841459, 1) - 0.05) < 1e-6);
  assert.ok(Math.abs(stats.chiSquareP(5.991465, 2) - 0.05) < 1e-6);
  assert.ok(Math.abs(stats.chiSquareP(6.634897, 1) - 0.01) < 1e-6);
  assert.ok(Math.abs(stats.chiSquareP(18.307038, 10) - 0.05) < 1e-6);
  assert.ok(Math.abs(stats.chiSquareP(0, 3) - 1) < 1e-12);
  assert.ok(stats.chiSquareP(500, 4) < 1e-100);
});

test('crosstab: counts and chi-square equal a direct count; layers; too many categories refused', () => {
  const { ds, cells } = SAV;
  const ct = stats.crosstab(ds, cells, 1, 7, null, null, true);
  const t = ct.tables[0];
  assert.deepStrictEqual(t.rowText, ['North', 'South', 'East', 'West']);
  assert.deepStrictEqual(t.colText, ['Web', 'Phone', 'Store']);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) assert.strictEqual(t.counts[i][j], ROWS.filter((x) => x.region === i + 1 && x.channel === j + 1).length);
  assert.strictEqual(t.n, ROWS.length);
  let chi = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) { const e = (t.rowTotals[i] * t.colTotals[j]) / t.n; chi += (t.counts[i][j] - e) ** 2 / e; }
  assert.ok(Math.abs(t.chi2 - chi) < 1e-9);
  assert.strictEqual(t.df, 6);
  const sat = stats.crosstab(ds, cells, 4, 1, null, null, true);
  assert.strictEqual(sat.missingRows, ROWS.filter((x) => x.sat === 8).length, 'user-missing rows are left out');
  const lay = stats.crosstab(ds, cells, 1, 7, 2, null, true);
  assert.deepStrictEqual(lay.tables.map((x) => x.layerText), ['Female', 'Male', 'Another gender']);
  assert.throws(() => stats.crosstab(ds, cells, 0, 1, null, null, true), (e) => e.code === 'TOO_MANY');
  assert.throws(() => stats.crosstab(ds, cells, 1, 1, null, null, true), /two different/);
  const csv = ex.crosstabCsv(ct);
  assert.match(csv, /Pearson chi-square = /);
  const md = ex.crosstabMarkdown(lay, 'survey.sav');
  assert.match(md, /## gender = Female/);
});

test('CSV export: header, labels or codes, quoting, missing as empty, current view only', () => {
  const { ds, cells } = SAV;
  const csv = ex.toCsv(ds, cells, null, { labels: true }).toString('utf8').split('\r\n');
  assert.strictEqual(csv[0], 'id,region,gender,age,satisfaction,recommend,income,channel,interview_date,comment');
  assert.strictEqual(csv.length, ROWS.length + 2);
  assert.match(csv[4], /^4,West,Male,63,/);
  const codes = ex.toCsv(ds, cells, null, { labels: false }).toString('utf8').split('\r\n');
  assert.match(codes[4], /^4,4,2,63,/);
  const idx = stats.viewIndex(ds, cells, { filter: { col: 1, query: 'South' } }, true);
  assert.strictEqual(ex.toCsv(ds, cells, idx, { labels: true }).toString().trim().split('\r\n').length, idx.length + 1);
  assert.strictEqual(ex.csvField('a,"b"'), '"a,""b"""');
  assert.strictEqual(ex.csvField(null), '');
});

test('JSON export: variables with value labels and rows with null for missing', () => {
  const j = JSON.parse(ex.toJson(SAV.ds, SAV.cells, null, { labels: false, name: 'survey.sav' }).toString('utf8'));
  assert.strictEqual(j.rows.length, ROWS.length);
  assert.strictEqual(j.variables[1].valueLabels['4'], 'West');
  assert.strictEqual(j.variables[2].missing, '9');
  const k = ROWS.findIndex((x) => Number.isNaN(x.income));
  assert.strictEqual(j.rows[k].income, null);
  assert.strictEqual(j.rows[3].region, 4);
  assert.strictEqual(j.rows[3].interview_date, '2026-10-21');
});

test('XLSX export: a valid zip with Data and Variables sheets, inline strings, no formulas', () => {
  const r = ex.toXlsx(SAV.ds, SAV.cells, null, { labels: true });
  const files = unzip(r.buffer);
  assert.ok(files['[Content_Types].xml'] && files['xl/workbook.xml'] && files['xl/styles.xml']);
  assert.match(files['xl/workbook.xml'], /name="Data"/);
  assert.match(files['xl/workbook.xml'], /name="Variables"/);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.strictEqual((sheet.match(/<row /g) || []).length, ROWS.length + 1);
  assert.match(sheet, /<c r="B5" t="inlineStr"><is><t xml:space="preserve">West<\/t>/);
  assert.ok(!/<f>/.test(sheet));
  const x = writeXlsx([{ name: 'a/b', rows: [['h'], ['=1+1'], ['<b>&"'], ['\u0001ok']], ncols: 1 }]);
  const s2 = unzip(x)['xl/worksheets/sheet1.xml'];
  assert.match(s2, /=1\+1<\/t>/);
  assert.match(s2, /&lt;b&gt;&amp;&quot;/);
  assert.match(s2, />ok</);
  assert.strictEqual(colName(0), 'A'); assert.strictEqual(colName(25), 'Z'); assert.strictEqual(colName(26), 'AA'); assert.strictEqual(colName(16383), 'XFD');
});

test('XLSX opens in SheetJS with the same values (when a SheetJS copy is on this machine)', (t) => {
  let XLSX;
  for (const c of [process.env.XLSX_PATH, path.join(__dirname, '..', '..', 'table-viewer-vscode', 'node_modules', 'xlsx')].filter(Boolean)) { try { XLSX = require(c); break; } catch { /* next */ } }
  if (!XLSX) { t.skip('SheetJS not found'); return; }
  const r = ex.toXlsx(DTA.ds, DTA.cells, null, { labels: false });
  const wb = XLSX.read(r.buffer, { type: 'buffer' });
  assert.deepStrictEqual(wb.SheetNames, ['Data', 'Variables']);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Data);
  assert.strictEqual(rows.length, ROWS.length);
  assert.strictEqual(rows[3].region, 4);
  assert.strictEqual(rows[3].comment, ROWS[3].comment || undefined);
  assert.ok(Math.abs(rows[3].income - ROWS[3].income) < 1e-9);
});

test('codebook: Markdown, HTML and CSV list every variable, value labels and counts; HTML escapes labels', () => {
  const md = ex.codebookMarkdown(SAV.ds, SAV.cells, null, 'survey.sav');
  for (const v of SAV.ds.variables) assert.ok(md.includes(`## ${v.name}`), v.name);
  assert.match(md, /\| 4 \| Agree \| \d+ \|/);
  assert.match(md, /Missing values: 8/);
  const evil = load(writeSav({ variables: [{ name: 'q1', label: '<script>alert(1)</script>', type: 'numeric', format: { type: 5, w: 1, d: 0 }, labels: [[1, '<img src=x onerror=alert(1)>']] }], rows: [[1], [1], [2]] }));
  const html = ex.codebookHtml(evil.ds, evil.cells, null, '<b>x</b>.sav');
  assert.ok(!/<script>|<img/.test(html));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const csv = ex.codebookCsv(SAV.ds, SAV.cells, null).split('\r\n');
  assert.match(csv[0], /^variable,label,type/);
  assert.ok(csv.some((l) => /^region,Region,.*,4,West,\d+,/.test(l)));
});

test('SAS transport: read through the same pipeline', () => {
  const buf = writeXpt({ name: 'DM', variables: [{ name: 'USUBJID', label: 'Subject', type: 'string', length: 12 }, { name: 'AGE', label: 'Age', type: 'numeric' }, { name: 'RFSTDTC', label: 'Start', type: 'numeric', format: 'DATE9' }], rows: [['S-001', 54, 0], ['S-002', NaN, 366]] });
  const { ds, cells } = load(buf);
  assert.strictEqual(ds.format, 'xpt');
  assert.strictEqual(cells.cell(0, 1, true).t, 'S-002');
  assert.strictEqual(cells.cell(1, 1, true).t, '.');
  assert.strictEqual(cells.cell(2, 1, true).t, '1961-01-01');
});
