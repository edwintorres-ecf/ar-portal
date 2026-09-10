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

const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const money2 = '$#,##0.00';

// A site is STARVED when it has real work waiting and nothing to bill it
// against; SURPLUS when it holds funds with no work waiting. The thresholds
// keep the story to material cases rather than rounding noise.
const STARVED_MIN_PENDING = 50000;
const SURPLUS_MIN_AVAILABLE = 100000;
const COVER_RATIO = 0.25;

function analyse(invoices, { snowOnly = true } = {}) {
  const sites = poLedger.getPendingBySite(invoices, { snowOnly });
  const ledger = poLedger.getPoLedger(invoices);
  const rows = snowOnly ? ledger.filter(r => r.serviceType === 'snow') : ledger;

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
      b.shortfall += Math.max(0, p - av);
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
    shortfall: sites.reduce((t, s) => t + Math.max(0, (s.pending || 0) - (s.available || 0)), 0),
    coverable: Object.values(byBu).reduce((t, b) => t + b.coverable, 0),
    overdrawnSites: sites.filter(s => (s.available || 0) < 0).length,
    overdrawn: sites.reduce((t, s) => t + Math.min(0, s.available || 0), 0),
    closedCount: closedWithFunds.length,
    closedFunds: closedWithFunds.reduce((t, r) => t + (r.available || 0), 0),
    neverUsedCount: neverUsed.length,
    neverUsedFunds: neverUsed.reduce((t, r) => t + (r.available || 0), 0),
  };

  const buList = Object.values(byBu).sort((a, b) => b.pending - a.pending);
  return { sites, buList, closedWithFunds, neverUsed, totals, snowOnly };
}

