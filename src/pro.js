'use strict';
// Zovo Pro for SPSS Viewer & Stata Viewer, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license). Three Pro tools, 3 free tries each on this computer. A try counts only after the tool
// produced its output (a saved file, or a crosstab on screen); Escape or Cancel never uses one.
// Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no tries left.
const { createLicense } = require('./license');

const SKU = 'stats-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'statsViewer.proTrial';

const FEATURES = {
  export: {
    title: 'Export data (CSV, Excel, JSON)',
    detail: 'Saves the rows in the current view (filter and sort applied) as CSV, an Excel workbook or JSON, with value labels or with codes. The Excel file also has a sheet of variables.',
  },
  codebook: {
    title: 'Codebook (Markdown, HTML, CSV)',
    detail: 'Writes a codebook of every variable: name, label, type, format, measure, missing value definitions, value labels with counts and percentages, and summary statistics.',
  },
  crosstab: {
    title: 'Crosstab with chi-square',
    detail: 'Cross-tabulates two variables (and an optional layer variable) with counts, row, column and total percentages and a Pearson chi-square test. Save the table as CSV or Markdown.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function createPro({ vscode, context, license, prefix = 'statsViewer', productName = 'SPSS & Stata Viewer' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, triesUsed: used(f), tools: TOOLS }));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). Returns the try note ('' when
   *  licensed). With { quiet: true } the caller shows the note in its own status message (one message, not two that
   *  replace each other). */
  async function produced(f, { quiet = false } = {}) {
    if (licensed() || !FEATURES[f]) return '';
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    const note = `Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`;
    if (!quiet) vscode.window.setStatusBarMessage(note, 8000);
    emitter.fire(false);
    return note;
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS };
