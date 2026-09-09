'use strict';
// ─── amazon.js — the structured Amazon invoicing view ────────────────────────
// Edwin's structure, 2026-09-09: narrow Department → Business Unit → Site → PO
// → Invoice, "while also being able to use any of the filters in any order".
//
// Those two requirements pull in opposite directions, so they are kept as two
// separate mechanisms rather than one:
//   DRILL   the fixed hierarchy. Clicking a row descends one level and pushes a
//           crumb. This is the guided path.
//   FILTERS independent, orthogonal, applied to every row before grouping. Set
//           any of them at any time, at any depth, in any order.
// A filter therefore never fights the drill: filters decide WHICH rows exist,
// the drill decides how the surviving rows are stacked.
//
// Relies on globals from index.html: apiFetch, escHtml.

const AMZ_LEVELS = [
  { key: 'deptGroup',    label: 'Department' },
  { key: 'businessUnit', label: 'Business Unit' },
  { key: 'site',         label: 'Site' },
  { key: 'po',           label: 'PO' },
];

let _amzRows = null;
let _amzVocab = null;
let _amzUnresolved = [];
let _amzPath = [];                 // [{key,value}] one per level descended
let _amzFilters = {};              // {businessUnit, siteType, region, bucket, q, ...}
let _amzSort = { key: 'amount', dir: -1 };

function amzMoney(v) {
  const n = Math.round(Number(v) || 0);
  return '$' + n.toLocaleString();
}
function amzBlank(v, dash) { return (v === '' || v === null || v === undefined) ? (dash || '—') : v; }

async function amazonLoad() {
  const el = document.getElementById('amazon-content');
  if (!el) return;
  el.innerHTML = '<div style="padding:30px;text-align:center;color:var(--gray-500);">Loading Amazon invoicing…</div>';
  try {
    const data = await apiFetch('/api/amazon/explorer');
    _amzRows = data.rows || [];
    _amzVocab = data.vocab || {};
    _amzUnresolved = data.unresolved || [];
    amazonRender();
  } catch (e) {
    el.innerHTML = `<div style="padding:20px;color:var(--red);">Error: ${escHtml(e.message)}</div>`;
  }
}

// ─── filtering ───────────────────────────────────────────────────────────────
// Applied to every row BEFORE the drill groups anything, which is what lets a
// filter work at any depth and in any order.
function amzFiltered() {
  const f = _amzFilters;
  const q = (f.q || '').trim().toUpperCase();
  return (_amzRows || []).filter(r => {
    if (f.deptGroup && r.deptGroup !== f.deptGroup) return false;
    if (f.department && r.deptId !== f.department) return false;
    if (f.businessUnit && r.businessUnit !== f.businessUnit) return false;
    if (f.siteType && r.siteType !== f.siteType) return false;
    if (f.region && r.region !== f.region) return false;
    if (f.bucket && r.bucket !== f.bucket) return false;
    if (f.site && r.site !== f.site) return false;
    if (f.serviceCenter && r.serviceCenter !== f.serviceCenter) return false;
    // One switch for both gaps the header warns about: no site at all, or a
    // site the location master carries no business unit for.
    if (f.unattributed && r.site && r.businessUnit) return false;
    if (q && !(`${r.invoiceId} ${r.po} ${r.site} ${r.deptName} ${r.businessUnit}`.toUpperCase().includes(q))) return false;
    // The drill path is just more equality filters, one per level descended.
    for (const step of _amzPath) if ((r[step.key] || '') !== step.value) return false;
    return true;
  });
}

function amzLevelIndex() { return _amzPath.length; }
function amzCurrentLevel() { return AMZ_LEVELS[amzLevelIndex()] || null; }

// ─── render ──────────────────────────────────────────────────────────────────
function amazonRender() {
  const el = document.getElementById('amazon-content');
  if (!el || !_amzRows) return;
  const rows = amzFiltered();
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const level = amzCurrentLevel();

  el.innerHTML = `
    ${amzHeaderHtml(rows, total)}
    ${amzFilterBarHtml()}
    ${amzCrumbHtml()}
    ${level ? amzGroupTableHtml(rows, level) : amzInvoiceTableHtml(rows)}
  `;
}

