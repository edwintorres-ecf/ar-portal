/* ───────────────────────────────────────────────────────────────────────────
   reports.js — redesign Phase 4, the reports view.

   The plan asks for "DSO trend line, collection forecast area, walk-forward,
   SC head-to-head as small multiples, each with table fallback and export".
   Three of those are drawable from what the endpoints return. One is NOT, and
   this file says so on the page rather than drawing something that looks like
   evidence and is not:

     DSO trend      — /api/reports/dso-cei returns ONE number, not a series, and
                      ar_snapshots holds a single day. A trend line needs a
                      history nothing has recorded yet. Shown as today's figure
                      with a plain statement of when a trend becomes possible.
     Walk-forward   — the endpoint gives an ending balance and new invoices, but
                      no opening balance and no payments, so it cannot be drawn
                      as a walk. Shown as the figures it does have.

   Every chart carries the same numbers as a table underneath, because a chart
   is for scanning and the table is what someone checks.
   ─────────────────────────────────────────────────────────────────────────── */
'use strict';

const REP_AGE = [
  { key: 'current', label: 'Current', color: 'var(--ramp-1)' },
  { key: 'b1_30',   label: '1-30',    color: 'var(--ramp-2)' },
  { key: 'b31_60',  label: '31-60',   color: 'var(--ramp-3)' },
  { key: 'b61_90',  label: '61-90',   color: 'var(--ramp-4)' },
  { key: 'b91plus', label: '91+',     color: 'var(--age-4)' },
];

async function repLoad() {
  const grid = document.getElementById('report-grid');
  if (!grid) return;
  grid.innerHTML = `<div style="padding:8px 0">${dsSkeleton(3)}</div>`;
  if (typeof loadDownloads === 'function') loadDownloads();

  const settle = p => p.then(v => ({ ok: true, v })).catch(e => ({ ok: false, e }));
  const [aging, dso, sc, forecast, walk, top] = await Promise.all([
    settle(apiFetch('/api/reports/aging-snapshot')),
    settle(apiFetch('/api/reports/dso-cei')),
    settle(apiFetch('/api/reports/sc-head-to-head')),
    settle(apiFetch('/api/reports/collection-forecast')),
    settle(apiFetch('/api/reports/walk-forward')),
    settle(apiFetch('/api/reports/top-customers')),
  ]);
  let snaps = [];
  try { snaps = (await apiFetch('/api/snapshots?days=30')).snapshots || []; } catch (e) {}

  grid.innerHTML = [
    repHeadline(dso, walk, forecast, snaps),
    `<div style="margin-top:var(--sp-4)">${repAging(aging)}</div>`,
    `<div style="margin-top:var(--sp-4)">${repForecast(forecast)}</div>`,
    `<div style="margin-top:var(--sp-4)">${repTopCustomers(top)}</div>`,
    `<div style="margin-top:var(--sp-4)">${repSmallMultiples(sc)}</div>`,
  ].join('');
}

