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

const HANDLERS = { 'invoice-copies': runInvoiceCopies };

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
  configure, start, kick, tick, purgeExpired,
  requestInvoiceCopies, REPORTS_DIR, MAX_INVOICES_PER_JOB, KEEP_DAYS,
};
