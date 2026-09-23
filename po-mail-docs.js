'use strict';
// ─── po-mail-docs.js ────────────────────────────────────────────────────────
// Amazon emails every purchase order, and every REVISION of one, to arclerk@
// with the PDF attached. SharePoint only ever gets that PDF if a person files
// it by hand — and that has not kept up. This ingests the mailbox so the
// portal reads the current document whether or not anyone filed it.
//
// What made this worth building (measured 2026-09-23, per PO against the
// mailbox rather than by keyword search):
//
//   PO value disagrees with the document   12 POs — email exists for 12,
//                                          and its PDF matches Amazon on 11
//   No PO document                         35 POs — email exists for 33,
//                                          31 of them carrying a value
//
// So the entire "disagrees with Amazon" category was never a disagreement. We
// were reading a stale filed copy while the current one sat unread in our own
// inbox, and the sheet was telling people to go argue with Amazon about it.
//
// Note what this CANNOT fix. For the 50 POs Amazon publishes as "--", an email
// exists for all 50 and NONE of their PDFs carry a Purchase Order Total —
// which is exactly why Amazon has no amount either. The value was never set on
// the order. Ingestion cannot invent it; that category needs Amazon.
//
// Nothing is uploaded anywhere. This reads mail and writes a row; filing the
// PDF into SharePoint is a separate, outward-facing action nobody has asked for.

require('dotenv').config();
const db = require('./db');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAILBOX = process.env.PO_MAILBOX || 'arclerk@eastcoastfacilities.com';
const TENANT = process.env.AZURE_TENANT_ID;
const CLIENT = process.env.AZURE_CLIENT_ID;
const SECRET = process.env.AZURE_CLIENT_SECRET;

let _tok = null, _exp = 0;
async function token() {
  if (_tok && Date.now() < _exp - 60000) return _tok;
  const body = new URLSearchParams({ grant_type: 'client_credentials',
    client_id: CLIENT, client_secret: SECRET, scope: 'https://graph.microsoft.com/.default' });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j = await r.json();
  if (!j.access_token) throw new Error('Graph token: ' + JSON.stringify(j).slice(0, 160));
  _tok = j.access_token; _exp = Date.now() + j.expires_in * 1000;
  return _tok;
}

async function g(url) {
  const r = await fetch(GRAPH + url, {
    headers: { Authorization: 'Bearer ' + (await token()), ConsistencyLevel: 'eventual' } });
  if (!r.ok) throw new Error('graph ' + r.status);
  return r.json();
}

