'use strict';
// SPSS reader: round trips through the fixture writer (scripts/make_sav.js) and hostile files built in memory.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const sav = require('../src/core/sav');
const { Source, DataError } = require('../src/core/source');
const dates = require('../src/core/dates');
const { writeSav } = require('../scripts/make_sav');

const read = (buf, limits) => sav.read(Source.fromBuffer(buf), limits);
const col = (ds, name) => ds.variables.findIndex((v) => v.name === name);
const cell = (ds, name, r) => ds.store.get(col(ds, name), r);
const SPSS_DAY = (y, m, d) => (Date.UTC(y, m - 1, d) + 12219379200000) / 1000;

const LONG600 = 'a'.repeat(250) + 'B'.repeat(300) + 'end-of-600'.padEnd(50, '.');
const SPEC = {
  fileLabel: 'Household survey <b>2026</b>',
  documents: ['Made-up data for tests.', 'Second line.'],
  weight: 'weight',
  variables: [
    { name: 'respondent_id', label: 'Respondent', type: 'numeric', format: { type: 5, w: 6, d: 0 }, measure: 'nominal' },
    { name: 'satisfaction', label: 'How satisfied are you?', type: 'numeric', format: { type: 5, w: 2, d: 0 }, measure: 'ordinal',
      labels: [[1, 'Not at all'], [2, 'Somewhat'], [3, '<script>alert(1)</script>']], missing: { values: [8, 9] } },
    { name: 'income', label: 'Income', type: 'numeric', format: { type: 5, w: 10, d: 2 }, measure: 'scale', missing: { range: [-Infinity, -1], values: [] } },
    { name: 'age', type: 'numeric', missing: { range: [990, 999], values: [-9] } },
    { name: 'city', label: 'City', type: 'string', width: 20, labels: [['Paris', 'Capital'], ['Lyon', 'Second city']], missing: { values: ['UNKNOWN'] } },
    { name: 'sex', type: 'string', width: 1, labels: [['F', 'Female'], ['M', 'Male']], missing: { values: ['X'] } },
    { name: 'comment', label: 'Open answer', type: 'string', width: 600 },
    { name: 'born', type: 'numeric', format: { type: 20, w: 11, d: 0 } },
    { name: 'interviewed_at', type: 'numeric', format: { type: 22, w: 20, d: 0 } },
    { name: 'duration', type: 'numeric', format: { type: 21, w: 8, d: 0 } },
    { name: 'weight', type: 'numeric', format: { type: 5, w: 8, d: 3 } },
  ],
  rows: [
    [1, 2, 52000.5, 34, 'Paris', 'F', LONG600, SPSS_DAY(1990, 5, 17), SPSS_DAY(2026, 11, 10) + 3600 * 13 + 61, 3725, 1.25],
    [2, 9, -5, 999, 'UNKNOWN', 'X', '', NaN, NaN, NaN, 0.75],
    [3, NaN, 1e10, -9, 'Lyon', 'M', 'café ünïcode ✓', SPSS_DAY(1582, 10, 14), SPSS_DAY(1970, 1, 1), 0, 1],
  ],
};

