'use strict';
// ─── reports.js — background report/copy builder ────────────────────────────
// Fetching one Omnia invoice PDF takes 17-26 seconds. Asking for copies of a
// dozen invoices therefore meant several minutes of staring at a spinner, with
// nothing else possible in the meantime. Requests are now QUEUED: the user asks,
// carries on working, and collects the finished file from Reports when it is
// ready (Edwin 2026-09-10).
//
// Deliberately SERIAL. The whole point is not to hammer Omnia — the existing
// per-invoice de-duplication exists because three clicks once became three
// separate 20-second fetches in production. One job, one invoice at a time.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const zipfile = require('./zipfile');

const REPORTS_DIR = path.join(__dirname, 'reports');
const MAX_INVOICES_PER_JOB = 500;
const KEEP_DAYS = 7;

// Injected by app.js so this module does not have to reach back into the web
// layer for Sage/Omnia access (and so it can be tested with a fake).
let _fetchInvoicePdfBuffer = null;
let _getInvoices = null;
function configure({ fetchInvoicePdfBuffer, getInvoices }) {
  _fetchInvoicePdfBuffer = fetchInvoicePdfBuffer;
  _getInvoices = getInvoices;
}

function ensureDir() {
  try { fs.mkdirSync(REPORTS_DIR, { recursive: true }); } catch (e) { /* exists */ }
  return REPORTS_DIR;
}

function safeFilePart(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';
}

// ─── Enqueue ────────────────────────────────────────────────────────────────
// `invoices` is the ALREADY-SCOPED list the caller resolved for this user, so
// the worker never has to re-derive who may see what.
function requestInvoiceCopies({ userEmail, invoices, label }) {
  const list = (invoices || []).slice(0, MAX_INVOICES_PER_JOB);
  if (!list.length) throw new Error('No invoices to copy');
  const job = db.createReportJob({
    userEmail,
    kind: 'invoice-copies',
    label: label || `${list.length} invoice cop${list.length === 1 ? 'y' : 'ies'}`,
    params: { invoices: list.map(i => ({ recordNo: i.recordNo, invoiceId: i.invoiceId })) },
    totalCount: list.length,
    expiresDays: KEEP_DAYS,
  });
  kick();
  return { job, queued: list.length, capped: (invoices || []).length > MAX_INVOICES_PER_JOB };
}

// ─── Worker ─────────────────────────────────────────────────────────────────
let _running = false;
let _timer = null;

async function runInvoiceCopies(job) {
  const params = JSON.parse(job.params || '{}');
  const wanted = params.invoices || [];
  const all = await _getInvoices();
  const byRecord = new Map(all.map(i => [String(i.recordNo), i]));

  const files = [];
  const missing = [];
  let done = 0;

  for (const w of wanted) {
    // Cancelled or deleted mid-run: stop cleanly rather than finish work nobody
    // is waiting for.
    const cur = db.getReportJob(job.id);
    if (!cur || cur.status === 'cancelled') return { cancelled: true };

    const inv = byRecord.get(String(w.recordNo));
    if (!inv) { missing.push(`${w.invoiceId || w.recordNo} (no longer in the open book)`); done++; continue; }
    try {
      const buf = await _fetchInvoicePdfBuffer(inv);
      if (buf && buf.length) files.push({ name: `${inv.invoiceId || inv.recordNo}.pdf`, data: buf });
      else missing.push(`${inv.invoiceId || inv.recordNo} (no PDF source)`);
    } catch (e) {
      // One unavailable PDF must not lose the other 39 — record it and continue.
      missing.push(`${inv.invoiceId || inv.recordNo} (${String(e.message).slice(0, 80)})`);
    }
    done++;
    db.updateReportJob(job.id, { done_count: done, missing: JSON.stringify(missing) });
  }

  if (!files.length) {
    throw new Error(`No PDF could be produced for any of the ${wanted.length} invoice(s)`);
  }

  ensureDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let filename, body, contentType;
  if (files.length === 1) {
    filename = files[0].name;
    body = files[0].data;
    contentType = 'application/pdf';
  } else {
    filename = `invoice-copies-${stamp}.zip`;
    body = zipfile.build(files);
    contentType = 'application/zip';
  }
  const filePath = path.join(REPORTS_DIR, `job-${job.id}-${safeFilePart(filename)}`);
  fs.writeFileSync(filePath, body);
  return { filename, filePath, size: body.length, contentType, missing, count: files.length };
}

// ─── Amazon site statements ─────────────────────────────────────────────────
// Built here rather than inline in a request because a statement per site
// across a filtered set can be dozens of sheets, and nobody should wait on it.
let _buildStatements = null;      // injected by app.js (needs the row builder)
function configureStatements(fn) { _buildStatements = fn; }

