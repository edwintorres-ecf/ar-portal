/* ───────────────────────────────────────────────────────────────────────────
   explorer.js — redesign Phase 3, the invoice explorer.
   The most-used screen in the portal. Built on ds.css / ds.js.

   No new endpoints and no schema change, per the plan's guardrails. Saved views
   therefore live in localStorage, which is the right home for them anyway: they
   are one person's working habits, not shared reference data.

   The one structural change is that the table is VIRTUALIZED. The old screen
   paged at 50 rows, so "sort by amount" meant "sort the 50 rows you can see"
   unless you noticed the sort control above it. Rendering the whole result set
   into the DOM is not an option at ~2,400 rows and would be worse in season, so
   only the visible slice is drawn and the rest is spacer height.
   ─────────────────────────────────────────────────────────────────────────── */
'use strict';

// Read from --row-h rather than hard-coded, so the density toggle cannot put
// CSS and this arithmetic out of step. A virtualized table positions every row
// by multiplication: if the real height is 30 and this says 38, rows overlap
// the spacer and the list tears as you scroll.
let EXP_ROW_H = 38;
function expRowH() { return (EXP_ROW_H = dsPx('--row-h', 38)); }
const EXP_OVERSCAN = 8;      // rows drawn beyond the viewport, so scrolling is not bare

let _exp = {
  all: [], rows: [], sel: new Set(), cursor: -1,
  sort: { key: 'daysOverdue', dir: 'desc' },
  f: {}, quick: '',
  cols: null,
  scrollTop: 0,
  loaded: false,
};

/* ── Columns ───────────────────────────────────────────────────────────────
   `get` returns the sortable VALUE; `cell` returns display HTML. Keeping those
   separate is what lets the header sort correctly on a column whose display is
   a chip or a pill rather than the underlying number.
   -------------------------------------------------------------------------- */
const EXP_COLS = [
  { key: 'invoiceId', label: 'Invoice', w: 130, always: true,
    get: i => i.invoiceId || i.recordNo,
    cell: i => `<strong>${dsEsc(i.invoiceId || i.recordNo)}</strong>` },
  { key: 'sc', label: 'SC', w: 64,
    get: i => (_gridMeta && _gridMeta.scMap[i.locationId]) || '',
    cell: i => (typeof commsScChipFor === 'function' ? commsScChipFor(i) : '') },
  { key: 'customerName', label: 'Customer', w: 220,
    get: i => i.customerName || '',
    cell: i => dsEsc(i.customerName || '—') },
  { key: 'locationName', label: 'Location', w: 180,
    get: i => i.locationName || '',
    cell: i => dsEsc(i.locationName || '—') },
  { key: 'status', label: 'Status', w: 140,
    get: i => ((_gridMeta && _gridMeta.csByRecord[i.recordNo]) || {}).status || 'Open',
    cell: i => { const s = ((_gridMeta && _gridMeta.csByRecord[i.recordNo]) || {}).status || 'Open';
                 return `<span class="cs-chip ${typeof commsCsClass === 'function' ? commsCsClass(s) : ''}">${dsEsc(s)}</span>`; } },
  { key: 'totalDue', label: 'Amount', w: 120, num: true, always: true,
    get: i => i.totalDue || 0,
    cell: i => dsMoney(i.totalDue, { cents: true }) },
  { key: 'daysOverdue', label: 'Aging', w: 92, num: true,
    get: i => i.daysOverdue || 0,
    cell: i => (i.daysOverdue > 0
      ? `<span class="age-pill ${typeof commsAgePillClass === 'function' ? commsAgePillClass(i.daysOverdue) : ''}">${i.daysOverdue}d</span>`
      : '<span style="color:#3f7238;font-weight:600;font-size:11.5px">Current</span>') },
  { key: 'poNumber', label: 'PO #', w: 130,
    get: i => i.poNumber || '',
    cell: i => `<span style="font-size:11.5px">${dsEsc(i.poNumber || '—')}</span>` },
  { key: 'paid', label: 'Paid', w: 120, num: true,
    get: i => Math.max(0, (i.totalEntered || 0) - (i.totalDue || 0)),
    cell: i => { const p = Math.max(0, (i.totalEntered || 0) - (i.totalDue || 0));
                 return p >= 0.01 ? `<span style="font-size:11.5px">${dsMoney(p)}</span>` : '<span class="ds-muted" style="font-size:11.5px">—</span>'; } },
  { key: 'collector', label: 'Collector', w: 140,
    get: i => expCollectorName(i),
    cell: i => `<span style="font-size:12px">${dsEsc(expCollectorName(i) || '—')}</span>` },
  { key: 'whenDue', label: 'Due', w: 110,
    get: i => i.whenDue || '',
    cell: i => `<span class="ds-muted" style="font-size:11.5px">${dsEsc((i.whenDue || '').slice(0, 10) || '—')}</span>` },
];

const EXP_DEFAULT_COLS = ['invoiceId', 'sc', 'customerName', 'status', 'totalDue', 'daysOverdue', 'poNumber', 'collector'];

