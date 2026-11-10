'use strict';
// Picks the reader by the first bytes of the file (the extension only breaks a tie), and runs it.
const { DataError } = require('./source');

const READERS = {
  sav: () => require('./sav'),
  dta: () => require('./dta'),
  xpt: () => require('./xpt'),
};

/** 'sav' | 'dta' | 'xpt' | null from the first bytes (up to 512) of a file. */
function detect(head, fileName = '') {
  for (const k of ['sav', 'dta', 'xpt']) { try { if (READERS[k]().sniff(head)) return k; } catch { /* reader missing */ } }
  return null;
}

function describeOther(head) {
  const s = Buffer.from(head.subarray(0, 64)).toString('latin1');
  if (/^PK\x03\x04/.test(s)) return 'It looks like a ZIP file (or an Office document).';
  if (/^%PDF/.test(s)) return 'It looks like a PDF file.';
  if (/^\x89HDF/.test(s)) return 'It looks like an HDF5 file.';
  if (s.startsWith('SAS FILE') || head.length > 32 && head[0] === 0 && head[12] === 0xc2 && head[13] === 0xea) return 'It looks like a SAS7BDAT file, which this viewer does not read (SAS transport .xpt files work).';
  if (/^\s*[\x20-\x7e\r\n\t]*$/.test(s) && head.length) return 'It looks like a text file.';
  return '';
}

/** Read a dataset from a Source. Throws DataError (code NOT_DATA when the file is not SPSS, Stata or SAS transport). */
function readDataset(src, limits, fileName = '') {
  const head = src.readUpTo(0, 512);
  const kind = detect(head, fileName);
  if (!kind) {
    const e = new DataError(`This is not an SPSS (.sav, .zsav), Stata (.dta) or SAS transport (.xpt) file. ${describeOther(head)}`.trim(), 'NOT_DATA');
    throw e;
  }
  const ds = READERS[kind]().read(src, limits);
  if (!ds.store) throw new DataError('The reader returned no data.');
  return ds;
}

module.exports = { detect, readDataset };