async function runAmazonStatements(job) {
  if (!_buildStatements) throw new Error('Statement builder not configured');
  const params = JSON.parse(job.params || '{}');
  const statements = await _buildStatements(params.sites || [], params.userEmail);
  if (!statements.length) throw new Error('No sites matched that request');

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ECF AR Portal';
  const NAVY = 'FF1E3A5F', GRAY = 'FFF1F5F9', RED = 'FFFEE2E2', AMBER = 'FFFEF3C7';
  const money = '$#,##0.00';

  // Summary first: which sites are blocked and by how much.
  const sum = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
  sum.addRow(['Site', 'Business Unit', 'Invoices', 'Open', 'Blocked', 'PO needed', 'Funds needed', 'Rejected', 'Amazon contact']);
  sum.getRow(1).eachCell(c => { c.font = { bold: true, color: { argb: 'FF334155' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
  [14, 16, 10, 15, 15, 12, 15, 10, 30].forEach((w, i) => { sum.getColumn(i + 1).width = w; });
  for (const st of statements) {
    const fundsAsk = st.actions.fundsNeeded.reduce((t, a) => t + (a.shortfall || 0), 0);
    const row = sum.addRow([st.siteCode, st.businessUnit, st.totals.invoices, st.totals.amount, st.totals.blocked,
      st.actions.poNeeded.amount || null, fundsAsk || null, st.actions.rejected.length || null, st.amazonContact || '']);
    [4, 5, 6, 7].forEach(ci => { row.getCell(ci).numFmt = money; });
    if (st.totals.blocked > 0) row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMBER } };
  }
  let job_done = 0;

  for (const st of statements) {
    // Excel sheet names cannot exceed 31 chars or contain []:*?/\
    const ws = wb.addWorksheet(String(st.siteCode).replace(/[\[\]:*?\/\\]/g, '-').slice(0, 31));
    ws.mergeCells('A1:H1');
    const t = ws.getCell('A1');
    t.value = `Amazon statement — ${st.siteCode}${st.businessUnit ? ' (' + st.businessUnit + ')' : ''}`
      + `${st.city ? ' · ' + st.city + ', ' + st.state : ''} — generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
    t.font = { bold: true, size: 12, color: { argb: NAVY } };
    ws.addRow([`Amazon contact: ${st.amazonContact || 'not known'}`, '', `ECF owner: ${st.internalOwner || 'unassigned'}`]);
    ws.addRow([`${st.totals.invoices} open invoices · ${st.totals.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} · ${st.totals.blocked.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} blocked pending action`]);
    ws.addRow([]);

    if (st.actions.fundsNeeded.length) {
      ws.addRow(['PURCHASE ORDERS NEEDING ADDITIONAL FUNDS']).getCell(1).font = { bold: true, color: { argb: 'FF991B1B' } };
      const h = ws.addRow(['PO', 'PO value', 'Remaining', 'Invoices against it', 'Value of those', 'Shortfall']);
      h.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
      for (const a of st.actions.fundsNeeded) {
        const r = ws.addRow([a.po, a.poAmount, a.available, a.invoices, a.amount, a.shortfall]);
        [2, 3, 5, 6].forEach(ci => { r.getCell(ci).numFmt = money; });
        r.getCell(6).font = { bold: true, color: { argb: 'FF991B1B' } };
      }
      ws.addRow([]);
    }
    if (st.actions.rejected.length) {
      ws.addRow(['REJECTED BY AMAZON — NEEDS CORRECTION']).getCell(1).font = { bold: true, color: { argb: 'FF991B1B' } };
      const h = ws.addRow(['Invoice', 'PO', 'Amount', 'Reason given', 'Rejected by']);
      h.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
      for (const r of st.actions.rejected) {
        const row = ws.addRow([r.invoiceId, r.po || '', r.amount, r.reason || 'not stated', r.rejectedBy || '']);
        row.getCell(3).numFmt = money;
        row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } };
      }
      ws.addRow([]);
    }
    if (st.actions.poNeeded.count) {
      ws.addRow([`A PURCHASE ORDER NEEDS TO BE ISSUED — ${st.actions.poNeeded.count} invoice(s), ${st.actions.poNeeded.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`])
        .getCell(1).font = { bold: true, color: { argb: 'FF92400E' } };
      ws.addRow([]);
    }

    ws.addRow(['ALL OPEN INVOICES']).getCell(1).font = { bold: true, color: { argb: NAVY } };
    const hh = ws.addRow(['Invoice', 'Invoice date', 'PO', 'Amount', 'Payee Central status', 'In Payee Central since', 'Days there', 'What it needs']);
    hh.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; });
    [16, 13, 16, 14, 26, 20, 11, 40].forEach((w, i) => { ws.getColumn(i + 1).width = Math.max(ws.getColumn(i + 1).width || 0, w); });
    for (const g of st.groups) {
      for (const inv of g.invoices) {
        const r = ws.addRow([inv.invoiceId, inv.invoiceDate, inv.po || '', inv.amount, inv.payeeStatus,
          inv.payeeEntryDate || '', inv.daysInPayee ?? '', inv.rejectionReason ? `${g.label} — ${inv.rejectionReason}` : (inv.needDetail || g.label)]);
        r.getCell(4).numFmt = money;
        if (['rejected', 'funds-needed', 'po-needed'].includes(g.need)) {
          r.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } };
        } else if (g.need === 'goods-receipt') {
          r.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMBER } };
        }
      }
    }
    job_done++;
    db.updateReportJob(job.id, { done_count: job_done });
  }

  ensureDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = statements.length === 1
    ? `amazon-statement-${statements[0].siteCode}-${stamp}.xlsx`
    : `amazon-statements-${statements.length}-sites-${stamp}.xlsx`;
  const filePath = path.join(REPORTS_DIR, `job-${job.id}-${safeFilePart(filename)}`);
  const buf = await wb.xlsx.writeBuffer();
  fs.writeFileSync(filePath, Buffer.from(buf));
  return { filename, filePath, size: buf.byteLength, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', missing: [], count: statements.length };
}

function requestAmazonStatements({ userEmail, sites, label }) {
  const list = (sites || []).filter(Boolean);
  if (!list.length) throw new Error('No sites to build a statement for');
  const job = db.createReportJob({
    userEmail, kind: 'amazon-statement',
    label: label || (list.length === 1 ? `Amazon statement — ${list[0]}` : `Amazon statements — ${list.length} sites`),
    params: { sites: list, userEmail },
    totalCount: list.length, expiresDays: KEEP_DAYS,
  });
  kick();
  return { job, queued: list.length };
}

const HANDLERS = { 'invoice-copies': runInvoiceCopies, 'amazon-statement': runAmazonStatements };

async function tick() {
  if (_running) return;
  _running = true;
  try {
    for (;;) {
      const job = db.claimNextReportJob();
      if (!job) break;
      try {
        const handler = HANDLERS[job.kind];
        if (!handler) throw new Error('Unknown report kind: ' + job.kind);
        const out = await handler(job);
        if (out && out.cancelled) { continue; }
        db.updateReportJob(job.id, {
          status: 'done',
          filename: out.filename, file_path: out.filePath,
          size_bytes: out.size, content_type: out.contentType,
          missing: JSON.stringify(out.missing || []),
          done_count: job.total_count,
          finished_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
        db.auditLog(job.user_email, 'report_ready', String(job.id), `${job.kind}: ${out.filename} (${out.count} file(s))`);
      } catch (e) {
        console.error('[reports] job', job.id, 'failed:', e.message);
        db.updateReportJob(job.id, {
          status: 'failed', error: String(e.message).slice(0, 300),
          finished_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
      }
    }
  } finally {
    _running = false;
  }
}

// Start work now if nothing is in flight. Errors are swallowed on purpose: the
// caller is an HTTP request that has already been answered.
function kick() {
  setImmediate(() => tick().catch(e => console.error('[reports] tick:', e.message)));
}

// ─── Housekeeping ───────────────────────────────────────────────────────────
function purgeExpired() {
  let removed = 0;
  for (const j of db.expiredReportJobs()) {
    if (j.file_path) { try { fs.unlinkSync(j.file_path); } catch (e) { /* already gone */ } }
    db.deleteReportJob(j.id);
    removed++;
  }
  return removed;
}

function start() {
  ensureDir();
  // A job left 'running' by a restart is nobody's work — put it back in the
  // queue or it blocks the head of the line for ever.
  const reset = db.resetStuckReportJobs();
  if (reset) console.log(`[reports] requeued ${reset} job(s) interrupted by a restart`);
  purgeExpired();
  kick();
  clearInterval(_timer);
  _timer = setInterval(() => {
    purgeExpired();
    tick().catch(e => console.error('[reports] tick:', e.message));
  }, 60 * 1000);
  if (_timer.unref) _timer.unref();
}

module.exports = {
  configure, configureStatements, start, kick, tick, purgeExpired,
  requestInvoiceCopies, requestAmazonStatements, REPORTS_DIR, MAX_INVOICES_PER_JOB, KEEP_DAYS,
};
