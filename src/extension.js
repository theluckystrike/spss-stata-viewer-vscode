'use strict';
// SPSS Viewer & Stata Viewer: a read-only custom editor for SPSS (.sav, .zsav), Stata (.dta) and SAS transport
// (.xpt) data files. Each file is read in its own worker thread (session.js) with a memory cap and a watchdog; the
// webview asks for pages of rows, so a file with millions of rows stays fast. No network: every value goes to the
// webview by postMessage. Pro tools (pro.js) ask only when used.
const vscode = require('vscode');
const path = require('path');
const { Session } = require('./session');
const { buildHtml } = require('./html');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const EXT_ID = 'zovo.zovo-spss-stata-viewer';
const PREFIX = 'statsViewer';
const VIEW_TYPE = 'statsViewer.data';
const MAX_REMOTE_BYTES = 512 * 1024 * 1024; // non-file URIs are read into memory, up to this size
const DATA_FILTERS = { 'SPSS, Stata and SAS transport files': ['sav', 'zsav', 'dta', 'xpt'], 'All files': ['*'] };

let rating = { success() {}, failure() {} };
let pro;
const viewers = new Set();
let active = null;

function setting(key, dflt) { try { return vscode.workspace.getConfiguration(PREFIX).get(key, dflt); } catch { return dflt; } }
const baseName = (uri) => path.posix.basename(uri.path) || uri.toString();
const stem = (name) => name.replace(/\.(sav|zsav|dta|xpt|por)$/i, '');
const fmtInt = (n) => Number(n).toLocaleString('en-US');

async function sessionFor(uri) {
  const name = baseName(uri);
  if (uri.scheme === 'file') return new Session({ file: uri.fsPath, name });
  const st = await vscode.workspace.fs.stat(uri);
  if (st.size > MAX_REMOTE_BYTES) throw new Error(`This file is ${Math.round(st.size / 1048576)} MB on a remote or virtual file system; files there are read up to 512 MB.`);
  const data = await vscode.workspace.fs.readFile(uri);
  return new Session({ buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), name });
}