function checkSpec(ds, label) {
  assert.strictEqual(ds.store.n, 3, label);
  assert.strictEqual(ds.variables.length, SPEC.variables.length, label);
  assert.deepStrictEqual(ds.variables.map((v) => v.name), SPEC.variables.map((v) => v.name), label);
  assert.strictEqual(ds.info.fileLabel, SPEC.fileLabel);
  assert.deepStrictEqual(ds.info.notes, SPEC.documents);
  assert.strictEqual(ds.info.weight, 'weight');
  assert.strictEqual(ds.info.rows, 3);
  assert.strictEqual(cell(ds, 'respondent_id', 2), 3);
  assert.strictEqual(cell(ds, 'income', 0), 52000.5);
  assert.strictEqual(cell(ds, 'income', 2), 1e10);
  assert.ok(Number.isNaN(cell(ds, 'satisfaction', 2)), 'sysmis is NaN');
  assert.strictEqual(cell(ds, 'city', 0), 'Paris');
  assert.strictEqual(cell(ds, 'comment', 0), LONG600);
  assert.strictEqual(cell(ds, 'comment', 1), '');
  assert.strictEqual(cell(ds, 'comment', 2), 'café ünïcode ✓');
  assert.strictEqual(cell(ds, 'weight', 1), 0.75);
  const v = (n) => ds.variables[col(ds, n)];
  assert.strictEqual(v('comment').width, 600);
  assert.strictEqual(v('comment').type, 'string');
  assert.strictEqual(v('income').format, 'F10.2');
  assert.strictEqual(v('city').format, 'A20');
  assert.strictEqual(v('satisfaction').measure, 'ordinal');
  assert.strictEqual(v('income').measure, 'scale');
  assert.strictEqual(v('city').measure, 'nominal');
  assert.strictEqual(v('satisfaction').label, 'How satisfied are you?');
  assert.deepStrictEqual(v('satisfaction').missing, { values: [8, 9], range: null });
  assert.deepStrictEqual(v('income').missing, { values: [], range: [-Infinity, -1] });
  assert.deepStrictEqual(v('age').missing, { values: [-9], range: [990, 999] });
  assert.deepStrictEqual(v('city').missing, { values: ['UNKNOWN'], range: null });
  assert.deepStrictEqual(v('sex').missing, { values: ['X'], range: null });
  assert.deepStrictEqual(ds.labelSets[v('satisfaction').labels], [[1, 'Not at all'], [2, 'Somewhat'], [3, '<script>alert(1)</script>']]);
  assert.deepStrictEqual(ds.labelSets[v('sex').labels], [['F', 'Female'], ['M', 'Male']]);
  assert.deepStrictEqual(ds.labelSets[v('city').labels], [['Paris', 'Capital'], ['Lyon', 'Second city']]);
  assert.deepStrictEqual(v('born').date, { base: 'spss', kind: 'date' });
  assert.strictEqual(dates.display(v('born').date, cell(ds, 'born', 0)), '1990-05-17');
  assert.strictEqual(dates.display(v('born').date, cell(ds, 'born', 2)), '1582-10-14');
  assert.strictEqual(dates.display(v('interviewed_at').date, cell(ds, 'interviewed_at', 0)), '2026-11-10 13:01:01');
  assert.strictEqual(dates.display(v('duration').date, cell(ds, 'duration', 0)), '01:02:05');
  assert.strictEqual(v('interviewed_at').format, 'DATETIME20');
  assert.deepStrictEqual(ds.warnings, [], label);
}

for (const compression of ['none', 'bytecode', 'zlib']) {
  for (const bigEndian of [false, true]) {
    test(`round trip: ${compression}, ${bigEndian ? 'big' : 'little'}-endian`, () => {
      const ds = read(writeSav(SPEC, { compression, bigEndian }));
      checkSpec(ds, `${compression} ${bigEndian}`);
      assert.strictEqual(ds.format, compression === 'zlib' ? 'zsav' : 'sav');
      assert.strictEqual(ds.info.compression, compression);
      assert.strictEqual(ds.info.byteOrder, bigEndian ? 'big-endian' : 'little-endian');
      assert.strictEqual(ds.info.encoding, 'utf-8');
    });
  }
}

test('sniff', () => {
  assert.ok(sav.sniff(Buffer.from('$FL2xxxx')));
  assert.ok(sav.sniff(Buffer.from('$FL3')));
  assert.ok(!sav.sniff(Buffer.from('$FL4')));
  assert.ok(!sav.sniff(Buffer.from('<st')));
  assert.ok(!sav.sniff(null));
});

test('zsav with many small blocks', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => [i, i * 1.5, `row ${i}`]);
  const spec = { variables: [{ name: 'i', type: 'numeric' }, { name: 'x', type: 'numeric' }, { name: 's', type: 'string', width: 12 }], rows };
  const ds = read(writeSav(spec, { compression: 'zlib', blockSize: 512 }));
  assert.strictEqual(ds.store.n, 2000);
  assert.strictEqual(ds.store.get(1, 1999), 1999 * 1.5);
  assert.strictEqual(ds.store.get(2, 1234), 'row 1234');
  assert.deepStrictEqual(ds.warnings, []);
});