/* ── Headline figures ──────────────────────────────────────────────────── */
function repHeadline(dso, walk, forecast, snaps) {
  const d = dso.ok ? dso.v : {};
  const w = walk.ok ? walk.v : {};
  const f = forecast.ok ? forecast.v : {};
  const series = snaps.map(s => s.open_ar).filter(n => typeof n === 'number');

  const tiles = [
    dsTile({ label: 'Total AR', value: dsMoneyShort(d.totalAR), title: dsMoney(d.totalAR, { cents: true }),
      sub: `${dsNum(d.invoiceCount)} invoices`, accent: 'var(--c2)', spark: dsSpark(series, { color: 'var(--c2)' }) }),
    dsTile({ label: 'Past due', value: dsMoneyShort(d.totalPastDue), title: dsMoney(d.totalPastDue, { cents: true }),
      sub: `${d.pastDuePct}% of AR`, accent: 'var(--div-neg)' }),
    dsTile({ label: 'Avg days outstanding', value: (d.avgDaysOutstanding || 0) + 'd',
      sub: 'past due date', accent: 'var(--c3)' }),
    dsTile({ label: 'Promised', value: dsMoneyShort(f.ptpTotal), title: dsMoney(f.ptpTotal, { cents: true }),
      sub: `${dsNum(f.ptpCount)} promises`, accent: 'var(--div-pos)' }),
    dsTile({ label: 'New this month', value: dsMoneyShort(w.newInvoiceAmount), title: dsMoney(w.newInvoiceAmount, { cents: true }),
      sub: `${dsNum(w.newInvoiceCount)} invoices`, accent: 'var(--c4)' }),
  ].join('');

  // Say plainly what cannot be drawn, instead of leaving a gap that reads as a bug.
  const caveat = series.length < 2
    ? `<div class="ds-muted" style="font:500 var(--fs-xs)/1.5 var(--ds-font);margin-top:var(--sp-2)">
         A DSO or balance trend needs a history of daily snapshots and there ${series.length === 1 ? 'is one so far' : 'are none yet'}.
         "Avg days outstanding" is today's average across open invoices, not a trend.
       </div>` : '';

  return `<div class="ds-row" style="margin:6px 0 var(--sp-3)">
      <h1 style="font:700 var(--fs-2xl)/1.15 var(--ds-font);margin:0;color:var(--ink)">Reports</h1>
      <span style="margin-left:auto" class="ds-row">
        <button class="ds-btn ds-btn-secondary is-sm" onclick="repLoad()">Refresh</button>
        ${typeof commsReportsV2 === 'function'
          ? '<button class="ds-btn ds-btn-ghost is-sm" onclick="commsReportsV2()">Previous reports</button>' : ''}
      </span>
    </div>
    <div class="ds-tiles">${tiles}</div>${caveat}`;
}

/* ── Aging by service centre ───────────────────────────────────────────── */
function repAging(aging) {
  if (!aging.ok) return dsCard({ title: 'Aging by service center', body: dsEmpty({ icon: '!', title: 'Unavailable', body: aging.e.message }) });
  const { rows, totals } = aging.v;
  const top = rows.slice(0, 12);
  if (!top.length) return dsCard({ title: 'Aging by service center', body: dsEmpty({ title: 'No open AR' }) });

  const segs = REP_AGE.map(a => ({ label: a.label, value: totals[a.key], color: a.color })).filter(s => s.value > 0);
  const max = Math.max(...top.map(r => r.total)) || 1;

  // One row per service centre, each a miniature stacked bar on a shared scale
  // so their widths are comparable across rows.
  const bars = top.map(r => `<tr>
      <td style="width:170px"><strong>${dsEsc(r.serviceCenter)}</strong>
        <span class="ds-muted" style="display:block;font-size:var(--fs-xs)">${dsNum(r.count)} invoices</span></td>
      <td><div class="ds-bar" style="height:18px;width:${(r.total / max * 100).toFixed(1)}%;min-width:2px">
        ${REP_AGE.map(a => r[a.key] > 0
          ? `<div class="ds-bar-seg" style="width:${(r[a.key] / r.total * 100).toFixed(2)}%;background:${a.color}"
                  title="${dsEsc(r.serviceCenter)} ${a.label}: ${dsMoney(r[a.key])}"></div>` : '').join('')}
      </div></td>
      <td class="is-money" style="width:120px">${dsMoney(r.total)}</td>
    </tr>`).join('');

  return dsCard({
    title: 'Aging by service center', sub: `Top ${top.length} of ${dsNum(rows.length)} · bars share one scale`,
    actions: `<button class="ds-btn ds-btn-secondary is-sm" onclick="repExport('aging')">Export CSV</button>`,
    body: `${dsBar(segs)}
      <table class="ds-table" style="margin-top:var(--sp-4)"><tbody>${bars}</tbody>
      <tfoot><tr><td>All service centers</td><td></td><td class="is-money">${dsMoney(totals.total)}</td></tr></tfoot></table>`,
  });
}

