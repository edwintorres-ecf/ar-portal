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
let _amzFresh = {};
let _amzAccruals = null;
let _amzSiteCollectors = {};
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
    _amzFresh = data.freshness || {};
    _amzAccruals = data.accruals || null;
    _amzSiteCollectors = data.siteCollectors || {};
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
    if (f.payeeStatus && (r.payeeStatus || '(not in Payee feed)') !== f.payeeStatus) return false;
    if (f.poStatus && (r.poStatus || '') !== f.poStatus) return false;
    if (f.needsCashApplication && !r.needsCashApplication) return false;
    if (f.collector) {
      const c = (_amzSiteCollectors[r.site] || {}).email || '';
      if (f.collector === '(unassigned)' ? !!c : c !== f.collector) return false;
    }
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

// The next level is the one AFTER the deepest level already in the path, not
// simply path.length. That distinction is what lets a search jump land you at a
// site: the path becomes a single Site step and the view groups by PO, instead
// of pretending you are one level below Department.
function amzCurrentLevel() {
  if (!_amzPath.length) return AMZ_LEVELS[0];
  const last = _amzPath[_amzPath.length - 1].key;
  const idx = AMZ_LEVELS.findIndex(l => l.key === last);
  return idx === -1 ? null : (AMZ_LEVELS[idx + 1] || null);
}

// ─── render ──────────────────────────────────────────────────────────────────
function amazonRender() {
  const el = document.getElementById('amazon-content');
  if (!el || !_amzRows) return;
  const rows = amzFiltered();
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const level = amzCurrentLevel();

  el.innerHTML = `
    ${amzHeaderHtml(rows, total)}
    ${amzJumpHtml()}
    ${amzToolbarHtml(rows)}
    ${amzFreshnessHtml()}
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
  const paidNotApplied = rows.filter(r => r.needsCashApplication);
  const pnaAmt = paidNotApplied.reduce((s, r) => s + r.amount, 0);
  return `
    ${paidNotApplied.length ? `<div style="background:#e0f2fe;border:1px solid #7dd3fc;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#075985;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span style="font-size:16px;">💰</span>
      <span><strong>${paidNotApplied.length}</strong> invoice${paidNotApplied.length > 1 ? 's' : ''} worth <strong>${amzMoney(pnaAmt)}</strong> are marked <strong>Paid by Amazon</strong> but still carry a balance in Intacct — the cash needs applying, not chasing.</span>
      <button onclick="amazonShowPaidNotApplied()" style="margin-left:auto;background:#0284c7;border:none;color:#fff;border-radius:5px;padding:4px 12px;cursor:pointer;font-size:12px;font-weight:600;">Show them</button>
    </div>` : ''}
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px;">
      ${amzTile('Open AR', amzMoney(total))}
      ${amzTile('Invoices', rows.length.toLocaleString())}
      ${amzTile('Sites', new Set(rows.map(r => r.site).filter(Boolean)).size)}
      ${amzTile('POs', new Set(rows.map(r => r.po).filter(Boolean)).size)}
      ${amzAccrualTileHtml()}
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
  // Underscore keys are UI state (the jump box text), not filters, so they must
  // not show up in the "Clear N filters" count.
  const active = Object.entries(_amzFilters).filter(([k, val]) => val && !k.startsWith('_')).length;
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
      ${amzSelect('payeeStatus', 'Amazon status', amzStatusVocab(), _amzFilters.payeeStatus)}
      ${amzSelect('poStatus', 'PO status', ['Open', 'Closed'], _amzFilters.poStatus)}
      ${amzSelect('collector', 'Collector', amzCollectorVocab(), _amzFilters.collector)}
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--gray-700);cursor:pointer;">
        <input type="checkbox" ${_amzFilters.needsCashApplication ? 'checked' : ''} onchange="amazonSetFilter('needsCashApplication', this.checked)"> Needs applying in Intacct
      </label>
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
    if (!groups[k]) groups[k] = { key: k, n: 0, amount: 0, sites: new Set(), pos: new Set(), sample: r, rows: [] };
    groups[k].n++; groups[k].amount += r.amount; groups[k].rows.push(r);
    if (r.site) groups[k].sites.add(r.site);
    if (r.po) groups[k].pos.add(r.po);
  }
  const list = Object.values(groups).sort((a, b) => b.amount - a.amount);
  const total = list.reduce((s, g) => s + g.amount, 0) || 1;
  const showAccrued = amzAccrualHasAny(level.key);
  const isSiteLevel = level.key === 'site';
  if (!list.length) return `<div style="padding:24px;text-align:center;color:var(--gray-500);">No invoices match these filters.</div>`;

  return `<div style="background:var(--white);border-radius:10px;box-shadow:var(--shadow);overflow:hidden;">
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:var(--gray-100);">
        <th style="text-align:left;padding:9px 12px;">${escHtml(level.label)}</th>
        <th style="text-align:left;padding:9px 12px;">Detail</th>
        <th style="text-align:right;padding:9px 12px;">Invoices</th>
        <th style="text-align:right;padding:9px 12px;">Open AR</th>
        ${showAccrued ? '<th style="text-align:right;padding:9px 12px;color:#92400e;" title="Earned but not yet invoiced — not part of Open AR">Accrued</th>' : ''}
        ${isSiteLevel ? '<th style="text-align:left;padding:9px 12px;">Collector</th>' : ''}
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
            ${showAccrued ? `<td style="padding:9px 12px;text-align:right;font-variant-numeric:tabular-nums;color:${amzAccrualFor(level.key, g.key) ? '#92400e' : 'var(--gray-400)'};">${amzAccrualFor(level.key, g.key) ? amzMoney(amzAccrualFor(level.key, g.key)) : '—'}</td>` : ''}
            ${isSiteLevel ? `<td style="padding:9px 12px;font-size:12px;" onclick="event.stopPropagation();amazonAssignSiteCollector(${JSON.stringify(g.key).replace(/"/g, '&quot;')})">${amzCollectorCellHtml(g.key)}</td>` : ''}
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
  if (key === 'po') return amzPoDetailHtml(g);
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
        ${h('deptName', 'Department')}${h('businessUnit', 'BU')}${h('payeeStatus', 'Amazon status')}${h('poStatus', 'PO')}
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
          <td style="padding:8px 12px;font-size:12px;">${amzStatusPill(r)}</td>
          <td style="padding:8px 12px;font-size:11px;color:${r.poStatus === 'Closed' ? '#dc2626' : 'var(--gray-600)'};">${escHtml(amzBlank(r.poStatus, '—'))}${r.poStale ? ' ⚠' : ''}</td>
          <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;${r.needsCashApplication ? 'color:var(--gray-400);text-decoration:line-through;' : ''}" ${r.needsCashApplication ? 'title="Amazon has paid this — the age is not a collections age"' : ''}>${r.daysOverdue || 0}d</td>
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


