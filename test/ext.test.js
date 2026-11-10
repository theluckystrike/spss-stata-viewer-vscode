'use strict';
// The extension host with a stub vscode: activation, opening files in a worker, pages, sort and filter, summary,
// copy, hostile files, the watchdog, no network, Pro tries and the Pro panel, the CSP.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { loadExtension, openInViewer } = require('./support/vscode-stub');
const { buildHtml } = require('../src/html');
const { Session } = require('../src/session');
const { writeSav } = require('../scripts/make_sav');
const { writeDta } = require('../scripts/make_dta');
const { surveyRows, savSpec, dtaSpec } = require('../scripts/make_samples');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statsv-ext-'));
const file = (name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p; };
const ROWS = surveyRows();
const SAV = file('survey.sav', writeSav(savSpec(ROWS), { compression: 'bytecode' }));
const DTA = file('survey.dta', writeDta(dtaSpec(ROWS), { release: 118 }));
const TXT = file('template.xpt', Buffer.from('«IMPORT metamodel» this is an Xpand template, not SAS\n'));
const CUT = file('cut.sav', fs.readFileSync(SAV).subarray(0, 700));
const HTMLNAMES = file('html.sav', writeSav({ variables: [{ name: 'q1', label: '<img src=x onerror=alert(1)>', type: 'numeric', format: { type: 5, w: 1, d: 0 }, labels: [[1, '<script>alert(1)</script>']] }], rows: [[1], [2]] }));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function trapNetwork() {
  const calls = [];
  const saved = { fetch: global.fetch, hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, ncc: net.createConnection };
  global.fetch = async (u) => { calls.push(String(u)); throw new Error('network blocked in test'); };
  http.request = http.get = https.request = https.get = (...a) => { calls.push(String(a[0] && (a[0].href || a[0].host || a[0]))); throw new Error('network blocked in test'); };
  net.connect = net.createConnection = (...a) => { calls.push('net ' + JSON.stringify(a[0])); throw new Error('network blocked in test'); };
  return { calls, restore: () => { global.fetch = saved.fetch; http.request = saved.hr; http.get = saved.hg; https.request = saved.sr; https.get = saved.sg; net.connect = saved.nc; net.createConnection = saved.ncc; } };
}
const last = (v, type) => v.posted.filter((m) => m.type === type).at(-1);
const closeAll = (s) => { for (const fn of s.context.subscriptions) { try { fn.dispose && fn.dispose(); } catch { /* */ } } s.ext.deactivate(); };

test('activation and opening SPSS, Stata and a text .xpt make no network call and show no message', async () => {
  const nw = trapNetwork();
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    assert.ok(s.providers.has('statsViewer.data'));
    for (const c of ['statsViewer.open', 'statsViewer.openSample', 'statsViewer.exportData', 'statsViewer.codebook', 'statsViewer.crosstab', 'statsViewer.getPro', 'statsViewer.enterLicenseKey', 'statsViewer.payByCard']) assert.ok(s.commands.has(c), c);
    const a = await openInViewer(s, SAV);
    assert.strictEqual(a.posted[0].type, 'meta');
    assert.strictEqual(a.posted[0].meta.rows, ROWS.length);
    assert.strictEqual(a.posted[0].meta.variables[1].labels !== null, true);
    assert.deepStrictEqual(a.posted[0].pro.tries, { export: 3, codebook: 3, crosstab: 3 });
    const b = await openInViewer(s, DTA);
    assert.match(b.posted[0].meta.formatLabel, /Stata/);
    const t = await openInViewer(s, TXT);
    assert.strictEqual(t.posted[0].type, 'error');
    assert.strictEqual(t.posted[0].notData, true);
    await t.send({ type: 'openText' });
    assert.deepStrictEqual(s.log.commands.at(-1).slice(0, 1), ['vscode.openWith']);
    assert.strictEqual(s.log.commands.at(-1)[2], 'default');
    assert.deepStrictEqual(nw.calls, []);
    assert.strictEqual(s.log.info.length + s.log.warn.length + s.log.error.length, 0, 'no message on open');
    closeAll(s);
  } finally { nw.restore(); s.restore(); }
});