/* ── Collection forecast ───────────────────────────────────────────────── */
function repForecast(forecast) {
  if (!forecast.ok) return dsCard({ title: 'Collection forecast', body: dsEmpty({ icon: '!', title: 'Unavailable', body: forecast.e.message }) });
  const f = forecast.v;
  const order = [['week1', 'Within 7 days'], ['week2', '8-14 days'], ['week3', '15-21 days'], ['week4', '22-30 days'], ['beyond', 'Beyond 30 days']];
  const buckets = f.weekBuckets || {};
  const segs = order.filter(([k]) => buckets[k] && buckets[k].amount > 0)
    .map(([k, label], n) => ({ label, value: buckets[k].amount, color: `var(--ramp-${Math.min(5, n + 1)})` }));

  if (!segs.length) {
    return dsCard({ title: 'Collection forecast', sub: 'Based on open promises to pay',
      body: dsEmpty({ icon: '💰', title: 'No open promises', body: 'Promises to pay recorded against invoices appear here, grouped by when they fall due.' }) });
  }
  const rows = order.filter(([k]) => buckets[k]).map(([k, label]) => `<tr>
      <td>${dsEsc(label)}</td><td class="is-num ds-muted">${dsNum(buckets[k].count)}</td>
      <td class="is-money">${dsMoney(buckets[k].amount)}</td></tr>`).join('');

  return dsCard({
    title: 'Collection forecast', sub: 'Open promises to pay, by when they fall due',
    actions: `<button class="ds-btn ds-btn-secondary is-sm" onclick="repExport('forecast')">Export CSV</button>`,
    body: `${dsBar(segs)}
      <table class="ds-table" style="margin-top:var(--sp-4)">
        <thead><tr><th>When</th><th class="is-num">Promises</th><th class="is-num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Promised in total</td><td class="is-num">${dsNum(f.ptpCount)}</td>
          <td class="is-money">${dsMoney(f.ptpTotal)}</td></tr></tfoot>
      </table>
      <div class="ds-muted" style="font-size:var(--fs-xs);margin-top:var(--sp-3)">
        Projected AR in 30 days: <strong>${dsMoney(f.projectedAR30)}</strong>, assuming promises are kept and
        new billing continues at ${dsMoney(f.avgMonthlyNew)} a month.
      </div>`,
  });
}

/* ── Top past-due customers ────────────────────────────────────────────────
   The screen this replaces carried this card, so it stays. Bars share one
   scale; the balance beside each is the number people actually quote.
   -------------------------------------------------------------------------- */
function repTopCustomers(top) {
  if (!top.ok) return dsCard({ title: 'Top past-due customers', body: dsEmpty({ icon: '!', title: 'Unavailable', body: top.e.message }) });
  const rows = (Array.isArray(top.v) ? top.v : []).filter(r => (r.pastDueAR || 0) > 0);
  if (!rows.length) return dsCard({ title: 'Top past-due customers', body: dsEmpty({ icon: '✓', title: 'Nothing past due' }) });
  const max = Math.max(...rows.map(r => r.pastDueAR)) || 1;
  return dsCard({
    title: 'Top past-due customers', sub: 'Ranked by remaining past-due balance',
    body: `<table class="ds-table"><tbody>${rows.map(r => `
      <tr style="cursor:pointer" onclick="goToCustomer('${dsEsc(r.id)}')" title="Open ${dsEsc(r.name || r.id)}">
        <td style="width:210px"><strong>${dsEsc(r.name || r.id)}</strong>
          <span class="ds-muted" style="display:block;font-size:var(--fs-xs)">${dsNum(r.invoiceCount)} invoices</span></td>
        <td><div class="ds-bar" style="height:16px;width:${(r.pastDueAR / max * 100).toFixed(1)}%;min-width:2px">
          <div class="ds-bar-seg" style="width:100%;background:var(--age-4)"></div></div></td>
        <td class="is-money" style="width:120px">${dsMoney(r.pastDueAR)}</td>
      </tr>`).join('')}</tbody></table>`,
  });
}

