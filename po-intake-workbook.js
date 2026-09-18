'use strict';
// ─── po-intake-workbook.js ──────────────────────────────────────────────────
// The intake-health screen as a workbook someone can actually work from.
//
// The screen answers "how bad is it". A worklist has to answer "what do I do
// next, and in what order", so this is sorted by whether the PO is blocking and
// then by the money already waiting behind it, and every row carries the fix
// rather than just the fault (Edwin 2026-09-17, for Vincenzo).

const ExcelJS = require('exceljs');
const intake = require('./po-intake-health');

const MONEY = '"$"#,##0';
const INK = 'FF1A1814';
const SOFT = 'FF6B6458';
const LINE = 'FFE7E1D4';

// What to actually DO about each defect. The screen explains why it matters;
// a worklist has to say where to go and what to change.
const FIX = {
  'no-ceiling': 'Get the PO value from Amazon (Payee Central > PO detail, or ask the site), then enter it against the PO.',
  'no-site': 'Work out which site the PO belongs to from the PO document line items, then set the site on the PO.',
  'no-business-unit': 'Add the site to the Amazon location master so it maps to a business unit.',
  'ceiling-discrepancy': 'Compare Amazon\'s figure with the PO document and establish which is right before billing more against it.',
  'no-document': 'Obtain the PO document from Amazon and attach it, so value, site and line items can be checked.',
  'closed-with-funds': 'Ask Amazon to reopen the PO, or write the remaining balance off as unbillable.',
  'overdrawn': 'Get the PO increased to cover what has been billed, or credit the excess.',
};

function styleHeader(row, from = 1, to = 12) {
  row.height = 22;
  for (let c = from; c <= to; c++) {
    const cell = row.getCell(c);
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  }
}

/**
 * `docCheck` is an optional per-PO document comparison for the ceiling
 * discrepancies: what Amazon says, what document the portal is reading, and
 * what the NEWEST document we hold says. It is passed in rather than computed
 * here because producing it means downloading and parsing PDFs from SharePoint,
 * which is far too slow to sit behind a download button.
 */