test('windows-1252 encoding', () => {
  const spec = { variables: [{ name: 'name', label: 'Prénom', type: 'string', width: 10, labels: [['Zoë', 'Zoë label']] }], rows: [['Zoë'], ['Ångström']] };
  const ds = read(writeSav(spec, { encoding: 'windows-1252' }));
  assert.strictEqual(ds.info.encoding, 'windows-1252');
  assert.strictEqual(ds.store.get(0, 0), 'Zoë');
  assert.strictEqual(ds.store.get(0, 1), 'Ångström');
  assert.strictEqual(ds.variables[0].label, 'Prénom');
  assert.deepStrictEqual(ds.labelSets[ds.variables[0].labels], [['Zoë', 'Zoë label']]);
});

test('UTF-8 string cut inside a character drops the partial character', () => {
  const spec = { variables: [{ name: 's', type: 'string', width: 4 }], rows: [['aé✓']] }; // 1 + 2 + 3 bytes, cut at 4
  const ds = read(writeSav(spec));
  assert.strictEqual(ds.store.get(0, 0), 'aé');
  assert.deepStrictEqual(Array.from(sav.cutPartial(Buffer.from([0x61, 0xe2, 0x9c]))), [0x61]);
});

test('long names (more than 8 bytes, also non-ASCII cut in the short name)', () => {
  const spec = { variables: [{ name: 'a_very_long_variable_name_64', type: 'numeric' }, { name: 'ותק_בעבודה', type: 'numeric' }, { name: 'a_very_long_variable_name_65', type: 'numeric' }], rows: [[1, 2, 3]] };
  const ds = read(writeSav(spec));
  assert.deepStrictEqual(ds.variables.map((v) => v.name), ['a_very_long_variable_name_64', 'ותק_בעבודה', 'a_very_long_variable_name_65']);
  assert.deepStrictEqual([0, 1, 2].map((c) => ds.store.get(c, 0)), [1, 2, 3]);
});

test('very long string of 32,767 bytes, long string labels and missing values', () => {
  const big = 'x'.repeat(32760) + 'ENDING!';
  const spec = {
    variables: [
      { name: 'n', type: 'numeric' },
      { name: 'huge', type: 'string', width: 32767 },
      { name: 'code', type: 'string', width: 12, labels: [['ABCDEFGHIJ', '<b>ten letters</b>']], missing: { values: ['NONE', 'N/A'] } },
      { name: 'after', type: 'numeric' },
    ],
    rows: [[1, big, 'ABCDEFGHIJ', 7], [2, 'short', 'NONE', 8]],
  };
  for (const compression of ['none', 'bytecode', 'zlib']) {
    const ds = read(writeSav(spec, { compression }));
    assert.strictEqual(ds.variables.length, 4);
    assert.strictEqual(ds.variables[1].width, 32767);
    assert.strictEqual(ds.store.get(1, 0), big);
    assert.strictEqual(ds.store.get(1, 0).length, 32767);
    assert.strictEqual(ds.store.get(1, 1), 'short');
    assert.strictEqual(ds.store.get(3, 0), 7);
    assert.strictEqual(ds.store.get(3, 1), 8);
    assert.deepStrictEqual(ds.labelSets[ds.variables[2].labels], [['ABCDEFGHIJ', '<b>ten letters</b>']]);
    assert.deepStrictEqual(ds.variables[2].missing, { values: ['NONE', 'N/A'], range: null });
  }
});

test('64-bit case count (header -1, subtype 16)', () => {
  const spec = { variables: [{ name: 'x', type: 'numeric' }], rows: [[1], [2], [3]] };
  const ds = read(writeSav(spec, { ncases: -1, case64: true }));
  assert.strictEqual(ds.info.rows, 3);
  assert.strictEqual(ds.store.n, 3);
  const ds2 = read(writeSav(spec, { ncases: -1 }));
  assert.strictEqual(ds2.info.rows, null);
  assert.strictEqual(ds2.store.n, 3);
});

