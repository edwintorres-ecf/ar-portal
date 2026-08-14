'use strict';
/**
 * po-ledger.js — PO fund ledger for ECF AR Portal
 *
 * Combines three sources into one per-PO view:
 *  - purchase_orders (db.js): manually/automatically tracked ceiling amounts
 *  - payee.getIndex() (payee.js): invoices already submitted to Payee Central,
 *    grouped by PO -> "consumed"
 *  - open Sage/Omnia invoices carrying a poNumber that are NOT yet in the
 *    Payee Central index -> "pending upload" (what still needs to be submitted)
 *
 * Callers pass in the invoice list they already fetched (same array used for
 * /api/invoices) so this module stays synchronous and side-effect free.
 */

const db = require('./db');
const payee = require('./payee');
const fs = require('fs');
const path = require('path');

// Cached reader for the SharePoint PO-document scan (po-doc-watcher.js output).
const PO_DOCS_PATH = path.join(__dirname, 'po-docs.json');
let _poDocsCache = null, _poDocsTs = 0;
function getPoDocsMap() {
  const now = Date.now();
  if (_poDocsCache && (now - _poDocsTs) < 15 * 60 * 1000) return _poDocsCache;
  try {
    const d = JSON.parse(fs.readFileSync(PO_DOCS_PATH, 'utf8'));
    _poDocsCache = d.byPo || {};
  } catch (e) { _poDocsCache = {}; }
  _poDocsTs = now;
  return _poDocsCache;
}

// Cached reader for the per-PO detail scrape (payee-po-detail-scraper.js output):
// Amazon's own "Available amount" per open PO — the authoritative, quantity-
// enforced remaining balance, keyed by upper-cased PO number. This replaces the
// computed (ceiling - consumed - pending) figure as "Value Remaining" wherever
// Amazon has spoken; the computed number is kept alongside for transparency and
// discrepancy detection. Reliability: a {stale:true} entry means the last scrape
// of that PO failed — we still show its last-known Amazon number but mark it so
// the UI/consumers can tell it may be behind, and we fall back to computed only
// when Amazon has never returned a value.
const PO_DETAILS_PATH = path.join(__dirname, 'payee-po-details.spark.json');
let _poDetailsCache = null, _poDetailsTs = 0;
function getPoDetailsMap() {
  const now = Date.now();
  if (_poDetailsCache && (now - _poDetailsTs) < 10 * 60 * 1000) return _poDetailsCache;
  const map = {};
  try {
    const d = JSON.parse(fs.readFileSync(PO_DETAILS_PATH, 'utf8'));
    for (const [po, rec] of Object.entries(d.details || {})) map[po.toUpperCase()] = rec;
  } catch (e) { /* no detail cache yet — ledger falls back to computed */ }
  _poDetailsCache = map;
  _poDetailsTs = now;
  return _poDetailsCache;
}

// Statuses that do not consume PO funds (the invoice never drew against it,
// or the draw was reversed).
// 'Cancellation in Progress' is non-consuming for the same reason it counts
// as dead in payee.js: that attempt will never pay out. Its liability is
// counted exactly once — as the pending resubmission in buildPendingUpload —
// so leaving it here too would double-charge the PO.
const NON_CONSUMING_STATUSES = new Set(['Rejected', 'Cancelled', 'Cancellation in Progress']);

// PO Funds is Amazon-only — Amazon.com Services LLC and CW Amazon Services.
const AMAZON_CUSTOMER_IDS = new Set(['C-00403', 'C-00566']);

// A real Amazon PO number looks like "2D-19170701" (2-char company code, dash,
// digits). Anything else in the PO field — "NEEDED KRB5", "PO-MSG-KRB5" — is a
// human placeholder someone typed into Sage while awaiting the real PO. Those
// aren't real POs; they only appear in the ledger because pending invoices are
// grouped under the text. Rolling them onto a real PO (reassignment) empties
// and removes them.
const AMAZON_PO_RE = /^[A-Z0-9]{2}-\d{4,}$/i;
function isPlaceholderPo(poNumber) {
  return !AMAZON_PO_RE.test(String(poNumber || '').trim());
}

// Sage's SHIPTO.CONTACTNAME is entered by hand, so the SAME Amazon site shows up
// under several strings — "DBU3", "DBU3 PKG HEMPSTEAD3", "DBU3 PKG" — which then
// split into separate rows in the by-site view (pending lands under one label,
// capacity under another). An Amazon site code is a canonical token: 2-4 letters
// + 1-2 digits ("DBU3", "EWR9", "KRB5"). Collapse any string that STARTS with
// one to just that token so every variant groups as one site. Strings without a
// recognizable code (e.g. "AKRON4", "LINDa") pass through untouched.
const SITE_TOKEN_RE = /^([A-Z]{2,4}\d{1,2})(?=$|[^A-Z0-9])/i;
function normalizeSite(s) {
  if (s == null) return s;
  const str = String(s).trim();
  const m = str.match(SITE_TOKEN_RE);
  return m ? m[1].toUpperCase() : str;
}
// A real Amazon site code (DBU3, EWR9). Junk ship-to values like "Amazon.com
// Services LLC" fail this, so we can tell "has a real site" from "has garbage".
function isValidSite(s) {
  return SITE_TOKEN_RE.test(String(s || '').trim());
}

function filterAmazon(invoices) {
  return invoices.filter(inv => AMAZON_CUSTOMER_IDS.has(inv.customerId));
}