function expCollectorName(i) {
  const e = (typeof commsEffectiveCollector === 'function') ? commsEffectiveCollector(i) : null;
  if (!e) return '';
  const u = (_gridMeta.users || []).find(u2 => u2.email.toLowerCase() === e.toLowerCase());
  return (u && u.name) || e.split('@')[0];
}
function expCols() {
  if (!_exp.cols) {
    try { _exp.cols = JSON.parse(localStorage.getItem('ar-exp-cols')) || null; } catch (e) {}
    if (!Array.isArray(_exp.cols) || !_exp.cols.length) _exp.cols = EXP_DEFAULT_COLS.slice();
  }
  // `always` columns cannot be turned off: a row with no invoice number and no
  // amount is not a row anybody can act on.
  const on = new Set(_exp.cols);
  return EXP_COLS.filter(c => c.always || on.has(c.key));
}

/* ── Saved views ───────────────────────────────────────────────────────────
   Per user, in localStorage. No schema change, and a collector's working set is
   personal rather than shared reference data.
   -------------------------------------------------------------------------- */
function expViews() {
  try { return JSON.parse(localStorage.getItem('ar-exp-views')) || []; } catch (e) { return []; }
}
function expSaveViews(v) { try { localStorage.setItem('ar-exp-views', JSON.stringify(v)); } catch (e) {} }

function expSaveView() {
  const name = prompt('Name this view (e.g. "My past due 90+")');
  if (!name || !name.trim()) return;
  const views = expViews().filter(v => v.name !== name.trim());
  views.push({ name: name.trim(), f: { ..._exp.f }, quick: _exp.quick, sort: { ..._exp.sort } });
  expSaveViews(views);
  dsNotify(`Saved "${name.trim()}"`, 'success');
  expRender(true);
}
function expApplyView(name) {
  const v = expViews().find(x => x.name === name);
  if (!v) return;
  _exp.f = { ...v.f }; _exp.quick = v.quick || ''; _exp.sort = { ...v.sort };
  _exp.sel.clear(); _exp.scrollTop = 0;
  expRender(true);
  dsNotify(`View: ${name}`, 'info', 2000);
}
function expDeleteView(name, ev) {
  if (ev) ev.stopPropagation();
  if (!confirm(`Delete the saved view "${name}"?`)) return;
  expSaveViews(expViews().filter(v => v.name !== name));
  expRender(true);
}

/* ── Load ──────────────────────────────────────────────────────────────── */
async function expLoad() {
  const root = document.getElementById('invoices2-root');
  if (!root) return;
  root.innerHTML = `<div style="padding:8px 0">${dsSkeleton(2)}
    <div class="ds-card" style="margin-top:16px"><div class="ds-card-body">${dsSkeleton(8)}</div></div></div>`;
  try {
    const [data] = await Promise.all([apiFetch('/api/invoices'), commsGridMeta(true)]);
    _exp.all = Array.isArray(data) ? data : (data.invoices || []);
    _exp.loaded = true;
    _exp.sel.clear();
    expRender(true);
  } catch (e) {
    root.innerHTML = dsCard({ title: 'Invoices unavailable',
      body: dsEmpty({ icon: '!', title: 'Could not load invoices', body: e.message }) });
  }
}