test('pages, sort, filter, summary and copy go through the worker', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const v = await openInViewer(s, SAV);
    await v.send({ type: 'page', seq: 1, start: 0, count: 10, c0: 0, c1: 60, labels: true });
    let p = last(v, 'page');
    assert.strictEqual(p.rows.length, 10);
    assert.deepStrictEqual(p.rows[3].slice(0, 3), ['4', 'West', 'Male']);
    assert.deepStrictEqual(p.nums.slice(0, 3), [1, 2, 3]);
    await v.send({ type: 'view', seq: 2, view: { filter: { col: 1, query: 'South' }, sort: { col: 3, dir: -1 } }, labels: true });
    const vw = last(v, 'view');
    assert.strictEqual(vw.count, ROWS.filter((x) => x.region === 2).length);
    await v.send({ type: 'page', seq: 2, start: 0, count: 5, c0: 0, c1: 4, labels: false });
    p = last(v, 'page');
    assert.ok(p.rows.every((r) => r[1] === '2'));
    assert.ok(Number(p.rows[0][3]) >= Number(p.rows[1][3]));
    await v.send({ type: 'summary', col: 4, labels: true });
    const sm = last(v, 'summary');
    assert.strictEqual(sm.filtered, true);
    assert.ok(sm.s.freq.some((f) => f.label === 'Agree'));
    await v.send({ type: 'copy', k0: 0, k1: 2, c0: 0, c1: 3, labels: true, header: true });
    assert.match(s.log.clipboard, /^id\tregion\tgender\n\d+\tSouth\t/);
    assert.ok(s.log.status.some((x) => /Copied 2 rows x 3 columns/.test(x)));
    await v.send({ type: 'view', seq: 3, view: { filter: { col: 3, query: 'x'.repeat(2000) } }, labels: true });
    assert.match(last(v, 'view').error, /1,000 characters/);
    await v.send({ type: 'page', seq: 3, start: -5, count: 1e9, c0: -1, c1: 1e9, labels: true });
    assert.ok(last(v, 'page').rows.length <= 500, 'pages are bounded');
    closeAll(s);
  } finally { s.restore(); }
});

test('hostile files: a cut file, HTML in labels; the host keeps working after each', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const c = await openInViewer(s, CUT);
    assert.ok(['error', 'meta'].includes(c.posted[0].type));
    if (c.posted[0].type === 'meta') assert.ok(c.posted[0].meta.warnings.length > 0);
    const h = await openInViewer(s, HTMLNAMES);
    assert.strictEqual(h.posted[0].meta.variables[0].label, '<img src=x onerror=alert(1)>', 'labels stay plain strings');
    const ok = await openInViewer(s, SAV);
    assert.strictEqual(ok.posted[0].type, 'meta');
    closeAll(s);
  } finally { s.restore(); }
});

test('the watchdog stops a request that takes too long, and the next request reads the file again', async () => {
  const sess = new Session({ file: SAV, name: 'survey.sav', timeouts: { summary: 1 } });
  try {
    await sess.open();
    await assert.rejects(sess.call({ op: 'summary', col: 6 }), (e) => e.code === 'TIMEOUT');
    sess.timeouts.summary = 30000;
    const r = await sess.call({ op: 'summary', col: 6 });
    assert.strictEqual(r.s.valid, ROWS.filter((x) => !Number.isNaN(x.income)).length);
  } finally { sess.dispose(); }
});

test('a session over an in-memory copy (remote files) reads data and refuses other bytes', async () => {
  const buf = fs.readFileSync(DTA);
  const good = new Session({ buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), name: 'survey.dta' });
  const bad = new Session({ buffer: new Uint8Array(64).buffer, name: 'x.sav' });
  try {
    assert.strictEqual((await good.open()).rows, ROWS.length);
    assert.strictEqual((await good.open()).rows, ROWS.length, 'a second open reads the same bytes again');
    await assert.rejects(bad.open(), (e) => e.code === 'NOT_DATA');
  } finally { good.dispose(); bad.dispose(); }
});

test('export: Escape keeps the try; 3 exports use the 3 tries; the 4th click shows the card1 panel', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const v = await openInViewer(s, SAV);
    s.ui.save.push(undefined);
    await v.send({ type: 'tool', tool: 'export', arg: { kind: 'csv' } });
    assert.strictEqual((s.state.get('statsViewer.proTrial') || {}).export, undefined, 'cancel uses no try');
    const kinds = ['csv', 'xlsx', 'json'];
    for (let i = 1; i <= 3; i++) {
      const out = path.join(dir, `out${i}.${kinds[i - 1]}`);
      s.ui.save.push(s.vscode.Uri.file(out));
      await v.send({ type: 'tool', tool: 'export', arg: { kind: kinds[i - 1] } });
      assert.ok(fs.existsSync(out), `export ${i} written`);
      assert.strictEqual(s.state.get('statsViewer.proTrial').export, i);
    }
    assert.match(fs.readFileSync(path.join(dir, 'out1.csv'), 'utf8').split('\r\n')[4], /^4,West,Male,/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'out2.xlsx')).subarray(0, 2).toString(), 'PK');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'out3.json'), 'utf8')).rows.length, ROWS.length);
    assert.ok(s.log.status.some((t) => /free try 3 of 3/.test(t)));
    const before = s.log.info.filter((m) => m.opts && m.opts.modal).length;
    assert.strictEqual(before, 0, 'no panel while tries are left');
    s.ui.info.push(undefined); // Cancel
    await v.send({ type: 'tool', tool: 'export', arg: { kind: 'csv' } });
    const panel = s.log.info.filter((m) => m.opts && m.opts.modal).at(-1);
    assert.match(panel.text, /Export data \(CSV, Excel, JSON\) is part of Zovo Pro/);
    assert.deepStrictEqual(panel.buttons.slice(0, 4), ['Pay by card (USD 19)', 'Get Zovo Pro with GitHub Sponsors', 'Pay with PayPal', 'Enter a key']);
    assert.match(panel.opts.detail, /You used the 3 free tries/);
    assert.match(panel.opts.detail, /Codebook/);
    assert.strictEqual(s.log.saved.length, 3, 'nothing written after the tries');
    assert.deepStrictEqual(last(v, 'pro').pro.tries, { export: 0, codebook: 3, crosstab: 3 });
    closeAll(s);
  } finally { s.restore(); }
});

test('Pay by card opens the card checkout with a client reference; GitHub Sponsors opens tier 679878', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    s.state.set('statsViewer.proTrial', { crosstab: 3, codebook: 3 });
    const v = await openInViewer(s, SAV);
    s.ui.info.push('Pay by card (USD 19)');
    await v.send({ type: 'tool', tool: 'crosstab' });
    assert.match(s.log.external.map(String).at(-1), /^https:\/\/license\.zovo\.one\/buy\/zovo-pro\?client_reference_id=[\w-]+$/);
    s.ui.info.push('Get Zovo Pro with GitHub Sponsors');
    await v.send({ type: 'tool', tool: 'codebook', arg: { kind: 'md' } });
    assert.strictEqual(s.log.external.map(String).at(-1), 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878');
    assert.ok(!v.posted.some((m) => m.type === 'crosstab'));
    closeAll(s);
  } finally { s.restore(); }
});

test('codebook: cancel keeps the try; a saved codebook uses one and opens', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const v = await openInViewer(s, DTA);
    s.ui.quick.push(undefined);
    await v.send({ type: 'tool', tool: 'codebook' });
    assert.strictEqual((s.state.get('statsViewer.proTrial') || {}).codebook, undefined);
    const out = path.join(dir, 'survey.codebook.html');
    s.ui.save.push(s.vscode.Uri.file(out));
    await v.send({ type: 'tool', tool: 'codebook', arg: { kind: 'html' } });
    assert.match(fs.readFileSync(out, 'utf8'), /<h2 id="v1">region: Region<\/h2>/);
    assert.strictEqual(s.state.get('statsViewer.proTrial').codebook, 1);
    // One status message carries both the saved file and the try count (a second message would replace the first).
    const last = s.log.status.at(-1);
    assert.match(last, /^Codebook of \d+ variables saved to survey\.codebook\.html\. Zovo Pro: free try 1 of 3 of "Codebook \(Markdown, HTML, CSV\)" used, 2 left on this computer\.$/);
    closeAll(s);
  } finally { s.restore(); }
});

test('crosstab: cancel at any pick keeps the try; a crosstab on screen uses one; saving it uses none', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const v = await openInViewer(s, SAV);
    const byName = (n) => (items) => items.find((i) => i.label === n);
    s.ui.quick.push(byName('satisfaction'), undefined);
    await v.send({ type: 'tool', tool: 'crosstab' });
    assert.strictEqual((s.state.get('statsViewer.proTrial') || {}).crosstab, undefined);
    s.ui.quick.push(byName('satisfaction'), byName('region'), byName('No layer'));
    await v.send({ type: 'tool', tool: 'crosstab' });
    const ct = last(v, 'crosstab');
    assert.ok(ct, 'crosstab posted');
    assert.deepStrictEqual(ct.result.tables[0].colText, ['North', 'South', 'East', 'West']);
    assert.strictEqual(s.state.get('statsViewer.proTrial').crosstab, 1);
    const out = path.join(dir, 'ct.md');
    s.ui.save.push(s.vscode.Uri.file(out));
    await v.send({ type: 'saveCrosstab', kind: 'md' });
    assert.match(fs.readFileSync(out, 'utf8'), /Pearson chi-square/);
    assert.strictEqual(s.state.get('statsViewer.proTrial').crosstab, 1);
    s.ui.quick.push(byName('id'), byName('region'), byName('No layer'));
    await v.send({ type: 'tool', tool: 'crosstab' });
    assert.match(s.log.warn.at(-1).text, /more than 200 different values/);
    assert.strictEqual(s.state.get('statsViewer.proTrial').crosstab, 1, 'an error uses no try');
    closeAll(s);
  } finally { s.restore(); }
});

