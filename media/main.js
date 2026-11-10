// SPSS Viewer & Stata Viewer webview. Every value goes on the page with textContent (never as HTML), so names and
// labels from a hostile file stay text. Rows come from the extension host a page at a time; nothing here talks to
// the network. Styles are set through the CSSOM (the CSP has no 'unsafe-inline').
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const ROW_H = 24, HEAD_H = 28, PAGE = 100, COLBLK = 60, MAX_H = 8000000;
  const S = {
    meta: null, name: '', tab: 'data', labels: true, view: { filter: null, sort: null }, count: 0, seq: 0,
    pages: new Map(), pending: new Set(), sel: null, scroll: { top: 0, left: 0 }, varFilter: '', summary: null, summaryCol: 0,
    crosstab: null, ctShow: { count: true, row: true, col: false, total: false }, pro: { show: true, tries: {} }, rendered: false,
    filterCol: 0, filterText: '',
  };

  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k === 'style') { for (const decl of String(v).split(';')) { const i = decl.indexOf(':'); if (i > 0) e.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); } }
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  };
  const px = (e, prop, n) => e.style.setProperty(prop, `${n}px`);
  const fmtInt = (n) => Number(n).toLocaleString('en-US');
  const fmtNum = (x, d = 4) => (x === null || x === undefined || Number.isNaN(x) ? '' : Number.isInteger(x) ? fmtInt(x) : Number(x).toLocaleString('en-US', { maximumFractionDigits: d }));
  const plural = (n, w) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;
  const post = (m) => vscode.postMessage(m);
  const vars = () => (S.meta ? S.meta.variables : []);

  // ---------- frame ----------

  function frame(main) {
    app.textContent = '';
    const m = S.meta;
    const desc = m ? `${m.formatLabel} · ${plural(m.rows, 'row')} · ${plural(m.variables.length, 'variable')}` : '';
    const head = h('header', { class: 'top' },
      h('div', { class: 'title' }, h('span', { class: 'fname', text: S.name }), h('span', { class: 'desc', text: desc })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn toggle' + (S.labels ? ' on' : ''), 'data-act': 'labels', 'aria-pressed': S.labels ? 'true' : 'false', title: 'Show value labels or the codes behind them', onclick: toggleLabels }, S.labels ? 'Value labels' : 'Codes'),
        S.pro.show && m ? proButtons() : null));
    const tabs = h('nav', { class: 'tabs', role: 'tablist' }, ...tabList().map(([id, label, count]) => h('button', {
      class: 'tab' + (S.tab === id ? ' on' : ''), role: 'tab', 'aria-selected': S.tab === id ? 'true' : 'false', 'data-tab': id,
      onclick: () => { S.tab = id; render(); if (id === 'summary' && !S.summary) askSummary(S.summaryCol); },
    }, label, count !== undefined ? h('span', { class: 'count', text: fmtInt(count) }) : null)));
    const foot = document.getElementById('zovo-footer');
    app.append(head, tabs, h('main', { class: 'view', id: 'view' }, main), foot ? foot.content.cloneNode(true) : '');
  }

  function tries(f) { const n = S.pro.tries[f] ?? 3; return S.pro.licensed ? 'Zovo Pro' : `Zovo Pro tool, ${n} free tr${n === 1 ? 'y' : 'ies'} left`; }

  function menuButton(label, tool, title, items) {
    const menu = h('div', { class: 'menu', hidden: true }, ...items.map(([text, kind]) => h('button', { text, 'data-tool': `${tool}:${kind}`, onclick: (e) => { e.stopPropagation(); menu.hidden = true; post({ type: 'tool', tool, arg: { kind } }); } })));
    return h('span', { class: 'drop' }, h('button', { class: 'btn', 'data-tool': tool, title, onclick: (e) => { e.stopPropagation(); document.querySelectorAll('.menu').forEach((x) => { if (x !== menu) x.hidden = true; }); menu.hidden = !menu.hidden; } }, `${label} ▾`), menu);
  }

  function proButtons() {
    return [
      menuButton('Export', 'export', `Save the rows in this view as CSV, Excel or JSON (${tries('export')})`, [['CSV', 'csv'], ['Excel (.xlsx)', 'xlsx'], ['JSON', 'json']]),
      menuButton('Codebook', 'codebook', `Write a codebook of all variables (${tries('codebook')})`, [['Markdown', 'md'], ['HTML', 'html'], ['CSV', 'csv']]),
      h('button', { class: 'btn', 'data-tool': 'crosstab', title: `Crosstab two variables with a chi-square test (${tries('crosstab')})`, onclick: () => post({ type: 'tool', tool: 'crosstab' }) }, 'Crosstab…'),
    ];
  }
  document.addEventListener('click', () => document.querySelectorAll('.menu').forEach((x) => { x.hidden = true; }));

  function tabList() {
    const out = [['data', 'Data'], ['variables', 'Variables', vars().length], ['info', 'Info'], ['summary', 'Summary']];
    if (S.crosstab) out.push(['crosstab', 'Crosstab']);
    return out;
  }

  function render() {
    if (!S.meta) return;
    let main;
    if (S.tab === 'variables') main = variablesView();
    else if (S.tab === 'info') main = infoView();
    else if (S.tab === 'summary') main = summaryView();
    else if (S.tab === 'crosstab') main = crosstabView();
    else main = dataView();
    frame(main);
    if (S.afterRender) { const f = S.afterRender; S.afterRender = null; f(); }
  }

  function toggleLabels() {
    S.labels = !S.labels;
    post({ type: 'labels', labels: S.labels });
    S.pages.clear(); S.pending.clear();
    if (S.view.filter) applyView(); else { S.seq++; render(); }
    if (S.summary) askSummary(S.summary.col);
  }

  // ---------- data grid ----------

  const colW = () => {
    if (S.colW && S.colW.n === vars().length) return S.colW;
    const w = vars().map((v) => {
      const base = v.type === 'string' ? Math.min(260, Math.max(90, (v.width || 8) * 7)) : v.date ? 150 : v.labels ? 130 : 96;
      return Math.max(base, Math.min(260, 24 + v.name.length * 8));
    });
    const x = new Float64Array(w.length + 1);
    for (let i = 0; i < w.length; i++) x[i + 1] = x[i] + w[i];
    S.colW = { n: w.length, w, x };
    return S.colW;
  };
  const numW = () => Math.max(56, 14 + String(S.meta.rows).length * 8);

  function applyView() {
    S.seq++;
    S.pages.clear(); S.pending.clear(); S.sel = null; S.scroll.top = 0;
    S.busy = true;
    post({ type: 'view', seq: S.seq, view: S.view, labels: S.labels });
    render();
  }

  function dataView() {
    const cols = vars();
    const sel = h('select', { class: 'fcol', 'aria-label': 'Filter column', title: 'Column to filter', onchange: (e) => { S.filterCol = Number(e.target.value); } },
      ...cols.map((v, i) => { const o = h('option', { value: String(i), text: v.name }); if (i === S.filterCol) o.selected = true; return o; }));
    const input = h('input', { type: 'search', class: 'filter', placeholder: 'Filter: text, > 3, 1..5, missing', 'aria-label': 'Filter value', value: S.filterText });
    const run = () => {
      S.filterText = input.value;
      S.view.filter = input.value.trim() ? { col: S.filterCol, query: input.value } : null;
      S.afterRender = () => { const f = document.querySelector('.filter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } };
      applyView();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    input.addEventListener('search', () => { if (!input.value && S.view.filter) run(); });
    const status = h('span', { class: 'muted status', text: S.busy ? 'Working…' : S.viewError ? S.viewError : S.view.filter || S.view.sort ? `${fmtInt(S.count)} of ${plural(S.meta.rows, 'row')}` : plural(S.meta.rows, 'row') });
    const tools = h('div', { class: 'tools' }, sel, input, h('button', { class: 'btn small', text: 'Filter', onclick: run }),
      S.view.filter || S.view.sort ? h('button', { class: 'btn small', text: 'Clear', title: 'Clear the filter and the sort', onclick: () => { S.view = { filter: null, sort: null }; S.filterText = ''; applyView(); } }) : null,
      status, h('span', { class: 'grow' }),
      h('button', { class: 'btn small', 'data-act': 'copy', title: 'Copy the selected cells, or the rows on screen, tab separated (Ctrl+C / Cmd+C)', onclick: copySelection }, 'Copy'));
    const scroller = h('div', { class: 'gscroll', tabindex: '0', 'aria-label': 'Data grid' });
    const spacer = h('div', { class: 'gspacer' });
    scroller.append(spacer);
    const layer = h('div', { class: 'glayer' });
    const wrap = h('div', { class: 'gwrap' }, scroller, layer);
    S.grid = { scroller, spacer, layer };
    scroller.addEventListener('scroll', () => { S.scroll.top = scroller.scrollTop; S.scroll.left = scroller.scrollLeft; drawGrid(); });
    layer.addEventListener('wheel', (e) => { scroller.scrollTop += e.deltaY; scroller.scrollLeft += e.deltaX || (e.shiftKey ? e.deltaY : 0); e.preventDefault(); }, { passive: false });
    scroller.addEventListener('keydown', gridKeys);
    layer.addEventListener('keydown', gridKeys);
    S.afterRender = ((prev) => () => { if (prev) prev(); scroller.scrollTop = S.scroll.top; scroller.scrollLeft = S.scroll.left; drawGrid(); })(S.afterRender);
    return h('div', { class: 'datawrap' }, tools, wrap, S.meta.warnings && S.meta.warnings.length ? h('div', { class: 'warnline', text: `${S.meta.warnings[0]}${S.meta.warnings.length > 1 ? ` (${S.meta.warnings.length} notes on the Info tab)` : ''}` }) : S.meta.truncated ? h('div', { class: 'warnline', text: 'Not every row was read.' }) : null);
  }

  /** Scroll geometry: first row on screen and the pixel offset of that row. */
  function geometry() {
    const g = S.grid, sc = g.scroller;
    const vh = Math.max(0, (sc.clientHeight || 400) - HEAD_H);
    const full = S.count * ROW_H;
    const totalH = Math.min(full, MAX_H);
    const vis = Math.ceil(vh / ROW_H) + 1;
    let first, offY;
    if (full <= MAX_H) { first = Math.floor(sc.scrollTop / ROW_H); offY = -(sc.scrollTop % ROW_H); }
    else { const span = Math.max(1, totalH - vh); const frac = Math.min(1, sc.scrollTop / span); const fit = Math.max(1, Math.floor(vh / ROW_H)); first = Math.floor(frac * Math.max(0, S.count - fit)); offY = 0; } // at the end the last row sits fully on screen
    return { first: Math.max(0, first), offY, vis, vh, totalH };
  }

  function drawGrid() {
    const g = S.grid;
    if (!g || !g.scroller.isConnected) return;
    const sc = g.scroller, cw = colW(), nw = numW();
    const { first, offY, vis, totalH } = geometry();
    px(g.spacer, 'height', HEAD_H + totalH + 2);
    px(g.spacer, 'width', nw + cw.x[cw.n] + 2);
    px(g.layer, 'width', sc.clientWidth || 600);
    px(g.layer, 'height', sc.clientHeight || 400);
    px(g.layer, '--numw', nw);
    const left = sc.scrollLeft, width = (sc.clientWidth || 600) - nw;
    let c0 = 0; while (c0 < cw.n && cw.x[c0 + 1] <= left) c0++;
    let c1 = c0; while (c1 < cw.n && cw.x[c1] < left + width) c1++;
    const last = Math.min(S.count, first + vis);
    g.layer.textContent = '';
    // header
    const head = h('div', { class: 'ghead' });
    px(head, 'height', HEAD_H);
    head.append(h('div', { class: 'gnum gcorner', text: '#' }));
    for (let c = c0; c < c1; c++) {
      const v = vars()[c];
      const s = S.view.sort;
      const cell = h('div', { class: 'gh' + (S.sel && c >= S.sel.c0 && c <= S.sel.c1 ? ' selc' : ''), title: `${v.name}${v.label ? `: ${v.label}` : ''} (${v.storage || v.type}). Click to sort.`, 'data-col': String(c) },
        h('span', { class: 'ghn', text: v.name }), s && s.col === c ? h('span', { class: 'arrow', text: s.dir > 0 ? '▴' : '▾' }) : null,
        h('button', { class: 'sum', title: `Summary of ${v.name}`, 'aria-label': `Summary of ${v.name}`, onclick: (e) => { e.stopPropagation(); S.tab = 'summary'; askSummary(c); render(); } }, 'Σ'));
      px(cell, 'left', nw + cw.x[c] - left); px(cell, 'width', cw.w[c]);
      cell.addEventListener('click', () => { const cur = S.view.sort; S.view.sort = !cur || cur.col !== c ? { col: c, dir: 1 } : cur.dir > 0 ? { col: c, dir: -1 } : null; applyView(); });
      head.append(cell);
    }
    g.layer.append(head);
    if (S.busy) { g.layer.append(h('div', { class: 'gmsg', text: 'Working…' })); return; }
    if (!S.count) { g.layer.append(h('div', { class: 'gmsg', text: S.view.filter ? 'No row matches the filter.' : 'This file has no rows.' })); return; }
    let missing = false;
    for (let k = first; k < last; k++) {
      const y = HEAD_H + (k - first) * ROW_H + offY;
      const pg = Math.floor(k / PAGE);
      const rowSel = S.sel && k >= S.sel.k0 && k <= S.sel.k1;
      const blk0 = Math.floor(c0 / COLBLK);
      const p0 = S.pages.get(`${pg}:${blk0}`);
      const num = h('div', { class: 'gnum' + (rowSel ? ' selr' : ''), text: p0 ? fmtInt(p0.nums[k - p0.start]) : '', title: 'Row in the file. Click to select the row.', onclick: (e) => selectAt(k, null, e.shiftKey) });
      px(num, 'top', y);
      g.layer.append(num);
      for (let c = c0; c < c1; c++) {
        const p = S.pages.get(`${pg}:${Math.floor(c / COLBLK)}`);
        if (!p) { missing = true; need(pg, Math.floor(c / COLBLK)); continue; }
        const t = p.rows[k - p.start][c - p.c0];
        const m = p.miss[k - p.start][c - p.c0];
        const v = vars()[c];
        const cls = 'gc' + (v.type !== 'string' && !(S.labels && v.labels && m === 0 && !/^-?[\d.,]+$/.test(t)) ? ' num' : '') + (m === 1 ? ' sys' : m === 2 ? ' umis' : '') + (rowSel && S.sel && c >= S.sel.c0 && c <= S.sel.c1 ? ' sel' : '');
        const cell = h('div', { class: cls, text: t, title: t.length > 24 ? t : m === 2 ? 'Missing value' : null });
        px(cell, 'top', y); px(cell, 'left', nw + cw.x[c] - left); px(cell, 'width', cw.w[c]);
        cell.addEventListener('click', (e) => selectAt(k, c, e.shiftKey));
        g.layer.append(cell);
      }
    }
    if (missing) g.layer.append(h('div', { class: 'gload', text: 'Loading…' }));
    else if (!S.rendered) { S.rendered = true; post({ type: 'rendered' }); }
  }

  function need(pg, blk) {
    const key = `${pg}:${blk}`;
    if (S.pending.has(key) || S.pages.has(key)) return;
    S.pending.add(key);
    post({ type: 'page', seq: S.seq, start: pg * PAGE, count: PAGE, c0: blk * COLBLK, c1: (blk + 1) * COLBLK, labels: S.labels, key });
  }

  function selectAt(k, c, extend) {
    const all = c === null;
    const c0 = all ? 0 : c, c1 = all ? vars().length - 1 : c;
    if (extend && S.sel) S.sel = { ak: S.sel.ak, ac: S.sel.ac, k0: Math.min(S.sel.ak, k), k1: Math.max(S.sel.ak, k), c0: all ? 0 : Math.min(S.sel.ac, c), c1: all ? vars().length - 1 : Math.max(S.sel.ac, c) };
    else S.sel = { ak: k, ac: all ? 0 : c, k0: k, k1: k, c0, c1 };
    drawGrid();
    S.grid.scroller.focus({ preventScroll: true });
  }

  function copySelection() {
    if (S.sel) post({ type: 'copy', k0: S.sel.k0, k1: S.sel.k1 + 1, c0: S.sel.c0, c1: S.sel.c1 + 1, labels: S.labels, header: S.sel.k0 !== S.sel.k1 || S.sel.c0 !== S.sel.c1 });
    else { const { first, vis } = geometry(); post({ type: 'copy', k0: first, k1: Math.min(S.count, first + vis), c0: 0, c1: vars().length, labels: S.labels, header: true }); }
  }

  function gridKeys(e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) { copySelection(); e.preventDefault(); return; }
    if (!S.sel || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const k = Math.max(0, Math.min(S.count - 1, S.sel.ak + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0)));
    const c = Math.max(0, Math.min(vars().length - 1, S.sel.ac + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0)));
    S.sel = { ak: k, ac: c, k0: k, k1: k, c0: c, c1: c };
    const sc = S.grid.scroller, { first, vis } = geometry();
    if (S.count * ROW_H <= MAX_H) { if (k < first) sc.scrollTop = k * ROW_H; else if (k >= first + vis - 2) sc.scrollTop = (k - vis + 3) * ROW_H; }
    const cw = colW(), nw = numW();
    if (cw.x[c] < sc.scrollLeft) sc.scrollLeft = cw.x[c]; else if (cw.x[c + 1] > sc.scrollLeft + sc.clientWidth - nw) sc.scrollLeft = cw.x[c + 1] - sc.clientWidth + nw;
    drawGrid();
    e.preventDefault();
  }

  // ---------- small virtual table (variables, frequencies) ----------

  function vtable(columns, rows, { onRow, empty = 'Nothing here.' } = {}) {
    const tpl = `grid-template-columns: ${columns.map((c) => c.w || 'minmax(80px, 1fr)').join(' ')}`;
    const head = h('div', { class: 'thead', style: tpl }, ...columns.map((c) => h('span', { class: 'th' + (c.num ? ' num' : ''), text: c.n })));
    const body = h('div', { class: 'tbody', tabindex: '0' });
    const spacer = h('div', { class: 'spacer' }); px(spacer, 'height', rows.length * ROW_H);
    const lay = h('div', { class: 'layer' });
    body.append(spacer, lay);
    const draw = () => {
      const top = body.scrollTop, hgt = body.clientHeight || 600;
      const a = Math.max(0, Math.floor(top / ROW_H) - 5), b = Math.min(rows.length, Math.ceil((top + hgt) / ROW_H) + 5);
      lay.textContent = '';
      lay.style.setProperty('transform', `translateY(${a * ROW_H}px)`);
      for (let i = a; i < b; i++) {
        const r = rows[i];
        lay.append(h('div', { class: 'tr' + (onRow ? ' click' : ''), style: tpl, onclick: onRow ? () => onRow(i) : null },
          ...r.map((v, ci) => h('span', { class: 'td' + (columns[ci].num ? ' num' : ''), text: v === null || v === undefined ? '' : String(v), title: String(v ?? '').length > 28 ? String(v) : null }))));
      }
    };
    body.addEventListener('scroll', draw);
    S.afterRender = ((prev) => () => { if (prev) prev(); draw(); })(S.afterRender);
    return h('div', { class: 'tablewrap' }, head, rows.length ? body : h('p', { class: 'pad muted', text: empty }));
  }

  function labelsText(name) {
    const set = name && S.meta.labelSets[name];
    if (!set || !set.length) return '';
    const parts = set.slice(0, 12).map(([v, l]) => `${v} = ${l}`);
    return parts.join('; ') + (set.length > 12 ? `; … (${fmtInt(set.length)} labels)` : '');
  }

  function variablesView() {
    const q = S.varFilter.trim().toLowerCase();
    const list = vars().map((v, i) => [i + 1, v.name, v.label, v.storage || v.type, v.format, v.measure, v.missing, labelsText(v.labels)])
      .filter((r) => !q || r.slice(1).some((x) => String(x).toLowerCase().includes(q)));
    const input = h('input', { type: 'search', class: 'filter vfilter', placeholder: `Filter ${fmtInt(vars().length)} variables`, 'aria-label': 'Filter variables', value: S.varFilter });
    let t;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { S.varFilter = input.value; S.afterRender = () => { const f = document.querySelector('.vfilter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }; render(); }, 150); });
    const cols = [{ n: '#', w: '48px', num: true }, { n: 'Name', w: 'minmax(110px, 1.2fr)' }, { n: 'Label', w: 'minmax(160px, 2.5fr)' }, { n: 'Type', w: 'minmax(70px, 0.8fr)' }, { n: 'Format', w: 'minmax(70px, 0.8fr)' }, { n: 'Measure', w: 'minmax(70px, 0.7fr)' }, { n: 'Missing values', w: 'minmax(90px, 1fr)' }, { n: 'Value labels', w: 'minmax(160px, 3fr)' }];
    const tools = h('div', { class: 'tools' }, input, h('span', { class: 'muted', text: q ? `${fmtInt(list.length)} of ${fmtInt(vars().length)} variables` : `${fmtInt(vars().length)} variables` }), h('span', { class: 'grow' }),
      h('button', { class: 'btn small', text: 'Copy list', title: 'Copy this list, tab separated', onclick: () => post({ type: 'copyText', what: `${fmtInt(list.length)} variables`, text: [cols.map((c) => c.n).join('\t'), ...list.map((r) => r.map((x) => String(x).replace(/[\t\n\r]+/g, ' ')).join('\t'))].join('\n') }) }));
    return h('div', { class: 'datawrap' }, tools, vtable(cols, list, { onRow: (i) => { const col = list[i][0] - 1; S.tab = 'summary'; askSummary(col); render(); }, empty: 'No variable matches.' }));
  }

  function infoView() {
    const m = S.meta, i = m.info || {};
    const pairs = [
      ['File', S.name], ['Format', m.formatLabel], ['Rows', i.rows !== null && i.rows !== undefined && i.rows !== m.rows ? `${fmtInt(m.rows)} read (the file says ${fmtInt(i.rows)})` : fmtInt(m.rows)],
      ['Variables', fmtInt(m.variables.length)], ['File label', i.fileLabel], ['Created', i.created], ['Encoding', i.encoding], ['Compression', i.compression],
      ['Written by', i.product], ['Release', i.release], ['Byte order', i.byteOrder], ['Weight variable', i.weight], ['Dataset', i.member],
      ['Value label sets', fmtInt(Object.keys(m.labelSets || {}).length)],
    ].filter(([, v]) => v !== '' && v !== null && v !== undefined);
    const box = h('div', { class: 'pad' }, h('h2', { text: 'Dataset' }), h('dl', { class: 'kv' }, ...pairs.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })])));
    if (m.warnings && m.warnings.length) box.append(h('h3', { text: 'Notes about this file' }), h('ul', { class: 'warn' }, ...m.warnings.map((w) => h('li', { text: w }))));
    if (i.notes && i.notes.length) box.append(h('h3', { text: 'Documents in the file' }), h('pre', { class: 'doc', text: i.notes.join('\n') }));
    return box;
  }

  // ---------- summary ----------

  function askSummary(col) { S.summaryCol = col; S.summary = { col, loading: true }; post({ type: 'summary', col, labels: S.labels }); }

  function summaryView() {
    const sel = h('select', { class: 'scol', 'aria-label': 'Variable', onchange: (e) => { askSummary(Number(e.target.value)); render(); } },
      ...vars().map((v, i) => { const o = h('option', { value: String(i), text: v.label ? `${v.name}: ${v.label}`.slice(0, 120) : v.name }); if (i === S.summaryCol) o.selected = true; return o; }));
    const box = h('div', { class: 'pad' }, h('div', { class: 'tools flat' }, h('label', { text: 'Variable ' }, sel)));
    const sm = S.summary;
    if (!sm || sm.loading) { box.append(h('p', { class: 'muted', text: 'Counting…' })); return box; }
    if (sm.error) { box.append(h('p', { class: 'notice', text: sm.error })); return box; }
    const s = sm.s, v = vars()[sm.col];
    box.append(h('h2', { text: v.label ? `${v.name}: ${v.label}` : v.name }), h('p', { class: 'muted', text: `${v.storage || v.type}${v.format ? `, format ${v.format}` : ''}${v.measure ? `, ${v.measure}` : ''}${sm.filtered ? `. Over the ${fmtInt(s.rows)} rows of the current filter.` : ''}` }));
    const cards = [['Rows', fmtInt(s.rows)], ['Valid', fmtInt(s.valid)], ['Missing', fmtInt(s.sysmis + s.usermis + (s.empty || 0))], ['Distinct', fmtInt(s.distinct) + (s.distinctCapped ? '+' : '')]];
    if (v.type !== 'string' && s.valid) {
      cards.push(['Mean', s.meanText || fmtNum(s.mean)], ['SD', s.sd === null ? '' : fmtNum(s.sd)], ['Min', s.minText], ['Median', s.medianText || fmtNum(s.median)], ['Max', s.maxText]);
    }
    box.append(h('div', { class: 'cards' }, ...cards.map(([k, val]) => h('div', { class: 'card' }, h('div', { class: 'ck', text: k }), h('div', { class: 'cv', text: val })))));
    if (s.usermis) box.append(h('p', { class: 'muted', text: `${fmtInt(s.usermis)} user-defined or extended missing value${s.usermis === 1 ? '' : 's'} (left out of the statistics).` }));
    if (s.freq && s.freq.length) {
      box.append(h('h3', { text: 'Frequencies' }), vtable([{ n: 'Value', w: 'minmax(80px, 1fr)' }, { n: 'Label', w: 'minmax(140px, 2fr)' }, { n: 'Count', w: '90px', num: true }, { n: 'Percent', w: '80px', num: true }, { n: 'Valid %', w: '80px', num: true }, { n: 'Cumulative %', w: '110px', num: true }],
        s.freq.map((f) => [f.code, f.label + (f.missing ? ' (missing)' : ''), fmtInt(f.count), `${f.pct.toFixed(1)}%`, f.validPct === null ? '' : `${f.validPct.toFixed(1)}%`, f.cumPct === null ? '' : `${f.cumPct.toFixed(1)}%`])));
    } else if (s.top && s.top.length) {
      box.append(h('h3', { text: 'Most frequent values' }), vtable([{ n: 'Value', w: 'minmax(140px, 3fr)' }, { n: 'Count', w: '90px', num: true }, { n: 'Percent', w: '80px', num: true }],
        s.top.map((t) => [t.value, fmtInt(t.count), `${t.pct.toFixed(1)}%`])));
    }
    return box;
  }

  // ---------- crosstab ----------

  function crosstabView() {
    const ct = S.crosstab;
    const box = h('div', { class: 'pad' });
    const title = `${ct.row.name} by ${ct.col.name}${ct.layer ? `, layered by ${ct.layer.name}` : ''}`;
    const checks = [['count', 'Count'], ['row', 'Row %'], ['col', 'Column %'], ['total', 'Total %']].map(([k, label]) => {
      const cb = h('input', { type: 'checkbox', 'data-show': k, onchange: (e) => { S.ctShow[k] = e.target.checked; render(); } });
      cb.checked = !!S.ctShow[k];
      return h('label', { class: 'chk' }, cb, ` ${label}`);
    });
    box.append(h('h2', { text: title }), h('p', { class: 'muted', text: `Rows used: ${fmtInt(ct.rowsUsed)}. Rows with a missing value in one of the variables: ${fmtInt(ct.missingRows)}.` }),
      h('div', { class: 'tools flat' }, ...checks, h('span', { class: 'grow' }),
        h('button', { class: 'btn small', 'data-act': 'ct-csv', onclick: () => post({ type: 'saveCrosstab', kind: 'csv' }) }, 'Save as CSV'),
        h('button', { class: 'btn small', 'data-act': 'ct-md', onclick: () => post({ type: 'saveCrosstab', kind: 'md' }) }, 'Save as Markdown'),
        S.pro.show ? h('button', { class: 'btn small', onclick: () => post({ type: 'tool', tool: 'crosstab' }) }, 'New crosstab…') : null));
    for (const t of ct.tables) {
      if (ct.layer) box.append(h('h3', { text: `${ct.layer.name} = ${t.layerText}` }));
      const pctOf = (i, j, mode) => { const n = t.counts[i][j]; const d = mode === 'row' ? t.rowTotals[i] : mode === 'col' ? t.colTotals[j] : t.n; return d ? `${((100 * n) / d).toFixed(1)}%` : ''; };
      const cellKids = (i, j) => [S.ctShow.count ? h('div', { text: fmtInt(t.counts[i][j]) }) : null, ...['row', 'col', 'total'].filter((k) => S.ctShow[k]).map((k) => h('div', { class: 'pct', text: pctOf(i, j, k) }))];
      const table = h('table', { class: 'ct' },
        h('thead', {}, h('tr', {}, h('th', { text: `${ct.row.name} \\ ${ct.col.name}` }), ...t.colText.map((c) => h('th', { text: c })), h('th', { text: 'Total' }))),
        h('tbody', {}, ...t.rowText.map((r, i) => h('tr', {}, h('th', { text: r }), ...t.colText.map((_, j) => h('td', {}, ...cellKids(i, j))), h('td', { class: 'tot', text: fmtInt(t.rowTotals[i]) }))),
          h('tr', { class: 'tot' }, h('th', { text: 'Total' }), ...t.colTotals.map((n) => h('td', { text: fmtInt(n) })), h('td', { text: fmtInt(t.n) }))));
      box.append(h('div', { class: 'ctwrap' }, table));
      box.append(h('p', { class: 'chi', text: t.chi2 === null ? `N = ${fmtInt(t.n)}. The chi-square test needs at least 2 rows and 2 columns with data.` : `N = ${fmtInt(t.n)}. Pearson chi-square = ${t.chi2.toFixed(3)}, df = ${t.df}, p ${t.p < 0.001 ? '< 0.001' : `= ${t.p.toFixed(3)}`}.${t.lowExpected ? ` ${t.lowExpected} of ${t.cellsUsed} cells have an expected count below 5, so read the p-value with care.` : ''}` }));
    }
    return box;
  }

  // ---------- messages ----------

  function errorPage(m) {
    app.textContent = '';
    app.append(h('div', { class: 'pad' }, h('h2', { text: m.notData ? 'Not an SPSS, Stata or SAS transport file' : 'This file could not be read' }), h('p', { class: 'errmsg', text: m.message }),
      m.notData ? h('p', { class: 'muted', text: 'SPSS & Stata Viewer reads SPSS .sav and .zsav, Stata .dta (releases 113 to 119) and SAS transport .xpt (versions 5 and 8) files.' }) : null,
      h('div', { class: 'tools flat' }, h('button', { class: 'btn', 'data-act': 'reload', onclick: () => { app.textContent = ''; app.append(h('p', { class: 'loading', text: 'Reading the file...' })); post({ type: 'reload' }); } }, 'Try again'),
        m.notData ? h('button', { class: 'btn', 'data-act': 'text', onclick: () => post({ type: 'openText' }) }, 'Open as text') : null)));
    const foot = document.getElementById('zovo-footer'); if (foot) app.append(foot.content.cloneNode(true));
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'meta') {
      S.meta = m.meta; S.name = m.name; S.count = m.meta.rows; S.pro = m.pro || S.pro; S.colW = null;
      S.seq++; S.pages.clear(); S.pending.clear(); S.view = { filter: null, sort: null }; S.busy = false; S.viewError = '';
      render();
      if (!S.meta.rows && !S.rendered) { S.rendered = true; post({ type: 'rendered' }); }
    } else if (m.type === 'error') {
      if (m.pro) S.pro = m.pro;
      errorPage(m);
    } else if (m.type === 'view') {
      if (m.seq !== S.seq) return;
      S.busy = false;
      if (m.error) { S.viewError = m.error; S.view.filter = null; } else { S.viewError = ''; S.count = m.count; }
      if (S.tab === 'data') render();
    } else if (m.type === 'page') {
      if (m.seq !== S.seq) return;
      S.pending.delete(m.key || `${Math.floor(m.start / PAGE)}:${Math.floor(m.c0 / COLBLK)}`);
      if (m.error) { const v = document.getElementById('view'); if (v) v.prepend(h('div', { class: 'notice', text: m.error })); return; }
      S.pages.set(`${Math.floor(m.start / PAGE)}:${Math.floor(m.c0 / COLBLK)}`, m);
      if (S.pages.size > 400) S.pages.delete(S.pages.keys().next().value);
      if (S.tab === 'data') drawGrid();
    } else if (m.type === 'summary') {
      if (m.col !== S.summaryCol) return;
      S.summary = m.error ? { col: m.col, error: m.error } : { col: m.col, s: m.s, filtered: m.filtered };
      if (S.tab === 'summary') render();
    } else if (m.type === 'crosstab') {
      S.crosstab = m.result; S.tab = 'crosstab'; render();
    } else if (m.type === 'pro') {
      S.pro = m.pro || S.pro;
      if (S.meta) render();
    } else if (m.type === 'notice') {
      const v = document.getElementById('view');
      if (v) v.prepend(h('div', { class: 'notice', text: m.text }));
    }
  });
  window.addEventListener('resize', () => { if (S.tab === 'data') drawGrid(); });
  // Draw again when the panel shows: a hidden webview may have skipped a frame.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.meta) render(); });
  post({ type: 'ready' });
}());