/* ── Filtering + sorting ─────────────────────────────────────────────────── */
function expFiltered() {
  const f = _exp.f, q = _exp.quick;
  let rows = _exp.all;

  if (q === 'amazon') rows = rows.filter(i => i.customerId === 'C-00403');
  else if (q) rows = rows.filter(i => (((_gridMeta.csByRecord[i.recordNo]) || {}).status || 'Open') === q);

  if (f.sc) rows = rows.filter(i => _gridMeta.scMap[i.locationId] === f.sc);
  if (f.location) rows = rows.filter(i => i.locationId === f.location);
  if (f.status) rows = rows.filter(i => (((_gridMeta.csByRecord[i.recordNo]) || {}).status || 'Open') === f.status);
  if (f.collector) rows = rows.filter(i => String(commsEffectiveCollector(i) || '').toLowerCase() === f.collector);
  if (f.bucket) rows = rows.filter(i => i.bucket === f.bucket);
  if (f.payment === 'none') rows = rows.filter(i => (i.totalEntered || 0) - (i.totalDue || 0) < 0.01);
  if (f.payment === 'partial') rows = rows.filter(i => (i.totalEntered || 0) - (i.totalDue || 0) >= 0.01);
  if (f.minAmount) rows = rows.filter(i => (i.totalDue || 0) >= Number(f.minAmount));

  // One search box across the fields people actually paste in: invoice number,
  // customer, location, PO.
  const s = String(f.search || '').trim().toLowerCase();
  if (s) {
    rows = rows.filter(i =>
      String(i.invoiceId || '').toLowerCase().includes(s) ||
      String(i.recordNo || '').toLowerCase().includes(s) ||
      String(i.customerName || '').toLowerCase().includes(s) ||
      String(i.customerId || '').toLowerCase().includes(s) ||
      String(i.locationName || '').toLowerCase().includes(s) ||
      String(i.poNumber || '').toLowerCase().includes(s));
  }

  const col = EXP_COLS.find(c => c.key === _exp.sort.key) || EXP_COLS[0];
  const dir = _exp.sort.dir === 'asc' ? 1 : -1;
  rows = rows.slice().sort((a, b) => {
    const va = col.get(a), vb = col.get(b);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
  return rows;
}

function expSort(key) {
  if (_exp.sort.key === key) _exp.sort.dir = _exp.sort.dir === 'asc' ? 'desc' : 'asc';
  else _exp.sort = { key, dir: EXP_COLS.find(c => c.key === key) && EXP_COLS.find(c => c.key === key).num ? 'desc' : 'asc' };
  _exp.scrollTop = 0;
  expRender(true);
}

/* ── Render ────────────────────────────────────────────────────────────── */
function expRender(rebuildChrome) {
  const root = document.getElementById('invoices2-root');
  if (!root) return;
  _exp.rows = expFiltered();

  if (rebuildChrome || !document.getElementById('exp-viewport')) {
    const m = _gridMeta;
    const locs = [...new Map(_exp.all.map(i => [i.locationId, i.locationName])).entries()]
      .filter(([id]) => id).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const scs = [...new Set(_exp.all.map(i => m.scMap[i.locationId]).filter(Boolean))].sort();
    const views = expViews();

    root.innerHTML = `
      <div class="ds-row" style="margin:6px 0 var(--sp-3);flex-wrap:wrap">
        <h1 style="font:700 var(--fs-2xl)/1.15 var(--ds-font);margin:0;color:var(--ink)">Invoices</h1>
        <span id="exp-count" class="ds-chip"></span>
        <span style="margin-left:auto" class="ds-row">
          <button class="ds-btn ds-btn-secondary is-sm" onclick="expSaveView()">☆ Save view</button>
          <button class="ds-btn ds-btn-secondary is-sm" onclick="expColumnChooser()">Columns</button>
          ${typeof dsDensityControl === 'function' ? dsDensityControl() : ''}
          <button class="ds-btn ds-btn-secondary is-sm" onclick="expLoad()">Refresh</button>
        </span>
      </div>

      ${views.length ? `<div class="ds-row" style="flex-wrap:wrap;margin-bottom:var(--sp-3)">
        <span class="ds-muted" style="font-size:var(--fs-xs)">Saved views</span>
        ${views.map(v => `<span class="ds-chip is-button" onclick="expApplyView('${dsEsc(v.name).replace(/'/g, "\\'")}')">
            ${dsEsc(v.name)}
            <span onclick="expDeleteView('${dsEsc(v.name).replace(/'/g, "\\'")}',event)" title="Delete"
                  style="margin-left:4px;opacity:.5;cursor:pointer">×</span></span>`).join('')}
      </div>` : ''}

      <div class="ds-card" style="margin-bottom:var(--sp-3)">
        <div class="ds-card-body" style="padding:var(--sp-3) var(--sp-4)">
          <div class="ds-row" style="flex-wrap:wrap;gap:var(--sp-2)">
            <input id="exp-search" class="exp-input" style="flex:2;min-width:220px"
                   placeholder="Search invoice, customer, location or PO"
                   value="${dsEsc(_exp.f.search || '')}" oninput="expDebouncedSearch(this.value)">
            ${expSelect('exp-f-sc', 'All service centers', scs.map(c => [c, c]), _exp.f.sc)}
            ${expSelect('exp-f-bucket', 'All ages', [['current', 'Current'], ['1-30', '1-30'], ['31-60', '31-60'], ['61-90', '61-90'], ['91+', '91+']], _exp.f.bucket)}
            ${expSelect('exp-f-status', 'All statuses', (m.statuses || []).map(s => [s, s]), _exp.f.status)}
            ${expSelect('exp-f-collector', 'All collectors', (m.users || []).map(u => [u.email.toLowerCase(), u.name || u.email]), _exp.f.collector)}
            ${expSelect('exp-f-location', 'All locations', locs, _exp.f.location)}
            ${expSelect('exp-f-payment', 'Any payment', [['none', 'No payments'], ['partial', 'Partially paid']], _exp.f.payment)}
            <button class="ds-btn ds-btn-ghost is-sm" onclick="expReset()">Reset</button>
          </div>
        </div>
      </div>

      <div id="exp-bulk" class="ds-card" style="display:none;margin-bottom:var(--sp-3);border-color:var(--ink)">
        <div class="ds-card-body ds-row" style="padding:var(--sp-3) var(--sp-4);flex-wrap:wrap">
          <strong id="exp-bulk-count" style="font:700 var(--fs-base) var(--ds-font)"></strong>
          <span id="exp-bulk-sum" class="ds-muted"></span>
          <span class="ds-row" style="margin-left:auto;flex-wrap:wrap">
            <select id="exp-bulk-collector" class="exp-input">
              <option value="">Assign collector…</option>
              ${(m.users || []).map(u => `<option value="${dsEsc(u.email.toLowerCase())}">${dsEsc(u.name || u.email)}</option>`).join('')}
              <option value="__clear__">— Clear collector —</option>
            </select>
            <button class="ds-btn ds-btn-primary is-sm" onclick="expBulkAssign(this)">Apply</button>
            <button class="ds-btn ds-btn-secondary is-sm" onclick="expBulkEmail()">✉ Email</button>
            <button class="ds-btn ds-btn-danger is-sm" onclick="expBulkStop(this)">⏸ Stop service</button>
            <button class="ds-btn ds-btn-ghost is-sm" onclick="expClearSel()">Clear</button>
          </span>
        </div>
      </div>

      <div class="ds-card">
        <div id="exp-head" class="exp-head"></div>
        <div id="exp-viewport" class="exp-viewport" tabindex="0"
             onscroll="expOnScroll()" onkeydown="expKey(event)">
          <div id="exp-spacer"><div id="exp-body" class="exp-body"></div></div>
        </div>
        <div class="exp-foot ds-row">
          <span id="exp-foot-text" class="ds-muted"></span>
          <span style="margin-left:auto" class="ds-muted" id="exp-foot-sum"></span>
        </div>
      </div>
      <div class="ds-muted" style="font-size:var(--fs-xs);margin-top:var(--sp-2)">
        Click a row to open it. <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>Enter</kbd> opens,
        <kbd>x</kbd> selects, <kbd>Esc</kbd> clears. Sorting and selection apply to all
        <span id="exp-kbd-count"></span> matching rows, not just the ones on screen.
      </div>`;

    document.getElementById('exp-viewport').scrollTop = _exp.scrollTop || 0;
    ['sc', 'bucket', 'status', 'collector', 'location', 'payment'].forEach(k => {
      const el = document.getElementById('exp-f-' + k);
      if (el) el.onchange = () => { _exp.f[k] = el.value; _exp.scrollTop = 0; expRender(false); };
    });
  }

  expRenderHead();
  expDraw();
  expBulkBar();
}

function expSelect(id, blank, opts, val) {
  return `<select id="${id}" class="exp-input"><option value="">${dsEsc(blank)}</option>${
    opts.map(([v, l]) => `<option value="${dsEsc(v)}" ${val === v ? 'selected' : ''}>${dsEsc(l)}</option>`).join('')}</select>`;
}

let _expSearchTimer = null;
function expDebouncedSearch(v) {
  clearTimeout(_expSearchTimer);
  _expSearchTimer = setTimeout(() => {
    _exp.f.search = v; _exp.scrollTop = 0;
    document.getElementById('exp-viewport').scrollTop = 0;
    expRender(false);
  }, 180);
}
function expReset() {
  _exp.f = {}; _exp.quick = ''; _exp.sel.clear(); _exp.cursor = -1; _exp.scrollTop = 0;
  expRender(true);
}

function expRenderHead() {
  const cols = expCols();
  const allOn = _exp.rows.length > 0 && _exp.rows.every(r => _exp.sel.has(r.recordNo));
  document.getElementById('exp-head').innerHTML =
    `<div class="exp-row is-head" style="grid-template-columns:${expGrid(cols)}">
      <div class="exp-cell is-check"><input type="checkbox" ${allOn ? 'checked' : ''} onchange="expSelectAll(this.checked)"
           title="Select every matching row"></div>
      ${cols.map(c => `<div class="exp-cell${c.num ? ' is-num' : ''} is-sortable" onclick="expSort('${c.key}')">
          ${dsEsc(c.label)}${_exp.sort.key === c.key ? `<span class="exp-caret">${_exp.sort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}
        </div>`).join('')}
    </div>`;
}

function expGrid(cols) {
  return `34px ${cols.map(c => c.w + 'px').join(' ')}`;
}

/* ── The virtual window ──────────────────────────────────────────────────── */
function expOnScroll() {
  const vp = document.getElementById('exp-viewport');
  _exp.scrollTop = vp.scrollTop;
  expDraw();
  // The header scrolls horizontally with the body but stays put vertically.
  document.getElementById('exp-head').scrollLeft = vp.scrollLeft;
}

function expDraw() {
  const vp = document.getElementById('exp-viewport');
  const body = document.getElementById('exp-body');
  const spacer = document.getElementById('exp-spacer');
  if (!vp || !body) return;
  const cols = expCols();
  const rows = _exp.rows;

  const rowH = expRowH();
  spacer.style.height = (rows.length * rowH) + 'px';
  const first = Math.max(0, Math.floor(vp.scrollTop / rowH) - EXP_OVERSCAN);
  const visible = Math.ceil(vp.clientHeight / rowH) + EXP_OVERSCAN * 2;
  const slice = rows.slice(first, first + visible);

  body.style.transform = `translateY(${first * rowH}px)`;
  body.innerHTML = slice.map((i, n) => {
    const idx = first + n;
    const sel = _exp.sel.has(i.recordNo);
    return `<div class="exp-row${sel ? ' is-selected' : ''}${idx === _exp.cursor ? ' is-cursor' : ''}"
         style="grid-template-columns:${expGrid(cols)}" data-idx="${idx}"
         onclick="expRowClick(${idx}, event)">
      <div class="exp-cell is-check" onclick="event.stopPropagation();expToggle(${idx})">
        <input type="checkbox" ${sel ? 'checked' : ''} tabindex="-1"></div>
      ${cols.map(c => `<div class="exp-cell${c.num ? ' is-num' : ''}">${c.cell(i)}</div>`).join('')}
    </div>`;
  }).join('');

  const sum = rows.reduce((t, r) => t + (r.totalDue || 0), 0);
  const cnt = document.getElementById('exp-count');
  if (cnt) cnt.textContent = `${dsNum(rows.length)} of ${dsNum(_exp.all.length)}`;
  const ft = document.getElementById('exp-foot-text');
  if (ft) ft.textContent = rows.length
    ? `Showing ${dsNum(Math.min(rows.length, first + 1))}–${dsNum(Math.min(rows.length, first + slice.length))} of ${dsNum(rows.length)}`
    : 'No invoices match';
  const fs = document.getElementById('exp-foot-sum');
  if (fs) fs.innerHTML = `Total <strong class="ds-money">${dsMoney(sum)}</strong>`;
  const kc = document.getElementById('exp-kbd-count');
  if (kc) kc.textContent = dsNum(rows.length);

  if (!rows.length) {
    body.innerHTML = `<div style="padding:var(--sp-8)">${dsEmpty({
      icon: '🔍', title: 'Nothing matches these filters',
      body: 'Try widening the search, or press Reset to start again.' })}</div>`;
    spacer.style.height = 'auto';
  }
}

/* ── Selection ─────────────────────────────────────────────────────────── */
function expRowClick(idx, ev) {
  // Modifier-click selects, plain click opens. Opening is the common case.
  if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey)) { expToggle(idx); return; }
  const r = _exp.rows[idx];
  if (r) { _exp.cursor = idx; openDrawer(r.recordNo); }
}
function expToggle(idx) {
  const r = _exp.rows[idx];
  if (!r) return;
  if (_exp.sel.has(r.recordNo)) _exp.sel.delete(r.recordNo); else _exp.sel.add(r.recordNo);
  _exp.cursor = idx;
  expDraw(); expBulkBar(); expRenderHead();
}
/* Selects every row matching the CURRENT filters, not just the drawn ones.
   With a virtual table those are very different numbers, so the bar says which. */
function expSelectAll(on) {
  if (on) _exp.rows.forEach(r => _exp.sel.add(r.recordNo));
  else _exp.rows.forEach(r => _exp.sel.delete(r.recordNo));
  expDraw(); expBulkBar();
}
function expClearSel() { _exp.sel.clear(); expDraw(); expBulkBar(); expRenderHead(); }

function expSelectedInvoices() {
  const want = _exp.sel;
  return _exp.all.filter(i => want.has(i.recordNo));
}

function expBulkBar() {
  const bar = document.getElementById('exp-bulk');
  if (!bar) return;
  const n = _exp.sel.size;
  bar.style.display = n ? '' : 'none';
  if (!n) return;
  const sel = expSelectedInvoices();
  const sum = sel.reduce((t, i) => t + (i.totalDue || 0), 0);
  const custs = new Set(sel.map(i => i.customerId));
  document.getElementById('exp-bulk-count').textContent = `${dsNum(n)} selected`;
  document.getElementById('exp-bulk-sum').textContent =
    `${dsMoney(sum)} · ${custs.size} customer${custs.size === 1 ? '' : 's'}`;
}

/* ── Bulk actions ──────────────────────────────────────────────────────── */
async function expBulkAssign(btn) {
  const sel = document.getElementById('exp-bulk-collector').value;
  const items = [..._exp.sel];
  if (!items.length || !sel) { dsNotify('Pick a collector first', 'warn'); return; }
  const clear = sel === '__clear__';
  // Reversible, so no cap — but a four-figure reassignment should not go through
  // on a reflexive OK.
  if (items.length > 200) {
    const typed = prompt(`${clear ? 'Clear the collector on' : 'Assign'} ${dsNum(items.length)} invoices`
      + `${clear ? '' : ' to ' + sel}.\n\nType ${items.length} to confirm:`, '');
    if (String(typed || '').trim() !== String(items.length)) {
      if (typed !== null) dsNotify('Not confirmed — nothing was changed', 'info');
      return;
    }
  } else if (!confirm(`${clear ? 'Clear the collector on' : 'Assign'} ${items.length} invoice(s)${clear ? '' : ' to ' + sel}?`)) return;
  btn.disabled = true;
  try {
    await apiFetch('/api/collector/invoice-bulk', { method: 'POST', body: JSON.stringify({ items, collectorEmail: clear ? '' : sel }) });
    await commsGridMeta(true);
    dsNotify(`${clear ? 'Cleared' : 'Assigned'} ${items.length} invoice(s)`, 'success');
    _exp.sel.clear();
    expRender(false); expRenderHead();
  } catch (e) { dsNotify('Failed: ' + e.message, 'error'); }
  btn.disabled = false;
}

/* The composer is addressed to ONE customer's contacts. Emailing a selection
   that spans several would either send one customer another's invoice numbers
   or silently drop most of them, so this refuses and says which customers are
   involved. */
function expBulkEmail() {
  const sel = expSelectedInvoices();
  if (!sel.length) return;
  const byCust = new Map();
  for (const i of sel) byCust.set(i.customerId, i.customerName);
  if (byCust.size > 1) {
    dsNotify(`Those invoices span ${byCust.size} customers. Email is per customer — narrow the selection to one.`, 'warn', 7000);
    return;
  }
  const [customerId, customerName] = [...byCust.entries()][0];
  commsOpenComposer({ customerId, customerName, recordNos: sel.map(i => i.recordNo) });
}

/* No bulk stop-service endpoint exists, and the plan forbids adding one, so this
   issues them one at a time. It reports what actually happened rather than
   assuming: a partial failure here means some customers keep getting service. */
// Stopping service is the one irreversible-feeling action on this screen, and
// virtualization changed its blast radius: the old page selected 50 rows at a
// time, "select all" here can reach every matching invoice — 1,835 of them on a
// single customer. A mis-click that would once have hit 50 could now hit
// thousands, each one notifying a collector. So above the cap it refuses, and
// near it, it asks the person to type the number (Edwin 2026-09-19: "hesitant
// to promote until I know nothing will mess up our amazon data").
const EXP_STOP_CAP = 25;

async function expBulkStop(btn) {
  const sel = expSelectedInvoices();
  if (!sel.length) return;
  if (sel.length > EXP_STOP_CAP) {
    dsNotify(`${dsNum(sel.length)} invoices selected. Stop service is capped at ${EXP_STOP_CAP} at a time `
      + `— narrow the selection, or use the customer page to stop a whole account.`, 'warn', 9000);
    return;
  }
  const customers = new Set(sel.map(i => i.customerId));
  const effectiveDate = prompt(`Stop service on ${sel.length} invoice(s).\n\nEffective date (YYYY-MM-DD), or leave blank for immediate:`, '');
  if (effectiveDate === null) return;
  // Typing the count is deliberate friction: it cannot be cleared by a reflexive
  // Enter on a confirm dialog.
  const typed = prompt(`This stops service on ${sel.length} invoice(s) across `
    + `${customers.size} customer${customers.size === 1 ? '' : 's'}, worth `
    + `${dsMoney(sel.reduce((t, i) => t + (i.totalDue || 0), 0))}, and notifies each invoice's collector.\n\n`
    + `Type ${sel.length} to confirm:`, '');
  if (String(typed || '').trim() !== String(sel.length)) {
    if (typed !== null) dsNotify('Not confirmed — nothing was stopped', 'info');
    return;
  }
  btn.disabled = true;
  const close = dsNotify(`Stopping service on ${sel.length} invoice(s)…`, 'info', 0);
  let done = 0; const failed = [];
  for (const i of sel) {
    try {
      await apiFetch(`/api/stop-service/invoice/${encodeURIComponent(i.recordNo)}`, {
        method: 'POST',
        body: JSON.stringify({ invoiceId: i.invoiceId, stop: true, effectiveDate: effectiveDate || null, note: 'Bulk stop from invoice explorer' }),
      });
      done++;
    } catch (e) { failed.push((i.invoiceId || i.recordNo) + ': ' + e.message); }
  }
  if (close) close();
  if (failed.length) dsNotify(`${done} stopped, ${failed.length} failed — ${failed[0]}`, 'error');
  else dsNotify(`Stop service issued on ${done} invoice(s)`, 'success');
  btn.disabled = false;
  _exp.sel.clear();
  expRender(false); expRenderHead();
}