test('palette Pro commands with no open viewer pick a file and open it first', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    // the stub has no workbench to open editors: route vscode.openWith to the provider
    const orig = s.vscode.commands.executeCommand;
    const opened = [];
    s.vscode.commands.executeCommand = async (id, ...a) => { if (id === 'vscode.openWith') { opened.push(a[0]); return openInViewer(s, a[0].fsPath); } return orig(id, ...a); };
    s.ui.open.push([s.vscode.Uri.file(SAV)]);
    s.ui.quick.push((items) => items.find((i) => i.k === 'csv'), (items) => items[1]);
    const out = path.join(dir, 'palette.csv');
    s.ui.save.push(s.vscode.Uri.file(out));
    await s.commands.get('statsViewer.exportData')();
    assert.strictEqual(opened.length, 1);
    assert.match(fs.readFileSync(out, 'utf8').split('\r\n')[4], /^4,4,2,63,/, 'codes chosen in the pick');
    closeAll(s);
  } finally { s.restore(); }
});

test('webview HTML: nonce scripts, no remote origin, no connect-src', () => {
  const html = buildHtml({ cspSource: 'vscode-webview://x', scriptUri: 'vscode-webview://x/main.js', styleUri: 'vscode-webview://x/main.css', title: '<evil>"', nonce: 'abc' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc'/);
  assert.ok(!/https?:/.test(csp));
  assert.ok(!/connect-src/.test(csp));
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.ok(html.includes('&lt;evil&gt;&quot;'));
  assert.ok(!/<script(?![^>]*nonce="abc")/.test(html));
});

test('the webview script sets no innerHTML and loads nothing remote', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js));
  assert.ok(!/https?:\/\//.test(js));
  assert.ok(/e\.style\.setProperty/.test(js));
  assert.ok(!/setAttribute\(\s*['"]style/.test(js));
});

test('showProTools false hides the tools in the webview state', async () => {
  const s = loadExtension();
  try {
    s.config.showProTools = false;
    s.ext.activate(s.context);
    const v = await openInViewer(s, SAV);
    assert.strictEqual(v.posted[0].pro.show, false);
    closeAll(s);
  } finally { s.restore(); }
});

test('package.json: phrase-first name, engines ^1.90.0, default editor for the 4 extensions, Pro titles', () => {
  const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(p.displayName.startsWith('SPSS Viewer & Stata Viewer'));
  assert.notStrictEqual(p.displayName, 'Stata Viewer');
  assert.ok(p.description.startsWith('SPSS viewer and Stata viewer'));
  assert.strictEqual(p.engines.vscode, '^1.90.0');
  assert.strictEqual(p.devDependencies['@types/vscode'], '~1.90.0');
  assert.deepStrictEqual(p.contributes.customEditors[0].selector.map((x) => x.filenamePattern), ['*.sav', '*.zsav', '*.dta', '*.xpt']);
  assert.strictEqual(p.contributes.customEditors[0].priority, 'default');
  const pro = p.contributes.commands.filter((c) => /exportData|codebook|crosstab/.test(c.command));
  assert.strictEqual(pro.length, 3);
  for (const c of pro) assert.match(c.title, /\(Pro\)$/);
  assert.strictEqual(p.contributes.commands.filter((c) => c.category === 'Zovo Pro').length, 6);
  assert.ok(!p.dependencies || !Object.keys(p.dependencies).length, 'no runtime dependencies');
  const w = p.contributes.walkthroughs[0].steps;
  assert.strictEqual(w.at(-1).id, 'zovo-related');
  for (const st of w) assert.ok(fs.existsSync(path.join(__dirname, '..', st.media.markdown)), st.media.markdown);
  for (const f of ['samples/sample-survey.sav', 'samples/sample-survey.dta', 'icon.png', 'LICENSE', 'CHANGELOG.md']) assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f);
});

test('rating wiring: a rendered file counts once; a text file is neither a success nor a failure; samples do not count', async () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const t = await openInViewer(s, TXT);
    assert.strictEqual(t.posted[0].notData, true);
    const st0 = s.state.get('zovo.rating.v2');
    assert.ok(!st0 || !st0.lastError, 'not a failure');
    const v = await openInViewer(s, SAV);
    await v.send({ type: 'rendered' });
    await v.send({ type: 'rendered' });
    const st = s.state.get('zovo.rating.v2');
    assert.ok(st && st.count === 1, `one good file counted once: ${JSON.stringify(st)}`);
    const sample = await openInViewer(s, path.join(__dirname, '..', 'samples', 'sample-survey.sav'));
    await sample.send({ type: 'rendered' });
    assert.strictEqual(s.state.get('zovo.rating.v2').count, 1, 'the walkthrough sample does not count');
    closeAll(s);
  } finally { s.restore(); }
});