// ─── Amazon Payee Central status ─────────────────────────────────────────────
// The status shown here is Amazon's own, resolved across the resubmission
// suffix chain, so a rejected invoice that was resubmitted as S8604A reports the
// live attempt rather than the dead original.
function amzStatusVocab() {
  const set = new Set((_amzRows || []).map(r => r.payeeStatus || '(not in Payee feed)'));
  return [...set].sort();
}

function amzAgeMin(iso) {
  const t = Date.parse(iso || '');
  return isNaN(t) ? null : Math.round((Date.now() - t) / 60000);
}

function amzAgeText(min) {
  if (min === null) return 'unknown';
  if (min < 90) return min + 'm ago';
  const h = Math.round(min / 60);
  return h < 48 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
}

// A status is only as good as its feed. Say the age out loud and colour it, so
// nobody reads a week-old "Scheduled for payment" as today's truth.
function amzFreshnessHtml() {
  const f = _amzFresh || {};
  const fm = amzAgeMin(f.payeeFeedGeneratedAt);
  const pm = amzAgeMin(f.poDetailsScrapedAt);
  const tone = (min, warnH, badH) => min === null ? '#6b7280'
    : min > badH * 60 ? '#dc2626' : min > warnH * 60 ? '#d97706' : '#059669';
  return `<div style="font-size:11px;color:var(--gray-500);margin-bottom:12px;display:flex;gap:16px;flex-wrap:wrap;align-items:center;">
    <span>Amazon status freshness:</span>
    <span><span style="color:${tone(fm, 6, 24)};">●</span> invoice statuses ${escHtml(amzAgeText(fm))}</span>
    <span><span style="color:${tone(pm, 8, 48)};">●</span> PO detail ${escHtml(amzAgeText(pm))}</span>
    ${fm !== null && fm > 24 * 60 ? '<span style="color:#dc2626;font-weight:600;">Feed is over a day old — statuses below may have moved.</span>' : ''}
  </div>`;
}

function amzStatusPill(r) {
  const label = r.payeeLabel || r.payeeStatus;
  if (!label) return '<span style="color:var(--gray-400);font-size:11px;">not in Payee feed</span>';
  const bg = r.payeeBg || '#f3f4f6';
  const color = r.payeeColor || '#374151';
  const dup = r.payeeDuplicateLive
    ? ' <span title="more than one attempt is live at Amazon — possible double submission" style="color:#dc2626;font-weight:700;">!!</span>' : '';
  const att = (r.payeeAttempts > 1 && !r.payeeDuplicateLive)
    ? ` <span title="resubmission chain: ${r.payeeAttempts} attempts, showing ${escHtml(r.payeeId)}" style="color:var(--gray-500);font-size:10px;">${r.payeeAttempts}×</span>` : '';
  const apply = r.needsCashApplication
    ? ' <span title="Amazon has paid this but Intacct still shows a balance — apply the cash" style="background:#fff7ed;color:#c2410c;border:1px solid #fdba74;padding:1px 6px;border-radius:9px;font-size:10px;font-weight:700;white-space:nowrap;">apply in Intacct</span>' : '';
  return `<span style="background:${bg};color:${color};padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;">${escHtml(r.payeeIcon || '')} ${escHtml(label)}</span>${att}${dup}${apply}`;
}

// At PO level the useful facts are Amazon's PO state and how its invoices are
// sitting, not just the total. A closed PO with pending invoices is a problem.
function amzPoDetailHtml(g) {
  const s = g.sample || {};
  const bits = [];
  if (s.poStatus) bits.push(s.poStatus === 'Closed' ? '⛔ Closed at Amazon' : '✓ Open at Amazon');
  if (s.poMasked) bits.push('amount hidden by Amazon');
  else if (s.poAvailable !== null && s.poAvailable !== undefined) bits.push('available ' + amzMoney(s.poAvailable));
  if (s.poStale) bits.push('⚠ stale scrape');
  const counts = {};
  (g.rows || []).forEach(r => { const k = r.payeeLabel || r.payeeStatus || 'not in feed'; counts[k] = (counts[k] || 0) + 1; });
  const statuses = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');
  return [bits.join(' · '), statuses].filter(Boolean).join('  —  ');
}


// Paid at Amazon, still open in Intacct. Kept as its own switch because these
// are the opposite of a collections problem: the money already arrived and the
// aging column beside them is meaningless until the cash is applied.
function amazonShowPaidNotApplied() {
  _amzPath = [];
  _amzFilters = { needsCashApplication: true };
  amazonRender();
}