/* ── Column chooser ────────────────────────────────────────────────────── */
function expColumnChooser() {
  const on = new Set(expCols().map(c => c.key));
  const html = EXP_COLS.map(c => `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;font:500 var(--fs-base) var(--ds-font)">
      <input type="checkbox" value="${c.key}" ${on.has(c.key) ? 'checked' : ''} ${c.always ? 'disabled' : ''}>
      ${dsEsc(c.label)}${c.always ? ' <span class="ds-muted" style="font-size:var(--fs-xs)">(always shown)</span>' : ''}
    </label>`).join('');
  const wrap = document.createElement('div');
  wrap.id = 'exp-colmodal';
  wrap.style.cssText = `position:fixed;inset:0;z-index:var(--z-modal);background:rgba(26,24,20,.35);display:flex;align-items:center;justify-content:center`;
  wrap.innerHTML = `<div class="ds-card" style="width:320px;max-height:80vh;overflow:auto" onclick="event.stopPropagation()">
      <div class="ds-card-head"><div class="ds-card-title">Columns</div></div>
      <div class="ds-card-body">${html}
        <div class="ds-row" style="margin-top:var(--sp-3)">
          <button class="ds-btn ds-btn-primary is-sm" onclick="expColumnSave()">Apply</button>
          <button class="ds-btn ds-btn-ghost is-sm" onclick="expColumnClose()">Cancel</button>
        </div>
      </div></div>`;
  wrap.onclick = expColumnClose;
  document.body.appendChild(wrap);
}
function expColumnSave() {
  const picked = [...document.querySelectorAll('#exp-colmodal input[type=checkbox]')]
    .filter(c => c.checked).map(c => c.value);
  _exp.cols = picked;
  try { localStorage.setItem('ar-exp-cols', JSON.stringify(picked)); } catch (e) {}
  expColumnClose();
  expRender(true);
}
function expColumnClose() {
  const el = document.getElementById('exp-colmodal');
  if (el) el.remove();
}

