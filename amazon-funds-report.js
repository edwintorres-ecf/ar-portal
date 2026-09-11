'use strict';
// ─── amazon-funds-report.js ─────────────────────────────────────────────────
// Two deliverables from one analysis:
//   1. a workbook — summary sheet plus one sheet per business unit;
//   2. a short slide deck to present the finding to Amazon.
//
// The finding: work is invoiced against a specific PO at a specific site, so
// funds sitting on a DIFFERENT site's PO cannot pay for it. Across snow alone
// there is more available on POs than there is pending — the money is simply in
// the wrong places, and much of it in the same business unit as the shortfall
// (Edwin 2026-09-10).

const db = require('./db');
const poLedger = require('./po-ledger');
// Needed to reconcile this report back to total open Amazon AR by Payee Central
// status — the same source the portal's OPEN AMAZON AR tiles use.
const siteLedger = require('./site-ledger');
const payee = require('./payee');

const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const money2 = '$#,##0.00';

// A site is STARVED when it has real work waiting and nothing to bill it
// against; SURPLUS when it holds funds with no work waiting. The thresholds
// keep the story to material cases rather than rounding noise.
const STARVED_MIN_PENDING = 50000;
const SURPLUS_MIN_AVAILABLE = 100000;
const COVER_RATIO = 0.25;

// A snow season runs July to June. Counting a PO raised for NEXT season as
// "money sitting unused" would be flatly wrong — the work has not happened yet —
// and it is the first thing Amazon would catch. $10.9M of the available balance
// sat on 2026-27 POs (Edwin 2026-09-10).
const SEASONS = {
  '2025-26': { start: Date.parse('2025-07-01'), end: Date.parse('2026-07-01'), label: '2025\u201326 snow season' },
  '2026-27': { start: Date.parse('2026-07-01'), end: Date.parse('2027-07-01'), label: '2026\u201327 snow season' },
};

function poInSeason(r, season) {
  if (!season) return true;
  const t = Date.parse(String(r.orderDate || r.docDate || ''));
  // An undated PO is kept rather than dropped: excluding it would understate
  // the funds actually on hand, and undated POs are a handful.
  if (isNaN(t)) return true;
  return t >= season.start && t < season.end;
}

function analyse(invoices, { snowOnly = true, seasonKey = null } = {}) {
  const season = seasonKey ? SEASONS[seasonKey] : null;
  const sites = poLedger.getPendingBySite(invoices, { snowOnly });
  const ledger = poLedger.getPoLedger(invoices);
  let rows = snowOnly ? ledger.filter(r => r.serviceType === 'snow') : ledger;

  if (season) {
    // Re-derive each site's funds from THIS season's POs only. Pending is left
    // alone: every invoice waiting is for work already done this season.
    for (const s of sites) {
      const keep = (s.poRows || []).filter(r => poInSeason(r, season));
      s.available = keep.length ? keep.reduce((t, r) => t + (r.available || 0), 0) : 0;
      s.ceiling = keep.reduce((t, r) => t + (r.ceilingAmount || 0), 0);
      s.consumed = keep.reduce((t, r) => t + (r.consumed || 0), 0);
      s.poRows = keep.length ? keep : s.poRows;
    }
    rows = rows.filter(r => poInSeason(r, season));
  }

  const byBu = {};
  for (const s of sites) {
    const bu = s.businessUnit || '(not in the Amazon master)';
    const b = byBu[bu] = byBu[bu] || { bu, sites: [], pending: 0, available: 0, ceiling: 0, consumed: 0, invoices: 0 };
    b.sites.push(s);
    b.pending += s.pending || 0;
    b.available += s.available || 0;
    b.ceiling += s.ceiling || 0;
    b.consumed += s.consumed || 0;
    b.invoices += s.count || 0;
  }
  for (const b of Object.values(byBu)) {
    // ARITHMETIC: per-site shortfall and surplus, over EVERY site.
    // This was previously derived from the threshold-filtered "starved" list
    // and summed their whole PENDING rather than their SHORTFALL — so it both
    // overstated sites that had partial funding and dropped every site below
    // the threshold. NACF came out $780k light and GSF/R2L showed nothing at
    // all despite having real shortfalls (Edwin spotted it, 2026-09-10).
    b.shortfall = 0; b.surplus = 0; b.overdrawn = 0; b.overdrawnSites = [];
    for (const s of b.sites) {
      const p = s.pending || 0, av = s.available || 0;
      // Floor available at zero for the shortfall. A site already invoiced PAST
      // its PO has negative available, and counting that as extra "funding
      // needed for waiting work" pushed NACF's coverable figure ABOVE its work
      // waiting — which reads as an arithmetic error, because it is one. The
      // over-invoiced amount is a real problem but a different one, so it is
      // reported on its own line instead.
      b.shortfall += Math.max(0, p - Math.max(0, av));
      b.surplus += Math.max(0, av - p);
      // Negative available = already invoiced past the PO's value. Worth
      // naming separately; it is a different problem from an empty PO.
      if (av < 0) { b.overdrawn += av; b.overdrawnSites.push(s); }
    }
    b.coverable = Math.min(b.shortfall, b.surplus);

    // The threshold lists are for CHOOSING A CLEAR EXAMPLE to show, nothing
    // else. They must never feed a total.
    b.starved = b.sites.filter(s => (s.pending || 0) > STARVED_MIN_PENDING && (s.available || 0) < (s.pending || 0) * COVER_RATIO)
      .sort((x, y) => (y.pending || 0) - (x.pending || 0));
    b.surplusSites = b.sites.filter(s => (s.available || 0) > SURPLUS_MIN_AVAILABLE && (s.pending || 0) < (s.available || 0) * COVER_RATIO)
      .sort((x, y) => (y.available || 0) - (x.available || 0));
    b.sites.sort((x, y) => (y.pending || 0) - (x.pending || 0) || (y.available || 0) - (x.available || 0));
  }

  // POs Amazon has closed that still hold money. Nothing can ever be billed
  // against these, so the funds are simply gone unless a PO is reopened.
  const closedWithFunds = rows
    .filter(r => r.poStatus && r.poStatus !== 'OPEN_FOR_INVOICING' && (r.available || 0) > 500)
    .sort((a, b) => (b.available || 0) - (a.available || 0));
  const neverUsed = closedWithFunds.filter(r => (r.consumed || 0) === 0);

  const totals = {
    sites: sites.length,
    pending: sites.reduce((t, s) => t + (s.pending || 0), 0),
    available: sites.reduce((t, s) => t + (s.available || 0), 0),
    invoices: sites.reduce((t, s) => t + (s.count || 0), 0),
    shortSites: sites.filter(s => (s.pending || 0) > (s.available || 0)).length,
    shortfall: sites.reduce((t, s) => t + Math.max(0, (s.pending || 0) - Math.max(0, s.available || 0)), 0),
    coverable: Object.values(byBu).reduce((t, b) => t + b.coverable, 0),
    overdrawnSites: sites.filter(s => (s.available || 0) < 0).length,
    overdrawn: sites.reduce((t, s) => t + Math.min(0, s.available || 0), 0),
    closedCount: closedWithFunds.length,
    closedFunds: closedWithFunds.reduce((t, r) => t + (r.available || 0), 0),
    neverUsedCount: neverUsed.length,
    neverUsedFunds: neverUsed.reduce((t, r) => t + (r.available || 0), 0),
  };

  // What reallocation inside the business units genuinely cannot reach. This is
  // the number that has to be asked for, not glossed over.
  totals.gap = Math.max(0, totals.shortfall - totals.coverable);

  const buList = Object.values(byBu).sort((a, b) => b.pending - a.pending);

  // ── Reconciliation to total open Amazon AR ────────────────────────────────
  // This report is about the funding position of work we cannot bill. On its own
  // that is a slice of the book with no stated denominator, so there is no way
  // to check it against the AR the business actually carries (Edwin 2026-09-11).
  //
  // Start from every open Amazon invoice, show what the snow filter removes, and
  // break the remainder down by Payee Central status — the same statuses as the
  // portal's OPEN AMAZON AR tiles, so the two can be laid side by side.
  const recon = (() => {
    let allRows = [];
    try { allRows = siteLedger.buildAmazonRows(invoices, { payee }).filter(r => (r.amount || 0) > 0.005); }
    catch (e) { return null; }

    // Snow is a property of the PO, not the invoice. Same rule as everywhere else.
    const snowPos = new Set(ledger.filter(p => p.serviceType === 'snow').map(p => p.poNumber));
    const inScope = snowOnly ? allRows.filter(r => snowPos.has(r.po)) : allRows;
    const sum = (list) => Math.round(list.reduce((t, r) => t + (r.amount || 0), 0) * 100) / 100;

    const statusOf = (r) => r.amazonSettled ? 'Paid — needs applying' : (r.payeeStatus || 'Not submitted');
    const tally = (list) => {
      const out = {};
      for (const r of list) {
        const k = statusOf(r);
        (out[k] = out[k] || { status: k, count: 0, amount: 0 });
        out[k].count++; out[k].amount += r.amount || 0;
      }
      for (const v of Object.values(out)) v.amount = Math.round(v.amount * 100) / 100;
      return Object.values(out).sort((x, y) => y.amount - x.amount);
    };

    const byBuStatus = {};
    for (const r of inScope) {
      const bu = r.businessUnit || '(not in the Amazon master)';
      (byBuStatus[bu] = byBuStatus[bu] || []).push(r);
    }
    const perBu = {};
    for (const [bu, list] of Object.entries(byBuStatus)) {
      perBu[bu] = { total: sum(list), count: list.length, statuses: tally(list) };
    }

    return {
      allAr: sum(allRows), allCount: allRows.length,
      excluded: Math.round((sum(allRows) - sum(inScope)) * 100) / 100,
      excludedCount: allRows.length - inScope.length,
      inScope: sum(inScope), inScopeCount: inScope.length,
      statuses: tally(inScope),
      perBu,
      // "Work we cannot bill" here comes from getNeedsUpload, which counts a
      // REJECTED invoice as waiting — it has to go back in. The status split
      // lists Rejected separately, so the two differ by exactly that much and
      // the difference is stated rather than left to be discovered.
      reportPending: Math.round(totals.pending * 100) / 100,
      reportPendingCount: totals.invoices,
    };
  })();

  return { sites, buList, closedWithFunds, neverUsed, totals, recon, snowOnly, season, seasonKey };
}

// ─── Workbook ───────────────────────────────────────────────────────────────
async function buildWorkbook(invoices, opts = {}) {
  const a = analyse(invoices, opts);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ECF AR Portal';

  const NAVY = 'FF1E3A5F', GRAY = 'FFF1F5F9', RED = 'FFFEE2E2', GREEN = 'FFDCFCE7', AMBER = 'FFFEF3C7';
  const label = a.snowOnly ? 'Snow' : 'All services';
  const inv = (n) => n + (n === 1 ? ' invoice' : ' invoices');

  // ── Summary ──
  const s1 = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 3 }] });
  s1.mergeCells('A1:G1');
  s1.getCell('A1').value = `ECF — Amazon PO funds by site (${label}) — generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
  s1.getCell('A1').font = { bold: true, size: 13, color: { argb: NAVY } };
  s1.mergeCells('A2:G2');
  s1.getCell('A2').value = 'Every job is billed against one PO at one site. Money sitting on another site’s PO can’t pay for it, however much of it there is.';
  s1.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
  s1.addRow([]);

  const headline = [
    ['Sites we cleared', a.totals.sites],
    ['Invoices we are holding', a.totals.invoices],
    ['Work we have done but cannot bill', a.totals.pending],
    ['Money still on Amazon POs', a.totals.available],
    ['Sites where we have run out of PO', a.totals.shortSites],
    ['What those sites are short by', a.totals.shortfall],
    ['Already sitting unused in the SAME business unit', a.totals.coverable],
    ['Sites we have already billed past the PO', a.totals.overdrawnSites],
    ['How far past', Math.abs(a.totals.overdrawn)],
    ['POs closed with money still on them', a.totals.closedCount],
    ['Money stranded on those closed POs', a.totals.closedFunds],
  ];
  for (const [k, v] of headline) {
    const r = s1.addRow([k, v]);
    r.getCell(1).font = { size: 11 };
    r.getCell(2).font = { bold: true, size: 11, color: { argb: NAVY } };
    if (typeof v === 'number' && v > 1000) r.getCell(2).numFmt = money2;
  }
  s1.getColumn(1).width = 56; s1.getColumn(2).width = 20;
  s1.addRow([]);

  // ── Reconciliation to total open Amazon AR ──
  // Without a stated denominator the figures above are a slice of the book with
  // nothing to check them against.
  if (a.recon) {
    const R = a.recon;
    const hdr = s1.addRow(['RECONCILIATION TO TOTAL OPEN AMAZON AR']);
    hdr.getCell(1).font = { bold: true, size: 11, color: { argb: NAVY } };
    const line = (k, v, n, note, opts = {}) => {
      const r = s1.addRow([k, v, n == null ? '' : n, note || '']);
      r.getCell(1).font = { size: 10.5, bold: !!opts.bold, color: { argb: opts.bold ? NAVY : 'FF334155' } };
      r.getCell(2).numFmt = money2;
      r.getCell(2).font = { size: 10.5, bold: !!opts.bold, color: { argb: opts.bold ? NAVY : 'FF334155' } };
      r.getCell(3).font = { size: 9.5, color: { argb: 'FF64748B' } };
      r.getCell(3).alignment = { horizontal: 'right' };
      r.getCell(4).font = { size: 9, color: { argb: 'FF94A3B8' } };
      if (opts.rule) r.getCell(2).border = { top: { style: 'thin' } };
      if (opts.fill) { r.getCell(1).fill = r.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } }; }
      return r;
    };
    s1.getColumn(3).width = Math.max(s1.getColumn(3).width || 0, 14);
    s1.getColumn(4).width = Math.max(s1.getColumn(4).width || 0, 62);

    line('Total open Amazon AR (all services)', R.allAr, inv(R.allCount),
      'Every open Amazon invoice in Sage. Matches the portal’s OPEN AMAZON AR tiles with no filter.', { bold: true });
    if (a.snowOnly) {
      line('Less: work not on a snow PO', -R.excluded, '-' + inv(R.excludedCount),
        'Landscaping and other services. Excluded because this report covers snow only.');
      line('Open Amazon AR on snow POs — scope of this report', R.inScope, inv(R.inScopeCount),
        'Matches the portal with the snow filter on.', { bold: true, rule: true });
    }

    s1.addRow([]);
    const sh = s1.addRow(['Where that sits, by Payee Central status', '', '', '']);
    sh.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF475569' } };
    const NOTE = {
      'Scheduled for payment': 'Accepted and queued to pay — moving normally.',
      'In Progress': 'Accepted, not yet scheduled.',
      'Pending Goods Receipt Hold': 'Waiting on a goods receipt. No money required.',
      'Insufficient PO Funds Hold': 'The PO has run out. Needs funding.',
      'Rejected': 'Has to be corrected and resubmitted — counted as waiting below.',
      'Not submitted': 'Not yet in Payee Central. This is the work this report is about.',
      'Paid — needs applying': 'Amazon has paid it; the cash needs applying in Intacct.',
      'Cancelled': 'Cancelled.',
    };
    for (const st of R.statuses) {
      line('    ' + st.status, st.amount, inv(st.count), NOTE[st.status] || '',
        { fill: /Insufficient|Not submitted/.test(st.status) ? AMBER : null });
    }
    line('    Total', R.inScope, inv(R.inScopeCount), '', { bold: true, rule: true });

    s1.addRow([]);
    line('“Work we have done but cannot bill” in this report', R.reportPending, inv(R.reportPendingCount),
      'Not submitted plus Rejected: a rejected invoice still has to go back in, so both are work waiting to be billed.',
      { bold: true });
    s1.addRow([]);
  }

  s1.addRow(['Short by = what the waiting work still needs.   Spare = money at sites with no work waiting.   Could be freed = whichever is smaller, i.e. what this business unit could sort out from its own budget without asking for anything new.']);
  s1.lastRow.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF64748B' } };
  s1.addRow([]);
  const h = s1.addRow(['Business unit', 'Sites', 'Invoices held', 'Work we cannot bill', 'Money on POs', 'Short by', 'Spare in this BU', 'Could be freed']);
  h.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
  [22, 8, 16, 16, 18, 14, 14, 20].forEach((w, i) => { s1.getColumn(i + 1).width = Math.max(s1.getColumn(i + 1).width || 0, w); });
  for (const b of a.buList) {
    const r = s1.addRow([b.bu, b.sites.length, b.invoices, b.pending, b.available, b.shortfall, b.surplus, b.coverable]);
    [4, 5, 6, 7, 8].forEach(ci => { r.getCell(ci).numFmt = money2; });
    if (b.coverable > 0) r.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMBER } };
  }

  // ── One sheet per business unit ──
  for (const b of a.buList) {
    const name = String(b.bu).replace(/[\[\]:*?\/\\]/g, '-').slice(0, 31);
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.mergeCells('A1:H1');
    ws.getCell('A1').value = `${b.bu} — ${label}`;
    ws.getCell('A1').font = { bold: true, size: 12, color: { argb: NAVY } };
    ws.mergeCells('A2:H2');
    ws.getCell('A2').value = `${b.sites.length} sites · ${money(b.pending)} of finished work we cannot bill · ${money(b.available)} still on POs here`
      + (b.coverable > 0 ? ` · ${money(b.coverable)} of it could be sorted out from spare funds inside this business unit alone` : '');
    ws.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };
    ws.addRow([]);

    // Same reconciliation as the Summary, for this business unit alone, so a BU
    // sheet can be sent on its own and still tie to the AR the BU carries.
    const RB = a.recon && a.recon.perBu ? a.recon.perBu[b.bu] : null;
    if (RB) {
      const rh = ws.addRow([`Open Amazon AR for ${b.bu}${a.snowOnly ? ' on snow POs' : ''}`, '', '', RB.total, '', '', '', '', inv(RB.count)]);
      rh.getCell(1).font = { bold: true, size: 10.5, color: { argb: NAVY } };
      rh.getCell(4).numFmt = money2;
      rh.getCell(4).font = { bold: true, size: 10.5, color: { argb: NAVY } };
      rh.getCell(9).font = { size: 9, color: { argb: 'FF64748B' } };
      for (const st of RB.statuses) {
        const r = ws.addRow(['    ' + st.status, '', '', st.amount, '', '', '', '', inv(st.count)]);
        r.getCell(1).font = { size: 10, color: { argb: 'FF475569' } };
        r.getCell(4).numFmt = money2;
        r.getCell(4).font = { size: 10, color: { argb: 'FF475569' } };
        r.getCell(9).font = { size: 9, color: { argb: 'FF94A3B8' } };
        if (/Insufficient|Not submitted/.test(st.status)) {
          r.getCell(1).fill = r.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMBER } };
        }
      }
      const rt = ws.addRow([`    Of which waiting to be billed (this sheet)`, '', '', b.pending, '', '', '', '', inv(b.invoices)]);
      rt.getCell(1).font = { bold: true, size: 10, color: { argb: NAVY } };
      rt.getCell(4).numFmt = money2;
      rt.getCell(4).font = { bold: true, size: 10, color: { argb: NAVY } };
      rt.getCell(4).border = { top: { style: 'thin' } };
      rt.getCell(9).font = { size: 9, color: { argb: 'FF64748B' } };
      ws.addRow([]);
    }

    const hh = ws.addRow(['Site', 'City', 'State', 'Invoices held', 'Work we cannot bill', 'PO value', 'Billed so far', 'Left on the PO', 'Where it stands']);
    hh.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
    [10, 18, 7, 16, 16, 15, 15, 15, 26].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    const master = db.getAmazonLocationMap();
    for (const s of b.sites) {
      const m = master[s.site] || {};
      const starved = b.starved.includes(s), surplus = b.surplusSites.includes(s);
      const status = starved ? 'Needs funding — we did the work, the PO is empty'
        : surplus ? 'Spare money here, no work waiting'
        : (s.pending || 0) > (s.available || 0) ? 'A little short' : '';
      const r = ws.addRow([s.site, m.city || '', m.state || '', s.count || 0, s.pending || 0, s.ceiling || 0, s.consumed || 0, s.available || 0, status]);
      [5, 6, 7, 8].forEach(ci => { r.getCell(ci).numFmt = money2; });
      if (starved) { r.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } }; r.getCell(9).font = { bold: true, color: { argb: 'FF991B1B' } }; }
      if (surplus) { r.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } }; r.getCell(9).font = { bold: true, color: { argb: 'FF166534' } }; }
    }
    const tot = ws.addRow(['Total', '', '', b.invoices, b.pending, b.ceiling, b.consumed, b.available, '']);
    tot.eachCell(c => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
    [5, 6, 7, 8].forEach(ci => { tot.getCell(ci).numFmt = money2; });
  }

  // ── Sites invoiced past their PO ──
  const over = a.sites.filter(s => (s.available || 0) < 0).sort((x, y) => (x.available || 0) - (y.available || 0));
  if (over.length) {
    const os = wb.addWorksheet('Invoiced past the PO', { views: [{ state: 'frozen', ySplit: 3 }] });
    os.mergeCells('A1:E1');
    os.getCell('A1').value = 'Sites where we have already billed past the PO';
    os.getCell('A1').font = { bold: true, size: 12, color: { argb: NAVY } };
    os.mergeCells('A2:E2');
    os.getCell('A2').value = 'Different problem from an empty PO — these invoices are already with you, they just sit above what the PO was written for.';
    os.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };
    const oh = os.addRow(['Site', 'Business unit', 'PO value', 'Billed so far', 'Over by']);
    oh.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
    [10, 16, 16, 16, 16].forEach((w, i) => { os.getColumn(i + 1).width = w; });
    for (const s of over) {
      const r = os.addRow([s.site, s.businessUnit || '', s.ceiling || 0, s.consumed || 0, Math.abs(s.available || 0)]);
      [3, 4, 5].forEach(ci => { r.getCell(ci).numFmt = money2; });
      r.getCell(5).font = { bold: true, color: { argb: 'FF991B1B' } };
    }
  }

  // ── Closed POs still holding funds ──
  const ws = wb.addWorksheet('Closed POs with funds', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.mergeCells('A1:G1');
  ws.getCell('A1').value = 'POs that were closed with money still on them';
  ws.getCell('A1').font = { bold: true, size: 12, color: { argb: NAVY } };
  ws.mergeCells('A2:G2');
  ws.getCell('A2').value = 'Once a PO closes we cannot bill against it, so this money is out of reach unless it is reopened.';
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };
  const ch = ws.addRow(['PO', 'Site', 'Business unit', 'What it was for', 'What we billed', 'Left on it', 'Did we ever use it?']);
  ch.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
  [16, 9, 14, 15, 15, 16, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  for (const r0 of a.closedWithFunds) {
    const r = ws.addRow([r0.poNumber, r0.siteCode || '', r0.businessUnit || '', r0.ceilingAmount || 0, r0.consumed || 0, r0.available || 0,
      (r0.consumed || 0) === 0 ? 'Never used once' : 'Partly used']);
    [4, 5, 6].forEach(ci => { r.getCell(ci).numFmt = money2; });
    r.getCell(6).font = { bold: true, color: { argb: 'FF991B1B' } };
    if ((r0.consumed || 0) === 0) r.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } };
  }

  return { workbook: wb, analysis: a };
}

// ─── Slide deck ─────────────────────────────────────────────────────────────
// Five landscape pages, big type, one point each. Built with pdfkit, which is
// already a dependency (the ECI invoice generator uses it).
function buildDeck(analysis) {
  const PDFDocument = require('pdfkit');
  const a = analysis;
  // An explicit size array is ALREADY landscape — passing layout:'landscape'
  // on top of it makes pdfkit swap the axes back to portrait and clip
  // everything past 612pt (2026-09-10).
  const doc = new PDFDocument({ size: [792, 612], margin: 0 });
  const NAVY = '#1e3a5f', RED = '#b91c1c', GREEN = '#166534', GREY = '#64748b', AMBER = '#b45309';
  const W = 792, H = 612;

  const slide = (n, kicker, title) => {
    if (n > 1) doc.addPage({ size: [792, 612], margin: 0 });
    doc.rect(0, 0, W, 8).fill(NAVY);
    doc.fillColor(GREY).fontSize(10).font('Helvetica-Bold').text(String(kicker).toUpperCase(), 56, 44, { characterSpacing: 1.2 });
    doc.fillColor(NAVY).fontSize(26).font('Helvetica-Bold').text(title, 56, 62, { width: W - 112 });
    doc.fillColor('#94a3b8').fontSize(9).font('Helvetica').text(`East Coast Facilities · ${n} of 5`, 56, H - 38);
  };
  const stat = (x, y, value, caption, color) => {
    doc.fillColor(color || NAVY).fontSize(30).font('Helvetica-Bold').text(value, x, y, { width: 220 });
    doc.fillColor(GREY).fontSize(10).font('Helvetica').text(caption, x, y + 36, { width: 220 });
  };
  const bullet = (y, text, color) => {
    doc.circle(62, y + 6, 3).fill(color || NAVY);
    doc.fillColor('#1f2937').fontSize(13.5).font('Helvetica').text(text, 78, y, { width: W - 150, lineGap: 4 });
  };

  const svc = a.snowOnly ? 'snow removal' : 'all services';

  // 1 — the headline
  slide(1, 'Where we are', `We've done the work. We can't send you the bill.`);
  doc.fillColor(GREY).fontSize(12).font('Helvetica')
    .text(`Our crews have cleared ${a.totals.sites} of your sites this season. The work is finished and your teams have`
      + ` signed off on it. We still can't invoice ${money(a.totals.pending)} of it, because the purchase order at those`
      + ` sites has nothing left on it to bill against.`, 56, 118, { width: W - 112, lineGap: 3 });
  stat(56, 214, money(a.totals.pending), 'of finished work we cannot bill', RED);
  stat(300, 214, money(a.totals.shortfall), 'of that has no PO money behind it', RED);
  stat(544, 214, String(a.totals.shortSites), 'sites where we have run out of PO', AMBER);
  doc.roundedRect(56, 344, W - 112, 150, 8).fill('#f8fafc');
  doc.fillColor(NAVY).fontSize(17).font('Helvetica-Bold').text('The good news: you have already approved the money.', 80, 372);
  doc.fillColor('#1f2937').fontSize(13.5).font('Helvetica')
    // Deliberately a WITHIN-business-unit claim. Comparing a portfolio-wide
    // available balance against the shortfall would imply funds moving between
    // business units, which is not how they are committed (Edwin 2026-09-10).
    .text(`${a.totals.coverable >= a.totals.shortfall - 1 ? 'Every dollar of it' : money(a.totals.coverable) + ' of it'}`
      + ` is already sitting unused on purchase orders in the same business unit — at sites where we have no work waiting.`
      + ` Nothing new needs to be committed. It just needs to be where the work is.`, 80, 402, { width: W - 160, lineGap: 4 });

  // 2 — the mechanism, using the clearest real example
  const worstBu = a.buList
    .filter(b => b.coverable > 0 && b.starved.length && b.surplusSites.length)
    .sort((x, y) => y.coverable - x.coverable)[0];
  slide(2, 'How it happens', 'The money and the snow end up in different places');
  if (worstBu) {
    const st = worstBu.starved[0], su = worstBu.surplusSites.slice(0, 2);
    doc.fillColor(GREY).fontSize(12).font('Helvetica')
      .text(`Take ${worstBu.bu} on its own. Both sites below are ${worstBu.bu} — we are not comparing across`
        + ` business units anywhere in this deck.`, 56, 118, { width: W - 112 });
    doc.roundedRect(56, 156, 330, 210, 8).fill('#fef2f2');
    doc.fillColor(RED).fontSize(11).font('Helvetica-Bold').text('WE PLOWED IT. WE CAN\u2019T BILL IT.', 80, 180);
    doc.fillColor(NAVY).fontSize(28).font('Helvetica-Bold').text(st.site, 80, 204);
    doc.fillColor('#1f2937').fontSize(13.5).font('Helvetica')
      .text(`${money(st.pending)} of work already finished`, 80, 250)
      .text(`${money(st.available)} left on the PO`, 80, 276)
      .text(`${st.count} invoices sitting in a drawer`, 80, 302);
    doc.roundedRect(406, 156, 330, 210, 8).fill('#f0fdf4');
    doc.fillColor(GREEN).fontSize(11).font('Helvetica-Bold').text('MONEY WAITING, NOTHING TO SPEND IT ON', 430, 180);
    let yy = 206;
    for (const s of su) {
      doc.fillColor(NAVY).fontSize(24).font('Helvetica-Bold').text(s.site, 430, yy);
      doc.fillColor('#1f2937').fontSize(13).font('Helvetica').text(`${money(s.available)} still on the PO, no work waiting`, 430, yy + 30);
      yy += 74;
    }
    doc.fillColor('#1f2937').fontSize(13.5).font('Helvetica')
      .text(`Same business unit, same budget, same winter. The money was committed where the snow didn't fall as hard,`
        + ` and the sites that got hit can't be billed. ${worstBu.bu} is holding ${money(worstBu.surplus)} it hasn't used,`
        + ` against ${money(worstBu.shortfall)} of work we can't invoice.`, 56, 396, { width: W - 112, lineGap: 4 });
    doc.fillColor(AMBER).fontSize(14).font('Helvetica-Bold')
      .text(`It looks like this in every business unit. The next page shows each one against its own budget.`, 56, 462, { width: W - 112, lineGap: 4 });
  }

  // 3 — scale, by business unit
  slide(3, 'The whole picture', 'Every business unit already has the money it needs');
  let y = 150;
  doc.fillColor(GREY).fontSize(12).font('Helvetica')
    .text('Each row stands on its own budget. We are not asking any business unit to fund another.', 56, 118, { width: W - 112 });
  doc.fillColor(GREY).fontSize(9.5).font('Helvetica-Bold');
  doc.text('BUSINESS UNIT', 56, y); doc.text('SITES', 214, y); doc.text('WORK WE\u2019VE DONE', 268, y, { width: 118, align: 'right' });
  doc.text('CAN\u2019T BILL YET', 400, y, { width: 112, align: 'right' });
  doc.text('UNUSED, SAME BU', 524, y, { width: 118, align: 'right' }); doc.text('COULD BE FREED', 654, y, { width: 96, align: 'right' });
  y += 18;
  doc.moveTo(56, y).lineTo(W - 56, y).lineWidth(0.8).stroke('#cbd5e1');
  y += 10;
  for (const b of a.buList.filter(x => x.pending > 0 || x.available > 0).slice(0, 8)) {
    doc.fillColor(NAVY).fontSize(11.5).font('Helvetica-Bold').text(b.bu, 56, y, { width: 156 });
    doc.fillColor('#1f2937').fontSize(11.5).font('Helvetica').text(String(b.sites.length), 214, y);
    doc.text(money(b.pending), 268, y, { width: 118, align: 'right' });
    doc.fillColor(b.shortfall > 0 ? RED : '#94a3b8').text(b.shortfall > 0 ? money(b.shortfall) : '—', 400, y, { width: 112, align: 'right' });
    doc.fillColor(GREEN).text(money(b.surplus), 524, y, { width: 118, align: 'right' });
    doc.fillColor(b.coverable > 0 ? AMBER : '#94a3b8').font(b.coverable > 0 ? 'Helvetica-Bold' : 'Helvetica')
      .text(b.coverable > 0 ? money(b.coverable) : '—', 654, y, { width: 96, align: 'right' });
    y += 32;
  }
  doc.moveTo(56, y + 4).lineTo(W - 56, y + 4).lineWidth(0.8).stroke('#cbd5e1');
  doc.fillColor(NAVY).fontSize(13).font('Helvetica-Bold').text('Total', 56, y + 18);
  doc.text(money(a.totals.pending), 268, y + 18, { width: 118, align: 'right' });
  doc.fillColor(RED).text(money(a.totals.shortfall), 400, y + 18, { width: 112, align: 'right' });
  doc.fillColor(GREEN).text(money(a.buList.reduce((t, b) => t + b.surplus, 0)), 524, y + 18, { width: 118, align: 'right' });
  doc.fillColor(AMBER).text(money(a.totals.coverable), 654, y + 18, { width: 96, align: 'right' });
  doc.fillColor(GREY).fontSize(10).font('Helvetica')
    .text('\u201cCould be freed\u201d is whichever is smaller: what a business unit can\u2019t bill, or what it has spare.'
      + ' Nothing here assumes money moving between business units.', 56, y + 48, { width: W - 112, lineGap: 3 });

  // 4 — closed POs
  slide(4, 'One more thing worth fixing', 'Some POs get closed with money still on them');
  doc.fillColor(GREY).fontSize(12).font('Helvetica')
    .text(`Once a purchase order is closed, we can\u2019t bill against it at all. ${a.totals.closedCount} have been closed`
      + ` with ${money(a.totals.closedFunds)} still on them`
      + (a.totals.neverUsedCount ? `, and ${a.totals.neverUsedCount} of those were never used for a single invoice.` : '.')
      + ` It\u2019s a smaller number than the rest of this deck, but it\u2019s the easiest one to stop happening.`, 56, 118, { width: W - 112, lineGap: 3 });
  y = 196;
  doc.fillColor(GREY).fontSize(9.5).font('Helvetica-Bold');
  doc.text('PURCHASE ORDER', 56, y); doc.text('SITE', 196, y); doc.text('BUSINESS UNIT', 258, y);
  doc.text('WHAT IT WAS FOR', 380, y, { width: 110, align: 'right' });
  doc.text('WHAT WE BILLED', 500, y, { width: 110, align: 'right' }); doc.text('LEFT ON IT', 620, y, { width: 116, align: 'right' });
  y += 18;
  doc.moveTo(56, y).lineTo(W - 56, y).lineWidth(0.8).stroke('#cbd5e1');
  y += 10;
  for (const r of a.closedWithFunds.slice(0, 8)) {
    doc.fillColor(NAVY).fontSize(11.5).font('Helvetica-Bold').text(r.poNumber, 56, y);
    doc.fillColor('#1f2937').fontSize(11.5).font('Helvetica').text(r.siteCode || '—', 196, y);
    doc.fillColor(GREY).text(r.businessUnit || '—', 258, y, { width: 116 });
    doc.fillColor('#1f2937').text(money(r.ceilingAmount), 380, y, { width: 110, align: 'right' });
    doc.fillColor((r.consumed || 0) === 0 ? RED : '#1f2937').text((r.consumed || 0) === 0 ? 'nothing at all' : money(r.consumed), 500, y, { width: 110, align: 'right' });
    doc.fillColor(RED).font('Helvetica-Bold').text(money(r.available), 620, y, { width: 116, align: 'right' });
    y += 32;
  }

  // 5 — the ask
  slide(5, 'What we\u2019re asking', 'Three things, and we can close the season out clean');
  bullet(155, `Move the money to where the snow was. ${money(a.totals.coverable)} of what we can\u2019t bill is already sitting`
    + ` unused in the same business unit. You don\u2019t need to approve anything new — it just needs to be on the right PO.`, RED);
  bullet(245, `Top up the sites that have nothing left. These are the ones our invoices sit on longest, and they\u2019re the`
    + ` sites where our crews were out the most.`, AMBER);
  bullet(325, `Give us a heads-up before a PO is closed. ${money(a.totals.closedFunds)} is stranded on POs we can no longer`
    + ` bill against`
    + (a.totals.neverUsedCount ? `, including ${a.totals.neverUsedCount} that were never used once.` : '.')
    + ` A quick check with us first would catch these.`, NAVY);
  doc.roundedRect(56, 410, W - 112, 130, 8).fill('#f8fafc');
  doc.fillColor(NAVY).fontSize(17).font('Helvetica-Bold').text('What that gets us both', 80, 438);
  doc.fillColor('#1f2937').fontSize(13.5).font('Helvetica')
    .text(`${a.totals.invoices} invoices, ${money(a.totals.pending)} of ${svc} work your sites have already had the benefit of,`
      + ` billed and paid on normal terms — and a clean start on next season.`, 80, 468, { width: W - 160, lineGap: 4 });

  doc.end();
  return doc;
}

module.exports = { analyse, buildWorkbook, buildDeck };