test('header says more rows than the data has: warning, rows kept', () => {
  const spec = { variables: [{ name: 'x', type: 'numeric' }], rows: [[1], [2]] };
  const ds = read(writeSav(spec, { ncases: 0x7fffffff }));
  assert.strictEqual(ds.store.n, 2);
  assert.ok(ds.warnings.some((w) => /2,147,483,647 rows/.test(w)), ds.warnings.join());
});

test('wrong magic gives NOT_DATA', () => {
  for (const b of [Buffer.from('PK\x03\x04 not a sav file at all'), Buffer.alloc(0), Buffer.from('$FL')]) {
    assert.throws(() => read(b), (e) => e instanceof DataError && e.code === 'NOT_DATA');
  }
});

test('every prefix of a small file: rows or a DataError, never anything else', () => {
  const spec = { ...SPEC, rows: SPEC.rows.slice(0, 2) };
  for (const compression of ['bytecode', 'none', 'zlib']) {
    const full = writeSav(spec, { compression });
    let ok = 0, errs = 0;
    for (let n = 0; n < full.length; n++) {
      try { const ds = read(full.subarray(0, n)); assert.ok(ds.store.n <= 2); ok++; } catch (e) {
        if (!(e instanceof DataError)) throw new Error(`prefix ${n} (${compression}): ${e && e.stack}`);
        errs++;
      }
    }
    assert.ok(errs > 0 && ok >= 0);
  }
});

// hand-made dictionaries for hostile counts
function header(nominal = 1, compression = 1, ncases = -1) {
  const b = Buffer.alloc(176, 0x20);
  b.write('$FL2', 0, 'latin1');
  b.writeInt32LE(2, 64); b.writeInt32LE(nominal, 68); b.writeInt32LE(compression, 72); b.writeInt32LE(0, 76);
  b.writeInt32LE(ncases, 80); b.writeDoubleLE(100, 84);
  return b;
}
const i32 = (...xs) => { const b = Buffer.alloc(xs.length * 4); xs.forEach((x, i) => b.writeInt32LE(x, i * 4)); return b; };
const numVar = (name) => Buffer.concat([i32(2, 0, 0, 0, 0x050802, 0x050802), Buffer.from(name.padEnd(8))]);
const END = i32(999, 0);

test('hostile counts of 2^31-1 give a DataError quickly (no allocation)', () => {
  const H = 0x7fffffff;
  const cases = {
    'value label count': Buffer.concat([header(), numVar('A'), i32(3, H), END]),
    'value label var count': Buffer.concat([header(), numVar('A'), i32(3, 1), Buffer.alloc(8), Buffer.from([1, 0x41, 0, 0, 0, 0, 0, 0]), i32(4, H), END]),
    'document lines': Buffer.concat([header(), numVar('A'), i32(6, H), END]),
    'extension size x count': Buffer.concat([header(), numVar('A'), i32(7, 3, 4, H), END]),
    'extension negative': Buffer.concat([header(), numVar('A'), i32(7, 3, -4, 8), END]),
    'variable label length': Buffer.concat([header(), Buffer.concat([i32(2, 0, 1, 0, 0x050802, 0x050802), Buffer.from('A'.padEnd(8)), i32(H)]), END]),
    'missing value count': Buffer.concat([header(), Buffer.concat([i32(2, 0, 0, H, 0x050802, 0x050802), Buffer.from('A'.padEnd(8))]), END]),
    'variable type': Buffer.concat([header(), Buffer.concat([i32(2, H, 0, 0, 0x050802, 0x050802), Buffer.from('A'.padEnd(8))]), END]),
    'unknown record': Buffer.concat([header(), numVar('A'), i32(H), END]),
    'record 4 alone': Buffer.concat([header(), numVar('A'), i32(4, 1, 1), END]),
    'continuation first': Buffer.concat([header(), Buffer.concat([i32(2, -1, 0, 0, 0, 0), Buffer.alloc(8)]), END]),
    'no variables': Buffer.concat([header(), END]),
    'no end record': Buffer.concat([header(), numVar('A')]),
    'layout code': (() => { const h = header(); h.writeInt32LE(H, 64); return Buffer.concat([h, numVar('A'), END]); })(),
    'compression code': Buffer.concat([header(1, H), numVar('A'), END]),
  };
  for (const [what, buf] of Object.entries(cases)) {
    const t0 = Date.now();
    assert.throws(() => read(buf), (e) => e instanceof DataError, what);
    assert.ok(Date.now() - t0 < 500, what);
  }
});

