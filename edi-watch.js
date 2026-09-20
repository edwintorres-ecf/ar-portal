'use strict';
// ─── edi-watch.js ───────────────────────────────────────────────────────────
// THE RULE (Edwin, 2026-09-20):
//   "All transmissions must be confirmed in Payee. If it does not exist in
//    Payee it does not exist and should be considered failed or needing upload.
//    A failed transmission later superseded by a successful one is resolved."
//
// So there is ONE state that matters — not in Payee — and one action: upload it.
// What our transmit log says is a CAUSE, never a verdict. An invoice we believe
// we sent successfully is in exactly the same position as one that errored:
// Amazon does not have it.
//
// The portal already works this way and I verified it rather than assuming:
// Needs Upload includes an invoice unless Payee shows it live, Uploaded refuses
// to list anything without a Payee entry (1,251 rows, 0 unconfirmed), and
// recentTransmitAt only decorates a row, it never removes one. This module adds
// the missing piece — telling someone — and nothing else.
//
// An invoice can reach that state two ways, and until now neither told anybody.
//
//   failed    the transmitter reported an error. Already retried twice (30s,
//             60s) before it is logged, so a logged FAIL is a real failure, not
//             a blip. One hid among 44 successes on 2026-09-18 and was found
//             two days later by reading the audit log.
//
//   no-confirmation
//             the transmitter reported OK and Amazon has no record of it. The
//             quieter and worse case: 21 invoices worth $440,457, the oldest
//             sent 65 days earlier. Checked three ways against the raw feed —
//             base number, the number actually sent, and any suffixed
//             resubmission variant — so a resubmission under a new number is
//             never mistaken for a disappearance.
//
// The grace window delays the ALERT, never the classification. The invoice is
// on Needs Upload from the moment Amazon does not have it; we simply do not
// shout for 48h, because the feed legitimately lags a fresh submission.
//
// READ-ONLY against Amazon. This never transmits, never retries, never touches
// an invoice. It reads the audit log and the feed, and raises an alert.

const db = require('./db');

// How long Amazon's feed is allowed to take before a successful send is
// considered unconfirmed rather than merely in flight.
//
// 24h (Edwin, 2026-09-20). Amazon's ingestion is "minutes to hours" and the
// feed refreshes every 30 minutes, so a full day is already generous; anything
// still invisible after that is not in flight.
//
// THIS IS THE ONLY DEFINITION. po-ledger imports it for the "🕓 Sent — awaiting
// Payee" badge and for the EDI preflight's duplicate-send warning, because
// those must agree with the alert. If the alert said "upload this" at 24h while
// the preflight still said "do not re-send, it will bounce as a duplicate"
// until 48h, there would be a full day where the portal contradicted itself.
const GRACE_HOURS = Number(process.env.EDI_MISSING_GRACE_HOURS || 24);

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
  // Amazon emails the reason within minutes of an EDI rejection. If we have one
  // for this invoice, say WHY rather than "no confirmation" — the reason is the
  // difference between "re-send it" and "it needs a bigger PO".
  let rejMail = {}, rejKey = (x) => x;
  try {
    const m = require('./edi-reject-mail');
    rejMail = m.map(); rejKey = m.keyOf;
  } catch (e) {}
  const rejectionFor = (invoiceId) => {
    const k = rejKey(invoiceId);
    if (!k) return null;
    if (rejMail[k]) return rejMail[k];
    // A resubmission is quoted with a letter suffix (AST003664A).
    const hit = Object.keys(rejMail).find(x => x.startsWith(k));
    return hit ? rejMail[hit] : null;
  };

  // The LAST attempt per invoice decides. An invoice that failed and was then
  // re-sent successfully is not a failure, and vice versa.
  const last = db.getDb().prepare(`
    SELECT record_no, detail, created_at FROM audit_log a
    WHERE action='edi_transmit'
      AND created_at = (SELECT MAX(created_at) FROM audit_log b
                        WHERE b.action='edi_transmit' AND b.record_no = a.record_no)
    ORDER BY created_at DESC`).all();

  // Both lists are the same state — not in Payee — kept apart only so the alert
  // can say WHY, and so a fresh send is not shouted about during feed lag.
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
    const rej = rejectionFor(inv.invoiceId);
    const amazonSaid = rej ? (rej.resolution || rej.error) : null;
    const withReason = { ...base,
      amazonReason: amazonSaid || null,
      amazonRejectedAt: rej ? rej.received_at : null,
      amazonSentAs: rej ? rej.invoice_sent : null };
    if (!ok) {
      // Superseded resolution is already handled: `last` is the invoice's most
      // recent attempt, so a failure followed by a success is never reported as
      // failed. It simply has to earn its confirmation like any other send.
      failed.push({ ...withReason, reason: 'transmit failed' });
    } else if (hours > GRACE_HOURS) {
      // Sent, acknowledged, and still invisible well past the feed's lag.
      // Amazon may already have told us why it never landed.
      missing.push({ ...withReason,
        reason: amazonSaid ? `Amazon rejected it — ${amazonSaid}` : 'no confirmation from Amazon' });
    }
  }

  const sum = l => Math.round(l.reduce((t, x) => t + (x.amount || 0), 0) * 100) / 100;
  failed.sort((a, b) => b.amount - a.amount);
  missing.sort((a, b) => b.hoursAgo - a.hoursAgo);
  // The single list the rule actually cares about.
  const notInPayee = [...failed, ...missing].sort((a, b) => b.amount - a.amount);
  return {
    notInPayee, failed, missing,
    totals: { count: notInPayee.length, amount: sum(notInPayee),
              withAmazonReason: notInPayee.filter(x => x.amazonReason).length,
              failedCount: failed.length, failedAmount: sum(failed),
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
