'use strict';
// Date and time formats of SPSS, Stata and SAS. A reader sets variable.date to a descriptor from one of the three
// *Format functions below; the grid, the exports and the summaries call display(desc, value).
//   SPSS: seconds since 1582-10-14 00:00 (dates and date-times alike), durations in seconds.
//   Stata: %td days and %tc/%tC milliseconds since 1960-01-01, %tw/%tm/%tq/%th periods since 1960, %ty years.
//   SAS: dates in days and date-times in seconds since 1960-01-01, times in seconds.

const SPSS_EPOCH_MS = -12219379200000; // 1582-10-14 00:00:00 UTC
const Y1960_MS = -315619200000; // 1960-01-01 00:00:00 UTC
const DAY_MS = 86400000;

const SPSS_CODES = {
  20: 'date', 23: 'date', 24: 'date', 38: 'date', 39: 'date', 28: 'date', 29: 'date', 30: 'date',
  22: 'datetime', 41: 'datetime', 21: 'time', 40: 'time', 25: 'dtime', 26: 'wkday', 27: 'monthname',
};

/** Descriptor for an SPSS print format type code (record 2 print format, bits 16-23), or null. */
function spssFormat(typeCode) {
  const kind = SPSS_CODES[typeCode];
  return kind ? { base: 'spss', kind } : null;
}

/** Descriptor for a Stata display format such as %td, %tdCCYY-NN-DD, %tc, %tm, or null. */
function stataFormat(fmt) {
  const f = String(fmt || '').trim();
  let m = /^%-?t([cCdwmqhy])/.exec(f);
  if (!m) { if (/^%-?d/.test(f)) return { base: 'stata', kind: 'date' }; return null; }
  const k = m[1];
  if (k === 'd') return { base: 'stata', kind: 'date' };
  if (k === 'c' || k === 'C') return { base: 'stata', kind: 'datetime' };
  return { base: 'stata', kind: { w: 'week', m: 'month', q: 'quarter', h: 'half', y: 'year' }[k] };
}

const SAS_DATE = /^(DATE|DDMMYY|MMDDYY|YYMMDD|YYMMDDN|E8601DA|IS8601DA|B8601DA|WEEKDATE|WEEKDATX|WORDDATE|WORDDATX|MONYY|JULIAN|NLDATE|MINGUO|EURDF|YYMM|YYQ|DOWNAME|DAY|WEEKDAY|MONNAME|MONTH|QTR|YEAR|NENGO|DTDATE)/;
const SAS_DATETIME = /^(DATETIME|DATEAMPM|E8601DT|IS8601DT|B8601DT|NLDATM|MDYAMPM|DTYYQC|DTMONYY|DTYEAR|DTWKDATX)/;
const SAS_TIME = /^(TIME|HHMM|HOUR|MMSS|TOD|E8601TM|IS8601TM|B8601TM|NLTIME)/;

/** Descriptor for a SAS format name (e.g. DATE9, DATETIME20, TIME8), or null. */
function sasFormat(name) {
  const n = String(name || '').trim().toUpperCase();
  if (!n) return null;
  if (SAS_DATETIME.test(n)) return { base: 'sas', kind: 'datetime' };
  if (SAS_TIME.test(n)) return { base: 'sas', kind: 'time' };
  if (SAS_DATE.test(n)) return { base: 'sas', kind: 'date' };
  return null;
}

const p2 = (n) => String(n).padStart(2, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ymd(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y > 9999 || y < -9999) return null;
  const ys = y < 0 ? `-${String(-y).padStart(4, '0')}` : String(y).padStart(4, '0');
  return `${ys}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

function hms(totalSec, withDays) {
  const neg = totalSec < 0;
  let s = Math.abs(totalSec);
  const frac = s - Math.floor(s);
  s = Math.floor(s);
  let days = 0;
  if (withDays) { days = Math.floor(s / 86400); s -= days * 86400; }
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  let out = `${withDays ? `${days} ` : ''}${p2(h)}:${p2(m)}:${p2(sec)}`;
  if (frac > 0.0005) out += (frac.toFixed(3)).slice(1);
  return (neg ? '-' : '') + out;
}

function dateTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const day = ymd(ms);
  if (day === null) return null;
  const msPart = d.getUTCMilliseconds();
  return `${day} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}${msPart ? `.${String(msPart).padStart(3, '0')}` : ''}`;
}

/** A value as text in its date format; null when the value is not a finite number or out of range. */
function display(desc, v) {
  if (!desc || typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (Math.abs(v) > 1e15) return null;
  const { base, kind } = desc;
  if (base === 'spss') {
    if (kind === 'date') return ymd(SPSS_EPOCH_MS + Math.floor(v / 86400) * DAY_MS);
    if (kind === 'datetime') return dateTime(SPSS_EPOCH_MS + Math.round(v * 1000));
    if (kind === 'time') return hms(v, false);
    if (kind === 'dtime') return hms(v, true);
    if (kind === 'wkday') return WEEKDAYS[v - 1] || null;
    if (kind === 'monthname') return MONTHS[v - 1] || null;
    return null;
  }
  if (base === 'stata') {
    const i = Math.floor(v);
    if (kind === 'date') return ymd(Y1960_MS + i * DAY_MS);
    if (kind === 'datetime') return dateTime(Y1960_MS + Math.round(v));
    const per = { week: 52, month: 12, quarter: 4, half: 2 }[kind];
    if (per) { const y = 1960 + Math.floor(i / per); const r = ((i % per) + per) % per; return `${y}${kind[0]}${r + 1}`; }
    if (kind === 'year') return String(i);
    return null;
  }
  if (base === 'sas') {
    if (kind === 'date') return ymd(Y1960_MS + Math.floor(v) * DAY_MS);
    if (kind === 'datetime') return dateTime(Y1960_MS + Math.round(v * 1000));
    if (kind === 'time') return hms(v, false);
  }
  return null;
}

module.exports = { spssFormat, stataFormat, sasFormat, display, SPSS_EPOCH_MS, Y1960_MS };
