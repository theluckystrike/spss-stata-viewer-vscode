'use strict';
// SAS transport (XPORT v5) reader: IBM floats, missing values, members, padding, and hostile files.
const test = require('node:test');
const assert = require('node:assert');
const { writeXpt, ibmBytes } = require('../scripts/make_xpt');
const xpt = require('../src/core/xpt');
const { Source, DataError } = require('../src/core/source');
const dates = require('../src/core/dates');

const read = (buf, limits) => xpt.read(Source.fromBuffer(buf), limits);
const close = (a, b, rel = 1e-12) => (a === b) || Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));

function dm() {
  return {
    name: 'DM', label: 'Demographics <b>',
    variables: [
      { name: 'USUBJID', label: 'Unique Subject ID', type: 'string', length: 12 },
      { name: 'AGE', label: 'Age in years', type: 'numeric' },
      { name: 'BRTHDT', label: 'Birth date', type: 'numeric', format: 'DATE9.' },
      { name: 'VISITDTM', type: 'numeric', format: 'DATETIME20.' },
      { name: 'WT', type: 'numeric', length: 4 },
      { name: 'SEX', type: 'string', length: 1 },
    ],
    rows: [
      ['S-001', 34, 0, 0, 70.5, 'M'],
      ['S-002', -0.1, 366, 86400, NaN, 'F'],
      ['S-003', 1e-30, { miss: 'A' }, { miss: '_' }, { miss: 'Z' }, ''],
      ['<i>x</i>', 1e30, -21914, 1.5e9, 3, 'M'],
    ],
  };
}

test('IBM float conversion round trips (8 bytes within 1e-15, 4 bytes within 1e-6)', () => {
  const vals = [1, -1, 0.1, -0.1, 1 / 3, 123456789.123, 1e-30, 1e30, 5e-75, 7e75, 2 ** 52, Math.PI, 0.5, 100, -2.5e-12];
  for (let i = 0; i < 2000; i++) vals.push((Math.random() - 0.5) * 10 ** Math.floor(Math.random() * 40 - 20));
  for (const v of vals) {
    const b8 = ibmBytes(v, 8);
    const [x8, m8] = xpt.ibm(b8, 0, 8);
    assert.strictEqual(m8, -1);
    assert.ok(close(x8, v, 1e-15), `${v} -> ${x8}`);
    const [x4] = xpt.ibm(ibmBytes(v, 4), 0, 4);
    assert.ok(close(x4, v, 1e-6), `${v} (4 bytes) -> ${x4}`);
  }
  assert.deepStrictEqual(xpt.ibm(Buffer.from([0x41, 0x10, 0, 0, 0, 0, 0, 0]), 0, 8), [1, -1]);
  assert.deepStrictEqual(xpt.ibm(Buffer.from([0xc2, 0x76, 0xa0, 0, 0, 0, 0, 0]), 0, 8), [-118.625, -1]);
  assert.deepStrictEqual(xpt.ibm(Buffer.alloc(8), 0, 8), [0, -1]);
});

test('round trip: numbers, strings, dates, missing . .A .Z ._', () => {
  const ds = read(writeXpt(dm()));
  assert.strictEqual(ds.format, 'xpt');
  assert.match(ds.formatLabel, /version 5/);
  assert.strictEqual(ds.info.rows, 4);
  assert.strictEqual(ds.info.member, 'DM');
  assert.strictEqual(ds.info.fileLabel, 'Demographics <b>');
  assert.strictEqual(ds.store.n, 4);
  assert.deepStrictEqual(ds.variables.map((v) => [v.name, v.type, v.storage]), [
    ['USUBJID', 'string', 'char12'], ['AGE', 'numeric', 'num8'], ['BRTHDT', 'numeric', 'num8'], ['VISITDTM', 'numeric', 'num8'], ['WT', 'numeric', 'num4'], ['SEX', 'string', 'char1']]);
  assert.strictEqual(ds.variables[0].label, 'Unique Subject ID');
  assert.strictEqual(ds.variables[2].format, 'DATE9.');
  const g = (c, r) => ds.store.get(c, r);
  assert.deepStrictEqual([g(0, 0), g(0, 3), g(5, 2)], ['S-001', '<i>x</i>', '']);
  assert.ok(close(g(1, 1), -0.1) && close(g(1, 2), 1e-30) && close(g(1, 3), 1e30));
  assert.ok(Number.isNaN(g(4, 1)) && ds.store.missCode(4, 1) === 0);
  assert.strictEqual(ds.store.missCode(2, 2), 1);
  assert.strictEqual(ds.store.missCode(3, 2), 27);
  assert.strictEqual(ds.store.missCode(4, 2), 26);
  assert.ok(close(g(4, 0), 70.5, 1e-6));
  const d = (c, r) => dates.display(ds.variables[c].date, g(c, r));
  assert.deepStrictEqual([d(2, 0), d(2, 1), d(2, 3), d(3, 1)], ['1960-01-01', '1961-01-01', '1900-01-01', '1960-01-02 00:00:00']);
  assert.deepStrictEqual(ds.warnings, []);
});

test('two members: the first is read, the other is named', () => {
  const ae = { name: 'AE', label: 'Adverse events', variables: [{ name: 'AETERM', type: 'string', length: 20 }], rows: [['Headache'], ['Nausea']] };
  const ds = read(writeXpt({ members: [dm(), ae] }));
  assert.strictEqual(ds.store.n, 4);
  assert.strictEqual(ds.info.member, 'DM');
  assert.ok(ds.info.notes.some((n) => /2 datasets \(DM, AE\); showing DM/.test(n)));
  const only = read(writeXpt(ae));
  assert.deepStrictEqual([only.store.get(0, 0), only.store.get(0, 1)], ['Headache', 'Nausea']);
});

