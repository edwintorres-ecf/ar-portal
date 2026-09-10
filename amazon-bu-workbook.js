'use strict';
// ─── amazon-bu-workbook.js — one workbook per Amazon business unit ──────────
// Three sheets, to Edwin's spec (2026-09-10):
//   1. Summary      — stalled billing split by WHY, against the funds available
//   2. Detail by PO — PO > invoice > invoice detail
//   3. Detail by site code — site > PO > invoice > invoice detail
//
// "Stalled billing" is everything we cannot turn into cash, in three kinds:
//   - Pending Goods Receipt Hold : submitted, Amazon has not booked the receipt
//   - Insufficient PO Funds Hold : submitted, the PO cannot cover it
//   - Cannot be delivered        : never submitted, because there is no PO or
//                                  no funds on it to submit against
// The third is not a Payee Central status — it is the work that never got as
// far as Payee Central at all, and it is usually the biggest of the three.

const db = require('./db');
const poLedger = require('./po-ledger');
const siteLedger = require('./site-ledger');
const payee = require('./payee');

const HOLD_PGR = 'Pending Goods Receipt Hold';
const HOLD_FUNDS = 'Insufficient PO Funds Hold';
const HOLD_FUNDS_ALT = 'Insufficient Amazon PO Manager Hold';

const EXPLAIN = {
  pgr: 'Submitted to Payee Central, but Amazon has not recorded a goods receipt against the PO. '
     + 'Nothing moves until the site confirms the work was received.',
  funds: 'Submitted to Payee Central and rejected for funding: the purchase order does not have '
       + 'enough left on it to cover the invoice.',
  undeliverable: 'Never submitted. Either no purchase order covers the work, or the PO it belongs to '
       + 'has nothing left on it, so the invoice cannot be raised in Payee Central at all.',
};

// A snow season runs July to June; a PO raised for next season is not spare
// money for this one.
function seasonWindow(key) {
  if (!key) return null;
  const [a] = String(key).split('-');
  const y = parseInt(a, 10);
  if (!y) return null;
  return { start: Date.parse(`${y}-07-01`), end: Date.parse(`${y + 1}-07-01`) };
}
function poInSeason(r, win) {
  if (!win) return true;
  const t = Date.parse(String(r.orderDate || r.docDate || ''));
  if (isNaN(t)) return true;          // undated: keep rather than understate
  return t >= win.start && t < win.end;
}

