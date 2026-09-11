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

// "NEEDED KRB5" and similar are not purchase orders — they are a note that one
// has to be raised.
const isPlaceholderPo = (po) => !po || /needed|tbd|pending|none|n\/a/i.test(String(po));

const EXPLAIN = {
  pgr: 'Submitted to Payee Central and already drawn against the PO, but Amazon has not recorded a goods '
     + 'receipt. NO ADDITIONAL FUNDS ARE NEEDED — this clears when the site confirms the work was received.',
  funds: 'Submitted to Payee Central and held for funding: the purchase order does not have enough left '
       + 'on it to cover the invoice. The value shown is the FULL value of those invoices — what we are owed '
       + 'and cannot collect. How far each PO has to be raised is shown per PO on sheet 2, where the PO value, '
       + 'what has been billed against it and what is left all sit alongside the held invoices.',
  undeliverable: 'Never submitted. Either no purchase order covers the work, or the PO it belongs to has '
       + 'nothing left on it, so the invoice cannot be raised in Payee Central at all. NEEDS A PO, OR FUNDS ON ONE.',
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
  const poIndex = {};
  for (const p of ledger) poIndex[p.poNumber] = p;

  // Work that was never submitted splits three ways, and the three carry
  // completely different asks (Edwin 2026-09-11):
  //   - no PO at all            -> Amazon must RAISE one
  //   - a PO with no room       -> Amazon must TOP IT UP
  //   - a PO with room          -> nothing to ask; we can submit it today
  const notSubmitted = rows.filter(r => !r.payeeStatus && (r.amount || 0) > 0.005);
  const noPo = [], needsTopUp = [], submittable = [];
  const unsubByPo = {};
  for (const r of notSubmitted) {
    if (isPlaceholderPo(r.po) || !poIndex[r.po]) { noPo.push(r); continue; }
    (unsubByPo[r.po] = unsubByPo[r.po] || []).push(r);
  }
  for (const [po, list] of Object.entries(unsubByPo)) {
    const avail = Math.max(0, poIndex[po].available || 0);
    // Biggest first, so the headroom is attributed to what it can actually cover
    // rather than being spread thinly and leaving everything half-funded.
    list.sort((x, y) => (y.amount || 0) - (x.amount || 0));
    let room = avail;
    for (const r of list) {
      if (room >= (r.amount || 0)) { room -= (r.amount || 0); submittable.push(r); }
      else needsTopUp.push(r);
    }
  }

  const buckets = {
    pgr: rows.filter(r => r.payeeStatus === HOLD_PGR),
    funds: rows.filter(r => isFundsHold(r.payeeStatus)),
    noPo, needsTopUp, submittable,
    // Kept for the detail sheets: everything never submitted.
    undeliverable: notSubmitted,
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
  // NOT every stalled invoice needs money. A Pending Goods Receipt Hold has
  // already been accepted against the PO — Amazon has drawn it down, so it sits
  // inside `available` already. It needs a goods receipt, not funding. Counting
  // it in the funding requirement overstates the ask and, for a business unit
  // like Logistics where it is 96% of the problem, points at entirely the wrong
  // fix (Edwin 2026-09-11).
  stalled.needsFunding = {
    count: stalled.funds.count + stalled.undeliverable.count,
    amount: Math.round((stalled.funds.amount + stalled.undeliverable.amount) * 100) / 100,
  };
  stalled.noFundingNeeded = { count: stalled.pgr.count, amount: stalled.pgr.amount };

  // Which sites already have a real purchase order of their own. Amazon does not
  // top POs up — across this book 131 of 281 sites carry two or more fully
  // consumed POs, issued one after another (BDL4 has 26, 19 of them exhausted).
  // So the ask is COVERAGE AT A SITE, and how they provide it is their call
  // (Edwin 2026-09-11).
  const sitesWithRealPo = new Set(
    ledger.filter(p => p.siteCode && !isPlaceholderPo(p.poNumber) && (p.ceilingAmount || 0) > 0)
      .map(p => p.siteCode));

  // An invoice parked on a placeholder at a site that HAS POs is not a
  // "no PO anywhere" case — it just needs covering like the rest.
  const noPoAtAll = noPo.filter(r => !r.site || !sitesWithRealPo.has(r.site));
  const unassigned = noPo.filter(r => r.site && sitesWithRealPo.has(r.site));

  const needCoverage = [...buckets.funds, ...needsTopUp, ...unassigned];
  const asks = {
    coverage: { count: needCoverage.length, amount: sum(needCoverage) },
    // Filled in below, once the per-site netting is known.
    netCoverage: { amount: 0, sites: 0 },
    reallocatable: { amount: 0, sites: 0 },
    newPo: { count: noPoAtAll.length, amount: sum(noPoAtAll), sites: [...new Set(noPoAtAll.map(r => r.site).filter(Boolean))] },
    goodsReceipt: { count: buckets.pgr.length, amount: sum(buckets.pgr) },
    ourBacklog: { count: submittable.length, amount: sum(submittable) },
    unassignedCount: unassigned.length,
    unassignedAmount: sum(unassigned),
  };

  // Coverage needed per SITE, with that site's PO history alongside so the
  // pattern of issue-and-exhaust is visible rather than asserted.
  const covBySite = {};
  for (const r of needCoverage) {
    const site = r.site || '(no site)';
    const c = covBySite[site] = covBySite[site] || { site, amount: 0, count: 0 };
    c.amount += r.amount || 0; c.count++;
  }
  const coverageList = Object.values(covBySite).map(c => {
    const pos = ledger.filter(p => p.siteCode === c.site && !isPlaceholderPo(p.poNumber));
    const exhausted = pos.filter(p => (p.available || 0) <= 0.5 && (p.ceilingAmount || 0) > 0);
    return {
      ...c,
      amount: Math.round(c.amount * 100) / 100,
      poCount: pos.length,
      exhaustedCount: exhausted.length,
      committed: Math.round(pos.reduce((t, p) => t + (p.ceilingAmount || 0), 0) * 100) / 100,
      left: Math.round(pos.reduce((t, p) => t + (p.available || 0), 0) * 100) / 100,
      latestPo: pos.map(p => ({ po: p.poNumber, date: p.orderDate || p.docDate || '' }))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null,
    };
  }).map(c => ({
    ...c,
    // A site can be stuck while still holding money — on a DIFFERENT PO of its
    // own. That is not new funding, it is moving what is already there, so the
    // ask is the net (MDW5 needs $74,660 and is sitting on $126,640).
    netNeeded: Math.round(Math.max(0, c.amount - Math.max(0, c.left)) * 100) / 100,
    fromOwnFunds: Math.round(Math.min(c.amount, Math.max(0, c.left)) * 100) / 100,
  })).sort((a, b) => b.netNeeded - a.netNeeded || b.amount - a.amount);

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
    needsFunding: 0, awaitingReceipt: 0,
  });
  for (const r of stalledRows) {
    const s = touchSite(r.site || '(no site)');
    s.stalled += r.amount || 0; s.invoices++;
    if (r.payeeStatus === HOLD_PGR) s.awaitingReceipt += r.amount || 0;
    else s.needsFunding += r.amount || 0;
  }
  for (const p of seasonPos) {
    const s = touchSite(p.siteCode || '(no site)');
    // Raw available, NOT floored per PO: an overdrawn PO genuinely reduces what
    // the site has to work with, and flooring it would overstate the site.
    s.available += (p.available || 0);
    s.poCount++;
    s.pos.push(p);
  }
  for (const s of Object.values(bySite)) {
    s.available = Math.round(s.available * 100) / 100;
    s.stalled = Math.round(s.stalled * 100) / 100;
    s.needsFunding = Math.round(s.needsFunding * 100) / 100;
    s.awaitingReceipt = Math.round(s.awaitingReceipt * 100) / 100;
    // Measured against what actually needs funding, not against everything
    // stalled at the site.
    s.spare = Math.max(0, s.available - s.needsFunding);
    s.short = Math.max(0, s.needsFunding - Math.max(0, s.available));
    s.pos.sort((x, y) => (y.available || 0) - (x.available || 0));
  }
  const siteList = Object.values(bySite).sort((x, y) => (y.needsFunding - y.available) - (x.needsFunding - x.available));

  asks.netCoverage = {
    amount: Math.round(coverageList.reduce((t, c) => t + c.netNeeded, 0) * 100) / 100,
    sites: coverageList.filter(c => c.netNeeded > 0).length,
  };
  asks.reallocatable = {
    amount: Math.round(coverageList.reduce((t, c) => t + c.fromOwnFunds, 0) * 100) / 100,
    sites: coverageList.filter(c => c.fromOwnFunds > 0).length,
  };

  // Excess for the BU is the sum of what its SITES have spare, once each site's
  // own stalled billing is met from its own POs.
  const excess = Math.round(siteList.reduce((t, s) => t + s.spare, 0) * 100) / 100;
  const excessSites = siteList.filter(s => s.spare > 0).sort((x, y) => y.spare - x.spare);
  const shortSites = siteList.filter(s => s.short > 0).sort((x, y) => y.short - x.short);
  const totalShort = Math.round(shortSites.reduce((t, s) => t + s.short, 0) * 100) / 100;

  // What moving money inside the BU can actually reach, and what it cannot.
  const coverable = Math.round(Math.min(excess, totalShort) * 100) / 100;
  const variance = Math.round(Math.max(0, totalShort - excess) * 100) / 100;


  return {
    bu, seasonKey, snowOnly,
    rows, buckets, stalled, stalledRows, asks, coverageList,
    bySite, siteList, excessSites, shortSites,
    excess, totalShort, coverable, variance,
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

  const title = s1.addRow(['', `${a.bu} — billing we cannot complete`]);
  title.getCell(2).font = { bold: true, size: 20, color: { argb: NAVY } };
  s1.addRow(['', `Prepared for Amazon by East Coast Facilities${seasonLabel}`])
    .getCell(2).font = { size: 11, color: { argb: 'FF334155' } };
  s1.addRow(['', `${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' })}`])
    .getCell(2).font = { size: 9, color: { argb: 'FF94A3B8' } };
  s1.addRow([]);
  const intro = s1.addRow(['', 'This covers work our crews have completed at your sites that we have not been able to turn '
    + 'into a paid invoice. Everything here is open to date — we are still working through last winter, so no PO has been '
    + 'left out on the grounds of age. Sheet 2 lists it by purchase order and sheet 3 by site code, down to the individual invoice.']);
  s1.mergeCells(`B${intro.number}:G${intro.number}`);
  intro.getCell(2).font = { size: 11, color: { argb: 'FF475569' } };
  intro.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  intro.height = 42;
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

  const sub1 = s1.addRow(['', '— requiring additional PO funds', a.stalled.needsFunding.amount, a.stalled.needsFunding.count, '', '',
    'The two rows above that need money: the funding hold, and the work we cannot raise an invoice for at all. '
    + 'Both are shown at full invoice value — the amount we are owed — not at the amount by which each PO falls short.']);
  sub1.getCell(2).font = { bold: true, size: 10.5, color: { argb: 'FF991B1B' } };
  sub1.getCell(3).numFmt = money;
  sub1.getCell(3).font = { bold: true, size: 11, color: { argb: 'FF991B1B' } };
  sub1.getCell(4).alignment = { horizontal: 'center' };
  sub1.getCell(7).font = { size: 9.5, color: { argb: 'FF475569' } };
  sub1.getCell(7).alignment = { wrapText: true, vertical: 'top' };
  sub1.height = 28;

  const sub2 = s1.addRow(['', '— requiring no additional funds, only a goods receipt', a.stalled.noFundingNeeded.amount, a.stalled.noFundingNeeded.count, '', '',
    'Already funded and drawn against the PO. These release as soon as the receipt is recorded.']);
  sub2.getCell(2).font = { bold: true, size: 10.5, color: { argb: 'FF92400E' } };
  sub2.getCell(3).numFmt = money;
  sub2.getCell(3).font = { bold: true, size: 11, color: { argb: 'FF92400E' } };
  sub2.getCell(4).alignment = { horizontal: 'center' };
  sub2.getCell(7).font = { size: 9.5, color: { argb: 'FF475569' } };
  sub2.getCell(7).alignment = { wrapText: true, vertical: 'top' };
  sub2.height = 28;
  s1.addRow([]);

  const tot = s1.addRow(['', `Total stalled billing for ${a.bu}`, a.stalled.total.amount, a.stalled.total.count, '', '', '']);
  tot.getCell(2).font = { bold: true, size: 12, color: { argb: NAVY } };
  tot.getCell(3).numFmt = money;
  tot.getCell(3).font = { bold: true, size: 13, color: { argb: 'FF991B1B' } };
  tot.getCell(4).alignment = { horizontal: 'center' };
  for (let i = 2; i <= 4; i++) tot.getCell(i).border = { top: { style: 'medium', color: { argb: 'FF94A3B8' } } };
  s1.addRow([]);
  s1.addRow([]);

  // ── What we are actually asking Amazon to do ──
  section('WHAT WE ARE ASKING FOR');
  const ah = s1.addRow(['', 'Action', 'Value', 'Invoices', '', '', 'Detail']);
  ah.eachCell((c, i) => {
    if (i === 1) return;
    c.font = { bold: true, size: 10, color: { argb: 'FF334155' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } };
  });
  const askRow = (label, v, detail, fill, colour) => {
    const r = s1.addRow(['', label, v.amount, v.count, '', '', detail]);
    r.getCell(2).font = { bold: true, size: 11 };
    r.getCell(3).numFmt = money;
    r.getCell(3).font = { bold: true, size: 11.5, color: { argb: colour } };
    r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    r.getCell(4).alignment = { horizontal: 'center' };
    r.getCell(7).font = { size: 9.5, color: { argb: 'FF475569' } };
    r.getCell(7).alignment = { wrapText: true, vertical: 'top' };
    r.height = 32;
    return r;
  };
  askRow('1. Additional PO coverage at these sites', a.asks.netCoverage.amount !== undefined
    ? { amount: a.asks.netCoverage.amount, count: a.asks.coverage.count } : a.asks.coverage,
    `${a.asks.netCoverage.sites} site(s) need funding they do not already hold. Whether that arrives as more on an existing PO or as a further PO is your call — `
    + `the sites are listed below with every PO already issued to them.`
    + (a.asks.reallocatable.amount > 0
      ? ` A further ${M(a.asks.reallocatable.amount)} is stuck only because it sits on the wrong PO within the same site; that needs moving, not funding.`
      : ''),
    RED, 'FF991B1B');
  askRow('2. A first purchase order', a.asks.newPo,
    a.asks.newPo.count
      ? `Work at ${a.asks.newPo.sites.length} site(s) with no purchase order of any kind: ${a.asks.newPo.sites.join(', ')}.`
      : 'None — every site we are holding invoices for already has at least one purchase order.',
    a.asks.newPo.count ? AMBER : GREEN, a.asks.newPo.count ? 'FF92400E' : 'FF166534');
  askRow('3. Record goods receipts', a.asks.goodsReceipt,
    'Already submitted and already drawn against the PO. No money needed — these release as soon as the site confirms the work was received.',
    AMBER, 'FF92400E');
  s1.addRow([]);
  const ob = s1.addRow(['', 'For our side: ready to submit, no action needed from Amazon', a.asks.ourBacklog.amount, a.asks.ourBacklog.count, '', '',
    'These have a purchase order with room on it. We are submitting them — they are listed here only so the totals reconcile.']);
  ob.getCell(2).font = { italic: true, size: 10.5, color: { argb: 'FF64748B' } };
  ob.getCell(3).numFmt = money;
  ob.getCell(3).font = { size: 10.5, color: { argb: 'FF64748B' } };
  ob.getCell(4).alignment = { horizontal: 'center' };
  ob.getCell(7).font = { size: 9.5, color: { argb: 'FF475569' } };
  ob.getCell(7).alignment = { wrapText: true, vertical: 'top' };
  ob.height = 28;
  s1.addRow([]);

  // The actionable list: coverage needed per site, with the PO history that
  // shows how that site has been funded so far.
  if (a.coverageList.length) {
    section('SITES NEEDING ADDITIONAL PO COVERAGE');
    const noteR = s1.addRow(['', 'Each site below already has purchase orders — most of them fully used. The last two columns show how many '
      + 'have been issued to that site and how many are now exhausted, which is why the work is stuck. Where a site still holds '
      + 'funds on another of its own POs, that part is shown as movable rather than as new funding.']);
    s1.mergeCells(`B${noteR.number}:G${noteR.number}`);
    noteR.getCell(2).font = { italic: true, size: 9.5, color: { argb: 'FF64748B' } };
    noteR.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    noteR.height = 26;
    const th = s1.addRow(['', 'Site', 'New funding needed', 'Movable within the site', 'Invoices', 'Left across all its POs', 'POs issued / fully used · most recent']);
    th.eachCell((c, i) => {
      if (i === 1) return;
      c.font = { bold: true, size: 10, color: { argb: 'FF334155' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } };
    });
    for (const t of a.coverageList) {
      const hist = `${t.poCount} issued / ${t.exhaustedCount} fully used`
        + (t.latestPo ? ` · latest ${t.latestPo.po}${t.latestPo.date ? ' (' + t.latestPo.date + ')' : ''}` : '');
      const r = s1.addRow(['', t.site, t.netNeeded || null, t.fromOwnFunds || null, t.count, t.left, hist]);
      [3, 4, 6].forEach(ci => { r.getCell(ci).numFmt = money; });
      r.getCell(2).font = { bold: true, color: { argb: NAVY } };
      if (t.netNeeded > 0) {
        r.getCell(3).font = { bold: true, color: { argb: 'FF991B1B' } };
        r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } };
      }
      if (t.fromOwnFunds > 0) {
        r.getCell(4).font = { color: { argb: 'FF166534' } };
        r.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
      }
      r.getCell(5).alignment = { horizontal: 'center' };
      r.getCell(6).font = { color: { argb: (t.left || 0) < 0 ? 'FF991B1B' : 'FF475569' } };
      r.getCell(7).font = { size: 9.5, color: { argb: 'FF64748B' } };
    }
    const tf = s1.addRow(['', `${a.coverageList.length} sites`, a.asks.netCoverage.amount, a.asks.reallocatable.amount, a.asks.coverage.count, '', '']);
    tf.eachCell((c, i) => {
      if (i === 1) return;
      c.font = { bold: true, size: 11 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } };
      c.border = { top: { style: 'medium', color: { argb: 'FF94A3B8' } } };
    });
    tf.getCell(3).numFmt = money;
    tf.getCell(4).numFmt = money;
    tf.getCell(5).alignment = { horizontal: 'center' };
    s1.addRow([]);
    s1.addRow([]);
  }

  section('FUNDING');
  const ex = s1.addRow(['', `Excess funding available in ${a.bu}`, a.excess, a.excessSites.length, '', '',
    'Every PO at each site added together first, then measured against what that site needs FUNDED. This is what is left over at the sites that can already cover themselves.']);
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
    (a.variance > 0
      ? `New funding still required after moving every spare dollar from the ${a.excessSites.length} site(s) that have some, into the ${a.shortSites.length} that are short. `
      : 'None — the sites with spare funds hold enough to cover every site that is short. ')
    + 'Calculated as the full value of what needs funding at each site, less the funds already on that site’s POs.']);
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
  const receiptNote = a.stalled.noFundingNeeded.amount > 0
    ? ` Separately, ${M(a.stalled.noFundingNeeded.amount)} across ${a.stalled.noFundingNeeded.count} invoices is already funded `
      + `and simply waiting on a goods receipt — that needs no money, only confirmation from the sites.`
    : '';
  const analysis = a.variance > 0
    ? `${a.bu} has ${M(a.stalled.needsFunding.amount)} of billing that needs funding, across `
      + `${a.siteList.filter(s => s.needsFunding > 0).length} sites. ${a.shortSites.length} of those sites cannot cover it from `
      + `their own POs, short by ${M(a.totalShort)} between them. Another ${a.excessSites.length} sites hold ${M(a.excess)} they `
      + `do not need. Moving that across covers ${pct}% of the gap; the remaining ${M(a.variance)} has to be newly funded.`
      + receiptNote
    : `${a.bu} needs no new funding. The ${a.excessSites.length} sites holding ${M(a.excess)} spare more than cover the `
      + `${M(a.totalShort)} that the ${a.shortSites.length} short sites are missing — it only needs moving.` + receiptNote;
  const analysisFull = analysis;
  const an = s1.addRow(['', analysisFull]);
  s1.mergeCells(`B${an.number}:G${an.number}`);
  an.getCell(2).font = { size: 12, color: { argb: NAVY } };
  an.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  an.height = 78;

  // Every site in the business unit, with ALL its POs consolidated into one
  // funding position. A site's POs mean nothing individually — what matters is
  // whether the site as a whole can cover what is stalled there.
  s1.addRow([]);
  s1.addRow([]);
  section('FUNDS BY SITE — ALL POs CONSOLIDATED');
  const noteRow = s1.addRow(['', 'A site usually has several purchase orders, and what matters is the site as a whole — so every '
    + 'PO at the site is added together here, and compared with what that site NEEDS FUNDED. Invoices awaiting a goods receipt are '
    + 'shown alongside but are not part of that comparison: they are already drawn against the PO. Where available is negative, we '
    + 'have already invoiced past what the POs were written for.']);
  s1.mergeCells(`B${noteRow.number}:G${noteRow.number}`);
  noteRow.getCell(2).font = { italic: true, size: 9.5, color: { argb: 'FF64748B' } };
  noteRow.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  noteRow.height = 30;
  s1.addRow([]);
  const sh = s1.addRow(['', 'Site', 'Needs funding', 'Awaiting goods receipt', 'POs', 'Available across all its POs']);
  sh.eachCell((c, i) => {
    if (i === 1) return;
    c.font = { bold: true, size: 10, color: { argb: 'FF334155' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } };
  });
  // Worst position first — the sites that cannot pay their own way.
  for (const st of a.siteList) {
    if (st.stalled === 0 && st.available === 0) continue;
    const r = s1.addRow(['', st.site, st.needsFunding, st.awaitingReceipt || null, st.poCount, st.available]);
    r.getCell(2).font = { bold: true, size: 10.5 };
    r.getCell(3).numFmt = money;
    r.getCell(4).numFmt = money;
    r.getCell(4).font = { size: 10, color: { argb: 'FF92400E' } };
    r.getCell(5).alignment = { horizontal: 'center' };
    r.getCell(6).numFmt = money;
    if (st.short > 0) {
      r.getCell(3).font = { bold: true, color: { argb: 'FF991B1B' } };
      r.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } };
    } else if (st.spare > 0) {
      r.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
      r.getCell(6).font = { color: { argb: 'FF166534' } };
    }
  }
  const sf = s1.addRow(['', `${a.bu} total`, a.stalled.needsFunding.amount, a.stalled.noFundingNeeded.amount || null,
    a.seasonPos.length, Math.round(a.seasonPos.reduce((t, p) => t + (p.available || 0), 0) * 100) / 100]);
  sf.eachCell((c, i) => {
    if (i === 1) return;
    c.font = { bold: true, size: 11 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } };
    c.border = { top: { style: 'medium', color: { argb: 'FF94A3B8' } } };
  });
  sf.getCell(3).numFmt = money;
  sf.getCell(4).numFmt = money;
  sf.getCell(5).alignment = { horizontal: 'center' };
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