// ─── Workbook ───────────────────────────────────────────────────────────────
async function buildWorkbook(invoices, opts = {}) {
  const a = analyse(invoices, opts);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ECF AR Portal';

  const NAVY = 'FF1E3A5F', GRAY = 'FFF1F5F9', RED = 'FFFEE2E2', GREEN = 'FFDCFCE7', AMBER = 'FFFEF3C7';
  const label = a.snowOnly ? 'Snow' : 'All services';

  // ── Summary ──
  const s1 = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 3 }] });
  s1.mergeCells('A1:G1');
  s1.getCell('A1').value = `ECF — Amazon PO funds by site (${label}) — generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
  s1.getCell('A1').font = { bold: true, size: 13, color: { argb: NAVY } };
  s1.mergeCells('A2:G2');
  s1.getCell('A2').value = 'Work is billed against a specific PO at a specific site. Funds on another site’s PO cannot pay for it.';
  s1.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
  s1.addRow([]);

  const headline = [
    ['Sites with snow POs', a.totals.sites],
    ['Invoices waiting to be submitted', a.totals.invoices],
    ['Value waiting to be submitted', a.totals.pending],
    ['Funds available across all POs', a.totals.available],
    ['Sites where pending exceeds available', a.totals.shortSites],
    ['Total shortfall at those sites', a.totals.shortfall],
    ['Of that, coverable from surplus in the SAME business unit', a.totals.coverable],
    ['Sites already invoiced past their PO value', a.totals.overdrawnSites],
    ['Value invoiced beyond the PO', Math.abs(a.totals.overdrawn)],
    ['POs closed while still holding funds', a.totals.closedCount],
    ['Value stranded on closed POs', a.totals.closedFunds],
  ];
  for (const [k, v] of headline) {
    const r = s1.addRow([k, v]);
    r.getCell(1).font = { size: 11 };
    r.getCell(2).font = { bold: true, size: 11, color: { argb: NAVY } };
    if (typeof v === 'number' && v > 1000) r.getCell(2).numFmt = money2;
  }
  s1.getColumn(1).width = 56; s1.getColumn(2).width = 20;
  s1.addRow([]);

  const h = s1.addRow(['Business unit', 'Sites', 'Invoices pending', 'Pending value', 'Available on POs', 'Shortfall', 'Surplus', 'Coverable within BU']);
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
    ws.getCell('A2').value = `${b.sites.length} sites · ${money(b.pending)} waiting to be submitted · ${money(b.available)} available on POs`
      + (b.coverable > 0 ? ` · ${money(b.coverable)} of the shortfall could be covered from surplus inside this business unit` : '');
    ws.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };
    ws.addRow([]);

    const hh = ws.addRow(['Site', 'City', 'State', 'Invoices pending', 'Pending value', 'PO value', 'Charged', 'Available', 'Status']);
    hh.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
    [10, 18, 7, 16, 16, 15, 15, 15, 26].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    const master = db.getAmazonLocationMap();
    for (const s of b.sites) {
      const m = master[s.site] || {};
      const starved = b.starved.includes(s), surplus = b.surplusSites.includes(s);
      const status = starved ? 'NEEDS FUNDS — work waiting, PO empty'
        : surplus ? 'Surplus — funds unused, no work waiting'
        : (s.pending || 0) > (s.available || 0) ? 'Short' : '';
      const r = ws.addRow([s.site, m.city || '', m.state || '', s.count || 0, s.pending || 0, s.ceiling || 0, s.consumed || 0, s.available || 0, status]);
      [5, 6, 7, 8].forEach(ci => { r.getCell(ci).numFmt = money2; });
      if (starved) { r.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } }; r.getCell(9).font = { bold: true, color: { argb: 'FF991B1B' } }; }
      if (surplus) { r.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } }; r.getCell(9).font = { bold: true, color: { argb: 'FF166534' } }; }
    }
    const tot = ws.addRow(['Total', '', '', b.invoices, b.pending, b.ceiling, b.consumed, b.available, '']);
    tot.eachCell(c => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
    [5, 6, 7, 8].forEach(ci => { tot.getCell(ci).numFmt = money2; });
  }

  // ── Closed POs still holding funds ──
  const ws = wb.addWorksheet('Closed POs with funds', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.mergeCells('A1:G1');
  ws.getCell('A1').value = 'POs closed by Amazon while still carrying available funds';
  ws.getCell('A1').font = { bold: true, size: 12, color: { argb: NAVY } };
  ws.mergeCells('A2:G2');
  ws.getCell('A2').value = 'Nothing can be billed against a closed PO, so these funds cannot be reached unless the PO is reopened.';
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };
  const ch = ws.addRow(['PO', 'Site', 'Business unit', 'PO value', 'Charged', 'Still available', 'Ever invoiced?']);
  ch.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
  [16, 9, 14, 15, 15, 16, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  for (const r0 of a.closedWithFunds) {
    const r = ws.addRow([r0.poNumber, r0.siteCode || '', r0.businessUnit || '', r0.ceilingAmount || 0, r0.consumed || 0, r0.available || 0,
      (r0.consumed || 0) === 0 ? 'NEVER USED' : 'partly used']);
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
  slide(1, 'Purchase order funding', `${money(a.totals.pending)} of completed work cannot be invoiced`);
  doc.fillColor(GREY).fontSize(12).font('Helvetica')
    .text(`Across ${a.totals.sites} Amazon sites where East Coast Facilities performs ${svc}, work has been completed and`
      + ` accepted but cannot be submitted, because the purchase order at that site has no funds left on it.`, 56, 118, { width: W - 112 });
  stat(56, 210, money(a.totals.pending), 'completed work waiting to be invoiced', RED);
  stat(300, 210, money(a.totals.available), 'available across all Amazon POs', GREEN);
  stat(544, 210, String(a.totals.shortSites), 'sites where the work exceeds the funds', AMBER);
  doc.roundedRect(56, 340, W - 112, 150, 8).fill('#f8fafc');
  doc.fillColor(NAVY).fontSize(17).font('Helvetica-Bold').text('There is no shortage of money.', 80, 368);
  doc.fillColor('#1f2937').fontSize(13.5).font('Helvetica')
    .text(`Amazon has committed ${money(a.totals.available)} across these POs — more than the ${money(a.totals.pending)} of work waiting.`
      + ` The funds are simply on the wrong purchase orders.`, 80, 398, { width: W - 160, lineGap: 4 });

  // 2 — the mechanism, using the clearest real example
  const worstBu = a.buList
    .filter(b => b.coverable > 0 && b.starved.length && b.surplusSites.length)
    .sort((x, y) => y.coverable - x.coverable)[0];
  slide(2, 'Why it happens', 'Funds are committed per site, but work does not follow the same split');
  if (worstBu) {
    const st = worstBu.starved[0], su = worstBu.surplusSites.slice(0, 2);
    doc.fillColor(GREY).fontSize(12).font('Helvetica')
      .text(`${worstBu.bu} is the clearest case. Within this one business unit:`, 56, 118, { width: W - 112 });
    doc.roundedRect(56, 156, 330, 210, 8).fill('#fef2f2');
    doc.fillColor(RED).fontSize(11).font('Helvetica-Bold').text('WORK DONE, NO FUNDS', 80, 180);
    doc.fillColor(NAVY).fontSize(28).font('Helvetica-Bold').text(st.site, 80, 204);
    doc.fillColor('#1f2937').fontSize(13.5).font('Helvetica')
      .text(`${money(st.pending)} of completed work`, 80, 250)
      .text(`${money(st.available)} left on its PO`, 80, 276)
      .text(`${st.count} invoices held back`, 80, 302);
    doc.roundedRect(406, 156, 330, 210, 8).fill('#f0fdf4');
    doc.fillColor(GREEN).fontSize(11).font('Helvetica-Bold').text('FUNDS SITTING UNUSED', 430, 180);
    let yy = 206;
    for (const s of su) {
      doc.fillColor(NAVY).fontSize(24).font('Helvetica-Bold').text(s.site, 430, yy);
      doc.fillColor('#1f2937').fontSize(13).font('Helvetica').text(`${money(s.available)} available, no work waiting`, 430, yy + 30);
      yy += 74;
    }
    doc.fillColor('#1f2937').fontSize(13.5).font('Helvetica')
      .text(`Both sites sit in ${worstBu.bu}. The funding exists and is already approved — it is committed at a site that has`
        + ` no work waiting, while the site with the work cannot be billed.`, 56, 396, { width: W - 112, lineGap: 4 });
    doc.fillColor(AMBER).fontSize(14).font('Helvetica-Bold')
      .text(`Across all business units, ${money(a.totals.coverable)} of the shortfall sits as surplus inside the SAME business unit.`, 56, 456, { width: W - 112, lineGap: 4 });
  }

  // 3 — scale, by business unit
  slide(3, 'Scale', 'Every business unit shows the same pattern');
  let y = 150;
  doc.fillColor(GREY).fontSize(9.5).font('Helvetica-Bold');
  doc.text('BUSINESS UNIT', 56, y); doc.text('SITES', 240, y); doc.text('WORK WAITING', 320, y, { width: 120, align: 'right' });
  doc.text('AVAILABLE ON POs', 470, y, { width: 130, align: 'right' }); doc.text('COVERABLE WITHIN BU', 620, y, { width: 130, align: 'right' });
  y += 18;
  doc.moveTo(56, y).lineTo(W - 56, y).lineWidth(0.8).stroke('#cbd5e1');
  y += 10;
  for (const b of a.buList.filter(x => x.pending > 0 || x.available > 0).slice(0, 8)) {
    doc.fillColor(NAVY).fontSize(12).font('Helvetica-Bold').text(b.bu, 56, y);
    doc.fillColor('#1f2937').fontSize(12).font('Helvetica').text(String(b.sites.length), 240, y);
    doc.fillColor(b.pending > 0 ? RED : '#1f2937').text(money(b.pending), 320, y, { width: 120, align: 'right' });
    doc.fillColor(GREEN).text(money(b.available), 470, y, { width: 130, align: 'right' });
    doc.fillColor(b.coverable > 0 ? AMBER : '#94a3b8').font(b.coverable > 0 ? 'Helvetica-Bold' : 'Helvetica')
      .text(b.coverable > 0 ? money(b.coverable) : '—', 620, y, { width: 130, align: 'right' });
    y += 34;
  }
  doc.moveTo(56, y + 4).lineTo(W - 56, y + 4).lineWidth(0.8).stroke('#cbd5e1');
  doc.fillColor(NAVY).fontSize(14).font('Helvetica-Bold').text('Total', 56, y + 18);
  doc.fillColor(RED).text(money(a.totals.pending), 320, y + 18, { width: 120, align: 'right' });
  doc.fillColor(GREEN).text(money(a.totals.available), 470, y + 18, { width: 130, align: 'right' });
  doc.fillColor(AMBER).text(money(a.totals.coverable), 620, y + 18, { width: 130, align: 'right' });

  // 4 — closed POs
  slide(4, 'A second, smaller leak', 'Purchase orders are being closed with funds still on them');
  doc.fillColor(GREY).fontSize(12).font('Helvetica')
    .text(`Nothing can be invoiced against a closed purchase order. ${a.totals.closedCount} POs have been closed while still`
      + ` carrying ${money(a.totals.closedFunds)}`
      + (a.totals.neverUsedCount ? `, and ${a.totals.neverUsedCount} of them were never invoiced against at all.` : '.'), 56, 118, { width: W - 112 });
  y = 196;
  doc.fillColor(GREY).fontSize(9.5).font('Helvetica-Bold');
  doc.text('PURCHASE ORDER', 56, y); doc.text('SITE', 220, y); doc.text('PO VALUE', 300, y, { width: 110, align: 'right' });
  doc.text('CHARGED', 430, y, { width: 110, align: 'right' }); doc.text('STILL ON IT', 560, y, { width: 120, align: 'right' });
  y += 18;
  doc.moveTo(56, y).lineTo(W - 56, y).lineWidth(0.8).stroke('#cbd5e1');
  y += 10;
  for (const r of a.closedWithFunds.slice(0, 8)) {
    doc.fillColor(NAVY).fontSize(11.5).font('Helvetica-Bold').text(r.poNumber, 56, y);
    doc.fillColor('#1f2937').fontSize(11.5).font('Helvetica').text(r.siteCode || '—', 220, y);
    doc.text(money(r.ceilingAmount), 300, y, { width: 110, align: 'right' });
    doc.fillColor((r.consumed || 0) === 0 ? RED : '#1f2937').text((r.consumed || 0) === 0 ? 'never invoiced' : money(r.consumed), 430, y, { width: 110, align: 'right' });
    doc.fillColor(RED).font('Helvetica-Bold').text(money(r.available), 560, y, { width: 120, align: 'right' });
    y += 32;
  }

  // 5 — the ask
  slide(5, 'What we are asking for', 'Three changes that release the work already completed');
  bullet(155, `Move or top up funding where the work actually is. ${money(a.totals.coverable)} of the shortfall already exists as surplus`
    + ` inside the same business unit — no new commitment is needed, only reallocation.`, RED);
  bullet(245, `Fund the sites that carry no PO headroom at all. These are the sites where invoices are held back the longest,`
    + ` and where the ageing is worst.`, AMBER);
  bullet(325, `Review purchase orders before they are closed. ${money(a.totals.closedFunds)} sits on POs that can no longer be`
    + ` invoiced against`
    + (a.totals.neverUsedCount ? `, including ${a.totals.neverUsedCount} that were never used at all.` : '.'), NAVY);
  doc.roundedRect(56, 410, W - 112, 130, 8).fill('#f8fafc');
  doc.fillColor(NAVY).fontSize(17).font('Helvetica-Bold').text('What this unlocks', 80, 438);
  doc.fillColor('#1f2937').fontSize(13.5).font('Helvetica')
    .text(`${a.totals.invoices} invoices covering ${money(a.totals.pending)} of completed and accepted ${svc} work,`
      + ` submitted and paid on normal terms.`, 80, 468, { width: W - 160, lineGap: 4 });

  doc.end();
  return doc;
}

module.exports = { analyse, buildWorkbook, buildDeck };