function analyseBu(invoices, { bu, seasonKey = null, snowOnly = false } = {}) {
  const win = seasonWindow(seasonKey);
  const all = siteLedger.buildAmazonRows(invoices, { payee });
  const rows = all.filter(r => (r.businessUnit || '') === bu);

  let ledger = poLedger.getPoLedger(invoices).filter(r => (r.businessUnit || '') === bu);
  if (snowOnly) ledger = ledger.filter(r => r.serviceType === 'snow');
  const seasonPos = ledger.filter(r => poInSeason(r, win));

  const isFundsHold = (st) => st === HOLD_FUNDS || st === HOLD_FUNDS_ALT;
  const buckets = {
    pgr: rows.filter(r => r.payeeStatus === HOLD_PGR),
    funds: rows.filter(r => isFundsHold(r.payeeStatus)),
    // Not in the feed at all, and still owed to us.
    undeliverable: rows.filter(r => !r.payeeStatus && (r.amount || 0) > 0.005),
  };
  const sum = (list) => Math.round(list.reduce((t, r) => t + (r.amount || 0), 0) * 100) / 100;

  const stalled = {
    pgr: { count: buckets.pgr.length, amount: sum(buckets.pgr), explain: EXPLAIN.pgr },
    funds: { count: buckets.funds.length, amount: sum(buckets.funds), explain: EXPLAIN.funds },
    undeliverable: { count: buckets.undeliverable.length, amount: sum(buckets.undeliverable), explain: EXPLAIN.undeliverable },
  };
  stalled.total = {
    count: stalled.pgr.count + stalled.funds.count + stalled.undeliverable.count,
    amount: Math.round((stalled.pgr.amount + stalled.funds.amount + stalled.undeliverable.amount) * 100) / 100,
  };

  // ── Consolidate by SITE ────────────────────────────────────────────────
  // Funds have to be read per site, not per PO: a site commonly has several POs,
  // one nearly exhausted and another barely touched, and looking at them
  // individually says nothing about whether that site can pay its own bills
  // (Edwin 2026-09-10). Every PO at the site is summed first, then compared with
  // what is stalled there.
  const stalledRows = [...buckets.pgr, ...buckets.funds, ...buckets.undeliverable];
  const bySite = {};
  const touchSite = (code) => (bySite[code] = bySite[code] || {
    site: code, stalled: 0, invoices: 0, available: 0, poCount: 0, pos: [],
    nextSeason: 0, nextSeasonPos: 0,
  });
  for (const r of stalledRows) {
    const s = touchSite(r.site || '(no site)');
    s.stalled += r.amount || 0; s.invoices++;
  }
  for (const p of seasonPos) {
    const s = touchSite(p.siteCode || '(no site)');
    // Raw available, NOT floored per PO: an overdrawn PO genuinely reduces what
    // the site has to work with, and flooring it would overstate the site.
    s.available += (p.available || 0);
    s.poCount++;
    s.pos.push(p);
  }
  // Funds on NEXT season's POs, tracked separately and shown, never counted.
  // The portal's Pending by Site screen counts every PO, so ORH3 reads $909,369
  // there and $642,205 here — one $288,333 PO raised in July 2026. Showing the
  // excluded figure is what makes the two views reconcilable (Edwin 2026-09-10).
  if (win) {
    for (const p of ledger) {
      if (poInSeason(p, win)) continue;
      const s = touchSite(p.siteCode || '(no site)');
      s.nextSeason += (p.available || 0);
      s.nextSeasonPos++;
    }
  }
  for (const s of Object.values(bySite)) {
    s.available = Math.round(s.available * 100) / 100;
    s.nextSeason = Math.round(s.nextSeason * 100) / 100;
    s.stalled = Math.round(s.stalled * 100) / 100;
    s.spare = Math.max(0, s.available - s.stalled);
    s.short = Math.max(0, s.stalled - Math.max(0, s.available));
    s.pos.sort((x, y) => (y.available || 0) - (x.available || 0));
  }
  const siteList = Object.values(bySite).sort((x, y) => (y.stalled - y.available) - (x.stalled - x.available));

  // Excess for the BU is the sum of what its SITES have spare, once each site's
  // own stalled billing is met from its own POs.
  const excess = Math.round(siteList.reduce((t, s) => t + s.spare, 0) * 100) / 100;
  const nextSeasonTotal = Math.round(siteList.reduce((t, s) => t + s.nextSeason, 0) * 100) / 100;
  const excessSites = siteList.filter(s => s.spare > 0).sort((x, y) => y.spare - x.spare);
  const shortSites = siteList.filter(s => s.short > 0).sort((x, y) => y.short - x.short);
  const totalShort = Math.round(shortSites.reduce((t, s) => t + s.short, 0) * 100) / 100;

  // What moving money inside the BU can actually reach, and what it cannot.
  const coverable = Math.round(Math.min(excess, totalShort) * 100) / 100;
  const variance = Math.round(Math.max(0, totalShort - excess) * 100) / 100;

  return {
    bu, seasonKey, snowOnly,
    rows, buckets, stalled, stalledRows,
    bySite, siteList, excessSites, shortSites,
    excess, totalShort, coverable, variance, nextSeasonTotal,
    ledger, seasonPos,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Workbook ───────────────────────────────────────────────────────────────
async function buildBuWorkbook(invoices, opts) {
  const a = analyseBu(invoices, opts);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ECF AR Portal';

  const NAVY = 'FF1E3A5F', GRAY = 'FFF1F5F9', RED = 'FFFEE2E2', GREEN = 'FFDCFCE7', AMBER = 'FFFEF3C7';
  const money = '$#,##0.00';
  const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
  const seasonLabel = a.seasonKey ? ` — ${a.seasonKey.replace('-', '–')} season` : '';

  // ── Sheet 1: Summary ──
  const s1 = wb.addWorksheet('Summary');
  s1.getColumn(1).width = 4;
  s1.getColumn(2).width = 46;
  s1.getColumn(3).width = 18;
  s1.getColumn(4).width = 12;
  s1.getColumn(5).width = 26;
  s1.getColumn(6).width = 30;
  s1.getColumn(7).width = 78;

  const title = s1.addRow(['', a.bu]);
  title.getCell(2).font = { bold: true, size: 20, color: { argb: NAVY } };
  s1.addRow(['', `Amazon business unit${seasonLabel}`]).getCell(2).font = { size: 10, color: { argb: 'FF64748B' } };
  s1.addRow(['', `Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`])
    .getCell(2).font = { size: 9, color: { argb: 'FF94A3B8' } };
  s1.addRow([]);

  const section = (text) => {
    const r = s1.addRow(['', text]);
    r.getCell(2).font = { bold: true, size: 12, color: { argb: NAVY } };
    r.getCell(2).border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    s1.addRow([]);
    return r;
  };

  section('STALLED BILLING VALUES');
  const hdr = s1.addRow(['', 'Reason', 'Value', 'Invoices', '', '', 'What it means']);
  hdr.eachCell((c, i) => {
    if (i === 1) return;
    c.font = { bold: true, size: 10, color: { argb: 'FF334155' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } };
  });

  const line = (label, b, fill) => {
    const r = s1.addRow(['', label, b.amount, b.count, '', '', b.explain]);
    r.getCell(2).font = { bold: true, size: 11 };
    r.getCell(3).numFmt = money;
    r.getCell(3).font = { bold: true, size: 11, color: { argb: 'FF991B1B' } };
    r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    r.getCell(4).alignment = { horizontal: 'center' };
    r.getCell(7).font = { size: 9.5, color: { argb: 'FF475569' } };
    r.getCell(7).alignment = { wrapText: true, vertical: 'top' };
    r.height = 34;
    return r;
  };
  line('Pending Goods Receipt Hold', a.stalled.pgr, AMBER);
  line('Insufficient PO Funds Hold', a.stalled.funds, RED);
  line('Invoice cannot be delivered', a.stalled.undeliverable, RED);

  const tot = s1.addRow(['', `Total stalled billing for ${a.bu}`, a.stalled.total.amount, a.stalled.total.count, '', '', '']);
  tot.getCell(2).font = { bold: true, size: 12, color: { argb: NAVY } };
  tot.getCell(3).numFmt = money;
  tot.getCell(3).font = { bold: true, size: 13, color: { argb: 'FF991B1B' } };
  tot.getCell(4).alignment = { horizontal: 'center' };
  for (let i = 2; i <= 4; i++) tot.getCell(i).border = { top: { style: 'medium', color: { argb: 'FF94A3B8' } } };
  s1.addRow([]);
  s1.addRow([]);

  section('FUNDING');
  const ex = s1.addRow(['', `Excess funding available in ${a.bu}`, a.excess, a.excessSites.length, '', '',
    'Every PO at each site added together first, then measured against what is stalled there. This is what is left over at the sites that can already cover themselves.']);
  ex.getCell(2).font = { bold: true, size: 11 };
  ex.getCell(3).numFmt = money;
  ex.getCell(3).font = { bold: true, size: 11, color: { argb: 'FF166534' } };
  ex.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
  ex.getCell(4).alignment = { horizontal: 'center' };
  ex.getCell(7).font = { size: 9.5, color: { argb: 'FF475569' } };
  ex.getCell(7).alignment = { wrapText: true, vertical: 'top' };
  ex.height = 30;

  const shortfall = a.variance > 0 ? a.variance : 0;
  const va = s1.addRow(['', 'Variance of funding needed', shortfall, a.shortSites.length, '', '',
    a.variance > 0
      ? `New funding still required after moving every spare dollar from the ${a.excessSites.length} site(s) that have some, into the ${a.shortSites.length} that are short.`
      : 'None — the sites with spare funds hold enough to cover every site that is short.']);
  va.getCell(2).font = { bold: true, size: 11 };
  va.getCell(3).numFmt = money;
  va.getCell(3).font = { bold: true, size: 12, color: { argb: a.variance > 0 ? 'FF991B1B' : 'FF166534' } };
  va.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: a.variance > 0 ? RED : GREEN } };
  va.getCell(7).font = { size: 9.5, color: { argb: 'FF475569' } };
  va.getCell(7).alignment = { wrapText: true, vertical: 'top' };
  va.height = 30;
  s1.addRow([]);
  s1.addRow([]);

  section('ANALYSIS');
  const pct = a.totalShort > 0 ? Math.round((a.coverable / a.totalShort) * 100) : 0;
  const analysis = a.variance > 0
    ? `${a.bu} has ${M(a.stalled.total.amount)} of stalled billing across ${a.siteList.filter(s => s.stalled > 0).length} sites. `
      + `${a.shortSites.length} of those sites cannot cover what is stalled there, short by ${M(a.totalShort)} between them. `
      + `Another ${a.excessSites.length} sites hold ${M(a.excess)} they do not need. Moving that across covers ${pct}% of the gap; `
      + `the remaining ${M(a.variance)} has to be newly funded.`
    : `${a.bu} needs no new funding. The ${a.excessSites.length} sites holding ${M(a.excess)} spare more than cover the `
      + `${M(a.totalShort)} that the ${a.shortSites.length} short sites are missing — it only needs moving.`;
  const an = s1.addRow(['', analysis]);
  s1.mergeCells(`B${an.number}:G${an.number}`);
  an.getCell(2).font = { size: 12, color: { argb: NAVY } };
  an.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  an.height = 46;

  // Every site in the business unit, with ALL its POs consolidated into one
  // funding position. A site's POs mean nothing individually — what matters is
  // whether the site as a whole can cover what is stalled there.
  s1.addRow([]);
  s1.addRow([]);
  section('FUNDS BY SITE — ALL POs CONSOLIDATED');
  s1.addRow(['', a.seasonKey
    ? `Available counts this business unit's ${a.seasonKey.replace('-', '–')} POs only. Funds on POs raised for the following season are listed separately and NOT counted — the portal's Pending by Site screen counts every PO, which is why a site can read higher there.`
    : 'Available counts every PO at the site.']).getCell(2).font = { italic: true, size: 9, color: { argb: 'FF64748B' } };
  s1.addRow([]);
  const sh = s1.addRow(['', 'Site', 'Stalled billing', 'POs', 'Available (this season)', 'On next season\u2019s POs (not counted)']);
  sh.eachCell((c, i) => {
    if (i === 1) return;
    c.font = { bold: true, size: 10, color: { argb: 'FF334155' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } };
  });
  // Worst position first — the sites that cannot pay their own way.
  for (const st of a.siteList) {
    if (st.stalled === 0 && st.available === 0) continue;
    const r = s1.addRow(['', st.site, st.stalled, st.poCount, st.available,
      st.nextSeason ? st.nextSeason : null]);
    r.getCell(2).font = { bold: true, size: 10.5 };
    r.getCell(3).numFmt = money;
    r.getCell(4).alignment = { horizontal: 'center' };
    r.getCell(5).numFmt = money;
    r.getCell(6).numFmt = money;
    r.getCell(6).font = { size: 10, color: { argb: 'FF94A3B8' } };
    if (st.short > 0) {
      r.getCell(3).font = { bold: true, color: { argb: 'FF991B1B' } };
      r.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } };
    } else if (st.spare > 0) {
      r.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
      r.getCell(5).font = { color: { argb: 'FF166534' } };
    }
  }
  const sf = s1.addRow(['', `${a.bu} total`, a.stalled.total.amount, a.seasonPos.length,
    Math.round(a.seasonPos.reduce((t, p) => t + (p.available || 0), 0) * 100) / 100,
    a.nextSeasonTotal || null]);
  sf.eachCell((c, i) => {
    if (i === 1) return;
    c.font = { bold: true, size: 11 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } };
    c.border = { top: { style: 'medium', color: { argb: 'FF94A3B8' } } };
  });
  sf.getCell(3).numFmt = money;
  sf.getCell(4).alignment = { horizontal: 'center' };
  sf.getCell(5).numFmt = money;
  sf.getCell(6).numFmt = money;

  // ── Sheet 2: Detail by PO ──
  const s2 = wb.addWorksheet('Detail by PO', { views: [{ state: 'frozen', ySplit: 2 }] });
  buildDetail(s2, a, 'po', { NAVY, GRAY, RED, AMBER, GREEN, money });

  // ── Sheet 3: Detail by site code ──
  const s3 = wb.addWorksheet('Detail by site code', { views: [{ state: 'frozen', ySplit: 2 }] });
  buildDetail(s3, a, 'site', { NAVY, GRAY, RED, AMBER, GREEN, money });

  return { workbook: wb, analysis: a };
}

