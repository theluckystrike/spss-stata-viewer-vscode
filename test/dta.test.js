'use strict';
// Stata .dta reader: round trips through scripts/make_dta.js for every release and byte order, and hostile files.
const test = require('node:test');
const assert = require('node:assert');
const { writeDta } = require('../scripts/make_dta');
const dta = require('../src/core/dta');
const { Source, DataError } = require('../src/core/source');
const dates = require('../src/core/dates');

const RELEASES = [113, 114, 115, 117, 118, 119];
const read = (buf, limits) => dta.read(Source.fromBuffer(buf), limits);
const cell = (ds, r, c) => { const x = ds.store.get(c, r); if (typeof x === 'number' && Number.isNaN(x)) { const m = ds.store.missCode(c, r); return m ? `.${String.fromCharCode(96 + m)}` : '.'; } return x; };

function spec() {
  return {
    fileLabel: 'Household survey 2026', timestamp: '10 Nov 2026 09:30',
    variables: [
      { name: 'id', label: 'Household ID', type: 'numeric', storage: 'long' },
      { name: 'sex', label: 'Sex of head <b>', type: 'numeric', storage: 'byte', labels: 'sexlbl' },
      { name: 'income', label: 'Monthly income', type: 'numeric', storage: 'double', format: '%10.2f' },
      { name: 'score', type: 'numeric', storage: 'float' },
      { name: 'members', type: 'numeric', storage: 'int' },
      { name: 'visit', type: 'numeric', storage: 'long', format: '%td' },
      { name: 'stamp', type: 'numeric', storage: 'double', format: '%tc' },
      { name: 'month', type: 'numeric', storage: 'int', format: '%tm' },
      { name: 'qtr', type: 'numeric', storage: 'int', format: '%tq' },
      { name: 'city', type: 'string' },
    ],
    labelSets: { sexlbl: [[1, 'Male'], [2, 'Female'], [9, '<script>alert(1)</script>']] },
    rows: [
      [1, 1, 1234.5, 1.5, 3, 0, 0, 0, 0, 'Paris'],
      [2, 2, NaN, { miss: 'a' }, { miss: 'z' }, 365, 86400000, 13, 5, 'Lyon'],
      [3, { miss: 'b' }, -1e300, null, 32740, -1, 1.5e12, -1, -1, ''],
      [-2147483647, -127, 1e-300, -3.25, -32767, 23000, 2e12, 700, 250, 'Saint-Étienne'],
    ],
  };
}

for (const release of RELEASES) {
  for (const bigEndian of [false, true]) {
    test(`release ${release} ${bigEndian ? 'big' : 'little'}-endian round trip`, () => {
      const ds = read(writeDta(spec(), { release, bigEndian }));
      assert.strictEqual(ds.format, 'dta');
      assert.match(ds.formatLabel, new RegExp(`release ${release}`));
      assert.strictEqual(ds.info.rows, 4);
      assert.strictEqual(ds.info.fileLabel, 'Household survey 2026');
      assert.strictEqual(ds.info.created, '10 Nov 2026 09:30');
      assert.strictEqual(ds.info.release, String(release));
      assert.strictEqual(ds.store.n, 4);
      assert.deepStrictEqual(ds.warnings, []);
      assert.deepStrictEqual(ds.variables.map((v) => v.storage), ['long', 'byte', 'double', 'float', 'int', 'long', 'double', 'int', 'int', release >= 118 ? 'str14' : 'str13']);
      assert.strictEqual(ds.variables[1].label, 'Sex of head <b>');
      assert.strictEqual(ds.variables[1].labels, 'sexlbl');
      assert.strictEqual(ds.variables[2].format, '%10.2f');
      assert.deepStrictEqual([0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4, 9].map((c) => cell(ds, r, c))), [
        [1, 1, 1234.5, 1.5, 3, 'Paris'],
        [2, 2, '.', '.a', '.z', 'Lyon'],
        [3, '.b', -1e300, '.', 32740, ''],
        [-2147483647, -127, 1e-300, -3.25, -32767, 'Saint-Étienne'],
      ]);
      assert.deepStrictEqual(ds.labelSets.sexlbl, [[1, 'Male'], [2, 'Female'], [9, '<script>alert(1)</script>']]);
      const d = (c, r) => dates.display(ds.variables[c].date, ds.store.get(c, r));
      assert.deepStrictEqual([d(5, 0), d(5, 1), d(5, 2)], ['1960-01-01', '1960-12-31', '1959-12-31']);
      assert.deepStrictEqual([d(6, 1), d(7, 1), d(8, 1), d(7, 2)], ['1960-01-02 00:00:00', '1961m2', '1961q2', '1959m12']);
      assert.strictEqual(ds.info.encoding, release >= 118 ? 'UTF-8' : 'windows-1252');
    });
  }
}