function parseAmount(value) {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const n = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

// Picks the most common non-empty siteCode among a PO's invoices.
function buildSiteCodeByPo(invoices) {
  const counts = {};
  for (const inv of invoices) {
    const po = (inv.poNumber || '').trim();
    const site = normalizeSite((inv.siteCode || '').trim());
    if (!po || !site) continue;
    if (!counts[po]) counts[po] = {};
    counts[po][site] = (counts[po][site] || 0) + 1;
  }
  const byPo = {};
  for (const [po, sites] of Object.entries(counts)) {
    byPo[po] = Object.entries(sites).sort((a, b) => b[1] - a[1])[0][0];
  }
  return byPo;
}

// Classify a PO's service from its document description so snow work can be
// isolated from landscaping/cleaning/maintenance at the same site (a site mixes
// them). Order matters: snow wins, then the rest. Word boundaries avoid the
// classic /ice/→"Serv-ice" false positive.
function classifyService(desc) {
  if (!desc) return 'unknown';
  const d = String(desc).toLowerCase();
  if (/\bsnow\b|\bice\b|\bde-?ic|plow|salt\b/.test(d)) return 'snow';
  if (/landscap|mulch|\bmow|turf|\btree|topsoil|\bseed|planting|irrigation|fertiliz|edging|sod\b/.test(d)) return 'landscape';
  if (/sweep|clean|debris|pressure wash|porter|litter|power wash/.test(d)) return 'cleaning';
  if (/repair|maintenance|lighting|electrical|\bsign\b|building|striping|paint|pothole|concrete|fence|plumb/.test(d)) return 'maintenance';
  return 'other';
}

// ─── Persistent PO consumption ledger ───────────────────────────────────────
// The payee feed only shows invoices still visible in Payee Central — settled
// (Paid) invoices age out, so a feed-only consumed figure forgets their draw
// forever (found 2026-08-14: 2D-20620291 showed 11/$1.86M consumed while
// Amazon's matched-invoices tab held 14/$1.93M — the gap was exactly the three
// Paid invoices). Rule per Edwin: an invoice match is PERMANENT; only an
// observed Rejected/Cancelled transition releases funds. Consumption may only
// grow automatically — anything that would shrink it goes to the review queue
// for manual confirmation.
const BACKFILL_INV = '(pre-feed history)';
let _consumptionReady = false, _consumptionSyncTs = 0;
function ensureConsumptionTables() {
  if (_consumptionReady) return;
  const d = db.getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS po_consumption (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number TEXT NOT NULL,
    invoice_number TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    status_last TEXT,
    source TEXT NOT NULL DEFAULT 'feed',
    first_seen_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT DEFAULT (datetime('now')),
    released_at TEXT, released_reason TEXT,
    UNIQUE(po_number, invoice_number)
  );
  CREATE TABLE IF NOT EXISTS po_consumption_review (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT,
    proposed_delta REAL,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT, resolved_by TEXT, resolution TEXT
  );`);
  _consumptionReady = true;
}

// Feed → ledger sync (throttled). Inserts new matches, updates status/amount
// upward, releases on Rejected/Cancelled, un-releases if an invoice comes back
// consuming. Never deletes; an amount DECREASE on a live row is queued for
// review instead of applied.
function syncConsumptionFromIndex() {
  ensureConsumptionTables();
  const now = Date.now();
  if (now - _consumptionSyncTs < 5 * 60 * 1000) return;
  _consumptionSyncTs = now;
  const d = db.getDb();
  const ins = d.prepare(`INSERT INTO po_consumption (po_number, invoice_number, amount, status_last)
    VALUES (?,?,?,?) ON CONFLICT(po_number, invoice_number) DO NOTHING`);
  const sel = d.prepare('SELECT id, amount, status_last, released_at FROM po_consumption WHERE po_number=? AND invoice_number=?');
  const upd = d.prepare(`UPDATE po_consumption SET amount=?, status_last=?, last_seen_at=datetime('now'), released_at=?, released_reason=? WHERE id=?`);
  const rev = d.prepare(`INSERT INTO po_consumption_review (po_number, kind, detail, proposed_delta) VALUES (?,?,?,?)`);
  const index = payee.getIndex();
  d.exec('BEGIN');
  try {
    for (const item of Object.values(index)) {
      const po = (item.po || '').trim();
      const invNo = String(item.invoice || item.invoiceNumber || item.id || '').trim();
      if (!po || !invNo) continue;
      const amt = parseAmount(item.amount);
      const nonConsuming = NON_CONSUMING_STATUSES.has(item.status);
      const row = sel.get(po, invNo);
      if (!row) {
        ins.run(po, invNo, amt, item.status || null);
        if (nonConsuming) {
          const r2 = sel.get(po, invNo);
          if (r2) upd.run(amt, item.status, new Date().toISOString(), item.status, r2.id);
        }
        continue;
      }
      let newAmt = row.amount;
      if (amt > row.amount + 0.005) newAmt = amt;
      else if (amt < row.amount - 0.005 && amt > 0) {
        rev.run(po, 'amount-decrease', `${invNo}: ledger $${row.amount} vs feed $${amt} — not applied, confirm manually`, amt - row.amount);
      }
      const released = nonConsuming ? (row.released_at || new Date().toISOString()) : null;
      upd.run(newAmt, item.status || row.status_last, released, nonConsuming ? item.status : null, row.id);
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
}

function buildConsumedByPo() {
  syncConsumptionFromIndex();
  const byPo = {};
  const rows = db.all(`SELECT po_number, source, SUM(amount) AS amt, COUNT(*) AS n
    FROM po_consumption WHERE released_at IS NULL GROUP BY po_number, source`);
  for (const r of rows) {
    if (!byPo[r.po_number]) byPo[r.po_number] = { consumed: 0, invoiceCount: 0, backfillAmount: 0 };
    byPo[r.po_number].consumed += r.amt;
    if (r.source === 'amazon-implied') byPo[r.po_number].backfillAmount += r.amt;
    else byPo[r.po_number].invoiceCount += r.n;
  }
  return byPo;
}

// Reconciliation: three-way compare per PO — our ledger consumed vs Amazon's
// implied consumed (PO amount − Amazon available). Buckets identify what needs
// fixing and how.
function getConsumptionRecon() {
  ensureConsumptionTables();
  syncConsumptionFromIndex();
  const consumedMap = buildConsumedByPo();
  const detailsMap = getPoDetailsMap();
  const openPoMap = payee.getOpenPoMap().byPo;
  const pos = new Set([...Object.keys(consumedMap), ...Object.keys(detailsMap)]);
  const out = { ok: [], autoFixable: [], overLedger: [], noAmazonFigure: [], overdrawn: [] };
  for (const po of pos) {
    const c = consumedMap[po] || { consumed: 0, invoiceCount: 0, backfillAmount: 0 };
    const det = detailsMap[po.toUpperCase()];
    const poAmount = det?.poAmount ?? openPoMap[po.toUpperCase()]?.amount ?? null;
    const implied = det && det.available != null && poAmount != null ? poAmount - det.available : null;
    const row = { po, ledgerConsumed: Math.round(c.consumed * 100) / 100, invoiceCount: c.invoiceCount,
      backfillAmount: Math.round((c.backfillAmount || 0) * 100) / 100,
      amazonImplied: implied != null ? Math.round(implied * 100) / 100 : null,
      amazonAvailable: det?.available ?? null, poAmount, stale: !!det?.stale, masked: !!det?.masked };
    if (det?.available != null && det.available < 0) out.overdrawn.push(row);
    if (implied == null) { if (c.consumed > 0) out.noAmazonFigure.push(row); continue; }
    const gap = implied - c.consumed;
    row.gap = Math.round(gap * 100) / 100;
    if (Math.abs(gap) <= 1) out.ok.push(row);
    else if (gap > 1) out.autoFixable.push(row);      // Amazon knows more draw than we do — backfillable
    else out.overLedger.push(row);                     // we claim MORE than Amazon — manual review only
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => Math.abs(b.gap || 0) - Math.abs(a.gap || 0));
  return out;
}

// Backfill: bring ledger consumed up to Amazon's implied figure via a single
// adjustment row per PO (source='amazon-implied', permanent). Only ever raises
// consumption automatically; a would-be decrease is queued for review. Safe to
// re-run — it re-targets the adjustment row upward as Amazon reveals more.
function runConsumptionBackfill() {
  const recon = getConsumptionRecon();
  const d = db.getDb();
  const rev = d.prepare(`INSERT INTO po_consumption_review (po_number, kind, detail, proposed_delta) VALUES (?,?,?,?)`);
  let adjusted = 0, queued = 0;
  for (const r of recon.autoFixable) {
    const target = (r.backfillAmount || 0) + r.gap;   // new adjustment total
    d.prepare(`INSERT INTO po_consumption (po_number, invoice_number, amount, status_last, source)
      VALUES (?,?,?,'backfill','amazon-implied')
      ON CONFLICT(po_number, invoice_number) DO UPDATE SET amount=excluded.amount, last_seen_at=datetime('now')`)
      .run(r.po, BACKFILL_INV, Math.round(target * 100) / 100);
    adjusted++;
  }
  const already = new Set(db.all(`SELECT po_number FROM po_consumption_review WHERE resolved_at IS NULL`).map(x => x.po_number));
  for (const r of recon.overLedger) {
    if (already.has(r.po)) continue;
    rev.run(r.po, 'ledger-exceeds-amazon', `ledger $${r.ledgerConsumed} vs Amazon implied $${r.amazonImplied} — shrinking consumed needs manual confirmation`, r.gap);
    queued++;
  }
  return { adjusted, queuedForReview: queued, okCount: recon.ok.length, noAmazonFigure: recon.noAmazonFigure.length, overdrawn: recon.overdrawn.length };
}

function buildPendingUpload(invoices) {
  const assignments = db.getAllPoAssignments();
  const byPo = {};
  const needsUpload = [];
  for (const inv of invoices) {
    const originalPo = (inv.poNumber || '').trim();
    const assignment = assignments[inv.recordNo];
    // effectivePo comes from a manual assignment first, then the native PO.
    // An invoice with NEITHER is "off radar" (Omnia invoices carry no PO): it is
    // skipped here and surfaced by getOrphanInvoices instead, until someone
    // assigns it a PO — which then pulls it into the normal Needs Upload flow.
    const effectivePo = ((assignment ? assignment.assigned_po : originalPo) || '').trim();
    if (!effectivePo) continue;
    const payeeId = payee.toPayeeId(inv.invoiceId);
    const resolved = payeeId ? payee.resolveInvoice(payeeId) : null;
    // If ANY attempt (original or a resubmission) is live in Amazon's system,
    // the invoice is handled — nothing to upload. It only belongs in Needs
    // Upload when it was never submitted, or every attempt is cancelled/rejected
    // (then it needs a resubmission under the next letter suffix).
    if (resolved && !resolved.needsResubmission) continue;
    const isResubmission = !!resolved; // resolved but all attempts dead
    if (!byPo[effectivePo]) byPo[effectivePo] = { pendingUpload: 0, invoiceCount: 0 };
    byPo[effectivePo].pendingUpload += (inv.totalEntered || 0);
    byPo[effectivePo].invoiceCount++;
    needsUpload.push({
      ...inv, originalPo, effectivePo,
      reassignedTo: assignment ? assignment.assigned_po : null,
      reassignNote: assignment ? assignment.note : null,
      isResubmission,
      lastAttemptStatus: resolved ? resolved.status : null,
      suggestedResubmitId: resolved ? resolved.suggestedResubmitId : null,
    });
  }
  return { byPo, needsUpload };
}

/**
 * Full per-PO ledger: tracked POs (from purchase_orders) merged with any PO
 * number seen in Payee Central or in pending Sage/Omnia invoices, even if
 * nobody has entered a ceiling for it yet (surfaced as "untracked").
 */
function getPoLedger(invoices) {
  const amazonInvoices = filterAmazon(invoices);
  const tracked = db.getPurchaseOrders();
  const trackedByNumber = {};
  for (const po of tracked) trackedByNumber[po.po_number] = po;

  const consumedByPo = buildConsumedByPo();
  const { byPo: pendingByPo } = buildPendingUpload(amazonInvoices);
  const siteCodeByPo = buildSiteCodeByPo(amazonInvoices);
  const openPoMap = payee.getOpenPoMap().byPo;
  const poDocsMap = getPoDocsMap();
  const poDetailsMap = getPoDetailsMap();

  const allPoNumbers = new Set([
    ...Object.keys(trackedByNumber),
    ...Object.keys(consumedByPo),
    ...Object.keys(pendingByPo),
    ...Object.keys(openPoMap),
  ]);

  const ledger = [];
  for (const poNumber of allPoNumbers) {
    const po = trackedByNumber[poNumber] || null;
    // Old/expired POs are out of scope (Edwin 2026-07-17: "we shouldn't have
    // to track POs for 2024 or earlier"). A PO is only listed if it's OPEN on
    // Amazon (every open PO is 2025+, verified), has pending invoices, or was
    // deliberately entered/pinned by a human. POs that exist only as payment
    // history on closed orders are noise in a funds-management view.
    const relevant = po || pendingByPo[poNumber] || openPoMap[poNumber.toUpperCase()];
    if (!relevant) continue;
    const consumed = consumedByPo[poNumber]?.consumed || 0;
    const pendingUpload = pendingByPo[poNumber]?.pendingUpload || 0;
    const scraped = openPoMap[poNumber.toUpperCase()];
    const scrapedCeiling = scraped && scraped.amount > 0 ? scraped.amount : null;

    // Ceiling priority: a manually-entered ceiling wins (someone deliberately
    // set it); otherwise use Payee Central's authoritative open-PO amount.
    let ceiling, ceilingSource;
    if (po?.ceiling_amount != null) { ceiling = po.ceiling_amount; ceilingSource = po.ceiling_source || 'manual'; }
    else if (scrapedCeiling != null) { ceiling = scrapedCeiling; ceilingSource = 'payee-central'; }
    else { ceiling = null; ceilingSource = null; }

    const computedAvailable = ceiling != null ? ceiling - consumed - pendingUpload : null;

    // Amazon's own "Available amount" from the PO detail page is the ground
    // truth for remaining capacity: it's quantity-enforced and it's the exact
    // number Amazon checks an invoice against at submission. Our computed figure
    // drifts (ceiling-capture lag, double-counted pending) and can even go
    // negative, which Amazon never shows — Amazon floors at $0. So when we have
    // a scraped balance, THAT is "Value Remaining"; computed is kept for
    // transparency. `pendingUpload` still reflects what's queued to draw against
    // it, so pending-vs-remaining decisions stay sound.
    const detail = poDetailsMap[poNumber.toUpperCase()] || null;
    const amazonAvailable = detail && detail.available != null ? detail.available : null;
    const available = amazonAvailable != null ? amazonAvailable : computedAvailable;
    const availableSource = amazonAvailable != null ? 'amazon' : (computedAvailable != null ? 'computed' : null);
    const availableStale = !!(detail && detail.stale);

    const poClosed = scraped && scraped.status && scraped.status !== 'OPEN_FOR_INVOICING';
    const doc = poDocsMap[poNumber.toUpperCase()] || null;

    // Service type: a manual override (someone reviewed it) wins; otherwise
    // classify from the PO doc description. When neither yields a definite
    // service AND the PO has pending work, it's ambiguous — flag it for manual
    // review so the snow-only filter (and any service filter) doesn't silently
    // drop it. This is the DNK5/2D-19117605 case: the PO doc was just an address.
    const autoService = classifyService(doc ? doc.description : null);
    const serviceManual = !!(po && po.service_type);
    const serviceType = serviceManual ? po.service_type : autoService;
    const needsServiceReview = !serviceManual
      && (serviceType === 'other' || serviceType === 'unknown')
      && pendingUpload > 0;

    // Cross-check: PO amount from the SharePoint PDF vs Payee Central's open-PO
    // amount. Two independent sources; flag when they disagree by > $1.
    const docAmount = doc && doc.docAmount != null ? doc.docAmount : null;
    let ceilingDiscrepancy = false;
    if (docAmount != null && scrapedCeiling != null && Math.abs(docAmount - scrapedCeiling) > 1) {
      ceilingDiscrepancy = true;
    }

    ledger.push({
      poNumber,
      tracked: !!po,
      // Site chain: MANUAL assignment (purchase_orders.site_code) wins, then
      // Amazon's own Ship To site from the PO detail page (ground truth — it's
      // the site Amazon actually cut the PO for), then invoice majority-vote,
      // then PDF extraction (SHIP TO block or the description's leading
      // "SITE - 20xx" pattern, e.g. "1 DUJ3 - 2026 - …").
      siteCode: normalizeSite(po?.site_code || (detail && detail.site) || siteCodeByPo[poNumber] || (doc && doc.docSiteCode)
        || (doc && doc.description && (doc.description.match(/(?:^|\s)([A-Z]{2,5}\d)\s*-\s*20\d\d/) || [])[1]) || null),
      siteManual: !!po?.site_code,
      siteFromAmazon: !!(detail && detail.site),
      locationId: po?.location_id || null,
      customerId: po?.customer_id || null,
      status: po?.status || (poClosed ? 'closed' : (ceiling == null ? 'untracked' : 'active')),
      statedAmount: po?.stated_amount ?? null,
      ceilingAmount: ceiling,
      ceilingSource,
      scrapedCeiling,
      docAmount,
      ceilingDiscrepancy,
      poStatus: scraped ? scraped.status : null,
      // Amazon's PO issue date (SearchOpenPOs orderDate, e.g. "Aug 4, 2026").
      orderDate: scraped ? (scraped.orderDate || null) : null,
      // Doc date, most-authoritative first: the PDF's internal "REVISED DATE:"
      // field (real revision date — filenames often just repeat the order date,
      // 215/312 revised POs verified), then the internal "ORDER DATE:" for
      // unrevised docs, then the filename date as last resort until the doc
      // scan has re-parsed the PDF.
      docDate: (doc
        ? (doc.pdfRevisedDate || doc.pdfOrderDate
          || (doc.latestFile && doc.latestFile.name
            ? ((doc.latestFile.name.match(/_v\d+_(\d{4})(\d{2})(\d{2})/) || []).slice(1).join('-') || null)
            : null))
        : null),
      docDateIsRevision: !!(doc && doc.pdfRevisedDate),
      // Placeholder = not a real Amazon PO number and not present in Amazon's
      // open-PO list. These are "roll into a real PO" candidates.
      isPlaceholder: isPlaceholderPo(poNumber) && !scraped,
      // SharePoint PO document: presence, version, revision, service type.
      hasDoc: !!doc,
      docVersion: doc ? doc.latestVersion : null,
      docRevised: doc ? doc.revised : false,
      docUrl: doc && doc.latestFile ? doc.latestFile.webUrl : null,
      isSnow: doc ? !!doc.isSnow : false,
      serviceType,
      serviceManual,
      needsServiceReview,
      docDescription: doc ? (doc.description || null) : null,
      discrepancyFlag: !!po?.discrepancy_flag || ceilingDiscrepancy,
      consumed,
      consumedInvoiceCount: consumedByPo[poNumber]?.invoiceCount || 0,
      pendingUpload,
      pendingUploadInvoiceCount: pendingByPo[poNumber]?.invoiceCount || 0,
      available,
      // available === amazonAvailable when Amazon has spoken, else computed.
      amazonAvailable,
      computedAvailable,
      availableSource,
      availableStale,
      amazonScrapedAt: detail ? detail.scrapedAt : null,
      notes: po?.notes || null,
    });
  }

  // Overages first, then ascending available; untracked/no-ceiling last.
  ledger.sort((a, b) => {
    if (a.available == null && b.available == null) return 0;
    if (a.available == null) return 1;
    if (b.available == null) return -1;
    return a.available - b.available;
  });
  return ledger;
}

/**
 * Invoices carrying a PO number that haven't shown up in the Payee Central
 * feed yet, each flagged with whether submitting it would overage its PO.
 */
function getNeedsUpload(invoices) {
  const amazonInvoices = filterAmazon(invoices);
  const { needsUpload } = buildPendingUpload(amazonInvoices);
  const ledgerByPo = {};
  for (const row of getPoLedger(invoices)) ledgerByPo[row.poNumber] = row;

  // Invoices EDI-transmitted recently won't show in the Payee feed until
  // Amazon ingests them (minutes–hours). Surface that state so nobody
  // re-transmits a live submission (observed: ECI-024912 sent 4x because the
  // row still read as plain "pending upload").
  const siteOverrides = db.getAllInvoiceSiteOverrides();
  const recentTx = {};
  try {
    for (const r of db.all(
      `SELECT record_no, MAX(created_at) AS at FROM audit_log
       WHERE action='edi_transmit' AND detail LIKE '%-> OK%'
         AND created_at >= datetime('now','-48 hours')
       GROUP BY record_no`)) {
      recentTx[r.record_no] = r.at;
    }
  } catch (e) { /* audit table unavailable — degrade to no flags */ }

  const openPoMap = payee.getOpenPoMap().byPo;

  return needsUpload.map(inv => {
    const poRow = ledgerByPo[inv.effectivePo];
    const openEntry = openPoMap[(inv.effectivePo || '').toUpperCase()];
    const amount = inv.totalEntered || 0;
    // "Drawable" = the capacity an invoice can still draw against = ceiling −
    // consumed, NOT counting our not-yet-submitted pending (those aren't in
    // Amazon yet). Prefer Amazon's own "Available amount" (its real remaining,
    // floored at $0); fall back to ceiling − consumed when we haven't scraped
    // the PO's detail yet. NB: poRow.available now equals amazonAvailable, which
    // already excludes pending — do NOT add `amount` back to it (that was only
    // correct for the old computed value that subtracted pending).
    const drawable = poRow?.amazonAvailable != null
      ? poRow.amazonAvailable
      : (poRow?.ceilingAmount != null ? poRow.ceilingAmount - (poRow.consumed || 0) : null);
    const otherPending = Math.max(0, (poRow?.pendingUpload || 0) - amount);
    // Headroom before THIS invoice, with the PO's other pending still charged.
    const availableBeforeThis = drawable != null ? drawable - otherPending : null;
    return {
      recordNo: inv.recordNo,
      invoiceId: inv.invoiceId,
      customerName: inv.customerName,
      locationName: inv.locationName,
      // Canonical Amazon site for grouping. Chain: manual per-invoice override
      // (multi-site blanket POs — the PO fallback would label with the PO's
      // header ship-to, e.g. corporate "BNA12") > the invoice's own valid
      // ship-to > the assigned PO's Amazon site.
      siteCode: (siteOverrides[inv.recordNo]?.site_code
        || (isValidSite(inv.siteCode) ? normalizeSite(inv.siteCode) : (poRow?.siteCode || null))),
      siteOverride: !!siteOverrides[inv.recordNo],
      invoiceDate: inv.whenCreated || null,
      siteCodeRaw: inv.siteCode || null,               // exact Sage SHIPTO string (kept for reference)
      poOnRecord: inv.originalPo,      // what Sage/DOCNUMBER says — "the PO on the record"
      assignedPo: inv.effectivePo,     // what it should actually be uploaded under (same as poOnRecord unless reassigned)
      assignedPlaceholder: isPlaceholderPo(inv.effectivePo),  // currently sitting on a placeholder, not a real PO
      reassigned: !!inv.reassignedTo,
      reassignNote: inv.reassignNote || null,
      isResubmission: !!inv.isResubmission,
      lastAttemptStatus: inv.lastAttemptStatus || null,
      suggestedResubmitId: inv.suggestedResubmitId || null,
      recentTransmitAt: recentTx[inv.recordNo] || null,
      amount,
      poCeiling: poRow?.ceilingAmount ?? null,
      poAvailable: availableBeforeThis,
      wouldOverage: availableBeforeThis != null ? (availableBeforeThis - amount) < 0 : null,
      // Pre-flight signals for the transmit UI (the Jul-17 vanished batch went
      // to $0-value POs — that must be visible BEFORE the send, not after).
      // NB: read the RAW open-PO amount — the ledger nulls a $0 ceiling as
      // "no data", which would hide exactly the POs that eat submissions.
      poStatus: poRow?.poStatus || null,                 // OPEN_FOR_INVOICING | CLOSED | null (not in Amazon's open list)
      poZeroFunds: !!openEntry && (openEntry.amount === 0 || openEntry.amount == null),
    };
  }).sort((a, b) => {
    if (a.wouldOverage === b.wouldOverage) return 0;
    return a.wouldOverage ? -1 : 1;
  });
}

/**
 * Transmission reconciliation: the EDI pipeline audits itself.
 *  - exceptions:  invoices EDI-transmitted (OK) more than GRACE hours ago that
 *    STILL have no live entry in the Payee feed — a submission that vanished
 *    (the ECI-024912 Jul-17 case) or a feed gap. Either way a human must look.
 *  - duplicates:  invoices with >1 successful transmit inside the window —
 *    each extra copy will bounce off Amazon as a reused invoice number.
 */
function getTransmissionExceptions() {
  const GRACE_HOURS = parseInt(process.env.EDI_RECONCILE_GRACE_HOURS || '72', 10);
  const rows = db.all(
    `SELECT record_no,
            COUNT(*)        AS ok_count,
            MIN(created_at) AS first_at,
            MAX(created_at) AS last_at,
            MAX(detail)     AS detail
     FROM audit_log
     WHERE action='edi_transmit' AND detail LIKE '%-> OK%'
       AND created_at >= datetime('now','-14 days')
     GROUP BY record_no`);

  const exceptions = [];
  const duplicates = [];
  for (const r of rows) {
    const invoiceId = (r.detail.match(/^(\S+)\s/) || [])[1] || r.record_no;
    const po = (r.detail.match(/PO=(\S+)/) || [])[1] || null;
    const asNumber = (r.detail.match(/AS=(\S+)/) || [])[1] || null;
    // Resolve from the BASE number (resolveInvoice is suffix-aware from base),
    // then require the SPECIFIC transmitted identity among Payee's attempts —
    // an old Cancelled base entry must not mask a vanished resubmission, and a
    // suffixed send must not resolve as "missing" just because the base exists.
    const basePayeeId = payee.toPayeeId(invoiceId);
    const sentPayeeId = (asNumber ? asNumber.replace(/-/g, '') : basePayeeId) || '';
    const resolved = basePayeeId ? payee.resolveInvoice(basePayeeId) : null;
    const attemptIds = resolved && resolved.attempts ? resolved.attempts.map(a => String(a.id || '').toUpperCase()) : [];
    const inFeed = attemptIds.includes(sentPayeeId.toUpperCase());
    const ageOk = db.get(`SELECT datetime(?, '+' || ? || ' hours') <= datetime('now') AS overdue`, [r.last_at, String(GRACE_HOURS)]);

    if (!inFeed && ageOk && ageOk.overdue) {
      exceptions.push({
        recordNo: r.record_no, invoiceId, po,
        lastTransmitAt: r.last_at, attempts: r.ok_count,
        ageHours: Math.round((Date.now() - Date.parse(r.last_at + 'Z')) / 3600000),
      });
    }
    if (r.ok_count > 1) {
      duplicates.push({
        recordNo: r.record_no, invoiceId, po,
        okTransmits: r.ok_count, firstAt: r.first_at, lastAt: r.last_at,
        inFeed,
      });
    }
  }
  exceptions.sort((a, b) => b.ageHours - a.ageHours);
  duplicates.sort((a, b) => b.okTransmits - a.okTransmits);
  return { graceHours: GRACE_HOURS, exceptions, duplicates };
}

function getOverages(invoices) {
  // An overage is a PO that can't absorb what's queued against it. Amazon's
  // "Available amount" floors at $0 (it never reports negative), so the true
  // signal is no longer "available < 0" — it's "pending upload exceeds the
  // remaining capacity." Still catch a negative computed-fallback value for POs
  // not yet detail-scraped.
  return getPoLedger(invoices).filter(r => {
    if (r.available == null) return false;
    if (r.available < 0) return true;
    return (r.pendingUpload || 0) > r.available + 0.01;
  });
}

function getExcessCapacity(invoices) {
  return getPoLedger(invoices)
    .filter(r => r.available != null && r.available > 0)
    .sort((a, b) => b.available - a.available);
}

/**
 * Invoices that WERE invoiced against one PO (Sage's poNumber, set when the
 * invoice/work order was created) but ended up actually submitted to Payee
 * Central under a different PO (the "Purchase Order #" on the Payee Central
 * side) — e.g. because the original PO ran out of funds and the invoice was
 * rerouted. This is the audit trail Edwin asked for: invoiced-against vs.
 * actually-submitted-under, surfaced whenever they disagree.
 */
function getPoMismatches(invoices) {
  const mismatches = [];
  for (const inv of filterAmazon(invoices)) {
    const invoicedPo = (inv.poNumber || '').trim();
    if (!invoicedPo) continue;
    const payeeId = payee.toPayeeId(inv.invoiceId);
    const payeeEntry = payeeId ? payee.resolveInvoice(payeeId) : null;
    if (!payeeEntry) continue; // not submitted yet — that's a "needs upload" case, not a mismatch
    const submittedPo = (payeeEntry.po || '').trim();
    if (submittedPo && invoicedPo.toUpperCase() !== submittedPo.toUpperCase()) {
      mismatches.push({
        recordNo: inv.recordNo,
        invoiceId: inv.invoiceId,
        customerName: inv.customerName,
        submittedAs: payeeEntry.payeeId !== (payeeId || '').toUpperCase() ? payeeEntry.payeeId : null,
        invoicedPo,
        submittedPo,
        amount: parseAmount(payeeEntry.amount),
        status: payeeEntry.status,
        statusMeta: payeeEntry.statusMeta,
      });
    }
  }
  return mismatches;
}

/**
 * The complement to getNeedsUpload: invoices that HAVE already shown up in
 * the Payee Central feed, i.e. successfully submitted.
 */
function getUploaded(invoices) {
  const uploaded = [];
  for (const inv of filterAmazon(invoices)) {
    const poNumber = (inv.poNumber || '').trim();
    if (!poNumber) continue;
    const payeeId = payee.toPayeeId(inv.invoiceId);
    const payeeEntry = payeeId ? payee.resolveInvoice(payeeId) : null;
    if (!payeeEntry) continue; // not submitted yet — that's "needs upload"
    uploaded.push({
      recordNo: inv.recordNo,
      invoiceId: inv.invoiceId,
      customerName: inv.customerName,
      siteCode: normalizeSite(inv.siteCode) || null,
      poNumber,
      submittedPo: (payeeEntry.po || '').trim(),
      // resubmission-aware: what ID this actually lives under in Payee Central
      // (e.g. Sage S-8604 was resubmitted as S8604A), plus how many attempts
      submittedAs: payeeEntry.payeeId !== (payeeId || '').toUpperCase() ? payeeEntry.payeeId : null,
      attemptCount: payeeEntry.attemptCount || 1,
      amount: parseAmount(payeeEntry.amount),
      status: payeeEntry.status,
      statusMeta: payeeEntry.statusMeta,
      entryDate: payeeEntry.entryDate,
    });
  }
  return uploaded.sort((a, b) => (b.entryDate || '').localeCompare(a.entryDate || ''));
}

/**
 * Resubmission monitor: every Amazon invoice that has more than one Payee
 * Central attempt (an original plus letter-suffixed resubmissions), so multiple
 * resubmissions can be watched. Flags anomalies: `duplicateLive` (more than one
 * attempt live at once — a likely accidental duplicate, the ECI-022485 case),
 * and `allDead` (every attempt cancelled/rejected — genuinely needs resubmit).
 */
function getResubmissionMonitor(invoices) {
  const rows = [];
  for (const inv of filterAmazon(invoices)) {
    const payeeId = payee.toPayeeId(inv.invoiceId);
    const resolved = payeeId ? payee.resolveInvoice(payeeId) : null;
    if (!resolved || resolved.attemptCount <= 1) continue; // only multi-attempt invoices
    rows.push({
      recordNo: inv.recordNo,
      invoiceId: inv.invoiceId,
      customerName: inv.customerName,
      siteCode: normalizeSite(inv.siteCode) || null,
      attemptCount: resolved.attemptCount,
      liveCount: resolved.liveCount,
      attempts: resolved.attempts, // [{id, status, entryDate}]
      currentStatus: resolved.status,
      currentId: resolved.payeeId,
      duplicateLive: resolved.duplicateLive,
      allDead: resolved.needsResubmission,
      suggestedResubmitId: resolved.suggestedResubmitId,
    });
  }
  // Anomalies first (duplicate-live, then all-dead), then by attempt count.
  return rows.sort((a, b) =>
    (b.duplicateLive - a.duplicateLive) || (b.allDead - a.allDead) || (b.attemptCount - a.attemptCount));
}

// When each underlying data source was last refreshed, for a "last updated"
// display so users know how current the PO view is.
function getDataFreshness() {
  const out = {};
  try { out.payeeFeed = payee.feedMeta().generatedAt; } catch (e) { out.payeeFeed = null; }
  try { out.openPos = payee.getOpenPoMap().generatedAt; } catch (e) { out.openPos = null; }
  try {
    const d = JSON.parse(fs.readFileSync(PO_DOCS_PATH, 'utf8'));
    out.poDocs = d.generatedAt || null;
  } catch (e) { out.poDocs = null; }
  return out;
}

/**
 * "Off radar" invoices: Amazon receivables that are open (balance due) but carry
 * NO PO (native or assigned) and have never gone live in Amazon's system, so
 * they never appear in Needs Upload or Uploaded. Omnia invoices are the bulk of
 * these (Omnia does not carry the Amazon PO). Each is returned with its site (if
 * the ship-to is a real Amazon code, not a junk company name) and suggested open
 * POs at that site, so it can be assigned a PO and then transmitted.
 */
function getOrphanInvoices(invoices) {
  const amazon = filterAmazon(invoices);
  const assignments = db.getAllPoAssignments();

  // site -> open POs (Amazon-available desc) for one-click assignment suggestions.
  const openBySite = {};
  for (const r of getPoLedger(invoices)) {
    if (!r.siteCode || r.poStatus !== 'OPEN_FOR_INVOICING') continue;
    (openBySite[r.siteCode] = openBySite[r.siteCode] || []).push(r);
  }
  for (const k of Object.keys(openBySite)) {
    openBySite[k].sort((a, b) => (b.available || 0) - (a.available || 0));
  }

  const orphans = [];
  const siteOverrides = db.getAllInvoiceSiteOverrides();
  for (const inv of amazon) {
    if ((inv.totalDue || 0) <= 0) continue;
    const originalPo = (inv.poNumber || '').trim();
    const assignment = assignments[inv.recordNo];
    const effectivePo = ((assignment ? assignment.assigned_po : originalPo) || '').trim();
    if (effectivePo) continue; // has a PO already -> lives in Needs Upload / Uploaded
    const payeeId = payee.toPayeeId(inv.invoiceId);
    const resolved = payeeId ? payee.resolveInvoice(payeeId) : null;
    if (resolved && !resolved.needsResubmission) continue; // already live in Amazon
    const ovr = siteOverrides[inv.recordNo];
    const site = (ovr && ovr.site_code) || (isValidSite(inv.siteCode) ? normalizeSite(inv.siteCode) : null);
    orphans.push({
      recordNo: inv.recordNo,
      invoiceId: inv.invoiceId,
      customerId: inv.customerId,
      customerName: inv.customerName,
      site,
      siteRaw: inv.siteCode || null,
      hasValidSite: !!site,
      locationName: inv.locationName || null,
      workTicketId: inv.workTicketId || null,
      description: inv.description || null,
      amount: inv.totalDue || 0,
      invoiceDate: inv.whenCreated || null,
      bucket: inv.bucket || null,
      daysOverdue: inv.daysOverdue || 0,
      source: inv.source || null,
      everSubmitted: !!resolved,
      lastAttemptStatus: resolved ? resolved.status : null,
      suggestedPos: site ? (openBySite[site] || []).slice(0, 5)
        .map(r => ({ poNumber: r.poNumber, available: r.available, serviceType: r.serviceType })) : [],
    });
  }
  // Biggest dollars first — triage the material ones.
  return orphans.sort((a, b) => (b.amount || 0) - (a.amount || 0));
}

/**
 * Pending-by-Site grouping — the single source of truth shared by the on-screen
 * report (renderPendingBySite mirrors this) and the Excel export. Two passes:
 *  (1) capacity from the ledger (ceiling/consumed/available per site), with
 *      per-PO pending ZEROED;
 *  (2) pending recomputed from needs-upload, attributed to the INVOICE's own
 *      site (override > valid ship-to > PO fallback — already resolved in
 *      getNeedsUpload). This catches placeholder POs ("NEEDED KRB5") and
 *      multi-site blanket POs the PO-site grouping mislabels.
 * snowOnly filters ledger rows by serviceType==='snow' and pending invoices by
 * their PO's serviceType — same rule as the screen toggle.
 */
function getPendingBySite(invoices, { snowOnly = false } = {}) {
  const ledgerAll = getPoLedger(invoices);
  const needsUpload = getNeedsUpload(invoices);
  const ledgerRows = snowOnly ? ledgerAll.filter(r => r.serviceType === 'snow') : ledgerAll;
  const ledgerByPo = {};
  for (const r of ledgerAll) ledgerByPo[r.poNumber] = r;

  const sites = {};
  const ensureSite = (k) => (sites[k] = sites[k] || { site: k, count: 0, pending: 0, ceiling: 0, consumed: 0, available: null, anyCeiling: false, poRows: [], poIndex: {} });

  for (const r of ledgerRows) {
    const s = ensureSite(r.siteCode || '(no site)');
    s.consumed += r.consumed || 0;
    if (r.ceilingAmount != null) { s.ceiling += r.ceilingAmount; s.anyCeiling = true; }
    if (r.available != null) s.available = (s.available || 0) + r.available;
    const row = { ...r, pendingUpload: 0, pendingUploadInvoiceCount: 0 };
    s.poRows.push(row); s.poIndex[r.poNumber] = row;
  }

  for (const inv of needsUpload) {
    const led = ledgerByPo[inv.assignedPo];
    if (snowOnly && !(led && led.serviceType === 'snow')) continue;
    const s = ensureSite(inv.siteCode || '(no site)');
    s.count++; s.pending += inv.amount || 0;
    let row = s.poIndex[inv.assignedPo];
    if (!row) {
      row = led
        ? { ...led, pendingUpload: 0, pendingUploadInvoiceCount: 0 }
        : { poNumber: inv.assignedPo, ceilingAmount: null, consumed: 0, available: null, poStatus: null, serviceType: null, isSnow: false, docUrl: null, docVersion: null, docRevised: false, pendingUpload: 0, pendingUploadInvoiceCount: 0, noRealPo: true };
      s.poRows.push(row); s.poIndex[inv.assignedPo] = row;
    }
    row.pendingUpload += inv.amount || 0; row.pendingUploadInvoiceCount++;
  }
  for (const s of Object.values(sites)) delete s.poIndex;
  return Object.values(sites);
}

module.exports = {
  getConsumptionRecon, runConsumptionBackfill, syncConsumptionFromIndex, getPoLedger, getNeedsUpload, getOverages, getExcessCapacity, getPoMismatches, getUploaded, getResubmissionMonitor, getDataFreshness, getTransmissionExceptions, getOrphanInvoices, getPendingBySite };