function amzHeaderHtml(rows, total) {
  const noBu = rows.filter(r => r.site && !r.businessUnit);
  const noSite = rows.filter(r => !r.site);
  const warn = [];
  if (noBu.length) warn.push(`${noBu.length} at a site with no business unit (${amzMoney(noBu.reduce((s, r) => s + r.amount, 0))})`);
  if (noSite.length) warn.push(`${noSite.length} with no site yet (${amzMoney(noSite.reduce((s, r) => s + r.amount, 0))})`);
  return `
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px;">
      ${amzTile('Open AR', amzMoney(total))}
      ${amzTile('Invoices', rows.length.toLocaleString())}
      ${amzTile('Sites', new Set(rows.map(r => r.site).filter(Boolean)).size)}
      ${amzTile('POs', new Set(rows.map(r => r.po).filter(Boolean)).size)}
    </div>
    ${warn.length ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#92400e;">
      ⚠ ${escHtml(warn.join(' · '))}. These are visible here rather than dropped from the totals.
      <button onclick="amazonShowUnattributed()" style="margin-left:8px;background:none;border:1px solid #d97706;color:#92400e;border-radius:5px;padding:2px 8px;cursor:pointer;font-size:11px;">Show them</button>
    </div>` : ''}
  `;
}

function amzTile(label, value) {
  return `<div style="background:var(--white);border-radius:10px;box-shadow:var(--shadow);padding:12px 16px;min-width:130px;border-left:3px solid var(--navy);">
    <div style="font-size:11px;color:var(--gray-500);text-transform:uppercase;letter-spacing:.04em;">${escHtml(label)}</div>
    <div style="font-size:19px;font-weight:700;color:var(--navy);font-variant-numeric:tabular-nums;">${escHtml(String(value))}</div>
  </div>`;
}

function amzSelect(key, label, options, current) {
  const opts = ['<option value="">' + escHtml(label) + ': all</option>']
    .concat(options.map(o => `<option value="${escHtml(o)}"${current === o ? ' selected' : ''}>${escHtml(o)}</option>`));
  return `<select onchange="amazonSetFilter('${key}', this.value)" style="padding:6px 8px;border:1px solid var(--gray-300);border-radius:6px;font-size:12px;background:var(--white);">${opts.join('')}</select>`;
}

function amzFilterBarHtml() {
  const v = _amzVocab || {};
  const groups = Object.keys(v.departmentGroups || {});
  const depts = Object.keys(v.departments || {});
  const sites = [...new Set((_amzRows || []).map(r => r.site).filter(Boolean))].sort();
  const scs = [...new Set((_amzRows || []).map(r => r.serviceCenter).filter(Boolean))].sort();
  const active = Object.entries(_amzFilters).filter(([, val]) => val).length;
  return `
    <div style="background:var(--white);border-radius:10px;box-shadow:var(--shadow);padding:12px;margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      ${amzSelect('deptGroup', 'Department', groups, _amzFilters.deptGroup)}
      ${amzSelect('department', 'Intacct code', depts, _amzFilters.department)}
      ${amzSelect('businessUnit', 'Business unit', v.businessUnits || [], _amzFilters.businessUnit)}
      ${amzSelect('siteType', 'Site type', v.siteTypes || [], _amzFilters.siteType)}
      ${amzSelect('region', 'Region', v.regions || [], _amzFilters.region)}
      ${amzSelect('site', 'Site', sites, _amzFilters.site)}
      ${amzSelect('serviceCenter', 'ECF branch', scs, _amzFilters.serviceCenter)}
      ${amzSelect('bucket', 'Aging', ['current', '1-30', '31-60', '61-90', '91+'], _amzFilters.bucket)}
      <input type="text" placeholder="Search invoice / PO / site" value="${escHtml(_amzFilters.q || '')}"
        oninput="amazonSetFilter('q', this.value)"
        style="padding:6px 8px;border:1px solid var(--gray-300);border-radius:6px;font-size:12px;min-width:190px;">
      ${active ? `<button onclick="amazonClearFilters()" style="padding:6px 10px;border:1px solid var(--gray-300);background:var(--white);border-radius:6px;font-size:12px;cursor:pointer;">Clear ${active} filter${active > 1 ? 's' : ''}</button>` : ''}
      <span style="margin-left:auto;font-size:11px;color:var(--gray-500);">Filters apply at any depth, in any order</span>
    </div>`;
}

function amzCrumbHtml() {
  const parts = [`<span onclick="amazonDrillTo(0)" style="cursor:pointer;color:var(--navy);font-weight:600;">All Amazon</span>`];
  _amzPath.forEach((step, i) => {
    const lbl = (AMZ_LEVELS.find(l => l.key === step.key) || {}).label || step.key;
    const last = i === _amzPath.length - 1;
    parts.push(last
      ? `<span style="color:var(--gray-700);font-weight:600;">${escHtml(lbl)}: ${escHtml(step.value || '—')}</span>`
      : `<span onclick="amazonDrillTo(${i + 1})" style="cursor:pointer;color:var(--navy);">${escHtml(lbl)}: ${escHtml(step.value || '—')}</span>`);
  });
  const next = amzCurrentLevel();
  return `<div style="font-size:12px;margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
    ${parts.join('<span style="color:var(--gray-400);">›</span>')}
    ${next ? `<span style="margin-left:8px;color:var(--gray-500);">grouped by ${escHtml(next.label)}</span>`
           : `<span style="margin-left:8px;color:var(--gray-500);">invoice level</span>`}
  </div>`;
}

function amzGroupTableHtml(rows, level) {
  const groups = {};
  for (const r of rows) {
    const k = r[level.key] || '';
    if (!groups[k]) groups[k] = { key: k, n: 0, amount: 0, sites: new Set(), pos: new Set(), sample: r };
    groups[k].n++; groups[k].amount += r.amount;
    if (r.site) groups[k].sites.add(r.site);
    if (r.po) groups[k].pos.add(r.po);
  }
  const list = Object.values(groups).sort((a, b) => b.amount - a.amount);
  const total = list.reduce((s, g) => s + g.amount, 0) || 1;
  if (!list.length) return `<div style="padding:24px;text-align:center;color:var(--gray-500);">No invoices match these filters.</div>`;

  return `<div style="background:var(--white);border-radius:10px;box-shadow:var(--shadow);overflow:hidden;">
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:var(--gray-100);">
        <th style="text-align:left;padding:9px 12px;">${escHtml(level.label)}</th>
        <th style="text-align:left;padding:9px 12px;">Detail</th>
        <th style="text-align:right;padding:9px 12px;">Invoices</th>
        <th style="text-align:right;padding:9px 12px;">Open AR</th>
        <th style="text-align:left;padding:9px 12px;width:150px;">Share</th>
      </tr></thead>
      <tbody>
        ${list.map(g => {
          const pct = Math.round((g.amount / total) * 100);
          return `<tr onclick="amazonDrill('${escHtml(level.key)}', ${JSON.stringify(g.key).replace(/"/g, '&quot;')})"
            style="border-top:1px solid var(--gray-200);cursor:pointer;" onmouseover="this.style.background='var(--gray-50)'" onmouseout="this.style.background=''">
            <td style="padding:9px 12px;font-weight:600;color:var(--navy);">${escHtml(amzBlank(g.key, level.key === 'businessUnit' ? '(no business unit)' : level.key === 'site' ? '(no site yet)' : level.key === 'po' ? '(no PO)' : '—'))}</td>
            <td style="padding:9px 12px;color:var(--gray-600);font-size:12px;">${escHtml(amzGroupDetail(level.key, g))}</td>
            <td style="padding:9px 12px;text-align:right;font-variant-numeric:tabular-nums;">${g.n.toLocaleString()}</td>
            <td style="padding:9px 12px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${amzMoney(g.amount)}</td>
            <td style="padding:9px 12px;"><div style="background:var(--gray-200);border-radius:3px;height:7px;"><div style="width:${pct}%;background:var(--navy);height:7px;border-radius:3px;"></div></div></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;
}

function amzGroupDetail(key, g) {
  const s = g.sample || {};
  if (key === 'deptGroup') return s.deptName ? `${g.sites.size} sites` : `${g.sites.size} sites`;
  if (key === 'businessUnit') return `${g.sites.size} sites · ${g.pos.size} POs${s.region ? ' · ' + s.region : ''}`;
  if (key === 'site') return [s.siteType, s.region, s.serviceCenter].filter(Boolean).join(' · ') || '—';
  if (key === 'po') return `${g.n} invoice${g.n > 1 ? 's' : ''}`;
  return '';
}

function amzInvoiceTableHtml(rows) {
  const sorted = rows.slice().sort((a, b) => {
    const k = _amzSort.key;
    const av = a[k], bv = b[k];
    if (typeof av === 'number') return (av - bv) * _amzSort.dir;
    return String(av || '').localeCompare(String(bv || '')) * _amzSort.dir;
  });
  if (!sorted.length) return `<div style="padding:24px;text-align:center;color:var(--gray-500);">No invoices match these filters.</div>`;
  const h = (k, lbl, align) => `<th style="text-align:${align || 'left'};padding:9px 12px;cursor:pointer;" onclick="amazonSort('${k}')">${escHtml(lbl)}${_amzSort.key === k ? (_amzSort.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`;
  return `<div style="background:var(--white);border-radius:10px;box-shadow:var(--shadow);overflow:auto;">
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:var(--gray-100);">
        ${h('invoiceId', 'Invoice')}${h('invoiceDate', 'Date')}${h('site', 'Site')}${h('po', 'PO')}
        ${h('deptName', 'Department')}${h('businessUnit', 'BU')}${h('payeeStatus', 'Amazon status')}
        ${h('daysOverdue', 'Age', 'right')}${h('amount', 'Open AR', 'right')}
      </tr></thead>
      <tbody>
        ${sorted.slice(0, 500).map(r => `<tr style="border-top:1px solid var(--gray-200);cursor:pointer;" onclick="openDrawer('${escHtml(r.recordNo)}')"
            onmouseover="this.style.background='var(--gray-50)'" onmouseout="this.style.background=''">
          <td style="padding:8px 12px;font-weight:600;color:var(--navy);">${escHtml(r.invoiceId)}</td>
          <td style="padding:8px 12px;color:var(--gray-600);">${escHtml(r.invoiceDate || '—')}</td>
          <td style="padding:8px 12px;">${escHtml(amzBlank(r.site))}${r.siteConfidence && r.siteConfidence !== 'certain' ? ` <span title="${escHtml(r.siteEvidence)}" style="color:#d97706;">•</span>` : ''}</td>
          <td style="padding:8px 12px;font-size:12px;">${escHtml(amzBlank(r.po))}</td>
          <td style="padding:8px 12px;font-size:12px;">${escHtml(amzBlank(r.deptName))}${r.deptMixed ? ' <span style="color:#d97706;" title="lines span more than one department">mixed</span>' : ''}</td>
          <td style="padding:8px 12px;font-size:12px;">${escHtml(amzBlank(r.businessUnit, '(none)'))}</td>
          <td style="padding:8px 12px;font-size:12px;color:var(--gray-600);">${escHtml(amzBlank(r.payeeStatus))}</td>
          <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;">${r.daysOverdue || 0}d</td>
          <td style="padding:8px 12px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${amzMoney(r.amount)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${sorted.length > 500 ? `<div style="padding:10px;text-align:center;color:var(--gray-500);font-size:12px;">Showing the first 500 of ${sorted.length.toLocaleString()} — narrow with a filter.</div>` : ''}
  </div>`;
}

// ─── interactions ────────────────────────────────────────────────────────────
function amazonDrill(key, value) {
  _amzPath.push({ key, value: value || '' });
  amazonRender();
}
function amazonDrillTo(depth) { _amzPath = _amzPath.slice(0, depth); amazonRender(); }
function amazonSetFilter(key, value) {
  _amzFilters[key] = value;
  // Descending past a level and then filtering it to something else would show
  // an empty table with no obvious cause, so drop crumbs the filter contradicts.
  _amzPath = _amzPath.filter(step => !(step.key === key && value && step.value !== value));
  amazonRender();
}
function amazonClearFilters() { _amzFilters = {}; amazonRender(); }
function amazonSort(key) {
  if (_amzSort.key === key) _amzSort.dir *= -1; else _amzSort = { key, dir: -1 };
  amazonRender();
}
function amazonShowUnattributed() {
  _amzPath = [];
  _amzFilters = { unattributed: true };
  amazonRender();
}