test('header nominal case size 2^31-1 and weight index out of range: warnings only', () => {
  const h = header(0x7fffffff, 1, 1);
  h.writeInt32LE(0x7fffffff, 76);
  const data = Buffer.from([101, 252, 0, 0, 0, 0, 0, 0]);
  const ds = read(Buffer.concat([h, numVar('A'), END, data]));
  assert.strictEqual(ds.store.n, 1);
  assert.strictEqual(ds.store.get(0, 0), 1);
  assert.strictEqual(ds.info.weight, '');
  assert.ok(ds.warnings.some((w) => /values per case/.test(w)));
});

test('too many variables gives a DataError', () => {
  const vars = Array.from({ length: 50 }, (_, i) => numVar(`V${i}`));
  assert.throws(() => read(Buffer.concat([header(50), ...vars, END]), { maxVars: 10 }), (e) => e instanceof DataError && /more than 10 variables/.test(e.message));
});

const twoNum = () => writeSav({ variables: [{ name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }], rows: [] }, { compression: 'bytecode', ncases: -1, noEof: true });

test('bytecode: end code 252 in the middle of a row keeps the complete rows', () => {
  const ds = read(Buffer.concat([twoNum(), Buffer.from([101, 102, 103, 252, 0, 0, 0, 0])]));
  assert.strictEqual(ds.store.n, 1);
  assert.deepStrictEqual([ds.store.get(0, 0), ds.store.get(1, 0)], [1, 2]);
  assert.ok(ds.warnings.some((w) => /middle of a row/.test(w)));
});

test('bytecode: stream ends inside a command block, and a 253 without its raw value', () => {
  let ds = read(Buffer.concat([twoNum(), Buffer.from([101, 102, 103, 104, 105])]));
  assert.ok(ds.store.n <= 2);
  ds = read(Buffer.concat([twoNum(), Buffer.from([101, 102, 103, 253, 0, 0, 0, 0]), Buffer.from([1, 2, 3])]));
  assert.strictEqual(ds.store.n, 1);
  assert.ok(ds.warnings.some((w) => /middle of a row/.test(w)));
  // 254 (spaces) and 0 (padding) codes in numeric places do not break the reader
  ds = read(Buffer.concat([twoNum(), Buffer.from([0, 0, 255, 101, 254, 102, 252, 0])]));
  assert.strictEqual(ds.store.n, 2);
  assert.ok(Number.isNaN(ds.store.get(0, 0)));
  assert.strictEqual(ds.store.get(1, 0), 1);
});

test('uncompressed: a cut last row is dropped with a warning', () => {
  const full = writeSav({ variables: [{ name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }], rows: [[1, 2], [3, 4]] }, { compression: 'none', ncases: -1 });
  const ds = read(full.subarray(0, full.length - 4));
  assert.strictEqual(ds.store.n, 1);
  assert.ok(ds.warnings.some((w) => /middle of a row/.test(w)));
});

const oneNumZ = (blocks) => writeSav({ variables: [{ name: 'x', type: 'numeric' }], rows: [] }, { compression: 'zlib', ncases: -1, rawBlocks: blocks });

test('zsav: a block that lies about its size stops with a warning, rows before it kept', () => {
  const good = Buffer.from([101, 102, 103, 104, 105, 106, 107, 108]);
  const ds = read(oneNumZ([{ usize: 8, c: zlib.deflateSync(good) }, { usize: 99, c: zlib.deflateSync(good) }]));
  assert.strictEqual(ds.store.n, 8);
  assert.ok(ds.warnings.some((w) => /block 2/.test(w)), ds.warnings.join());
  const ds2 = read(writeSav({ variables: [{ name: 'x', type: 'numeric' }], rows: [[1], [2]] }, { compression: 'zlib', lieBlockSize: true }));
  assert.ok(ds2.warnings.length > 0);
});

test('zsav: zlib bomb (stated 16 bytes, inflates to 20 MB) and a block over 64 MB are refused', () => {
  const bomb = zlib.deflateSync(Buffer.alloc(20 * 1024 * 1024, 101));
  const t0 = Date.now();
  let ds = read(oneNumZ([{ usize: 16, c: bomb }]));
  assert.strictEqual(ds.store.n, 0);
  assert.ok(ds.warnings.some((w) => /more than its stated size/.test(w)), ds.warnings.join());
  ds = read(oneNumZ([{ usize: 200 * 1024 * 1024, c: bomb }]));
  assert.ok(ds.warnings.some((w) => /64 MB/.test(w)), ds.warnings.join());
  ds = read(oneNumZ([{ usize: 8, c: Buffer.from('not zlib data') }]));
  assert.ok(ds.warnings.some((w) => /damaged/.test(w)), ds.warnings.join());
  assert.ok(Date.now() - t0 < 3000);
});

test('zsav: trailer outside the file gives a DataError', () => {
  const buf = Buffer.from(oneNumZ([{ usize: 8, c: zlib.deflateSync(Buffer.alloc(8, 101)) }]));
  const dictEnd = buf.length - (24 + zlib.deflateSync(Buffer.alloc(8, 101)).length + 48);
  buf.writeBigInt64LE(BigInt(buf.length + 1000), dictEnd + 8);
  assert.throws(() => read(buf), (e) => e instanceof DataError);
});

test('row limits: maxCells cuts the rows with a warning', () => {
  const rows = Array.from({ length: 500 }, (_, i) => [i, i]);
  const ds = read(writeSav({ variables: [{ name: 'a', type: 'numeric' }, { name: 'b', type: 'numeric' }], rows }), { maxCells: 200 });
  assert.strictEqual(ds.store.n, 100);
  assert.ok(ds.truncated);
  assert.ok(ds.warnings.some((w) => /first 100 rows/.test(w)));
});

test('200,000 rows x 20 numeric variables read in well under 5 s', () => {
  const vars = Array.from({ length: 20 }, (_, i) => ({ name: `v${i}`, type: 'numeric' }));
  const dict = writeSav({ variables: vars, rows: [] }, { compression: 'bytecode', ncases: 200000, noEof: true });
  const data = Buffer.alloc(200000 * 20);
  for (let i = 0; i < data.length; i++) data[i] = 100 + (i % 50);
  const t0 = Date.now();
  const ds = read(Buffer.concat([dict, data]));
  const ms = Date.now() - t0;
  assert.strictEqual(ds.store.n, 200000);
  assert.strictEqual(ds.store.get(19, 199999), (199999 * 20 + 19) % 50);
  assert.ok(ms < 5000, `${ms} ms`);
});

test('labels and values with HTML stay plain strings', () => {
  const spec = { fileLabel: '<img src=x onerror=alert(1)>', variables: [{ name: 'q', label: '<h1>label</h1>', type: 'string', width: 30, labels: [['<i>v</i>', '<script>bad()</script>']] }], rows: [['<i>v</i>']] };
  const ds = read(writeSav(spec));
  assert.strictEqual(ds.info.fileLabel, '<img src=x onerror=alert(1)>');
  assert.strictEqual(ds.variables[0].label, '<h1>label</h1>');
  assert.strictEqual(ds.store.get(0, 0), '<i>v</i>');
  assert.deepStrictEqual(ds.labelSets[ds.variables[0].labels], [['<i>v</i>', '<script>bad()</script>']]);
});