// Both detail sheets are the same shape; only the outer grouping differs.
function buildDetail(ws, a, mode, C) {
  const stalledRows = a.stalledRows;
  const reasonOf = (r) => r.payeeStatus === HOLD_PGR ? 'Pending Goods Receipt Hold'
    : (r.payeeStatus === HOLD_FUNDS || r.payeeStatus === HOLD_FUNDS_ALT) ? 'Insufficient PO Funds Hold'
    : 'Invoice cannot be delivered';

  ws.getColumn(1).width = 16;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 16;
  ws.getColumn(4).width = 13;
  ws.getColumn(5).width = 13;
  ws.getColumn(6).width = 15;
  ws.getColumn(7).width = 28;
  ws.getColumn(8).width = 30;

  const t = ws.addRow([`${a.bu} — stalled billing, grouped by ${mode === 'po' ? 'purchase order' : 'site code'}`]);
  ws.mergeCells(`A1:H1`);
  t.getCell(1).font = { bold: true, size: 12, color: { argb: C.NAVY } };

  const head = ws.addRow(mode === 'po'
    ? ['PO', 'Site', 'Invoice', 'Inv. date', 'Due date', 'Amount', 'Why it is stalled', 'Payee Central status']
    : ['Site', 'PO', 'Invoice', 'Inv. date', 'Due date', 'Amount / available', 'Why it is stalled', 'Position']);
  head.eachCell(c => {
    c.font = { bold: true, size: 10, color: { argb: 'FF334155' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.GRAY } };
  });

  // Group, then within each group list the invoices, with a subtotal.
  const groups = {};
  for (const r of stalledRows) {
    const key = mode === 'po' ? (r.po || '(no PO)') : (r.site || '(no site)');
    (groups[key] = groups[key] || []).push(r);
  }
  const ordered = Object.entries(groups)
    .map(([k, list]) => ({ k, list, amt: list.reduce((s, r) => s + (r.amount || 0), 0) }))
    .sort((x, y) => y.amt - x.amt);

  for (const g of ordered) {
    const led = mode === 'po' ? a.ledger.find(p => p.poNumber === g.k) : null;
    // Group header carries the PO's own funding position, which is the thing
    // that explains most of what follows.
    const st = mode === 'site' ? (a.bySite[g.k] || null) : null;
    const gh = ws.addRow(mode === 'po'
      ? [g.k, led ? (led.siteCode || '') : '', `${g.list.length} invoice${g.list.length === 1 ? '' : 's'}`, '', '', g.amt,
         led ? `PO value ${fmtUsd(led.ceilingAmount)} · left ${fmtUsd(led.available)}` : '', led ? (led.poStatus || '') : '']
      // Site header states the CONSOLIDATED position: every PO at this site
      // added up, against everything stalled there.
      : [g.k, st ? `${st.poCount} PO(s)` : '', `${g.list.length} invoice${g.list.length === 1 ? '' : 's'}`, '', '', g.amt,
         st ? `${fmtUsd(st.available)} available across all its POs` : '',
         st ? (st.short > 0 ? `SHORT ${fmtUsd(st.short)}` : st.spare > 0 ? `spare ${fmtUsd(st.spare)}` : 'covered') : '']);
    gh.eachCell(c => { c.font = { bold: true, size: 11, color: { argb: C.NAVY } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }; });
    gh.getCell(6).numFmt = C.money;
    if (st) {
      gh.getCell(8).font = { bold: true, size: 10, color: { argb: st.short > 0 ? 'FF991B1B' : 'FF166534' } };
      gh.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: st.short > 0 ? C.RED : C.GREEN } };
    }

    // List the site's POs and what each still holds, so the consolidated number
    // in the header can be checked against its parts.
    if (st && st.pos.length) {
      for (const p of st.pos) {
        const pr = ws.addRow(['', p.poNumber, '', '', '', p.available || 0,
          `PO value ${fmtUsd(p.ceilingAmount)} · billed ${fmtUsd(p.consumed)}`, p.poStatus || '']);
        pr.getCell(2).font = { size: 10, italic: true, color: { argb: 'FF475569' } };
        pr.getCell(6).numFmt = C.money;
        pr.getCell(6).font = { size: 10, color: { argb: (p.available || 0) > 0 ? 'FF166534' : 'FF991B1B' } };
        pr.getCell(7).font = { size: 9, color: { argb: 'FF64748B' } };
        pr.getCell(8).font = { size: 9, color: { argb: 'FF64748B' } };
      }
    }
    g.list.sort((x, y) => (y.amount || 0) - (x.amount || 0));
    for (const r of g.list) {
      const why = reasonOf(r);
      const row = ws.addRow(mode === 'po'
        ? ['', r.site || '', r.invoiceId, r.invoiceDate || '', r.dueDate || '', r.amount || 0, why, r.payeeStatus || 'not in Payee Central']
        : ['', r.po || '(no PO)', r.invoiceId, r.invoiceDate || '', r.dueDate || '', r.amount || 0, why, r.payeeStatus || 'not in Payee Central']);
      row.getCell(6).numFmt = C.money;
      row.getCell(7).font = { size: 10 };
      row.getCell(7).fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: why === 'Pending Goods Receipt Hold' ? C.AMBER : C.RED },
      };
      row.getCell(3).font = { color: { argb: C.NAVY } };
    }
  }

  const foot = ws.addRow(mode === 'po'
    ? ['Total', '', `${stalledRows.length} invoices`, '', '', a.stalled.total.amount, '', '']
    : ['Total', '', `${stalledRows.length} invoices`, '', '', a.stalled.total.amount, '', '']);
  foot.eachCell(c => { c.font = { bold: true, size: 11 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.GRAY } }; c.border = { top: { style: 'medium', color: { argb: 'FF94A3B8' } } }; });
  foot.getCell(6).numFmt = C.money;
}

function fmtUsd(n) {
  if (n === null || n === undefined) return 'n/a';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function listBusinessUnits(invoices) {
  const rows = siteLedger.buildAmazonRows(invoices, { payee });
  const set = {};
  for (const r of rows) {
    const bu = r.businessUnit || '';
    if (!bu) continue;
    set[bu] = set[bu] || { bu, invoices: 0, amount: 0 };
    set[bu].invoices++; set[bu].amount += r.amount || 0;
  }
  return Object.values(set).sort((a, b) => b.amount - a.amount);
}

module.exports = { analyseBu, buildBuWorkbook, listBusinessUnits };