class Viewer {
  constructor(uri, panel) {
    this.uri = uri; this.panel = panel; this.name = baseName(uri); this.session = null; this.meta = null; this.counted = false;
    this.labels = true; this.lastCrosstab = null; this.loaded = null;
  }
  post(msg) { return this.panel.webview.postMessage(msg).then(undefined, () => false); }
  async load() {
    if (this.session) this.session.dispose();
    this.meta = null;
    this.loaded = (async () => {
      try {
        this.session = await sessionFor(this.uri);
        this.meta = await this.session.open();
        await this.post({ type: 'meta', meta: this.meta, name: this.name, pro: proState() });
      } catch (e) {
        const notData = e.code === 'NOT_DATA';
        if (!notData && e.code !== 'ENOENT') rating.failure();
        await this.post({ type: 'error', message: e.message || String(e), notData, pro: proState() });
      }
    })();
    return this.loaded;
  }
  call(job) { if (!this.session) throw new Error('The file is not open.'); return this.session.call(job); }
  async onMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return undefined;
    switch (msg.type) {
      case 'ready': return this.load();
      case 'rendered':
        if (!this.counted && this.meta) { this.counted = true; rating.success(this.uri); }
        return undefined;
      case 'labels': this.labels = !!msg.labels; return undefined;
      case 'view': {
        try {
          const r = await this.call({ op: 'view', view: msg.view, labels: msg.labels !== false });
          return this.post({ type: 'view', seq: msg.seq, count: r.count });
        } catch (e) { return this.post({ type: 'view', seq: msg.seq, error: e.message }); }
      }
      case 'page': {
        try {
          const r = await this.call({ op: 'page', start: msg.start, count: msg.count, c0: msg.c0, c1: msg.c1, labels: msg.labels !== false });
          return this.post({ type: 'page', seq: msg.seq, ...r });
        } catch (e) { return this.post({ type: 'page', seq: msg.seq, error: e.message }); }
      }
      case 'summary': {
        try {
          const r = await this.call({ op: 'summary', col: msg.col, labels: msg.labels !== false });
          return this.post({ type: 'summary', ...r });
        } catch (e) { return this.post({ type: 'summary', col: msg.col, error: e.message }); }
      }
      case 'copy': {
        try {
          const r = await this.call({ op: 'copy', k0: msg.k0, k1: msg.k1, c0: msg.c0, c1: msg.c1, labels: msg.labels !== false, header: msg.header !== false });
          await vscode.env.clipboard.writeText(r.text);
          vscode.window.setStatusBarMessage(`Copied ${fmtInt(r.rows)} row${r.rows === 1 ? '' : 's'} x ${fmtInt(r.cols)} column${r.cols === 1 ? '' : 's'} (tab separated).`, 4000);
          return this.post({ type: 'copied', rows: r.rows, cols: r.cols });
        } catch (e) { return this.post({ type: 'notice', text: e.message }); }
      }
      case 'copyText': {
        await vscode.env.clipboard.writeText(String(msg.text || '').slice(0, 20 << 20));
        vscode.window.setStatusBarMessage(msg.what ? `Copied ${msg.what}.` : 'Copied.', 3000);
        return undefined;
      }
      case 'tool': return runTool(String(msg.tool), this, msg.arg);
      case 'saveCrosstab': return saveCrosstab(this, msg.kind === 'csv' ? 'csv' : 'md');
      case 'reload': return this.load();
      case 'openText': return vscode.commands.executeCommand('vscode.openWith', this.uri, 'default');
      case 'settings': return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXT_ID}`);
      default: return undefined;
    }
  }
  dispose() { if (this.session) this.session.dispose(); this.session = null; }
}

function proState() {
  return { show: setting('showProTools', true) !== false, licensed: !!(pro && pro.licensed), tries: pro ? pro.tries() : {} };
}

class Provider {
  constructor(context) { this.context = context; }
  openCustomDocument(uri) { return { uri, dispose() {} }; }
  resolveCustomEditor(document, panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, enableCommandUris: commandUris(PREFIX), localResourceRoots: [media] };
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css')).toString(),
      title: baseName(document.uri),
      showSupportLinks: showLinks(vscode, PREFIX),
    });
    const v = new Viewer(document.uri, panel);
    viewers.add(v);
    if (panel.active) active = v;
    panel.onDidChangeViewState(() => { if (panel.active) active = v; else if (active === v && !panel.visible) active = null; });
    panel.onDidDispose(() => { viewers.delete(v); if (active === v) active = null; v.dispose(); });
    panel.webview.onDidReceiveMessage((m) => v.onMessage(m).then(undefined, (e) => v.post({ type: 'notice', text: String((e && e.message) || e) })));
  }
}

// ---------------- Pro tools ----------------

/** The viewer to work on: the one that sent the click, the active one, or a file picked now (opened in the viewer). */
async function targetViewer(from, title) {
  if (from instanceof Viewer) return from;
  let uri = from && from.fsPath ? from : null;
  if (!uri && active) return active;
  if (!uri) {
    const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: title, title: `${title}: pick an SPSS, Stata or SAS transport file`, filters: DATA_FILTERS });
    if (!pick || !pick[0]) return null;
    uri = pick[0];
  }
  const open = [...viewers].find((v) => v.uri.toString() === uri.toString());
  if (open) { if (open.loaded) await open.loaded; return open; }
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  for (let i = 0; i < 100; i++) {
    const v = [...viewers].find((x) => x.uri.toString() === uri.toString());
    if (v && v.loaded) { await v.loaded; return v; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function ready(v) {
  if (v.loaded) await v.loaded;
  if (!v.meta) { vscode.window.showWarningMessage(`${v.name} is not open in the viewer: it could not be read.`); return false; }
  return true;
}

async function runTool(tool, from, arg) {
  if (tool === 'export') return exportData(from, arg && arg.kind);
  if (tool === 'codebook') return codebook(from, arg && arg.kind);
  if (tool === 'crosstab') return crosstab(from, arg);
  return undefined;
}

const EXPORTS = {
  csv: { label: 'CSV', ext: 'csv', filter: { CSV: ['csv'] } },
  xlsx: { label: 'Excel workbook (.xlsx)', ext: 'xlsx', filter: { 'Excel workbook': ['xlsx'] } },
  json: { label: 'JSON', ext: 'json', filter: { JSON: ['json'] } },
};

function defaultTarget(v, suffix) {
  if (v.uri.scheme !== 'file') return undefined;
  return vscode.Uri.file(path.join(path.dirname(v.uri.fsPath), `${stem(v.name)}${suffix}`));
}

async function exportData(from, kind) {
  if (!(await pro.allowed('export'))) return;
  const v = await targetViewer(from, 'Export');
  if (!v || !(await ready(v))) return;
  if (!EXPORTS[kind]) {
    const p = await vscode.window.showQuickPick(Object.entries(EXPORTS).map(([k, e]) => ({ label: e.label, k })), { title: `Export ${v.name}: format` });
    if (!p) return; // cancelled: no try used
    kind = p.k;
  }
  let labels = v.labels;
  if (!(from instanceof Viewer)) {
    const p = await vscode.window.showQuickPick([{ label: 'Value labels', description: 'for example "Female"', l: true }, { label: 'Codes', description: 'for example 2', l: false }], { title: 'Write labelled values as' });
    if (!p) return;
    labels = p.l;
  }
  const e = EXPORTS[kind];
  const target = await vscode.window.showSaveDialog({ defaultUri: defaultTarget(v, `.${e.ext}`), filters: e.filter, title: `Export ${v.name} as ${e.label}, ${labels ? 'with value labels' : 'with codes'}` });
  if (!target) return; // cancelled: no try used
  let r;
  try {
    r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting ${v.name}` }, () => v.call({ op: 'export', kind, labels }));
  } catch (err) { vscode.window.showWarningMessage(`Export stopped: ${err.message}`); return; }
  await vscode.workspace.fs.writeFile(target, new Uint8Array(r.buffer));
  await pro.produced('export');
  const rows = r.rows - (r.cut || 0);
  const note = r.cut ? ` Excel holds 1,048,575 rows: ${fmtInt(r.cut)} more rows were left out; export to CSV for all of them.` : '';
  vscode.window.showInformationMessage(`Saved ${fmtInt(rows)} rows x ${fmtInt(v.meta.variables.length)} variables to ${baseName(target)}.${note}`);
  if (kind !== 'xlsx' && r.bytes < 20 * 1048576) await vscode.window.showTextDocument(target, { preview: false, viewColumn: vscode.ViewColumn.Beside }).then(undefined, () => undefined);
  refreshPro();
}