/* ── Keyboard ──────────────────────────────────────────────────────────── */
function expKey(ev) {
  const k = ev.key;
  if (['j', 'k', 'Enter', 'x', 'Escape', 'ArrowDown', 'ArrowUp'].includes(k)) ev.preventDefault();
  if (k === 'j' || k === 'ArrowDown') expMove(1);
  else if (k === 'k' || k === 'ArrowUp') expMove(-1);
  else if (k === 'Enter') { const r = _exp.rows[_exp.cursor]; if (r) openDrawer(r.recordNo); }
  else if (k === 'x') { if (_exp.cursor >= 0) expToggle(_exp.cursor); }
  else if (k === 'Escape') expClearSel();
}
function expMove(d) {
  const n = _exp.rows.length;
  if (!n) return;
  _exp.cursor = Math.max(0, Math.min(n - 1, (_exp.cursor < 0 ? -1 : _exp.cursor) + d));
  // Keep the cursor on screen. With a virtual table the row may not exist in
  // the DOM yet, so scroll by arithmetic rather than scrollIntoView.
  const vp = document.getElementById('exp-viewport');
  const h = expRowH();
  const top = _exp.cursor * h;
  const bottom = top + h;
  if (top < vp.scrollTop) vp.scrollTop = top;
  else if (bottom > vp.scrollTop + vp.clientHeight) vp.scrollTop = bottom - vp.clientHeight;
  expDraw();
}