test('strL values: 32,767 characters, binary, empty, shared', () => {
  for (const release of [117, 118, 119]) for (const bigEndian of [false, true]) {
    const long = 'x'.repeat(32766) + 'y';
    const s = { fileLabel: '', variables: [{ name: 'note', type: 'string', storage: 'strL' }, { name: 'n', type: 'numeric', storage: 'byte' }],
      rows: [[long, 1], ['', 2], [{ binary: new Uint8Array([1, 0, 2, 3]) }, 3], ['short <i>text</i>', 4], [null, 5]] };
    const ds = read(writeDta(s, { release, bigEndian }));
    assert.strictEqual(ds.variables[0].storage, 'strL');
    assert.strictEqual(ds.store.get(0, 0).length, 32767);
    assert.strictEqual(ds.store.get(0, 0).slice(-1), 'y');
    assert.strictEqual(ds.store.get(0, 1), '');
    assert.strictEqual(ds.store.get(0, 2), '[binary data, 4 bytes]');
    assert.strictEqual(ds.store.get(0, 3), 'short <i>text</i>');
    assert.strictEqual(ds.store.get(0, 4), '');
    assert.deepStrictEqual(ds.warnings, [], `${release}`);
  }
});

test('long strN (2,045) and auto strL when longer (117+)', () => {
  const s = { variables: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }], rows: [['a'.repeat(2045), 'b'.repeat(3000)]] };
  const ds = read(writeDta(s, { release: 118 }));
  assert.strictEqual(ds.variables[0].storage, 'str2045');
  assert.strictEqual(ds.variables[1].storage, 'strL');
  assert.strictEqual(ds.store.get(0, 0).length, 2045);
  assert.strictEqual(ds.store.get(1, 0).length, 3000);
});

test('UTF-8 names, labels and values in release 118 and 119', () => {
  const s = { fileLabel: 'Données été', variables: [{ name: 'größe', label: '身長 (cm)', type: 'numeric', storage: 'double', labels: 'größe_l' }, { name: 'ville', type: 'string' }],
    labelSets: { 'größe_l': [[1, 'klein ü'], [2, '大きい']] }, rows: [[1, 'Zürich'], [2, '東京']] };
  for (const release of [118, 119]) {
    const ds = read(writeDta(s, { release }));
    assert.strictEqual(ds.info.fileLabel, 'Données été');
    assert.strictEqual(ds.variables[0].name, 'größe');
    assert.strictEqual(ds.variables[0].label, '身長 (cm)');
    assert.deepStrictEqual(ds.labelSets['größe_l'], [[1, 'klein ü'], [2, '大きい']]);
    assert.deepStrictEqual([ds.store.get(1, 0), ds.store.get(1, 1)], ['Zürich', '東京']);
  }
});

test('every extended missing value .a to .z in each numeric storage', () => {
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const vars = ['byte', 'int', 'long', 'float', 'double'].map((st) => ({ name: st, type: 'numeric', storage: st }));
  const rows = letters.map((l) => vars.map(() => ({ miss: l }))).concat([vars.map(() => NaN)]);
  for (const release of [113, 118]) {
    const ds = read(writeDta({ variables: vars, rows }, { release }));
    for (let r = 0; r < 26; r++) for (let c = 0; c < 5; c++) assert.strictEqual(cell(ds, r, c), `.${letters[r]}`);
    for (let c = 0; c < 5; c++) assert.strictEqual(cell(ds, 26, c), '.');
  }
});

test('a variable with a label name but no table keeps the name; no label set is made', () => {
  const s = { variables: [{ name: 'x', type: 'numeric', storage: 'byte', labels: 'nolabels' }], rows: [[1]] };
  const ds = read(writeDta(s, { release: 118 }));
  assert.strictEqual(ds.variables[0].labels, 'nolabels');
  assert.deepStrictEqual(ds.labelSets, {});
});

test('characteristics are skipped', () => {
  const s = { ...spec(), characteristic: 'x'.repeat(500) };
  const ds = read(writeDta(s, { release: 117 }));
  assert.strictEqual(ds.store.n, 4);
});