// ─── Jump to a site ──────────────────────────────────────────────────────────
// Edwin: "a search feature on these amazon pages to get to a site code". Site
// codes are opaque (DBL1, KRB5, QYY4), so matching the code alone is not enough
// — you often know the city or the business unit and not the code. This matches
// code, city, region, business unit, site type and ECF branch, and also finds a
// PO or an invoice, so one box gets you anywhere in the hierarchy.
let _amzJumpOpen = false;

function amzJumpIndex() {
  const sites = {};
  for (const r of (_amzRows || [])) {
    if (!r.site) continue;
    if (!sites[r.site]) sites[r.site] = { site: r.site, n: 0, amount: 0, bu: r.businessUnit, region: r.region, type: r.siteType, sc: r.serviceCenter, city: r.city, state: r.state };
    sites[r.site].n++; sites[r.site].amount += r.amount;
  }
  return Object.values(sites);
}

function amzJumpMatches(q) {
  const s = q.trim().toUpperCase();
  if (s.length < 2) return [];
  const out = [];
  for (const site of amzJumpIndex()) {
    const hay = [site.site, site.bu, site.region, site.type, site.sc, site.city, site.state].filter(Boolean).join(' ').toUpperCase();
    if (hay.includes(s)) {
      out.push({ kind: 'site', key: site.site, amount: site.amount, n: site.n,
                 sub: [[site.city, site.state].filter(Boolean).join(', '), site.bu, site.type, site.sc].filter(Boolean).join(' · '),
                 exact: site.site === s });
    }
  }
  const pos = {};
  for (const r of (_amzRows || [])) {
    if (r.po && r.po.toUpperCase().includes(s)) {
      if (!pos[r.po]) { pos[r.po] = { kind: 'po', key: r.po, amount: 0, n: 0, sub: r.site ? 'site ' + r.site : 'PO' }; out.push(pos[r.po]); }
      pos[r.po].amount += r.amount; pos[r.po].n++;
    }
  }
  for (const r of (_amzRows || [])) {
    if (r.invoiceId && r.invoiceId.toUpperCase().includes(s)) {
      out.push({ kind: 'invoice', key: r.invoiceId, amount: r.amount, n: 1,
                 sub: [r.site, r.po].filter(Boolean).join(' · '), recordNo: r.recordNo });
    }
  }
  // Exact site code first, then biggest balances; a code typed in full should
  // never sit below a fuzzy match on some other site's city.
  out.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0) || b.amount - a.amount);
  return out.slice(0, 8);
}

function amzJumpHtml() {
  const q = _amzFilters._jump || '';
  const matches = _amzJumpOpen ? amzJumpMatches(q) : [];
  return `<div style="position:relative;margin-bottom:12px;">
    <input id="amz-jump" type="text" value="${escHtml(q)}" placeholder="🔎 Jump to a site code, city, business unit, PO or invoice…"
      autocomplete="off"
      oninput="amazonJumpInput(this.value)" onfocus="amazonJumpInput(this.value)"
      onkeydown="if(event.key==='Escape'){amazonJumpClose();}"
      style="width:100%;max-width:560px;padding:9px 12px;border:1px solid var(--gray-300);border-radius:8px;font-size:13px;">
    ${matches.length ? `<div style="position:absolute;z-index:50;background:var(--white);border:1px solid var(--gray-300);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);margin-top:4px;max-width:560px;width:100%;overflow:hidden;">
      ${matches.map(m => `<div onclick="amazonJumpGo('${m.kind}', ${JSON.stringify(m.key).replace(/"/g, '&quot;')}, ${JSON.stringify(m.recordNo || '').replace(/"/g, '&quot;')})"
        style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--gray-100);display:flex;gap:10px;align-items:center;"
        onmouseover="this.style.background='var(--gray-50)'" onmouseout="this.style.background=''">
        <span style="font-size:10px;text-transform:uppercase;color:var(--gray-500);width:52px;">${escHtml(m.kind)}</span>
        <span style="font-weight:600;color:var(--navy);">${escHtml(m.key)}</span>
        <span style="color:var(--gray-500);font-size:12px;">${escHtml(m.sub || '')}</span>
        <span style="margin-left:auto;font-variant-numeric:tabular-nums;font-size:12px;">${amzMoney(m.amount)}${m.kind !== 'invoice' ? ` · ${m.n}` : ''}</span>
      </div>`).join('')}
    </div>` : ''}
  </div>`;
}

function amazonJumpInput(v) {
  _amzFilters._jump = v;
  _amzJumpOpen = true;
  amazonRender();
  const el = document.getElementById('amz-jump');
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

function amazonJumpClose() { _amzJumpOpen = false; amazonRender(); }

function amazonJumpGo(kind, key, recordNo) {
  _amzJumpOpen = false;
  _amzFilters._jump = '';
  if (kind === 'invoice') { if (recordNo) openDrawer(recordNo); return; }
  // Land AT the thing, not above it: a site jump groups by PO, a PO jump lands
  // on its invoices. Other filters are left alone on purpose.
  _amzPath = kind === 'site' ? [{ key: 'site', value: key }]
                             : [{ key: 'po', value: key }];
  amazonRender();
}


// ─── Reporting + export ──────────────────────────────────────────────────────
// Both take the CURRENT filters and drill path. An export that quietly differs
// from what is on screen is worse than no export, so the server route re-applies
// the same filters to the same row builder rather than trusting a payload.
let _amzShowReport = false;

// The drill path is a set of equality filters, so it serialises alongside them.
function amzExportParams() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(_amzFilters)) {
    if (!v || k.startsWith('_')) continue;
    p.set(k, v === true ? '1' : v);
  }
  for (const step of _amzPath) p.set(step.key, step.value);
  return p;
}