/* ───────────────────────────────────────────────────────────────────────────
   The drawer becomes a right rail with tabs (Phase 3, item 7)

   It WRAPS the existing drawer rather than replacing it. openDrawer() already
   renders a working Overview — notes, promises, watch, stop service, Amazon
   site provenance, collection status — and comms.js decorates it afterwards
   with contacts and email history. Rebuilding all of that to add three tabs
   would have risked a heavily-used surface for no gain.

   So: #drawer-body stays exactly as it is and becomes the Overview pane. The
   tab strip and the three new panes are siblings, which also means comms.js can
   keep inserting into #drawer-body without knowing any of this exists.
   ─────────────────────────────────────────────────────────────────────────── */

const DRAWER_TABS = [
  { key: 'overview',  label: 'Overview' },
  { key: 'activity',  label: 'Activity' },
  { key: 'comms',     label: 'Comms' },
  { key: 'documents', label: 'Documents' },
];
let _railTab = 'overview';
let _railRec = null;
let _poLedgerCache = null;

// openDrawer() is defined by the inline script in index.html, which runs AFTER
// this file (loaded in <head>). Wrapping at load time therefore found nothing
// and silently did nothing, so the tabs never appeared. Wrap once the document
// is ready, and keep trying briefly in case script order changes again.
function railWrapOpenDrawer() {
  if (typeof window === 'undefined' || window.__railWrapped) return true;
  if (typeof window.openDrawer !== 'function') return false;
  const original = window.openDrawer;
  window.__railWrapped = true;
  window.openDrawer = async function (recordNo, scrollToNotes) {
    _railRec = recordNo;
    _railTab = 'overview';
    const r = await original.apply(this, arguments);
    try { railMount(recordNo); } catch (e) { /* the drawer must open regardless */ }
    return r;
  };
  return true;
}
(function () {
  if (typeof document === 'undefined') return;
  const tryWrap = () => {
    if (railWrapOpenDrawer()) return true;
    return false;
  };
  if (!tryWrap()) {
    document.addEventListener('DOMContentLoaded', tryWrap);
    let n = 0;
    const t = setInterval(() => { if (tryWrap() || ++n > 40) clearInterval(t); }, 150);
  }
})();