test('sniff', () => {
  assert.ok(dta.sniff(writeDta(spec(), { release: 118 }).subarray(0, 16)));
  assert.ok(dta.sniff(writeDta(spec(), { release: 114 }).subarray(0, 16)));
  assert.ok(!dta.sniff(Buffer.from('$FL2@(#) IBM SPSS STATISTICS')));
  assert.ok(!dta.sniff(Buffer.from('id,name\n1,a\n')));
});

// ---------------------------------------------------------------- hostile files

test('wrong magic and old releases give a clear DataError', () => {
  assert.throws(() => read(Buffer.from('hello world, this is not stata at all')), (e) => e instanceof DataError && e.code === 'NOT_DATA');
  assert.throws(() => read(Buffer.alloc(2)), (e) => e.code === 'NOT_DATA');
  const old = Buffer.from(writeDta(spec(), { release: 114 })); old[0] = 110;
  assert.throws(() => read(old), (e) => e.code === 'UNSUPPORTED' && /release 110/.test(e.message));
  const bad = Buffer.from(writeDta(spec(), { release: 118 }));
  bad.write('120', 28, 'latin1');
  assert.throws(() => read(bad), (e) => e.code === 'UNSUPPORTED');
});

test('every prefix of a small file gives a dataset or a DataError, never a hang', () => {
  for (const release of [114, 117, 118]) {
    const s = spec(); s.variables.push({ name: 'note', type: 'string', storage: 'strL' }); s.rows.forEach((r, i) => r.push(i % 2 ? `note ${i}` : ''));
    const full = writeDta(s, { release });
    const t0 = Date.now();
    let partial = 0;
    for (let n = 0; n < full.length; n++) {
      try {
        const ds = read(full.subarray(0, n));
        assert.ok(ds.store.n <= 4);
        if (ds.store.n < 4 || ds.warnings.length) partial++;
      } catch (e) {
        assert.ok(e instanceof DataError, `release ${release} cut at ${n}: ${e && e.stack}`);
      }
    }
    assert.ok(partial > 0);
    assert.ok(Date.now() - t0 < 8000);
  }
});

test('a cut data section keeps the complete rows and says so', () => {
  const full = writeDta({ ...spec(), labelSets: {} }, { release: 114 });
  const ds = read(full.subarray(0, full.length - 30));
  assert.ok(ds.store.n >= 1 && ds.store.n < 4);
  assert.ok(ds.warnings.some((w) => /ends early/.test(w)));
  assert.ok(ds.truncated);
});

test('huge K and N give a DataError or cut rows, never a giant allocation', () => {
  // 118: K is uint16 at offset 70 ("<stata_dta><header><release>118</release><byteorder>LSF</byteorder><K>")
  const b118 = Buffer.from(writeDta(spec(), { release: 118 }));
  const kAt = b118.indexOf('<K>') + 3, nAt = b118.indexOf('<N>') + 3;
  const k = Buffer.from(b118); k.writeUInt16LE(0xffff, kAt);
  assert.throws(() => read(k), (e) => e instanceof DataError);
  const n = Buffer.from(b118); n.writeBigUInt64LE(1n << 40n, nAt);
  const ds = read(n);
  assert.ok(ds.store.n < 100);
  assert.ok(ds.warnings.some((w) => /ends early/.test(w)));
  const n2 = Buffer.from(b118); n2.writeBigUInt64LE((1n << 63n) + 5n, nAt);
  assert.throws(() => read(n2), (e) => e instanceof DataError);
  const b119 = Buffer.from(writeDta(spec(), { release: 119 }));
  const k9 = Buffer.from(b119); k9.writeUInt32LE(2 ** 31, b119.indexOf('<K>') + 3);
  assert.throws(() => read(k9), (e) => e instanceof DataError && e.code === 'TOO_BIG');
  const k9b = Buffer.from(b119); k9b.writeUInt32LE(90000, b119.indexOf('<K>') + 3);
  assert.throws(() => read(k9b), (e) => e instanceof DataError);
  // old format: nobs int32 at offset 6
  const b114 = Buffer.from(writeDta(spec(), { release: 114 }));
  b114.writeUInt32LE(0x7fffffff, 6);
  const d2 = read(b114);
  assert.ok(d2.store.n < 100 && d2.truncated);
});

test('strL reference to a missing GSO: empty value and one warning', () => {
  const s = { variables: [{ name: 'note', type: 'string', storage: 'strL' }], rows: [['one'], ['two'], ['three']] };
  const b = Buffer.from(writeDta(s, { release: 118 }));
  const g = b.indexOf('GSO');
  b.writeUInt32LE(77, g + 3); // v of the first GSO no longer matches
  const ds = read(b);
  assert.deepStrictEqual([ds.store.get(0, 0), ds.store.get(0, 1), ds.store.get(0, 2)], ['', 'two', 'three']);
  assert.strictEqual(ds.warnings.filter((w) => /strL/.test(w)).length, 1);
});

