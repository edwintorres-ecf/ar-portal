'use strict';
// ─── amazon-no-bu-report.js ─────────────────────────────────────────────────
// Everything Amazon that has no business unit behind it.
//
// A business unit comes from the Amazon location master (amazon_locations). A
// site that is not in the master has no BU, so it falls out of every per-BU
// view: it is absent from the BU tiles, it lands in "(not in the Amazon master)"
// on the funds report, and it gets no BU workbook of its own. The money is real
// and open — it is simply invisible to the reporting everyone actually reads.
//
// Deliberately NOT snow-filtered. A site missing from the master is missing for
// landscaping and cleaning too, and this is a data-hygiene report rather than
// something we hand to Amazon (Edwin 2026-09-14).

const db = require('./db');
const poLedger = require('./po-ledger');
const siteLedger = require('./site-ledger');
const payee = require('./payee');

const money = '$#,##0.00';

function analyse(invoices, { snowOnly = false } = {}) {
  const ledger = poLedger.getPoLedger(invoices);
  const rows = siteLedger.buildAmazonRows(invoices, { payee })
    .filter(r => (r.amount || 0) > 0.005);

  const snowPos = new Set(ledger.filter(p => p.serviceType === 'snow').map(p => p.poNumber));
  const noBu = (v) => !String(v || '').trim();

  const invRows = rows.filter(r => noBu(r.businessUnit) && (!snowOnly || snowPos.has(r.po)));
  const poRows = ledger.filter(p => noBu(p.businessUnit) && (!snowOnly || p.serviceType === 'snow'));

  // One row per site, which is the unit of the fix: add the site to the master
  // and everything below it gets a business unit.
  let master = {};
  try { master = db.getAmazonLocationMap() || {}; } catch (e) {}

  const sites = {};
  const ensure = (code) => (sites[code] = sites[code] || {
    site: code, openAr: 0, invoices: 0, poValue: 0, poAvailable: 0, pos: 0,
    services: new Set(), statuses: {}, inMaster: !!master[code],
    masterBu: master[code] ? (master[code].business_unit || '') : null,
    city: master[code] ? (master[code].city || '') : '',
    state: master[code] ? (master[code].state || '') : '',
  });

  for (const r of invRows) {
    const s = ensure(r.site || '(no site code)');
    s.openAr += r.amount || 0; s.invoices++;
    const st = r.payeeStatus || 'Not submitted';
    s.statuses[st] = (s.statuses[st] || 0) + 1;
  }
  for (const p of poRows) {
    const s = ensure(p.siteCode || '(no site code)');
    s.poValue += p.ceilingAmount || 0;
    s.poAvailable += p.available || 0;
    s.pos++;
    if (p.serviceType) s.services.add(p.serviceType);
  }

  const siteList = Object.values(sites)
    .map(s => ({ ...s, services: [...s.services].sort().join(', '), statusText: Object.entries(s.statuses).map(([k, v]) => `${k} ${v}`).join(' · ') }))
    .sort((a, b) => (b.openAr + b.poAvailable) - (a.openAr + a.poAvailable));

  const totals = {
    sites: siteList.length,
    // Split out, because the two need different fixes: a site genuinely absent
    // from the master has to be added; a site present with a blank business
    // unit just needs the field filled in.
    notInMaster: siteList.filter(s => !s.inMaster).length,
    blankBuInMaster: siteList.filter(s => s.inMaster).length,
    openAr: invRows.reduce((t, r) => t + (r.amount || 0), 0),
    invoices: invRows.length,
    poValue: poRows.reduce((t, p) => t + (p.ceilingAmount || 0), 0),
    poAvailable: poRows.reduce((t, p) => t + (p.available || 0), 0),
    pos: poRows.length,
  };

  return { siteList, invRows, poRows, totals, snowOnly, generatedAt: new Date().toISOString() };
}