function railMount(recordNo) {
  const body = document.getElementById('drawer-body');
  if (!body) return;

  // Tab strip, once, directly above the body.
  let strip = document.getElementById('rail-tabs');
  if (!strip) {
    strip = document.createElement('div');
    strip.id = 'rail-tabs';
    strip.className = 'rail-tabs';
    body.parentNode.insertBefore(strip, body);
  }
  strip.innerHTML = DRAWER_TABS.map(t =>
    `<button class="rail-tab${_railTab === t.key ? ' is-on' : ''}" data-tab="${t.key}"
             onclick="railShow('${t.key}')">${dsEsc(t.label)}<span class="rail-tab-n" id="rail-n-${t.key}"></span></button>`).join('');

  // Panes for the three new tabs, as siblings of #drawer-body.
  for (const t of DRAWER_TABS) {
    if (t.key === 'overview') continue;
    let pane = document.getElementById('rail-pane-' + t.key);
    if (!pane) {
      pane = document.createElement('div');
      pane.id = 'rail-pane-' + t.key;
      pane.className = 'rail-pane';
      body.parentNode.appendChild(pane);
    }
    pane.innerHTML = '';
    pane.dataset.loaded = '';
  }
  railShow('overview');
  railCounts(recordNo);
}

/* Counts on the tabs, so it is obvious where there is something to look at
   without opening each one. */
async function railCounts(recordNo) {
  const set = (k, n) => {
    const el = document.getElementById('rail-n-' + k);
    if (el) el.textContent = n ? ` ${n}` : '';
  };
  const d = window._drawerData || {};
  set('activity', (d.audit || []).length);
  try {
    const msgs = await apiFetch(`/api/invoices/${encodeURIComponent(recordNo)}/messages`);
    set('comms', msgs.length);
  } catch (e) {}
}

function railShow(tab) {
  _railTab = tab;
  const body = document.getElementById('drawer-body');
  if (body) body.style.display = tab === 'overview' ? '' : 'none';
  for (const t of DRAWER_TABS) {
    if (t.key === 'overview') continue;
    const pane = document.getElementById('rail-pane-' + t.key);
    if (pane) pane.style.display = tab === t.key ? '' : 'none';
  }
  document.querySelectorAll('#rail-tabs .rail-tab').forEach(b =>
    b.classList.toggle('is-on', b.dataset.tab === tab));
  if (tab !== 'overview') railLoad(tab);
}

async function railLoad(tab) {
  const pane = document.getElementById('rail-pane-' + tab);
  if (!pane || pane.dataset.loaded === '1') return;
  pane.innerHTML = `<div style="padding:16px">${dsSkeleton(4)}</div>`;
  try {
    if (tab === 'activity')  pane.innerHTML = railActivity();
    if (tab === 'comms')     pane.innerHTML = await railComms();
    if (tab === 'documents') pane.innerHTML = await railDocuments();
    pane.dataset.loaded = '1';
  } catch (e) {
    pane.innerHTML = `<div style="padding:16px">${dsEmpty({ icon: '!', title: 'Could not load', body: e.message })}</div>`;
  }
}