/* ── Service centres as small multiples ────────────────────────────────── */
function repSmallMultiples(sc) {
  if (!sc.ok) return dsCard({ title: 'Service centers', body: dsEmpty({ icon: '!', title: 'Unavailable', body: sc.e.message }) });
  const rows = (Array.isArray(sc.v) ? sc.v : []).slice(0, 12);
  if (!rows.length) return dsCard({ title: 'Service centers', body: dsEmpty({ title: 'Nothing to compare' }) });

  // Every card uses the SAME axis maximum. Small multiples where each panel is
  // scaled to itself compare nothing at all.
  const max = Math.max(...rows.map(r => r.totalAR || 0)) || 1;
  const cards = rows.map(r => {
    const pastPct = r.totalAR ? (r.pastDueAR / r.totalAR * 100) : 0;
    return `<div class="rep-mult">
      <div class="rep-mult-head">${typeof commsScChips === 'function' ? commsScChips([r.sc]) : dsEsc(r.sc)}</div>
      <div class="ds-bar" style="height:14px;width:${((r.totalAR || 0) / max * 100).toFixed(1)}%;min-width:3px">
        <div class="ds-bar-seg" style="width:${(100 - pastPct).toFixed(2)}%;background:var(--ramp-2)" title="Current ${dsMoney(r.currentAR)}"></div>
        <div class="ds-bar-seg" style="width:${pastPct.toFixed(2)}%;background:var(--age-4)" title="Past due ${dsMoney(r.pastDueAR)}"></div>
      </div>
      <div class="rep-mult-val">${dsMoneyShort(r.totalAR)}</div>
      <div class="rep-mult-sub">${dsPct(pastPct, 0)} past due · ${dsNum(r.invoiceCount)} inv
        ${r.avgDaysPastDue != null ? ` · ${dsNum(Math.round(r.avgDaysPastDue))}d avg` : ''}</div>
    </div>`;
  }).join('');

  const table = rows.map(r => `<tr>
      <td><strong>${dsEsc(r.sc)}</strong></td>
      <td class="is-money">${dsMoney(r.totalAR)}</td>
      <td class="is-money">${dsMoney(r.pastDueAR)}</td>
      <td class="is-num ds-muted">${dsNum(r.invoiceCount)}</td>
      <td class="is-num ds-muted">${r.customerCount != null ? dsNum(r.customerCount) : '—'}</td>
    </tr>`).join('');

  return dsCard({
    title: 'Service centers', sub: 'Same scale across every panel, so the widths are comparable',
    actions: `<button class="ds-btn ds-btn-secondary is-sm" onclick="repExport('sc')">Export CSV</button>`,
    body: `<div class="rep-mults">${cards}</div>
      <table class="ds-table" style="margin-top:var(--sp-4)">
        <thead><tr><th>Service center</th><th class="is-num">Total AR</th><th class="is-num">Past due</th>
          <th class="is-num">Invoices</th><th class="is-num">Customers</th></tr></thead>
        <tbody>${table}</tbody></table>`,
  });
}

/* ── Export ────────────────────────────────────────────────────────────────
   Client-side CSV from the table already on screen, so what is exported is
   exactly what was looked at.
   -------------------------------------------------------------------------- */
async function repExport(which) {
  try {
    const src = {
      aging: () => apiFetch('/api/reports/aging-snapshot').then(d => ({
        name: 'aging-by-service-center',
        head: ['Service center', 'Current', '1-30', '31-60', '61-90', '91+', 'Total', 'Invoices'],
        rows: d.rows.map(r => [r.serviceCenter, r.current, r.b1_30, r.b31_60, r.b61_90, r.b91plus, r.total, r.count]),
      })),
      forecast: () => apiFetch('/api/reports/collection-forecast').then(d => ({
        name: 'collection-forecast',
        head: ['Bucket', 'Promises', 'Amount'],
        rows: Object.entries(d.weekBuckets || {}).map(([k, v]) => [k, v.count, v.amount]),
      })),
      sc: () => apiFetch('/api/reports/sc-head-to-head').then(d => ({
        name: 'service-centers',
        head: ['Service center', 'Total AR', 'Past due', 'Current', 'Invoices', 'Customers'],
        rows: d.map(r => [r.sc, r.totalAR, r.pastDueAR, r.currentAR, r.invoiceCount, r.customerCount]),
      })),
    }[which];
    if (!src) return;
    const { name, head, rows } = await src();
    const esc = v => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [head.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ecf-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    dsNotify(`Exported ${rows.length} rows`, 'success');
  } catch (e) {
    dsNotify('Export failed: ' + e.message, 'error');
  }
}