async function buildWorkbook(invoices, opts = {}) {
  const a = analyse(invoices, opts);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ECF AR Portal';
  const NAVY = 'FF1E3A5F', GRAY = 'FFF1F5F9', RED = 'FFFEE2E2', AMBER = 'FFFEF3C7';
  const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

  // ── Sheet 1: what to fix ──
  const s1 = wb.addWorksheet('Sites to fix', { views: [{ state: 'frozen', ySplit: 8 }] });
  s1.mergeCells('A1:I1');
  s1.getCell('A1').value = `Amazon sites with no business unit${a.snowOnly ? ' (snow only)' : ''} — generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
  s1.getCell('A1').font = { bold: true, size: 13, color: { argb: NAVY } };
  s1.mergeCells('A2:I2');
  s1.getCell('A2').value = 'A business unit comes from the Amazon location master. A site that is not in the master has no BU, '
    + 'so it disappears from the BU tiles, the per-BU workbooks and the per-BU case studies — the money is open, it is just not being looked at.';
  s1.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
  s1.addRow([]);

  for (const [k, v, fmt] of [
    ['Sites with no business unit', a.totals.sites, null],
    ['   of those, not in the master at all', a.totals.notInMaster, null],
    ['   in the master but the BU field is blank', a.totals.blankBuInMaster, null],
    ['Open AR behind them', a.totals.openAr, money],
    ['Still available on their POs', a.totals.poAvailable, money],
  ]) {
    const r = s1.addRow([k, v]);
    r.getCell(1).font = { size: 11 };
    r.getCell(2).font = { bold: true, size: 11, color: { argb: NAVY } };
    if (fmt) r.getCell(2).numFmt = fmt;
  }
  s1.getColumn(1).width = 44; s1.getColumn(2).width = 16;
  s1.addRow([]);

  const h = s1.addRow(['Site', 'In the master?', 'City', 'State', 'Open AR', 'Invoices', 'PO value', 'Still available', 'Services', 'Payee Central status']);
  h.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
  [10, 26, 18, 7, 14, 10, 14, 15, 22, 40].forEach((w, i) => { s1.getColumn(i + 1).width = w; });
  for (const s of a.siteList) {
    const r = s1.addRow([s.site, s.inMaster ? 'yes — BU field is blank' : 'NO — add it', s.city, s.state,
      s.openAr, s.invoices, s.poValue, s.poAvailable, s.services, s.statusText]);
    [5, 7, 8].forEach(ci => { r.getCell(ci).numFmt = money; });
    r.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.inMaster ? AMBER : RED } };
  }

  // ── Sheet 2: the POs ──
  const s2 = wb.addWorksheet('POs', { views: [{ state: 'frozen', ySplit: 1 }] });
  const h2 = s2.addRow(['PO', 'Site', 'Service', 'Status', 'PO value', 'Billed', 'Still available', 'Waiting to bill', 'Document']);
  h2.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
  [16, 10, 13, 22, 14, 14, 15, 15, 60].forEach((w, i) => { s2.getColumn(i + 1).width = w; });
  for (const p of a.poRows.sort((x, y) => (y.available || 0) - (x.available || 0))) {
    const r = s2.addRow([p.poNumber, p.siteCode || '(none)', p.serviceType || '', p.poStatus || '',
      p.ceilingAmount, p.consumed, p.available, p.pendingUpload || 0, p.docUrl || '']);
    [5, 6, 7, 8].forEach(ci => { r.getCell(ci).numFmt = money; });
  }

  // ── Sheet 3: the invoices ──
  const s3 = wb.addWorksheet('Open invoices', { views: [{ state: 'frozen', ySplit: 1 }] });
  const h3 = s3.addRow(['Invoice', 'Site', 'PO', 'Amount', 'Payee Central status', 'Customer']);
  h3.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
  [16, 10, 16, 14, 28, 34].forEach((w, i) => { s3.getColumn(i + 1).width = w; });
  for (const r0 of a.invRows.sort((x, y) => (y.amount || 0) - (x.amount || 0))) {
    const r = s3.addRow([r0.invoiceId || r0.payeeId || '', r0.site || '(none)', r0.po || '',
      r0.amount, r0.payeeStatus || 'Not submitted', r0.customerName || '']);
    r.getCell(4).numFmt = money;
  }

  return { workbook: wb, analysis: a };
}

module.exports = { analyse, buildWorkbook };