function build(invoices, { snowOnly = false, docCheck = null } = {}) {
  const a = intake.analyse(invoices, { snowOnly });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ECF AR Portal';
  wb.created = new Date();

  const today = new Date().toLocaleDateString('en-US',
    { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });

  // ── Sheet 1: the worklist ────────────────────────────────────────────────
  const s1 = wb.addWorksheet('Fix these', { views: [{ state: 'frozen', ySplit: 6 }] });
  s1.columns = [
    { width: 4 }, { width: 18 }, { width: 9 }, { width: 16 }, { width: 10 },
    { width: 14 }, { width: 14 }, { width: 14 }, { width: 30 }, { width: 62 }, { width: 12 },
  ];

  const t = s1.addRow(['', 'Amazon PO intake — items to fix']);
  t.getCell(2).font = { bold: true, size: 16, color: { argb: INK } };
  s1.addRow(['', `Prepared ${today} from the AR Portal (PO Manager > Intake health)`])
    .getCell(2).font = { size: 10, color: { argb: SOFT } };
  s1.addRow(['', snowOnly
    ? 'Scope: snow and ice purchase orders only.'
    : 'Scope: all purchase orders, snow and landscaping.'])
    .getCell(2).font = { size: 10, color: { argb: SOFT } };
  s1.addRow(['', `${a.totals.posWithDefects} POs need attention, of which ${a.totals.blocking} cannot be billed against at all. `
    + `$${Math.round(a.totals.atRisk).toLocaleString('en-US')} of finished work is already waiting behind them.`])
    .getCell(2).font = { size: 10, bold: true, color: { argb: INK } };
  s1.addRow([]);

  const h = s1.addRow(['', 'PO number', 'Site', 'Business unit', 'Service',
    'PO value', 'Available', 'Waiting', 'What is wrong', 'What to do', 'Blocking?']);
  styleHeader(h, 2, 11);

  for (const p of a.pos) {
    const defectLabels = p.defects.map(d => (a.checks.find(c => c.key === d) || {}).label || d).join('; ');
    const fixes = [...new Set(p.defects.map(d => FIX[d]).filter(Boolean))].join(' ');
    const r = s1.addRow(['', p.poNumber, p.siteCode || '', p.businessUnit || '', p.serviceType || '',
      p.value == null ? null : p.value, p.available == null ? null : p.available,
      p.pendingUpload || 0, defectLabels, fixes, p.blocking ? 'YES' : '']);
    r.getCell(6).numFmt = MONEY;
    r.getCell(7).numFmt = MONEY;
    r.getCell(8).numFmt = MONEY;
    r.getCell(9).alignment = { wrapText: true, vertical: 'top' };
    r.getCell(10).alignment = { wrapText: true, vertical: 'top' };
    r.getCell(11).font = { bold: true, color: { argb: p.blocking ? 'FFB32020' : SOFT } };
    // A missing value is different from a zero value, and the difference is the
    // entire point of the no-ceiling check. Leave the cell empty and say so.
    if (p.value == null) {
      r.getCell(6).value = 'not set';
      r.getCell(6).font = { italic: true, color: { argb: 'FFB32020' } };
    }
    if (p.docUrl) {
      r.getCell(2).value = { text: p.poNumber, hyperlink: p.docUrl };
      r.getCell(2).font = { color: { argb: 'FF3763A0' }, underline: true };
    }
    for (let c = 2; c <= 11; c++) {
      r.getCell(c).border = { bottom: { style: 'thin', color: { argb: LINE } } };
    }
  }
  s1.autoFilter = { from: { row: 6, column: 2 }, to: { row: 6, column: 11 } };

  // ── Sheet 2: grouped by defect, so the same fix can be batched ───────────
  const s2 = wb.addWorksheet('By problem');
  s2.columns = [{ width: 4 }, { width: 34 }, { width: 10 }, { width: 14 }, { width: 12 }, { width: 76 }];
  const t2 = s2.addRow(['', 'Grouped by problem']);
  t2.getCell(2).font = { bold: true, size: 14, color: { argb: INK } };
  s2.addRow(['', 'Several POs usually share one cause, and one trip to Amazon can clear a whole group.'])
    .getCell(2).font = { size: 10, color: { argb: SOFT } };
  s2.addRow([]);
  const h2 = s2.addRow(['', 'Problem', 'POs', 'Waiting', 'Blocking?', 'Why it matters']);
  styleHeader(h2, 2, 6);
  for (const c of a.checks) {
    if (!c.count) continue;
    const r = s2.addRow(['', c.label, c.count, c.atRisk, c.blocking ? 'YES' : '', c.why]);
    r.getCell(4).numFmt = MONEY;
    r.getCell(5).font = { bold: true, color: { argb: c.blocking ? 'FFB32020' : SOFT } };
    r.getCell(6).alignment = { wrapText: true, vertical: 'top' };
    r.getCell(2).font = { bold: true };
  }
  s2.addRow([]);
  const note = s2.addRow(['', 'A PO can appear under more than one problem, so these counts add to more than the '
    + `${a.totals.posWithDefects} on the first sheet.`]);
  note.getCell(2).font = { size: 10, italic: true, color: { argb: SOFT } };

  // ── Sheet 3: the state of the book ──────────────────────────────────────
  const s3 = wb.addWorksheet('Summary');
  s3.columns = [{ width: 4 }, { width: 42 }, { width: 18 }];
  const t3 = s3.addRow(['', 'Where intake stands']);
  t3.getCell(2).font = { bold: true, size: 14, color: { argb: INK } };
  s3.addRow([]);
  const rows = [
    ['POs checked', a.totals.posChecked],
    ['POs with something wrong', a.totals.posWithDefects],
    ['— of those, cannot be billed against', a.totals.blocking],
    ['POs that are clean', a.totals.clean],
    ['Share of the book ready to bill', `${a.totals.readyPct}%`],
    ['Finished work waiting behind a broken PO', a.totals.atRisk],
  ];
  for (const [label, val] of rows) {
    const r = s3.addRow(['', label, val]);
    r.getCell(2).font = { color: { argb: INK } };
    if (typeof val === 'number' && label.startsWith('Finished')) r.getCell(3).numFmt = MONEY;
    r.getCell(3).font = { bold: true };
  }
  s3.addRow([]);
  s3.addRow(['', 'Figures are live from Sage and Amazon Payee Central at the time this was generated.'])
    .getCell(2).font = { size: 10, italic: true, color: { argb: SOFT } };
  s3.addRow(['', 'The portal recomputes this hourly; this file is a point-in-time copy.'])
    .getCell(2).font = { size: 10, italic: true, color: { argb: SOFT } };

  // ── Sheet 4: the exceptions, checked against every document we hold ──────
  if (docCheck && docCheck.length) {
    // Header lands on row 5 (title, blurb, count, blank, header).
    const s4 = wb.addWorksheet('Exceptions checked', { views: [{ state: 'frozen', ySplit: 5 }] });
    s4.columns = [{ width: 4 }, { width: 18 }, { width: 9 }, { width: 15 }, { width: 15 },
      { width: 15 }, { width: 13 }, { width: 34 }, { width: 62 }];
    const t4 = s4.addRow(['', 'Ceiling discrepancies — checked against every document on file']);
    t4.getCell(2).font = { bold: true, size: 14, color: { argb: INK } };
    s4.addRow(['', 'For each of these the portal reported that the PO document disagrees with Amazon. '
      + 'Every document we hold for the PO was re-read to see whether we are simply reading an older one.'])
      .getCell(2).font = { size: 10, color: { argb: SOFT } };
    const resolves = docCheck.filter(d => d.resolves).length;
    s4.addRow(['', `${resolves} of ${docCheck.length} resolve by reading the newest document. `
      + `The other ${docCheck.length - resolves} genuinely disagree with Amazon and need reconciling.`])
      .getCell(2).font = { size: 10, bold: true, color: { argb: INK } };
    s4.addRow([]);
    const h4 = s4.addRow(['', 'PO number', 'Site', 'Amazon says', 'Portal reads',
      'Newest doc says', 'Gap', 'Newest document', 'What to do']);
    styleHeader(h4, 2, 9);

    for (const d of docCheck) {
      const gap = (d.amazon != null && d.newest != null) ? d.amazon - d.newest : null;
      const r = s4.addRow(['', d.poNumber, d.site || '', d.amazon, d.portal, d.newest,
        gap, d.newestFile || '', d.action]);
      for (const c of [4, 5, 6, 7]) r.getCell(c).numFmt = MONEY;
      r.getCell(9).alignment = { wrapText: true, vertical: 'top' };
      r.getCell(8).font = { size: 9, color: { argb: SOFT } };
      if (d.resolves) {
        for (let c = 2; c <= 9; c++) {
          r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF3E7' } };
        }
        r.getCell(2).font = { bold: true, color: { argb: 'FF3F7238' } };
      }
      if (d.stale) r.getCell(8).font = { size: 9, bold: true, color: { argb: 'FFB45309' } };
      for (let c = 2; c <= 9; c++) r.getCell(c).border = { bottom: { style: 'thin', color: { argb: LINE } } };
    }
    s4.addRow([]);
    const n4 = s4.addRow(['', 'Shaded rows resolve by reading the newest document. '
      + 'A bolded file name means the portal is not currently reading that file.']);
    n4.getCell(2).font = { size: 10, italic: true, color: { argb: SOFT } };
  }

  return { wb, analysis: a };
}

module.exports = { build };