function ensureTable() {
  try {
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS po_mail_docs (
      po_number     TEXT PRIMARY KEY,
      message_id    TEXT,
      subject       TEXT,
      received_at   TEXT,
      web_link      TEXT,
      file_name     TEXT,
      amount        REAL,
      pdf_version   INTEGER,
      revised_date  TEXT,
      order_date    TEXT,
      site_code     TEXT,
      description   TEXT,
      is_snow       INTEGER,
      ship_to       TEXT,
      ingested_at   TEXT
    )`);
  } catch (e) { console.error('[po-mail-docs] table:', e.message); }
}

/**
 * The newest PO email for this number that actually carries a PDF naming it.
 *
 * Searched PER PO NUMBER on purpose. A keyword sweep of the mailbox
 * ($search="Purchase Order") is relevance-ranked and caps out — it surfaced 109
 * POs and matched only 11 of 154 defects, which very nearly buried this whole
 * finding. Per-number search found an email for every one of them.
 */
async function newestFor(poNumber) {
  const res = await g(`/users/${MAILBOX}/messages?$search="${poNumber}"`
    + `&$top=25&$select=id,subject,receivedDateTime,hasAttachments,webLink`);
  const msgs = (res.value || [])
    .filter(m => m.hasAttachments && String(m.subject || '').includes(poNumber))
    .sort((a, b) => String(b.receivedDateTime).localeCompare(String(a.receivedDateTime)));

  const watcher = require('./po-doc-watcher');
  for (const m of msgs) {
    const atts = await g(`/users/${MAILBOX}/messages/${encodeURIComponent(m.id)}/attachments`);
    for (const a of atts.value || []) {
      if (!/pdf/i.test(a.contentType || '') && !/\.pdf$/i.test(a.name || '')) continue;
      if (!a.contentBytes) continue;
      const buf = Buffer.from(a.contentBytes, 'base64');
      let x;
      try { x = await watcher.extractFromPdf(buf); } catch (e) { continue; }
      // A batch attachment can name several POs; require THIS one, or a
      // covering email would silently overwrite the wrong PO's document.
      if (!String(x.text || '').includes(poNumber)) continue;
      const { text, ...fields } = x;
      return { msg: m, file: a.name, ...fields };
    }
  }
  return null;
}

/**
 * Ingest the newest emailed document for each PO given (default: every PO the
 * intake sheet flags with a document-shaped defect). Re-running is cheap for
 * anything already ingested from the same message.
 */
async function ingest(poList, { invoices, verbose = false, force = false } = {}) {
  ensureTable();
  const d = db.getDb();

  let targets = poList;
  if (!targets) {
    const inv = invoices || require('./sage').getCachedInvoices();
    const a = require('./po-intake-health').analyse(inv);
    const want = new Set(['ceiling-discrepancy', 'no-document', 'no-site']);
    targets = [...new Set(a.pos.filter(p => p.defects.some(k => want.has(k))).map(p => p.poNumber))];
  }

  const seen = {};
  for (const r of d.prepare('SELECT po_number, message_id FROM po_mail_docs').all()) seen[r.po_number] = r.message_id;

  const save = d.prepare(`INSERT INTO po_mail_docs
    (po_number, message_id, subject, received_at, web_link, file_name, amount, pdf_version,
     revised_date, order_date, site_code, description, is_snow, ship_to, ingested_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(po_number) DO UPDATE SET
      message_id=excluded.message_id, subject=excluded.subject, received_at=excluded.received_at,
      web_link=excluded.web_link, file_name=excluded.file_name, amount=excluded.amount,
      pdf_version=excluded.pdf_version, revised_date=excluded.revised_date, order_date=excluded.order_date,
      site_code=excluded.site_code, description=excluded.description, is_snow=excluded.is_snow,
      ship_to=excluded.ship_to, ingested_at=excluded.ingested_at`);

  let ingested = 0, unchanged = 0, noEmail = 0, failed = 0;
  for (const po of targets) {
    try {
      const hit = await newestFor(po);
      if (!hit) { noEmail++; if (verbose) console.log(`  · ${po} no PO email with a PDF`); continue; }
      if (!force && seen[po] === hit.msg.id) { unchanged++; continue; }
      save.run(po, hit.msg.id, hit.msg.subject || null, hit.msg.receivedDateTime || null,
        hit.msg.webLink || null, hit.file || null,
        hit.amount == null ? null : hit.amount,
        hit.pdfVersion == null ? null : hit.pdfVersion,
        hit.pdfRevisedDate || null, hit.pdfOrderDate || null,
        hit.docSiteCode || null, hit.description || null,
        hit.isSnow ? 1 : 0, hit.shipToAddr || null, new Date().toISOString());
      ingested++;
      if (verbose) console.log(`  ✓ ${po} v${hit.pdfVersion ?? '?'} $${hit.amount ?? '?'} ${hit.docSiteCode || ''}`);
    } catch (e) { failed++; if (verbose) console.log(`  ! ${po} ${e.message}`); }
    await new Promise(r => setTimeout(r, 350));   // gentle on Graph
  }
  return { targets: targets.length, ingested, unchanged, noEmail, failed };
}

/**
 * Mail-sourced documents in the shape po-docs.json uses, so po-ledger can merge
 * them without knowing where they came from.
 */
function map() {
  ensureTable();
  const out = {};
  try {
    for (const r of db.getDb().prepare('SELECT * FROM po_mail_docs').all()) {
      out[String(r.po_number).toUpperCase()] = {
        poNumber: r.po_number,
        source: 'email',
        latestVersion: r.pdf_version,
        versionCount: 1,
        files: [],
        // webUrl points at the EMAIL. There is no SharePoint copy — that is the
        // whole point — and a link to the message is how a person gets to the
        // document to file it.
        latestFile: { name: r.file_name, webUrl: r.web_link, docDate: r.revised_date || r.order_date },
        revised: !!r.revised_date,
        docAmount: r.amount,
        pdfVersion: r.pdf_version,
        pdfRevisedDate: r.revised_date,
        pdfOrderDate: r.order_date,
        docSiteCode: r.site_code,
        description: r.description,
        isSnow: !!r.is_snow,
        shipToAddr: r.ship_to,
        mailSubject: r.subject,
        mailReceivedAt: r.received_at,
      };
    }
  } catch (e) { /* not ingested yet */ }
  return out;
}

module.exports = { ingest, map, newestFor, ensureTable, MAILBOX };
