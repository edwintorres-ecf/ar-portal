'use strict';
// ─── corrigo-store.js ───────────────────────────────────────────────────────
// The work order inbox.
//
// Edwin 2026-09-26, describing the loop this exists to break:
//   "To get those work order references on the invoices, we have to go into
//    the portal, figure out where they belong, get the details, complete them,
//    and then make sure they make it onto the invoice. If we can pull that
//    electronically and see it, it'll help us connect it to invoicing."
//
// That manual carry is exactly where the reference gets dropped: 28 of
// CyrusOne's 109 open invoices ($185,481) reach Sage with no work order on
// them at all. Nothing then ties the money to the job.
//
// ─── WHY IT WORKS BEFORE THE API DOES ───────────────────────────────────────
// Every work order we have ever billed left a reference behind in the Sage PO
// field. Seeding from those gives a real, if partial, inbox today — 81 work
// orders for CyrusOne. When credentials land, the sync fills in what only
// Corrigo knows (status, site, NTE, dates) and adds the ones we have NOT
// billed, which is the half we are blind to.
//
// A row's `source` says which it is, so a seeded row is never mistaken for one
// Corrigo confirmed.

const db = require('./db');

let _ready = false;
function ensureTable() {
  if (_ready) return;
  const d = db.getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS corrigo_work_orders (
    wo_ref        TEXT PRIMARY KEY,   -- CONE06700043, as it appears on the invoice
    wo_id         TEXT,               -- Corrigo's own id, only known via the API
    customer_tag  TEXT,               -- CONE
    customer_id   TEXT,               -- ours, e.g. C-00576
    status        TEXT,
    site          TEXT,
    address       TEXT,
    city          TEXT,
    state         TEXT,
    description   TEXT,
    nte           REAL,               -- not-to-exceed
    opened_at     TEXT,
    completed_at  TEXT,
    source        TEXT NOT NULL,      -- 'api' | 'invoice-ref'
    raw_json      TEXT,
    first_seen_at TEXT DEFAULT (datetime('now')),
    last_seen_at  TEXT DEFAULT (datetime('now'))
  )`);
  d.exec('CREATE INDEX IF NOT EXISTS idx_cwo_cust ON corrigo_work_orders(customer_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_cwo_status ON corrigo_work_orders(status)');
  _ready = true;
}

const clean = (v) => (v === null || v === undefined || String(v).trim() === '') ? null : String(v).trim();

/**
 * Record a work order Corrigo told us about.
 *
 * API data always wins over a seeded row — Corrigo knows the status and we are
 * only inferring one. But a field Corrigo left empty never blanks one we
 * already hold: COALESCE keeps it, so a sparse payload cannot erase detail.
 */
function upsertFromApi(wo) {
  ensureTable();
  const ref = clean(wo.ref || wo.number || wo.workOrderNumber);
  if (!ref) return null;
  db.getDb().prepare(`INSERT INTO corrigo_work_orders
    (wo_ref, wo_id, customer_tag, customer_id, status, site, address, city, state,
     description, nte, opened_at, completed_at, source, raw_json, last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'api',?,datetime('now'))
    ON CONFLICT(wo_ref) DO UPDATE SET
      wo_id        = COALESCE(excluded.wo_id, corrigo_work_orders.wo_id),
      customer_id  = COALESCE(excluded.customer_id, corrigo_work_orders.customer_id),
      status       = COALESCE(excluded.status, corrigo_work_orders.status),
      site         = COALESCE(excluded.site, corrigo_work_orders.site),
      address      = COALESCE(excluded.address, corrigo_work_orders.address),
      city         = COALESCE(excluded.city, corrigo_work_orders.city),
      state        = COALESCE(excluded.state, corrigo_work_orders.state),
      description  = COALESCE(excluded.description, corrigo_work_orders.description),
      nte          = COALESCE(excluded.nte, corrigo_work_orders.nte),
      opened_at    = COALESCE(excluded.opened_at, corrigo_work_orders.opened_at),
      completed_at = COALESCE(excluded.completed_at, corrigo_work_orders.completed_at),
      source       = 'api',
      raw_json     = excluded.raw_json,
      last_seen_at = datetime('now')`).run(
    ref.toUpperCase(), clean(wo.id), clean(wo.tag), clean(wo.customerId), clean(wo.status),
    clean(wo.site), clean(wo.address), clean(wo.city), clean(wo.state),
    clean(wo.description), Number.isFinite(Number(wo.nte)) ? Number(wo.nte) : null,
    clean(wo.openedAt), clean(wo.completedAt), JSON.stringify(wo).slice(0, 20000));
  return ref.toUpperCase();
}

/**
 * Seed from the references already on our invoices.
 *
 * Inserts ONLY. An existing row is left completely alone, because it either
 * came from the API (better) or is already here. Returns what it added so a
 * caller can report honestly rather than claiming a sync happened.
 */
function seedFromInvoices(invoices) {
  ensureTable();
  const refs = require('./corrigo-refs');
  const built = refs.build(invoices);
  const d = db.getDb();
  const ins = d.prepare(`INSERT OR IGNORE INTO corrigo_work_orders
    (wo_ref, customer_tag, customer_id, source) VALUES (?,?,?,'invoice-ref')`);
  let added = 0;
  for (const r of built.rows) {
    if (!r.ref) continue;
    const before = d.prepare('SELECT 1 FROM corrigo_work_orders WHERE wo_ref=?').get(r.ref);
    if (before) continue;
    ins.run(r.ref, r.tag, r.customerId);
    added++;
  }
  return { added, seen: built.resolved.count, unresolvedInvoices: built.unresolved };
}

function list(opts = {}) {
  ensureTable();
  const where = [], args = [];
  if (opts.customerId) { where.push('customer_id = ?'); args.push(opts.customerId); }
  if (opts.source) { where.push('source = ?'); args.push(opts.source); }
  try {
    return db.getDb().prepare(`SELECT * FROM corrigo_work_orders
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY wo_ref`).all(...args);
  } catch (e) { return []; }
}

/**
 * The inbox: every work order we know of, against what we have billed for it.
 *
 * Three states worth acting on, and they are the point of the screen:
 *   billed        — an invoice carries this reference
 *   not billed    — Corrigo gave us the work order, nothing has been invoiced
 *   orphan invoice— billed with NO work order reference at all, so nothing
 *                   connects the money to a job
 */
function inbox(invoices) {
  ensureTable();
  const refs = require('./corrigo-refs');
  const built = refs.build(invoices);

  const byRef = {};
  for (const r of built.rows) {
    if (!r.ref) continue;
    (byRef[r.ref] = byRef[r.ref] || []).push(r);
  }

  const round = (n) => Math.round((n || 0) * 100) / 100;
  const rows = list().map(w => {
    const inv = byRef[w.wo_ref] || [];
    return {
      ref: w.wo_ref, woId: w.wo_id, customerId: w.customer_id, tag: w.customer_tag,
      status: w.status, site: w.site, city: w.city, state: w.state,
      description: w.description, nte: w.nte,
      openedAt: w.opened_at, completedAt: w.completed_at,
      source: w.source, firstSeenAt: w.first_seen_at, lastSeenAt: w.last_seen_at,
      billed: inv.length > 0,
      invoiceCount: inv.length,
      invoiced: round(inv.reduce((t, x) => t + x.amount, 0)),
      invoices: inv.map(x => ({ invoiceId: x.invoiceId, amount: x.amount, date: x.invoiceDate,
        daysOverdue: x.daysOverdue, serviceCenter: x.serviceCenter })),
    };
  });

  const orphans = built.rows.filter(r => !r.ref);
  const notBilled = rows.filter(r => !r.billed);
  const billed = rows.filter(r => r.billed);
  const fromApi = rows.filter(r => r.source === 'api');

  return {
    generatedAt: new Date().toISOString(),
    // Said plainly, because a partial inbox that looks complete is worse than
    // no inbox: until the API is connected this holds only work orders we have
    // ALREADY billed, so "not billed" will read as zero and mean nothing.
    apiConnected: fromApi.length > 0,
    counts: {
      workOrders: rows.length,
      fromApi: fromApi.length,
      fromInvoiceRefs: rows.length - fromApi.length,
      billed: billed.length,
      notBilled: notBilled.length,
    },
    totals: {
      invoiced: round(billed.reduce((t, r) => t + r.invoiced, 0)),
      orphanInvoices: orphans.length,
      orphanAmount: round(orphans.reduce((t, r) => t + r.amount, 0)),
    },
    rows: rows.sort((a, b) => b.invoiced - a.invoiced),
    orphanInvoices: orphans.sort((a, b) => b.amount - a.amount),
  };
}

module.exports = { ensureTable, upsertFromApi, seedFromInvoices, list, inbox };