const CODEBOOKS = {
  md: { label: 'Markdown', ext: 'md', filter: { Markdown: ['md'] } },
  html: { label: 'HTML', ext: 'html', filter: { HTML: ['html'] } },
  csv: { label: 'CSV (one row per value label)', ext: 'csv', filter: { CSV: ['csv'] } },
};

async function codebook(from, kind) {
  if (!(await pro.allowed('codebook'))) return;
  const v = await targetViewer(from, 'Codebook');
  if (!v || !(await ready(v))) return;
  if (!CODEBOOKS[kind]) {
    const p = await vscode.window.showQuickPick(Object.entries(CODEBOOKS).map(([k, e]) => ({ label: e.label, k })), { title: `Codebook of ${v.name}: format` });
    if (!p) return;
    kind = p.k;
  }
  const e = CODEBOOKS[kind];
  const target = await vscode.window.showSaveDialog({ defaultUri: defaultTarget(v, `.codebook.${e.ext}`), filters: e.filter, title: `Save the codebook of ${v.name} as ${e.label}` });
  if (!target) return;
  let r;
  try {
    r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Writing the codebook of ${v.name}` }, () => v.call({ op: 'codebook', kind }));
  } catch (err) { vscode.window.showWarningMessage(`Codebook stopped: ${err.message}`); return; }
  await vscode.workspace.fs.writeFile(target, Buffer.from(r.text, 'utf8'));
  const note = await pro.produced('codebook', { quiet: true });
  vscode.window.setStatusBarMessage(`Codebook of ${fmtInt(r.variables)} variables saved to ${baseName(target)}.${note ? ` ${note}` : ''}`, 8000);
  await vscode.window.showTextDocument(target, { preview: false, viewColumn: vscode.ViewColumn.Beside }).then(undefined, () => undefined);
  refreshPro();
}

async function pickVariable(v, title, { optional = false, exclude = [] } = {}) {
  const items = v.meta.variables.map((x, i) => ({ label: x.name, description: x.label, detail: x.labels ? 'has value labels' : x.type === 'string' ? 'text' : undefined, i })).filter((x) => !exclude.includes(x.i));
  if (optional) items.unshift({ label: 'No layer', description: 'one table', i: null });
  const p = await vscode.window.showQuickPick(items, { title, matchOnDescription: true, placeHolder: 'Type a variable name or label' });
  return p ? p : undefined;
}

async function crosstab(from, arg) {
  if (!(await pro.allowed('crosstab'))) return;
  const v = await targetViewer(from, 'Crosstab');
  if (!v || !(await ready(v))) return;
  let row, col, layer = null;
  if (arg && Number.isInteger(arg.row) && Number.isInteger(arg.col)) { row = arg.row; col = arg.col; layer = Number.isInteger(arg.layer) ? arg.layer : null; }
  else {
    const a = await pickVariable(v, 'Crosstab 1 of 3: row variable');
    if (!a) return; // cancelled: no try used
    const b = await pickVariable(v, `Crosstab 2 of 3: column variable (rows: ${a.label})`, { exclude: [a.i] });
    if (!b) return;
    const c = await pickVariable(v, `Crosstab 3 of 3: layer variable (optional; ${a.label} by ${b.label})`, { optional: true, exclude: [a.i, b.i] });
    if (!c) return;
    row = a.i; col = b.i; layer = c.i;
  }
  let result;
  try { result = await v.call({ op: 'crosstab', row, col, layer, labels: v.labels }); } catch (err) { vscode.window.showWarningMessage(`Crosstab: ${err.message}`); return; }
  v.lastCrosstab = result;
  await v.post({ type: 'crosstab', result });
  v.panel.reveal();
  await pro.produced('crosstab');
  refreshPro();
}

async function saveCrosstab(v, kind) {
  if (!v.lastCrosstab) return;
  const target = await vscode.window.showSaveDialog({ defaultUri: defaultTarget(v, `.crosstab.${kind}`), filters: kind === 'csv' ? { CSV: ['csv'] } : { Markdown: ['md'] }, title: 'Save the crosstab' });
  if (!target) return;
  const r = await v.call({ op: 'crosstabText', kind, result: v.lastCrosstab });
  await vscode.workspace.fs.writeFile(target, Buffer.from(r.text, 'utf8'));
  vscode.window.setStatusBarMessage(`Crosstab saved to ${baseName(target)}.`, 5000);
  if (kind === 'md') await vscode.window.showTextDocument(target, { preview: false, viewColumn: vscode.ViewColumn.Beside }).then(undefined, () => undefined);
}

function refreshPro() { for (const v of viewers) v.post({ type: 'pro', pro: proState() }); }

// ---------------- activation ----------------

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'SPSS & Stata Viewer' });
  registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  context.subscriptions.push(pro.onDidChange(() => refreshPro()));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, new Provider(context), { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }));
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg(`${PREFIX}.open`, async (uri) => {
    let target = uri && uri.scheme ? uri : null;
    if (!target) {
      const p = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open', title: 'Open an SPSS, Stata or SAS transport file', filters: DATA_FILTERS });
      if (!p || !p[0]) return;
      target = p[0];
    }
    await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
  });
  reg(`${PREFIX}.openSample`, async (which) => {
    const name = which === 'dta' ? 'sample-survey.dta' : 'sample-survey.sav';
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'samples', name), VIEW_TYPE);
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#statsViewer.start`, false));
  reg(`${PREFIX}.exportData`, (uri) => exportData(uri && uri.fsPath ? uri : active));
  reg(`${PREFIX}.codebook`, (uri) => codebook(uri && uri.fsPath ? uri : active));
  reg(`${PREFIX}.crosstab`, (uri) => crosstab(uri && uri.fsPath ? uri : active));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) refreshPro(); }));
}

function deactivate() { for (const v of viewers) v.dispose(); }

module.exports = { activate, deactivate, Viewer, VIEW_TYPE };