test('GSO length past the end of the file', () => {
  const s = { variables: [{ name: 'note', type: 'string', storage: 'strL' }], rows: [['one'], ['two']] };
  const b = Buffer.from(writeDta(s, { release: 117 }));
  const g = b.indexOf('GSO', b.indexOf('GSO') + 1);
  b.writeUInt32LE(0x7fffffff, g + 3 + 4 + 4 + 1);
  const ds = read(b);
  assert.strictEqual(ds.store.get(0, 0), 'one');
  assert.strictEqual(ds.store.get(0, 1), '');
  assert.ok(ds.warnings.length >= 1);
});

test('value label table with a huge count or offsets outside the text', () => {
  const b = Buffer.from(writeDta(spec(), { release: 118 }));
  const at = b.indexOf('<lbl>') + 5 + 4 + 129 + 3;
  const huge = Buffer.from(b); huge.writeInt32LE(0x7ffffff0, at);
  const d1 = read(huge);
  assert.deepStrictEqual(d1.labelSets.sexlbl, []);
  assert.ok(d1.warnings.some((w) => /damaged/.test(w)));
  const off = Buffer.from(b); off.writeInt32LE(100000, at + 8);
  const d2 = read(off);
  assert.strictEqual(d2.labelSets.sexlbl.length, 2);
  assert.ok(d2.warnings.some((w) => /outside/.test(w)));
  const lenHuge = Buffer.from(b); lenHuge.writeUInt32LE(0x7fffffff, b.indexOf('<lbl>') + 5);
  const d3 = read(lenHuge);
  assert.ok(d3.warnings.some((w) => /cut/.test(w)));
});

test('unknown storage type and broken tags', () => {
  const b = Buffer.from(writeDta(spec(), { release: 118 }));
  const t = Buffer.from(b); t.writeUInt16LE(40000, b.indexOf('<variable_types>') + 16);
  assert.throws(() => read(t), (e) => e instanceof DataError && /storage type/.test(e.message));
  const tag = Buffer.from(b); tag.write('X', b.indexOf('<varnames>') + 1, 'latin1');
  assert.throws(() => read(tag), (e) => e instanceof DataError);
});

test('the cell limit cuts rows with a warning', () => {
  const rows = []; for (let i = 0; i < 5000; i++) rows.push([i, `r${i}`]);
  const ds = read(writeDta({ variables: [{ name: 'i', type: 'numeric', storage: 'long' }, { name: 's', type: 'string' }], rows }, { release: 118 }), { maxCells: 2000 });
  assert.strictEqual(ds.store.n, 1000);
  assert.ok(ds.truncated);
  assert.ok(ds.warnings.some((w) => /first 1,000 rows/.test(w)));
});

test('100,000 rows read fast', () => {
  const rows = []; for (let i = 0; i < 100000; i++) rows.push([i, i * 0.5, i % 3]);
  const buf = writeDta({ variables: [{ name: 'a', type: 'numeric', storage: 'long' }, { name: 'b', type: 'numeric' }, { name: 'c', type: 'numeric', storage: 'byte' }], rows }, { release: 118 });
  const t0 = Date.now();
  const ds = read(buf);
  assert.strictEqual(ds.store.n, 100000);
  assert.strictEqual(ds.store.get(1, 99999), 49999.5);
  assert.ok(Date.now() - t0 < 3000);
});

test('release 118 with Latin-1 text: read as windows-1252 with one note', () => {
  const s = { variables: [{ name: 'city', type: 'string', storage: 'str12' }], rows: [['Düsseldorf'], ['Köln']] };
  const b = Buffer.from(writeDta(s, { release: 118 }));
  // replace the UTF-8 bytes of ü (c3 bc) and ö (c3 b6) by Latin-1 fc and f6
  const d = b.indexOf(Buffer.from('Düsseldorf'));
  Buffer.from('D\xfcsseldorf\0', 'latin1').copy(b, d);
  const k = b.indexOf(Buffer.from('Köln'));
  Buffer.from('K\xf6ln\0', 'latin1').copy(b, k);
  const ds = read(b);
  assert.deepStrictEqual([ds.store.get(0, 0), ds.store.get(0, 1)], ['Düsseldorf', 'Köln']);
  assert.strictEqual(ds.warnings.filter((w) => /not UTF-8/.test(w)).length, 1);
});
