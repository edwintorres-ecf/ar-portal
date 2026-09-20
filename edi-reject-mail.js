'use strict';
// ─── edi-reject-mail.js ─────────────────────────────────────────────────────
// Amazon tells us why, immediately, and we were not listening.
//
// When an invoice fails Payee Central's EDI ingestion, Amazon emails
// arclerk@ from amazon-payee-central@email.amazon.com within minutes, with the
// invoice number and the reason in a fixed layout. The portal has been getting
// the reason the slow way instead — scraping each rejected invoice's detail
// page — and only for rejections that made it INTO Payee. An invoice bounced at
// the EDI gateway never appears there at all, so its reason existed nowhere in
// the portal (Edwin 2026-09-20: "We receive rejection emails right away that
// can give us the reason").
//
// 93 of these were sitting unread. Two reasons account for all of them:
//   53  Amazon has already processed an invoice with this number  (duplicate)
//   40  Total invoice amount exceeds the PO's available amount    (over ceiling)
//
// Both are actionable and neither was visible. The duplicate one especially:
// it means we re-sent something Amazon already had.
//
// READ-ONLY. Reads mail, writes its own table. Never sends, never transmits,
// never marks an invoice as anything.

const db = require('./db');
const g = require('./graph');

const MAILBOX = process.env.PO_MAILBOX || 'arclerk@eastcoastfacilities.com';
const SENDER = 'amazon-payee-central@email.amazon.com';

function init() {
  db.getDb().exec(`CREATE TABLE IF NOT EXISTS edi_rejections (
    message_id   TEXT PRIMARY KEY,
    invoice_key  TEXT NOT NULL,          -- normalised: letters+digits, no dash
    invoice_sent TEXT,                   -- exactly as Amazon quoted it
    error        TEXT,
    resolution   TEXT,
    received_at  TEXT,
    subject      TEXT,
    ingested_at  TEXT NOT NULL
  )`);
  db.getDb().exec(`CREATE INDEX IF NOT EXISTS idx_edi_rej_key ON edi_rejections(invoice_key)`);
  db.getDb().exec(`CREATE INDEX IF NOT EXISTS idx_edi_rej_at ON edi_rejections(received_at DESC)`);
}

const stripHtml = h => String(h || '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, '\n')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;/g, "'")
  .split('\n').map(s => s.trim()).filter(Boolean).join('\n');

/** Amazon's layout is label on one line, value on the next. */
function parse(msg) {
  const text = stripHtml(msg.body && msg.body.content);
  const lines = text.split('\n');
  const after = (label) => {
    const i = lines.findIndex(l => new RegExp(`^${label}\\s*:?$`, 'i').test(l));
    return i >= 0 ? (lines[i + 1] || '').trim() : null;
  };
  // The subject carries the number too, including any resubmission suffix
  // (AST003664A), which is the more reliable of the two.
  const fromSubject = (msg.subject || '').match(/Invoice\s+([A-Z0-9]+)\s+has failed/i);
  const invoice = after('Invoice#') || (fromSubject ? fromSubject[1] : null);
  if (!invoice) return null;
  return {
    messageId: msg.id,
    invoiceSent: invoice,
    invoiceKey: String(invoice).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    error: after('Error'),
    resolution: after('Resolution'),
    receivedAt: msg.receivedDateTime || null,
    subject: msg.subject || null,
  };
}

/**
 * Pull recent failure emails and store any we have not seen.
 * Returns { scanned, stored, newOnes }.
 */
async function ingest({ top = 100 } = {}) {
  init();
  // $filter on from/emailAddress plus $orderby is refused by Graph as an
  // "InefficientFilter", so search and narrow on this side.
  const r = await g.gGet(`/users/${encodeURIComponent(MAILBOX)}/messages`
    + `?$search="from:${SENDER}"&$top=${top}&$select=id,subject,receivedDateTime,body,from`);
  const msgs = (r.value || []).filter(m =>
    /has failed for Business/i.test(m.subject || '')
    && String(m.from && m.from.emailAddress && m.from.emailAddress.address || '').toLowerCase() === SENDER);

  const d = db.getDb();
  const have = new Set(d.prepare('SELECT message_id FROM edi_rejections').all().map(x => x.message_id));
  const ins = d.prepare(`INSERT OR IGNORE INTO edi_rejections
    (message_id, invoice_key, invoice_sent, error, resolution, received_at, subject, ingested_at)
    VALUES (?,?,?,?,?,?,?,?)`);

  const newOnes = [];
  const now = new Date().toISOString();
  for (const m of msgs) {
    if (have.has(m.id)) continue;
    const p = parse(m);
    if (!p) continue;
    ins.run(p.messageId, p.invoiceKey, p.invoiceSent, p.error, p.resolution, p.receivedAt, p.subject, now);
    newOnes.push(p);
  }
  return { scanned: msgs.length, stored: newOnes.length, newOnes };
}

const keyOf = id => String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The most recent rejection for one invoice, matching suffixed resubmissions. */
function forInvoice(invoiceId) {
  const k = keyOf(invoiceId);
  if (!k) return null;
  try {
    return db.getDb().prepare(`SELECT * FROM edi_rejections
      WHERE invoice_key = ? OR invoice_key LIKE ?
      ORDER BY received_at DESC LIMIT 1`).get(k, k + '%') || null;
  } catch (e) { return null; }
}

/** Keyed map so a list can be decorated without a query per row. */
function map() {
  const out = {};
  try {
    for (const r of db.getDb().prepare('SELECT * FROM edi_rejections ORDER BY received_at ASC').all()) {
      out[r.invoice_key] = r;   // ascending, so the newest wins
    }
  } catch (e) {}
  return out;
}

/** Counts by reason, for a summary. */
function byReason() {
  try {
    return db.getDb().prepare(`SELECT COALESCE(resolution, error, 'unknown') AS reason,
      COUNT(*) n, MAX(received_at) AS latest
      FROM edi_rejections GROUP BY reason ORDER BY n DESC`).all();
  } catch (e) { return []; }
}

module.exports = { init, ingest, parse, forInvoice, map, byReason, keyOf, MAILBOX, SENDER };