test('row count ignores the space padding of the last record', () => {
  for (let rows = 0; rows < 25; rows++) {
    const m = { name: 'P', variables: [{ name: 'X', type: 'numeric' }, { name: 'C', type: 'string', length: 3 }], rows: [] };
    for (let i = 0; i < rows; i++) m.rows.push([i, 'abc']);
    const ds = read(writeXpt(m));
    assert.strictEqual(ds.store.n, rows, `rows ${rows}`);
  }
});

test('sniff', () => {
  assert.ok(xpt.sniff(writeXpt(dm()).subarray(0, 80)));
  assert.ok(!xpt.sniff(Buffer.from('HEADER RECORD but not really, just some text that is long enough')));
});

test('wrong magic and short files', () => {
  assert.throws(() => read(Buffer.alloc(400, 0x41)), (e) => e instanceof DataError && e.code === 'NOT_DATA');
  assert.throws(() => read(Buffer.from('short')), (e) => e.code === 'NOT_DATA');
});

test('every prefix cut gives a dataset or a DataError', () => {
  const full = writeXpt({ members: [dm(), { name: 'B', variables: [{ name: 'Y', type: 'numeric' }], rows: [[1]] }] });
  const t0 = Date.now();
  for (let n = 0; n < full.length; n++) {
    try { const ds = read(full.subarray(0, n)); assert.ok(ds.store.n <= 4); } catch (e) { assert.ok(e instanceof DataError, `cut at ${n}: ${e && e.stack}`); }
  }
  assert.ok(Date.now() - t0 < 8000);
});

test('NAMESTR count 9999 in a short file, impossible lengths and types', () => {
  const m = dm(); m.namestrCount = 9999;
  assert.throws(() => read(writeXpt(m)), (e) => e instanceof DataError && /9999 variables/.test(e.message));
  const b = Buffer.from(writeXpt(dm()));
  const ns = 80 * 8; // 3 library records + 5 member records
  const len = Buffer.from(b); len.writeInt16BE(0, ns + 140 + 4); // AGE length 0
  assert.throws(() => read(len), (e) => e instanceof DataError);
  const typ = Buffer.from(b); typ.writeInt16BE(7, ns);
  assert.throws(() => read(typ), (e) => e instanceof DataError && /unknown type/.test(e.message));
  const pos = Buffer.from(b); pos.writeInt32BE(-5, ns + 84);
  assert.throws(() => read(pos), (e) => e instanceof DataError);
});

test('a huge position makes no giant allocation (rows cut by the file size)', () => {
  const b = Buffer.from(writeXpt(dm()));
  b.writeInt32BE(0x7fff0000, 80 * 8 + 84);
  const ds = read(b);
  assert.strictEqual(ds.store.n, 0);
});

test('the cell limit cuts rows with a warning', () => {
  const m = { name: 'BIG', variables: [{ name: 'X', type: 'numeric' }, { name: 'Y', type: 'numeric' }], rows: [] };
  for (let i = 0; i < 3000; i++) m.rows.push([i, -i]);
  const ds = read(writeXpt(m), { maxCells: 1000 });
  assert.strictEqual(ds.store.n, 500);
  assert.ok(ds.truncated && ds.warnings.some((w) => /first 500 rows/.test(w)));
  assert.strictEqual(ds.store.get(1, 499), -499);
});

test('XPORT version 8: long names, long labels, two members', () => {
  const m = { name: 'DEMOGRAPHICS_LONG_NAME', label: 'Version 8', variables: [
    { name: 'subject_identifier_x', label: 'A label that is much longer than forty characters, kept whole', type: 'string', length: 30 },
    { name: 'age_in_years', label: 'Age', type: 'numeric' }], rows: [['first subject', 41], ['second', { miss: 'B' }]] };
  const ds = read(writeXpt({ members: [m, { name: 'SECOND', variables: [{ name: 'x', type: 'numeric' }], rows: [[1]] }] }, { v8: true }));
  assert.match(ds.formatLabel, /version 8/);
  assert.strictEqual(ds.info.member, 'DEMOGRAPHICS_LONG_NAME');
  assert.deepStrictEqual(ds.variables.map((v) => v.name), ['subject_identifier_x', 'age_in_years']);
  assert.strictEqual(ds.variables[0].label, 'A label that is much longer than forty characters, kept whole');
  assert.deepStrictEqual([ds.store.get(0, 0), ds.store.get(1, 0), ds.store.get(0, 1), ds.store.missCode(1, 1)], ['first subject', 41, 'second', 2]);
  assert.ok(ds.info.notes.some((n) => /2 datasets/.test(n)));
});

test('positions that do not match the rows: text columns decide the layout', () => {
  const m = { name: 'L', variables: [{ name: 'N1', type: 'numeric' }, { name: 'C1', type: 'string', length: 16 }, { name: 'N2', type: 'numeric' }], rows: [] };
  for (let i = 0; i < 10; i++) m.rows.push([i + 0.5, `row number ${i}`, -i]);
  // the writer stores rows in variable order (N1 at 0, C1 at 8, N2 at 24); the namestr says numbers first (N2 at 8, C1 at 16)
  const bad = read(writeXpt({ ...m, npos: [0, 16, 8] }));
  assert.strictEqual(bad.store.get(1, 3), 'row number 3');
  assert.strictEqual(bad.store.get(2, 3), -3);
  assert.ok(bad.info.notes.some((n) => /variable order/.test(n)));
  // a real reordered layout (rows written by npos) keeps npos
  const good = read(writeXpt(m));
  assert.deepStrictEqual(good.info.notes, []);
});