function amazonExportExcel() {
  const p = amzExportParams();
  // Cloudflare edge-caches .xlsx URLs by default; the query string is part of
  // the cache key, so a timestamp guarantees a fresh file (2026-08-05 lesson).
  p.set('t', Date.now());
  window.location = '/api/amazon/export.xlsx?' + p.toString();
}

function amazonExportCsv() {
  const rows = amzFiltered();
  if (!rows.length) return;
  const cols = [
    ['Invoice', 'invoiceId'], ['Invoice Date', 'invoiceDate'], ['Due Date', 'dueDate'],
    ['Days Overdue', 'daysOverdue'], ['Aging', 'bucket'], ['Open AR', 'amount'],
    ['Department', 'deptGroup'], ['Intacct Code', 'deptId'], ['Business Unit', 'businessUnit'],
    ['Site', 'site'], ['Site Type', 'siteType'], ['Region', 'region'], ['City', 'city'], ['State', 'state'],
    ['Site Source', 'siteSource'], ['PO', 'po'], ['PO Status', 'poStatus'],
    ['Amazon Status', 'payeeStatus'], ['Needs Applying', 'needsCashApplication'], ['ECF Branch', 'serviceCenter'],
  ];
  const esc = (v) => {
    if (v === true) return 'YES';
    if (v === false || v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cols.map(c => c[0]).join(',')]
    .concat(rows.map(r => cols.map(c => esc(r[c[1]])).join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ecf-amazon-drilldown-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 800);
}

function amazonToggleReport() { _amzShowReport = !_amzShowReport; amazonRender(); }

function amzToolbarHtml(rows) {
  const n = rows.length;
  return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
    <button onclick="amazonToggleReport()" style="padding:6px 12px;border:1px solid var(--gray-300);background:${_amzShowReport ? 'var(--navy)' : 'var(--white)'};color:${_amzShowReport ? '#fff' : 'var(--gray-700)'};border-radius:6px;font-size:12px;cursor:pointer;font-weight:600;">
      ${_amzShowReport ? '▼' : '▶'} Report
    </button>
    <button onclick="amazonExportCsv()" title="The ${n.toLocaleString()} rows currently shown" style="padding:6px 12px;border:1px solid var(--gray-300);background:var(--white);border-radius:6px;font-size:12px;cursor:pointer;">⬇ CSV</button>
    <button onclick="amazonExportExcel()" title="Excel workbook with summary sheets plus the detail rows" style="padding:6px 12px;border:1px solid var(--gray-300);background:var(--white);border-radius:6px;font-size:12px;cursor:pointer;">⬇ Excel report</button>
    <button onclick="amazonAssignVisibleSites()" title="Assign a collector to every site currently in view" style="padding:6px 12px;border:1px solid var(--gray-300);background:var(--white);border-radius:6px;font-size:12px;cursor:pointer;">👤 Assign collector</button>
    <span style="font-size:11px;color:var(--gray-500);">exports follow the filters and drill you have set — ${n.toLocaleString()} invoice${n === 1 ? '' : 's'}</span>
  </div>
  ${_amzShowReport ? amzReportHtml(rows) : ''}`;
}

// Grouped totals for every dimension at once, so the shape is visible without
// clicking down the hierarchy one level at a time.
function amzReportHtml(rows) {
  const dims = [
    ['Department', 'deptGroup'], ['Business Unit', 'businessUnit'], ['Amazon Status', 'payeeStatus'],
    ['Site Type', 'siteType'], ['Region', 'region'], ['Aging', 'bucket'],
    ['ECF Branch', 'serviceCenter'], ['Site', 'site'],
  ];
  const total = rows.reduce((t, r) => t + r.amount, 0) || 1;
  const block = ([label, key]) => {
    const g = {};
    for (const r of rows) {
      const k = r[key] || '(none)';
      if (!g[k]) g[k] = { k, n: 0, amt: 0 };
      g[k].n++; g[k].amt += r.amount;
    }
    const list = Object.values(g).sort((a, b) => b.amt - a.amt).slice(0, 12);
    return `<div style="background:var(--white);border-radius:10px;box-shadow:var(--shadow);padding:12px 14px;min-width:280px;flex:1;">
      <div style="font-size:11px;font-weight:700;color:var(--gray-500);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">${escHtml(label)}</div>
      ${list.map(x => `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:12px;">
        <span style="flex:1;color:var(--gray-700);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(x.k)}</span>
        <span style="color:var(--gray-500);font-variant-numeric:tabular-nums;">${x.n.toLocaleString()}</span>
        <span style="width:92px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${amzMoney(x.amt)}</span>
        <span style="width:44px;"><span style="display:block;height:6px;border-radius:3px;background:var(--navy);width:${Math.max(2, Math.round(x.amt / total * 44))}px;"></span></span>
      </div>`).join('')}
      ${Object.keys(g).length > 12 ? `<div style="font-size:11px;color:var(--gray-500);margin-top:4px;">+${Object.keys(g).length - 12} more — see the Excel report</div>` : ''}
    </div>`;
  };
  const a = _amzAccruals;
  const accBlock = (a && a.openCount) ? `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:12px 14px;min-width:280px;flex:1;">
      <div style="font-size:11px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Accrued, not invoiced</div>
      <div style="font-size:11px;color:#b45309;margin-bottom:8px;">Earned work with no invoice — excluded from every Open AR figure above.</div>
      ${Object.entries(a.byDeptGroup).sort((x, y) => y[1].amount - x[1].amount).map(([k, v]) => `<div style="display:flex;gap:8px;margin-bottom:5px;font-size:12px;">
        <span style="flex:1;color:var(--gray-700);">${escHtml(k)}</span>
        <span style="color:var(--gray-500);">${v.count}</span>
        <span style="width:92px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${amzMoney(v.amount)}</span></div>`).join('')}
      <div style="border-top:1px solid #fcd34d;margin-top:6px;padding-top:6px;display:flex;font-size:12px;font-weight:700;color:#92400e;">
        <span style="flex:1;">Total accrued</span><span>${amzMoney(a.openAmount)}</span></div>
    </div>` : '';
  return `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;">${dims.map(block).join('')}${accBlock}</div>`;
}


// ─── Accrual register: work done for Amazon with no PO yet ───────────────────
// Edwin 2026-09-09: work is performed before a PO exists and we wait on an
// accrual. That revenue is real and earned but cannot be invoiced, so it shows
// up nowhere in AR — this register is the only place it exists. Tracking is the
// point; pushing to Intacct is a bonus and is currently blocked upstream.
let _accruals = null, _accrualMeta = null, _accrualShowCancelled = false;
let _accrualEditingId = null;   // set while the form is editing an existing row

async function accrualsLoad() {
  const el = document.getElementById('accruals-content');
  if (!el) return;
  el.innerHTML = '<div style="padding:30px;text-align:center;color:var(--gray-500);">Loading…</div>';
  try {
    const d = await apiFetch('/api/amazon/accruals' + (_accrualShowCancelled ? '?includeCancelled=1' : ''));
    _accruals = d.accruals || [];
    _accrualMeta = d;
    accrualsRender();
  } catch (e) {
    el.innerHTML = `<div style="padding:20px;color:var(--red);">Error: ${escHtml(e.message)}</div>`;
  }
}

const ACCRUAL_LABEL = {
  awaiting_po: 'Awaiting PO', po_received: 'PO received', invoiced: 'Invoiced', cancelled: 'Cancelled',
};
const ACCRUAL_TONE = {
  awaiting_po: { bg: '#fef3c7', color: '#92400e' },
  po_received: { bg: '#e0f2fe', color: '#075985' },
  invoiced:    { bg: '#dcfce7', color: '#166534' },
  cancelled:   { bg: '#f3f4f6', color: '#6b7280' },
};

function accrualDays(r) {
  const t = Date.parse(r.work_date || r.created_at || '');
  return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

function accrualsRender() {
  const el = document.getElementById('accruals-content');
  if (!el || !_accruals) return;
  const m = _accrualMeta || {};
  const by = m.byStatus || {};
  const tile = (label, v, sub, color) => `<div style="background:var(--white);border-radius:10px;box-shadow:var(--shadow);padding:12px 16px;min-width:150px;border-left:3px solid ${color};">
    <div style="font-size:11px;color:var(--gray-500);text-transform:uppercase;letter-spacing:.04em;">${escHtml(label)}</div>
    <div style="font-size:19px;font-weight:700;color:var(--navy);font-variant-numeric:tabular-nums;">${escHtml(v)}</div>
    <div style="font-size:11px;color:var(--gray-500);">${escHtml(sub)}</div></div>`;
  const st = (k) => by[k] || { count: 0, amount: 0 };

  const rows = _accruals.slice().sort((a, b) => b.amount - a.amount);
  el.innerHTML = `
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px;">
      ${tile('Open accrual value', amzMoney(m.openTotal || 0), `${m.openCount || 0} not yet invoiced`, '#d97706')}
      ${tile('Awaiting PO', amzMoney(st('awaiting_po').amount), `${st('awaiting_po').count} entries`, '#f59e0b')}
      ${tile('PO received', amzMoney(st('po_received').amount), `${st('po_received').count} ready to invoice`, '#0284c7')}
      ${tile('Invoiced', amzMoney(st('invoiced').amount), `${st('invoiced').count} closed out`, '#16a34a')}
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
      <button onclick="accrualOpenForm()" style="padding:7px 14px;border:none;background:var(--navy);color:#fff;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">+ Record accrual</button>
      <button onclick="accrualExportCsv()" style="padding:7px 12px;border:1px solid var(--gray-300);background:var(--white);border-radius:6px;font-size:12px;cursor:pointer;">⬇ CSV</button>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--gray-700);cursor:pointer;">
        <input type="checkbox" ${_accrualShowCancelled ? 'checked' : ''} onchange="_accrualShowCancelled=this.checked;accrualsLoad()"> show cancelled
      </label>
      ${m.scoped ? '<span style="font-size:11px;color:var(--gray-500);">showing your sites only</span>' : ''}
      ${m.intacctOrderEntry && !m.intacctOrderEntry.available ? `<span title="${escHtml(m.intacctOrderEntry.reason)}" style="margin-left:auto;font-size:11px;color:#92400e;background:#fef3c7;border-radius:10px;padding:2px 10px;">Push to Intacct unavailable — ${escHtml(m.intacctOrderEntry.reason)}</span>` : ''}
    </div>
    ${rows.length ? accrualTableHtml(rows) : '<div style="padding:30px;text-align:center;color:var(--gray-500);background:var(--white);border-radius:10px;box-shadow:var(--shadow);">Nothing recorded yet. Use “Record accrual” when work is done before a PO exists.</div>'}
  `;
}

function accrualTableHtml(rows) {
  return `<div style="background:var(--white);border-radius:10px;box-shadow:var(--shadow);overflow:auto;">
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:var(--gray-100);">
        <th style="text-align:left;padding:9px 12px;">Site</th>
        <th style="text-align:left;padding:9px 12px;">Work</th>
        <th style="text-align:left;padding:9px 12px;">Department</th>
        <th style="text-align:left;padding:9px 12px;">Work date</th>
        <th style="text-align:right;padding:9px 12px;">Amount</th>
        <th style="text-align:right;padding:9px 12px;">Age</th>
        <th style="text-align:left;padding:9px 12px;">Status</th>
        <th style="text-align:left;padding:9px 12px;">PO / Invoice</th>
        <th style="text-align:left;padding:9px 12px;">Actions</th>
      </tr></thead>
      <tbody>${rows.map(r => {
        const tone = ACCRUAL_TONE[r.status] || ACCRUAL_TONE.cancelled;
        const age = accrualDays(r);
        return `<tr style="border-top:1px solid var(--gray-200);">
          <td style="padding:8px 12px;font-weight:600;color:var(--navy);">${escHtml(r.site_code || '—')}
            ${r.businessUnit ? `<span style="display:block;font-size:11px;font-weight:400;color:var(--gray-500);">${escHtml(r.businessUnit)}</span>` : ''}</td>
          <td style="padding:8px 12px;max-width:280px;">${escHtml(r.description)}
            ${r.notes ? `<span style="display:block;font-size:11px;color:var(--gray-500);">${escHtml(r.notes)}</span>` : ''}</td>
          <td style="padding:8px 12px;font-size:12px;">${escHtml(r.dept_id || '—')}</td>
          <td style="padding:8px 12px;font-size:12px;">${escHtml(r.work_date || '—')}</td>
          <td style="padding:8px 12px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${amzMoney(r.amount)}</td>
          <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;color:${age !== null && age > 90 ? '#dc2626' : 'var(--gray-600)'};">${age === null ? '—' : age + 'd'}</td>
          <td style="padding:8px 12px;"><span style="background:${tone.bg};color:${tone.color};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;white-space:nowrap;">${escHtml(ACCRUAL_LABEL[r.status] || r.status)}</span>
            ${r.cancel_reason ? `<span style="display:block;font-size:11px;color:var(--gray-500);">${escHtml(r.cancel_reason)}</span>` : ''}</td>
          <td style="padding:8px 12px;font-size:12px;">${escHtml(r.po_number || '')}${r.po_number && r.invoice_id ? ' · ' : ''}${escHtml(r.invoice_id || '')}${!r.po_number && !r.invoice_id ? '—' : ''}</td>
          <td style="padding:8px 12px;white-space:nowrap;">${accrualActionsHtml(r)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  </div>`;
}

function accrualActionsHtml(r) {
  const btn = (label, fn, tone) => `<button onclick="${fn}" style="margin-right:4px;padding:2px 8px;border:1px solid ${tone};background:var(--white);color:${tone};border-radius:5px;font-size:11px;cursor:pointer;">${label}</button>`;
  // Copy is available on every row, including closed ones: the same work recurs
  // at the same site, and a finished accrual is the most useful template there
  // is. It opens a PREFILLED FORM rather than saving straight away, so the
  // amount and date get looked at instead of inherited by accident.
  const copy = btn('Copy', `accrualCopy(${r.id})`, '#6b7280');
  // Editable after posting: an accrual is an estimate of work already done, so
  // the amount and description get corrected as better information arrives.
  // Cancelled rows stay frozen — they are a record of a decision.
  const edit = r.status === 'cancelled' ? '' : btn('Edit', `accrualEdit(${r.id})`, '#334155');
  if (r.status === 'awaiting_po') return btn('PO received', `accrualMarkPo(${r.id})`, '#0284c7') + btn('Cancel', `accrualCancel(${r.id})`, '#dc2626') + edit + copy;
  if (r.status === 'po_received') return btn('Invoiced', `accrualMarkInvoiced(${r.id})`, '#16a34a') + btn('Cancel', `accrualCancel(${r.id})`, '#dc2626') + edit + copy;
  return edit + copy;
}

// Prefill the form from an existing accrual. Everything about WHERE and WHAT
// carries over; nothing about the specific event does — the work date clears and
// the PO/invoice never copy, because those belong to the original.
function accrualCopy(id) {
  const src = (_accruals || []).find(a => a.id === id);
  if (!src) return;
  accrualOpenForm();   // clears any edit in progress: a copy is a NEW record
  const set = (elId, v) => { const e = document.getElementById(elId); if (e) e.value = v == null ? '' : v; };
  set('ac-site', src.site_code || '');
  set('ac-dept', src.dept_id || '');
  set('ac-desc', src.description || '');
  set('ac-amount', src.amount || '');
  set('ac-date', '');
  set('ac-notes', src.notes || '');
  const msg = document.getElementById('ac-msg');
  if (msg) msg.innerHTML = `<span style="color:#0369a1">Copied from accrual #${src.id}. Set the work date and check the amount before saving.</span>`;
  setTimeout(() => { const e = document.getElementById('ac-date'); if (e) e.focus(); }, 60);
}

async function accrualPatch(id, body) {
  try {
    await apiFetch('/api/amazon/accruals/' + id, { method: 'PATCH', body: JSON.stringify(body) });
    accrualsLoad();
  } catch (e) { alert(e.message); }
}

// The prompts ask for the evidence the server requires anyway, so a transition
// can never be recorded without the thing that justifies it.
function accrualMarkPo(id) {
  const po = prompt('PO number Amazon issued for this work:');
  if (po && po.trim()) accrualPatch(id, { status: 'po_received', poNumber: po.trim().toUpperCase() });
}
function accrualMarkInvoiced(id) {
  const inv = prompt('Invoice number raised for this work:');
  if (inv && inv.trim()) accrualPatch(id, { status: 'invoiced', invoiceId: inv.trim().toUpperCase() });
}
function accrualCancel(id) {
  const why = prompt('Why is this accrual being cancelled? (kept on the record, never deleted)');
  if (why && why.trim()) accrualPatch(id, { status: 'cancelled', cancelReason: why.trim() });
}

function accrualOpenForm() {
  const m = document.getElementById('accrual-modal');
  if (!m) return;
  _accrualEditingId = null;
  ['ac-site', 'ac-desc', 'ac-amount', 'ac-date', 'ac-notes'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
  document.getElementById('ac-msg').innerHTML = '';
  const title = document.getElementById('ac-title');
  if (title) title.textContent = 'Record an accrual';
  const save = document.getElementById('ac-save');
  if (save) save.textContent = 'Save accrual';
  m.style.display = 'flex';
  setTimeout(() => { const e = document.getElementById('ac-site'); if (e) e.focus(); }, 30);
}
function accrualCloseForm() {
  const m = document.getElementById('accrual-modal');
  if (m) m.style.display = 'none';
  _accrualEditingId = null;
}

function accrualEdit(id) {
  const src = (_accruals || []).find(a => a.id === id);
  if (!src) return;
  accrualOpenForm();
  _accrualEditingId = id;
  const set = (elId, v) => { const e = document.getElementById(elId); if (e) e.value = v == null ? '' : v; };
  set('ac-site', src.site_code || '');
  set('ac-dept', src.dept_id || '');
  set('ac-desc', src.description || '');
  set('ac-amount', src.amount || '');
  set('ac-date', src.work_date || '');
  set('ac-notes', src.notes || '');
  const title = document.getElementById('ac-title');
  if (title) title.textContent = 'Edit accrual #' + id;
  const save = document.getElementById('ac-save');
  if (save) save.textContent = 'Save changes';
  const msg = document.getElementById('ac-msg');
  if (msg && src.status !== 'awaiting_po') {
    msg.innerHTML = `<span style="color:#92400e">This accrual is already marked ${escHtml(src.status.replace('_', ' '))}. Editing it will not change that.</span>`;
  }
}

async function accrualSave() {
  const msg = document.getElementById('ac-msg');
  const body = {
    siteCode: (document.getElementById('ac-site').value || '').trim(),
    deptId: document.getElementById('ac-dept').value,
    description: (document.getElementById('ac-desc').value || '').trim(),
    amount: document.getElementById('ac-amount').value,
    workDate: document.getElementById('ac-date').value,
    notes: (document.getElementById('ac-notes').value || '').trim(),
  };
  if (!body.description) { msg.innerHTML = '<span style="color:var(--red)">Describe the work — this is what tells someone later what the money is for.</span>'; return; }
  if (!(parseFloat(body.amount) > 0)) { msg.innerHTML = '<span style="color:var(--red)">Enter the amount accrued.</span>'; return; }
  try {
    if (_accrualEditingId) {
      await apiFetch('/api/amazon/accruals/' + _accrualEditingId, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await apiFetch('/api/amazon/accruals', { method: 'POST', body: JSON.stringify(body) });
    }
    accrualCloseForm();
    accrualsLoad();
  } catch (e) { msg.innerHTML = `<span style="color:var(--red)">${escHtml(e.message)}</span>`; }
}

function accrualExportCsv() {
  const rows = _accruals || [];
  if (!rows.length) return;
  const cols = [['Site','site_code'],['Business Unit','businessUnit'],['Description','description'],['Department','dept_id'],
    ['Work Date','work_date'],['Amount','amount'],['Status','status'],['PO','po_number'],['Invoice','invoice_id'],
    ['Service Center','service_center'],['Notes','notes'],['Cancel Reason','cancel_reason'],['Created By','created_by'],['Created At','created_at']];
  const esc = (v) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [cols.map(c => c[0]).join(',')].concat(rows.map(r => cols.map(c => esc(r[c[1]])).join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ecf-amazon-accruals-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 800);
}

(function injectAccrualModal() {
  const html = `
<div id="accrual-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)accrualCloseForm()">
  <div class="modal-box" style="width:540px;max-width:95vw">
    <h3 id="ac-title" style="margin-bottom:2px">Record an accrual</h3>
    <div style="font-size:12px;color:var(--gray-500);margin-bottom:12px">Work performed for Amazon with no PO yet. It stays here until a PO arrives and it can be invoiced.</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
      <div><label style="display:block;font-size:12px;font-weight:600;color:var(--gray-700);margin-bottom:3px">Site code</label>
        <input id="ac-site" placeholder="DBL1" style="width:100%;padding:8px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:13px"></div>
      <div><label style="display:block;font-size:12px;font-weight:600;color:var(--gray-700);margin-bottom:3px">Department</label>
        <select id="ac-dept" style="width:100%;padding:8px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:13px">
          <option value="">—</option><option value="D-SNOW">Snow Removal</option><option value="D-GRMT">Landscape Maintenance</option>
          <option value="D-ARBR">Arbor</option><option value="D-LAPR">Landscape Projects</option><option value="D-PKLT">Parking Lot</option><option value="D-IRMG">Irrigation</option>
        </select></div>
    </div>
    <label style="display:block;font-size:12px;font-weight:600;color:var(--gray-700);margin-bottom:3px">What was done</label>
    <input id="ac-desc" placeholder="e.g. Dec 18 snow event, 3 pushes" style="width:100%;padding:8px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:13px;margin-bottom:10px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
      <div><label style="display:block;font-size:12px;font-weight:600;color:var(--gray-700);margin-bottom:3px">Amount accrued</label>
        <input id="ac-amount" type="number" step="0.01" min="0" placeholder="12500.00" style="width:100%;padding:8px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:13px"></div>
      <div><label style="display:block;font-size:12px;font-weight:600;color:var(--gray-700);margin-bottom:3px">Work date</label>
        <input id="ac-date" type="date" style="width:100%;padding:8px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:13px"></div>
    </div>
    <label style="display:block;font-size:12px;font-weight:600;color:var(--gray-700);margin-bottom:3px">Notes <span style="font-weight:400;color:var(--gray-500)">(optional)</span></label>
    <input id="ac-notes" placeholder="who authorised it, what we are waiting on" style="width:100%;padding:8px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:13px">
    <div id="ac-msg" style="font-size:12px;margin-top:10px;min-height:16px"></div>
    <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button onclick="accrualCloseForm()" style="padding:7px 14px;border:1px solid var(--gray-300);background:var(--white);border-radius:6px;font-size:13px;cursor:pointer">Cancel</button>
      <button id="ac-save" onclick="accrualSave()" style="padding:7px 16px;border:none;background:var(--navy);color:#fff;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Save accrual</button>
    </div>
  </div>
</div>`;
  const d = document.createElement('div');
  d.innerHTML = html;
  document.body.appendChild(d.firstElementChild);
})();


// ─── Accruals inside the reporting surface ───────────────────────────────────
// Accrued work is earned but uninvoiced, so it must never be added into Open AR
// — that would overstate receivables. It sits ALONGSIDE, in its own amber tile
// and its own column, and the wording says so wherever it appears.
function amzAccrualTileHtml() {
  const a = _amzAccruals;
  if (!a || !a.openCount) return '';
  return `<div onclick="navGo('amazon-accruals')" title="Work performed with no PO yet — not part of Open AR"
    style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:12px 16px;min-width:150px;cursor:pointer;border-left:3px solid #d97706;">
    <div style="font-size:11px;color:#92400e;text-transform:uppercase;letter-spacing:.04em;">Accrued, not invoiced</div>
    <div style="font-size:19px;font-weight:700;color:#92400e;font-variant-numeric:tabular-nums;">${amzMoney(a.openAmount)}</div>
    <div style="font-size:11px;color:#b45309;">${a.openCount} entr${a.openCount === 1 ? 'y' : 'ies'} · not in Open AR</div>
  </div>`;
}

// Accrued value for whichever grouping the drill is currently showing.
function amzAccrualFor(levelKey, groupKey) {
  const a = _amzAccruals;
  if (!a) return 0;
  const bag = levelKey === 'site' ? a.bySite
    : levelKey === 'deptGroup' ? a.byDeptGroup
    : levelKey === 'businessUnit' ? a.byBusinessUnit : null;
  if (!bag) return 0;
  return (bag[groupKey || '(none)'] || {}).amount || 0;
}

function amzAccrualHasAny(levelKey) {
  const a = _amzAccruals;
  if (!a || !a.openCount) return false;
  return ['site', 'deptGroup', 'businessUnit'].includes(levelKey);
}


// ─── Site ownership ──────────────────────────────────────────────────────────
// Amazon is one customer with 219 sites, so the site is the only unit that can
// actually divide the work between collectors.
function amzCollectorVocab() {
  const set = new Set(Object.values(_amzSiteCollectors || {}).map(c => c.email).filter(Boolean));
  return ['(unassigned)'].concat([...set].sort());
}

function amzCollectorCellHtml(site) {
  const c = (_amzSiteCollectors || {})[site];
  if (!c || !c.email) {
    return `<span style="color:var(--gray-400);cursor:pointer;text-decoration:underline dotted;" title="Click to assign a collector">unassigned</span>`;
  }
  const name = c.email.split('@')[0].replace(/[._]/g, ' ');
  return `<span style="cursor:pointer;text-decoration:underline dotted;" title="${escHtml(c.email)} — assigned by ${escHtml(c.assignedBy || 'unknown')} on ${escHtml((c.assignedAt || '').slice(0, 10))}. Click to change.">${escHtml(name)}</span>`;
}

async function amazonAssignSiteCollector(site) {
  const cur = (_amzSiteCollectors[site] || {}).email || '';
  const who = prompt(`Collector for site ${site}\n\nEnter an @eastcoastfacilities.com address, or leave blank to clear.`, cur);
  if (who === null) return;
  const email = who.trim().toLowerCase();
  if (email && !email.endsWith('@eastcoastfacilities.com')) { alert('Must be an @eastcoastfacilities.com address.'); return; }
  try {
    await apiFetch('/api/amazon/site-collectors', { method: 'POST', body: JSON.stringify({ siteCode: site, collectorEmail: email || null }) });
    if (email) _amzSiteCollectors[site] = { email, assignedBy: 'you', assignedAt: new Date().toISOString() };
    else delete _amzSiteCollectors[site];
    amazonRender();
  } catch (e) { alert(e.message); }
}

// Assign every site currently in view at once — dividing 219 sites one at a
// time is not a workflow.
async function amazonAssignVisibleSites() {
  const sites = [...new Set(amzFiltered().map(r => r.site).filter(Boolean))];
  if (!sites.length) return;
  const who = prompt(`Assign a collector to all ${sites.length} site${sites.length === 1 ? '' : 's'} currently in view.\n\nEnter an @eastcoastfacilities.com address, or leave blank to clear them.`);
  if (who === null) return;
  const email = who.trim().toLowerCase();
  if (email && !email.endsWith('@eastcoastfacilities.com')) { alert('Must be an @eastcoastfacilities.com address.'); return; }
  if (!confirm(`${email ? 'Assign ' + email + ' to' : 'Clear the collector on'} ${sites.length} site${sites.length === 1 ? '' : 's'}?`)) return;
  try {
    await apiFetch('/api/amazon/site-collectors/bulk', { method: 'POST', body: JSON.stringify({ siteCodes: sites, collectorEmail: email || null }) });
    amazonLoad();
  } catch (e) { alert(e.message); }
}
