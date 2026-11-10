'use strict';
// Text decoding for names, labels and string values. Unknown encodings fall back to windows-1252 (or latin1 when
// the runtime has no windows-1252 decoder). Trailing spaces and NUL padding are cut.

const ALIASES = {
  'utf8': 'utf-8', 'utf-8': 'utf-8', 'cp1252': 'windows-1252', 'windows-1252': 'windows-1252', 'latin1': 'windows-1252',
  'iso-8859-1': 'windows-1252', 'iso8859-1': 'windows-1252', 'us-ascii': 'windows-1252', 'ascii': 'windows-1252',
};

/** SPSS character code (record 7 subtype 3, element 8) to an encoding name. */
const CODEPAGES = {
  65001: 'utf-8', 1252: 'windows-1252', 1250: 'windows-1250', 1251: 'windows-1251', 1253: 'windows-1253',
  1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  28591: 'iso-8859-1', 28592: 'iso-8859-2', 28595: 'iso-8859-5', 28597: 'iso-8859-7', 932: 'shift_jis',
  936: 'gbk', 949: 'euc-kr', 950: 'big5', 20127: 'windows-1252', 2: 'windows-1252', 3: 'windows-1252', 4: 'windows-1252',
};

function makeDecoder(name) {
  const want = String(name || 'utf-8').trim().toLowerCase();
  const label = ALIASES[want] || want;
  let td;
  try { td = new TextDecoder(label, { fatal: false }); } catch { td = null; }
  if (!td) { try { td = new TextDecoder('windows-1252'); } catch { td = null; } }
  const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
  const used = td ? td.encoding : 'latin1';
  const dec = (bytes) => (td ? td.decode(bytes) : latin1(bytes));
  /** Decode, cut at the first NUL when nul is true, and cut trailing spaces. */
  const fn = (bytes, { nul = true, trim = true } = {}) => {
    let end = bytes.length;
    if (nul) { const z = bytes.indexOf(0); if (z >= 0) end = z; }
    if (trim) while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0)) end--;
    if (end <= 0) return '';
    return dec(end === bytes.length ? bytes : bytes.subarray(0, end));
  };
  fn.encoding = used;
  return fn;
}

module.exports = { makeDecoder, CODEPAGES };