/* ── Activity: the audit trail, as a timeline ───────────────────────────── */
function railActivity() {
  const rows = (window._drawerData && window._drawerData.audit) || [];
  if (!rows.length) {
    return `<div style="padding:16px">${dsEmpty({ icon: '—', title: 'Nothing recorded yet',
      body: 'Notes, status changes, collector assignments and emails all appear here once they happen.' })}</div>`;
  }
  const when = ts => {
    const d = new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'));
    return isNaN(d) ? String(ts || '') : d.toLocaleString('en-US',
      { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  return `<div class="rail-timeline">${rows.map(r => `
    <div class="rail-event">
      <div class="rail-dot"></div>
      <div>
        <div class="rail-event-head">${dsEsc(String(r.action || '').replace(/_/g, ' '))}</div>
        ${r.detail ? `<div class="rail-event-detail">${dsEsc(r.detail)}</div>` : ''}
        <div class="rail-event-meta">${dsEsc(String(r.user_email || '').split('@')[0])} · ${dsEsc(when(r.created_at))}</div>
      </div>
    </div>`).join('')}</div>`;
}

/* ── Comms: the emails tagged to this invoice ───────────────────────────── */
async function railComms() {
  const inv = (window._drawerData || {}).invoice || {};
  const msgs = await apiFetch(`/api/invoices/${encodeURIComponent(inv.recordNo)}/messages`);
  const compose = commsCanEdit()
    ? `<button class="ds-btn ds-btn-primary is-sm" onclick='commsOpenComposer({customerId:"${dsEsc(inv.customerId)}",customerName:"${dsEsc(inv.customerName || '')}",recordNos:["${dsEsc(inv.recordNo)}"],invoiceId:"${dsEsc(inv.invoiceId || inv.recordNo)}"})'>✉ Email about this invoice</button>`
    : '';
  if (!msgs.length) {
    return `<div style="padding:16px">${dsEmpty({ icon: '✉', title: 'No email about this invoice yet',
      body: 'Anything sent from the portal about it, and any reply, lands here.' })}
      <div style="text-align:center;margin-top:-12px">${compose}</div></div>`;
  }
  return `<div style="padding:12px 14px" class="ds-row">${compose}</div>` + msgs.map(m => `
    <div class="rail-msg" onclick="this.classList.toggle('is-open')">
      <div class="rail-msg-head">
        <span>${m.direction === 'in' ? '📩' : '📤'} <strong>${dsEsc((m.subject || '').replace(/\s*\[ECF#[^\]]+\]/, '') || '(no subject)')}</strong></span>
        <span class="ds-muted" style="font-size:var(--fs-xs);white-space:nowrap">${dsEsc(((m.sent_at || m.received_at || m.created_at) || '').slice(0, 10))}</span>
      </div>
      <div class="rail-msg-meta">
        ${dsEsc(m.direction === 'in' ? (m.from_email || '') : (m.to_emails || '').replace(/[\[\]"]/g, ''))}
        ${m.actor_type === 'automation' ? '<span class="ds-chip is-yellow" style="margin-left:6px">AUTO</span>' : ''}
        ${m.status === 'failed' ? '<span class="ds-chip is-red" style="margin-left:6px">FAILED</span>' : ''}
      </div>
      <div class="rail-msg-body">${m.body_html || dsEsc(m.body_text || '')}</div>
    </div>`).join('');
}

/* ── Documents: the invoice, and the PO it is billed against ────────────── */
async function railDocuments() {
  const inv = (window._drawerData || {}).invoice || {};
  const items = [];

  items.push({
    icon: '🧾', title: `Invoice ${inv.invoiceId || inv.recordNo}`,
    sub: 'PDF from Sage Intacct',
    href: `/api/invoice/${encodeURIComponent(inv.recordNo)}/pdf`,
  });

  if (inv.poNumber) {
    // The ledger is memoised server-side, so one fetch per session is cheap.
    if (!_poLedgerCache) {
      try { _poLedgerCache = await apiFetch('/api/po/ledger'); } catch (e) { _poLedgerCache = []; }
    }
    const list = Array.isArray(_poLedgerCache) ? _poLedgerCache : (_poLedgerCache.ledger || []);
    const po = list.find(p => p.poNumber === inv.poNumber);
    if (po && po.docUrl) {
      items.push({
        icon: '📄', title: `Purchase order ${po.poNumber}`,
        sub: [po.docDate ? `document dated ${po.docDate}` : null,
              po.ceilingAmount != null ? `value ${dsMoney(po.ceilingAmount)}` : null,
              po.siteCode || null].filter(Boolean).join(' · '),
        href: po.docUrl, external: true,
      });
    } else {
      items.push({ icon: '📄', title: `Purchase order ${inv.poNumber}`,
        sub: 'no document on file', muted: true });
    }
  } else {
    items.push({ icon: '📄', title: 'No PO on this invoice', sub: 'nothing to link to', muted: true });
  }

  return `<div class="rail-docs">${items.map(i => i.href
    ? `<a class="rail-doc" href="${i.href}" target="_blank" rel="noopener">
         <span class="rail-doc-icon">${i.icon}</span>
         <span><span class="rail-doc-title">${dsEsc(i.title)}</span>
           <span class="rail-doc-sub">${dsEsc(i.sub)}</span></span>
         <span class="rail-doc-go">${i.external ? '↗' : '↓'}</span></a>`
    : `<div class="rail-doc is-muted">
         <span class="rail-doc-icon">${i.icon}</span>
         <span><span class="rail-doc-title">${dsEsc(i.title)}</span>
           <span class="rail-doc-sub">${dsEsc(i.sub)}</span></span></div>`).join('')}
    <div class="ds-muted" style="padding:10px 16px;font-size:var(--fs-xs)">
      Customer-level attachments live on the customer page.</div></div>`;
}


/* Density changed under us: re-measure the row height and redraw. */
function expOnDensityChange() {
  expRowH();
  if (document.getElementById('exp-viewport')) expDraw();
}
