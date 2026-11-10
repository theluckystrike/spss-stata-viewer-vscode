'use strict';
// Writes the walkthrough samples: samples/sample-survey.sav and samples/sample-survey.dta, a made-up customer
// survey of 600 answers (no real people). Run: node scripts/make_samples.js
const fs = require('fs');
const path = require('path');
const { writeSav } = require('./make_sav');
const { writeDta } = require('./make_dta');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const REGION = [[1, 'North'], [2, 'South'], [3, 'East'], [4, 'West']];
const GENDER = [[1, 'Female'], [2, 'Male'], [3, 'Another gender'], [9, 'No answer']];
const AGREE = [[1, 'Strongly disagree'], [2, 'Disagree'], [3, 'Neither'], [4, 'Agree'], [5, 'Strongly agree'], [8, "Don't know"]];
const CHANNEL = [[1, 'Web'], [2, 'Phone'], [3, 'Store']];
const COMMENTS = ['', '', '', 'Delivery was fast.', 'The app keeps logging me out.', 'Staff in the store were helpful.', 'Prices went up again.', '', 'Good value for the money.', 'I waited 20 minutes on the phone.'];

function surveyRows(n = 600) {
  const r = rng(20261110);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const rows = [];
  const day0 = Date.UTC(2026, 8, 1);
  for (let i = 1; i <= n; i++) {
    const region = 1 + Math.floor(r() * 4);
    const g = r(); const gender = g < 0.48 ? 1 : g < 0.94 ? 2 : g < 0.97 ? 3 : 9;
    const age = r() < 0.02 ? 99 : 18 + Math.floor(r() * 62);
    const base = region === 2 ? 3.7 : region === 4 ? 2.9 : 3.3;
    let sat = Math.round(base + (r() - 0.5) * 4.2); sat = Math.max(1, Math.min(5, sat)); if (r() < 0.04) sat = 8;
    const recommend = r() < 0.05 ? NaN : Math.max(0, Math.min(10, Math.round(sat * 2 + (r() - 0.5) * 3)));
    const income = r() < 0.08 ? NaN : Math.round((1800 + r() * 5200 + (age === 99 ? 0 : age) * 20) * 100) / 100;
    const channel = 1 + Math.floor(r() * 3);
    const dayMs = day0 + Math.floor(r() * 61) * 86400000;
    rows.push({ i, region, gender, age, sat, recommend, income, channel, dayMs, comment: pick(COMMENTS) });
  }
  return rows;
}

function savSpec(rows) {
  const spssDate = (ms) => ms / 1000 + 12219379200;
  return {
    fileLabel: 'Customer survey 2026 (sample data, made up)',
    documents: ['Sample file for SPSS & Stata Viewer. The answers are made up.'],
    variables: [
      { name: 'id', label: 'Respondent ID', type: 'numeric', format: { type: 5, w: 6, d: 0 }, measure: 'nominal' },
      { name: 'region', label: 'Region', type: 'numeric', format: { type: 5, w: 1, d: 0 }, measure: 'nominal', labels: REGION },
      { name: 'gender', label: 'Gender', type: 'numeric', format: { type: 5, w: 1, d: 0 }, measure: 'nominal', labels: GENDER, missing: { values: [9] } },
      { name: 'age', label: 'Age in years', type: 'numeric', format: { type: 5, w: 3, d: 0 }, measure: 'scale', missing: { values: [99] } },
      { name: 'satisfaction', label: 'Overall, I am satisfied with the service', type: 'numeric', format: { type: 5, w: 1, d: 0 }, measure: 'ordinal', labels: AGREE, missing: { values: [8] } },
      { name: 'recommend', label: 'How likely are you to recommend us (0 to 10)?', type: 'numeric', format: { type: 5, w: 2, d: 0 }, measure: 'scale' },
      { name: 'income', label: 'Monthly household income (USD)', type: 'numeric', format: { type: 5, w: 8, d: 2 }, measure: 'scale' },
      { name: 'channel', label: 'Main contact channel', type: 'numeric', format: { type: 5, w: 1, d: 0 }, measure: 'nominal', labels: CHANNEL },
      { name: 'interview_date', label: 'Date of the interview', type: 'numeric', format: { type: 20, w: 11, d: 0 }, measure: 'scale' },
      { name: 'comment', label: 'Comments (free text)', type: 'string', width: 60, measure: 'nominal' },
    ],
    rows: rows.map((x) => [x.i, x.region, x.gender, x.age, x.sat, x.recommend, x.income, x.channel, spssDate(x.dayMs), x.comment]),
  };
}

function dtaSpec(rows) {
  const tdDays = (ms) => Math.round((ms - Date.UTC(1960, 0, 1)) / 86400000);
  const miss = (x, code, letter) => (x === code ? { miss: letter } : x);
  return {
    fileLabel: 'Customer survey 2026 (sample data, made up)',
    timestamp: '10 Nov 2026 09:00',
    variables: [
      { name: 'id', label: 'Respondent ID', type: 'numeric', storage: 'int', format: '%8.0g' },
      { name: 'region', label: 'Region', type: 'numeric', storage: 'byte', format: '%8.0g', labels: 'region' },
      { name: 'gender', label: 'Gender', type: 'numeric', storage: 'byte', format: '%14.0g', labels: 'gender' },
      { name: 'age', label: 'Age in years', type: 'numeric', storage: 'byte', format: '%8.0g' },
      { name: 'satisfaction', label: 'Overall, I am satisfied with the service', type: 'numeric', storage: 'byte', format: '%17.0g', labels: 'agree' },
      { name: 'recommend', label: 'How likely are you to recommend us (0 to 10)?', type: 'numeric', storage: 'byte', format: '%8.0g' },
      { name: 'income', label: 'Monthly household income (USD)', type: 'numeric', storage: 'double', format: '%10.2f' },
      { name: 'channel', label: 'Main contact channel', type: 'numeric', storage: 'byte', format: '%8.0g', labels: 'channel' },
      { name: 'interview_date', label: 'Date of the interview', type: 'numeric', storage: 'long', format: '%td' },
      { name: 'comment', label: 'Comments (free text)', type: 'string', storage: 'str60', format: '%60s' },
    ],
    labelSets: { region: REGION, gender: GENDER.filter(([v]) => v !== 9), agree: AGREE.filter(([v]) => v !== 8), channel: CHANNEL },
    rows: rows.map((x) => [x.i, x.region, miss(x.gender, 9, 'a'), miss(x.age, 99, 'a'), miss(x.sat, 8, 'b'), x.recommend, x.income, x.channel, tdDays(x.dayMs), x.comment]),
  };
}

function main() {
  const rows = surveyRows();
  const dir = path.join(__dirname, '..', 'samples');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sample-survey.sav'), writeSav(savSpec(rows), { compression: 'bytecode', encoding: 'utf-8' }));
  fs.writeFileSync(path.join(dir, 'sample-survey.dta'), writeDta(dtaSpec(rows), { release: 118 }));
  console.log('wrote', fs.readdirSync(dir).join(', '));
}

if (require.main === module) main();
module.exports = { surveyRows, savSpec, dtaSpec };
