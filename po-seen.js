'use strict';
// ─── po-seen.js ─────────────────────────────────────────────────────────────
// When did a purchase order first appear, and has its value moved since?
//
// Neither question was answerable. `purchase_orders` holds 90 rows against the
// 1,232 POs Amazon's feed carries, so it is not a registry of what exists — a
// PO's arrival left no trace anywhere, and an increase overwrote the old figure
// with no record that it had changed.
//
// That matters because increases are the norm, not the exception: 485 of 1,326
// POs with a document have been revised at least once, 202 of them more than
// twice, and 2D-20300544 walked $20,000 → $25,975 → $42,487.50 across three
// versions. Meanwhile 358 invoices worth $7.3M sit waiting for exactly that
// kind of top-up (Edwin 2026-09-20).
//
// ADDITIVE ONLY. This writes to its own table and reads Amazon's feed. It
// changes nothing about the ledger, the invoices or any existing row.

const db = require('./db');

function init() {
  const d = db.getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS po_seen (
    po_number      TEXT PRIMARY KEY,
    first_seen_at  TEXT NOT NULL,
    first_amount   REAL,
    current_amount REAL,
    prev_amount    REAL,
    last_change_at TEXT,
    change_count   INTEGER NOT NULL DEFAULT 0,
    order_date     TEXT,
    site_code      TEXT,
    business_unit  TEXT,
    last_seen_at   TEXT NOT NULL
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_po_seen_first ON po_seen(first_seen_at DESC)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_po_seen_change ON po_seen(last_change_at DESC)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_po_seen_site ON po_seen(site_code)`);
}

/**
 * Fold Amazon's current open-PO feed into the table.
 * Returns { arrived, increased, decreased, unchanged } — `arrived` and
 * `increased` are the events worth acting on.
 *
 * `siteOf` is optional and lets the caller supply site/BU from the ledger
 * without this module having to build one.
 */
function sync({ payee, siteOf } = {}) {
  init();
  const p = payee || require('./payee');
  const d = db.getDb();
  const now = new Date().toISOString();

  let byPo = {};
  try { byPo = p.getOpenPoMap().byPo || {}; } catch (e) { return { error: e.message, arrived: [], increased: [] }; }

  const prev = {};
  for (const r of d.prepare('SELECT po_number, current_amount FROM po_seen').all()) prev[r.po_number] = r.current_amount;

  const ins = d.prepare(`INSERT INTO po_seen
      (po_number, first_seen_at, first_amount, current_amount, prev_amount, last_change_at, change_count, order_date, site_code, business_unit, last_seen_at)
      VALUES (?,?,?,?,NULL,NULL,0,?,?,?,?)`);
  const bump = d.prepare(`UPDATE po_seen SET current_amount=?, prev_amount=?, last_change_at=?,
      change_count=change_count+1, site_code=COALESCE(?,site_code), business_unit=COALESCE(?,business_unit), last_seen_at=?
      WHERE po_number=?`);
  const touch = d.prepare(`UPDATE po_seen SET last_seen_at=?, site_code=COALESCE(?,site_code),
      business_unit=COALESCE(?,business_unit) WHERE po_number=?`);

  const arrived = [], increased = [], decreased = [];
  for (const [po, row] of Object.entries(byPo)) {
    const amt = typeof row.poAmount === 'number' ? row.poAmount : null;
    const s = (typeof siteOf === 'function' ? siteOf(po) : null) || {};
    if (!(po in prev)) {
      // First sighting. On the very first run this is the whole book, which is
      // why callers should treat a large `arrived` as a baseline, not news.
      ins.run(po, now, amt, amt, row.orderDate || null, s.siteCode || null, s.businessUnit || null, now);
      arrived.push({ poNumber: po, amount: amt, orderDate: row.orderDate || null, siteCode: s.siteCode || null });
      continue;
    }
    const before = prev[po];
    if (amt != null && before != null && Math.abs(amt - before) > 0.005) {
      bump.run(amt, before, now, s.siteCode || null, s.businessUnit || null, now, po);
      const ev = { poNumber: po, from: before, to: amt, delta: amt - before, siteCode: s.siteCode || null };
      (amt > before ? increased : decreased).push(ev);
    } else {
      touch.run(now, s.siteCode || null, s.businessUnit || null, po);
    }
  }
  return { arrived, increased, decreased, total: Object.keys(byPo).length, at: now };
}

/** Everything we know about one PO's history. */
function get(poNumber) {
  try { return db.getDb().prepare('SELECT * FROM po_seen WHERE po_number=?').get(poNumber) || null; }
  catch (e) { return null; }
}

/** Keyed map for decorating a ledger without a query per row. */
function map() {
  const out = {};
  try { for (const r of db.getDb().prepare('SELECT * FROM po_seen').all()) out[r.po_number] = r; }
  catch (e) {}
  return out;
}

/** Recent arrivals and increases, newest first. */
function recent({ days = 14 } = {}) {
  const d = db.getDb();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  try {
    return {
      arrived: d.prepare('SELECT * FROM po_seen WHERE first_seen_at >= ? ORDER BY first_seen_at DESC').all(since),
      changed: d.prepare('SELECT * FROM po_seen WHERE last_change_at >= ? ORDER BY last_change_at DESC').all(since),
    };
  } catch (e) { return { arrived: [], changed: [] }; }
}

module.exports = { init, sync, get, map, recent };
