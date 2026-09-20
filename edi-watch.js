'use strict';
// ─── edi-watch.js ───────────────────────────────────────────────────────────
// An invoice can leave the portal and never arrive at Amazon in two ways, and
// until now neither one told anybody.
//
//   FAILED    the transmitter reported an error. Already retried twice (30s,
//             60s) before it is logged, so a logged FAIL is a real failure, not
//             a blip. One hid among 44 successes on 2026-09-18 and was found
//             two days later by reading the audit log.
//
//   MISSING   the transmitter reported OK and Amazon has no record of it. This
//             is the quieter and worse case: 21 invoices worth $440,457 were
//             sitting in it, the oldest sent 65 days earlier. Checked three
//             ways against the raw feed — base number, the number actually
//             sent, and any suffixed resubmission variant — so a resubmission
//             under a new number is not mistaken for a disappearance.
//
// Both self-heal in the sense that the invoice stays on Needs Upload, but
// silence is the problem: nobody knew to go and look (Edwin 2026-09-20).
//
// READ-ONLY against Amazon. This never transmits, never retries, never touches
// an invoice. It reads the audit log and the feed, and raises an alert.

const db = require('./db');

// How long Amazon's feed is allowed to take before a successful send is
// considered missing rather than merely in flight. The Payee feed refreshes
// every 30 minutes; 48h is the same grace window recentTransmitAt already uses
// to suppress re-sending, so the two agree.
const GRACE_HOURS = Number(process.env.EDI_MISSING_GRACE_HOURS || 48);

function init() {
  db.getDb().exec(`CREATE TABLE IF NOT EXISTS edi_watch (
    record_no     TEXT NOT NULL,
    kind          TEXT NOT NULL,          -- failed | missing
    invoice_id    TEXT,
    po_number     TEXT,
    amount        REAL,
    transmitted_at TEXT,
    detail        TEXT,
    first_seen_at TEXT NOT NULL,
    alerted_at    TEXT,
    resolved_at   TEXT,
    PRIMARY KEY (record_no, kind)
  )`);
}

/**
 * Both categories, computed fresh. Pure — writes nothing.
 * `invoices` is the Sage cache; only OPEN invoices can be in trouble, since a
 * paid one plainly arrived.
 */
function check(invoices, { payee } = {}) {
  const p = payee || require('./payee');
  const byRec = new Map((invoices || []).map(i => [i.recordNo, i]));

  // The LAST attempt per invoice decides. An invoice that failed and was then
  // re-sent successfully is not a failure, and vice versa.
  const last = db.getDb().prepare(`
    SELECT record_no, detail, created_at FROM audit_log a
    WHERE action='edi_transmit'
      AND created_at = (SELECT MAX(created_at) FROM audit_log b
                        WHERE b.action='edi_transmit' AND b.record_no = a.record_no)
    ORDER BY created_at DESC`).all();

  const failed = [], missing = [];
  for (const row of last) {
    const inv = byRec.get(row.record_no);
    if (!inv) continue;                       // closed or paid — it arrived
    const ok = /-> OK/.test(row.detail || '');
    const live = p.resolveInvoice(p.toPayeeId(inv.invoiceId));
    if (live) continue;                       // Amazon has it; nothing to say

    const at = String(row.created_at).replace(' ', 'T') + (String(row.created_at).endsWith('Z') ? '' : 'Z');
    const hours = (Date.now() - new Date(at).getTime()) / 3600000;
    const base = {
      recordNo: row.record_no, invoiceId: inv.invoiceId,
      poNumber: inv.poNumber || null, amount: inv.totalEntered || 0,
      transmittedAt: row.created_at, hoursAgo: Math.round(hours),
      detail: String(row.detail || '').slice(0, 200),
    };
    if (!ok) {
      failed.push(base);
    } else if (hours > GRACE_HOURS) {
      // Sent, acknowledged, and still invisible well past the feed's lag.
      missing.push(base);
    }
  }

  const sum = l => Math.round(l.reduce((t, x) => t + (x.amount || 0), 0) * 100) / 100;
  failed.sort((a, b) => b.amount - a.amount);
  missing.sort((a, b) => b.hoursAgo - a.hoursAgo);
  return {
    failed, missing,
    totals: { failedCount: failed.length, failedAmount: sum(failed),
              missingCount: missing.length, missingAmount: sum(missing),
              graceHours: GRACE_HOURS },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Persist and return only what is NEW, so an invoice is alerted once rather
 * than every hour. Returns { newly, resolved, analysis }.
 */
function sweep(invoices, opts) {
  init();
  const a = check(invoices, opts);
  const d = db.getDb();
  const now = new Date().toISOString();

  const prev = {};
  for (const r of d.prepare('SELECT record_no, kind, resolved_at FROM edi_watch').all()) {
    prev[`${r.record_no}|${r.kind}`] = r;
  }

  const up = d.prepare(`INSERT INTO edi_watch
      (record_no, kind, invoice_id, po_number, amount, transmitted_at, detail, first_seen_at, alerted_at, resolved_at)
      VALUES (?,?,?,?,?,?,?,?,NULL,NULL)
      ON CONFLICT(record_no, kind) DO UPDATE SET
        amount=excluded.amount, transmitted_at=excluded.transmitted_at,
        detail=excluded.detail, resolved_at=NULL`);

  const newly = [], seen = new Set();
  for (const kind of ['failed', 'missing']) {
    for (const x of a[kind]) {
      const k = `${x.recordNo}|${kind}`;
      seen.add(k);
      const was = prev[k];
      if (!was || was.resolved_at) newly.push({ ...x, kind });
      up.run(x.recordNo, kind, x.invoiceId, x.poNumber, x.amount, x.transmittedAt, x.detail,
        (was && was.first_seen_at) || now);
    }
  }

  // Anything we were watching that no longer qualifies has arrived, been
  // re-sent successfully, or been paid. Close it.
  const close = d.prepare('UPDATE edi_watch SET resolved_at=? WHERE record_no=? AND kind=? AND resolved_at IS NULL');
  const resolved = [];
  for (const [k, r] of Object.entries(prev)) {
    if (seen.has(k) || r.resolved_at) continue;
    close.run(now, r.record_no, r.kind);
    resolved.push(r);
  }
  return { newly, resolved, analysis: a };
}

function markAlerted(items) {
  if (!items || !items.length) return;
  const d = db.getDb();
  const now = new Date().toISOString();
  const s = d.prepare('UPDATE edi_watch SET alerted_at=? WHERE record_no=? AND kind=?');
  for (const x of items) s.run(now, x.recordNo, x.kind);
}

/** Everything currently open, for the screen. */
function open() {
  init();
  try {
    return db.getDb().prepare(`SELECT * FROM edi_watch WHERE resolved_at IS NULL
      ORDER BY kind, amount DESC`).all();
  } catch (e) { return []; }
}

module.exports = { init, check, sweep, markAlerted, open, GRACE_HOURS };
