'use strict';
// ─── customer-family.js ─────────────────────────────────────────────────────
// Intacct models customers as a hierarchy, and 399 of ours sit under a parent:
// Amazon.com Services LLC (C-00403) under Amazon (C-00002), every CBRE and Kurv
// site under its head office, the MHS hospital records under one district.
//
// It matters for correspondence because the person you email about a past-due
// invoice at one site is very often the same person who handles the other nine,
// and because "what do they owe us" is a question about the family, not the
// record (Edwin 2026-09-16).
//
// Cached in the DB rather than fetched per request: the hierarchy changes when
// someone edits a customer in Intacct, which is rare, and a Sage round trip is
// far too slow to sit behind a composer.

const db = require('./db');

/** Refresh the cache from Sage. Returns { count, parents }. */
async function refresh(sage) {
  const list = await (sage || require('./sage')).getCustomers();
  const d = db.getDb();
  const now = new Date().toISOString();
  const up = d.prepare(`INSERT INTO customer_family (customer_id, name, parent_id, parent_name, updated_at)
                        VALUES (?,?,?,?,?)
                        ON CONFLICT(customer_id) DO UPDATE SET
                          name=excluded.name, parent_id=excluded.parent_id,
                          parent_name=excluded.parent_name, updated_at=excluded.updated_at`);
  let parents = 0;
  for (const c of list) {
    up.run(c.id, c.name || '', c.parentId || null, c.parentName || null, now);
    if (c.parentId) parents++;
  }
  return { count: list.length, parents };
}

function row(customerId) {
  if (!customerId) return null;
  try { return db.getDb().prepare('SELECT * FROM customer_family WHERE customer_id=?').get(customerId) || null; }
  catch (e) { return null; }
}

/**
 * The family a customer belongs to.
 *   self     — this record
 *   parent   — its parent, if any
 *   children — records whose parent is THIS one
 *   siblings — records sharing this one's parent (excluding self)
 *   all      — every id in the family including self, for balance queries
 *
 * One level only. Intacct permits deeper nesting, but ours is flat in practice
 * and walking further would silently pull in customers nobody expects on an
 * email about one invoice.
 */
function family(customerId) {
  const self = row(customerId);
  if (!self) return { self: null, parent: null, children: [], siblings: [], all: customerId ? [customerId] : [] };
  const d = db.getDb();
  const parent = self.parent_id ? row(self.parent_id) : null;
  let children = [], siblings = [];
  try {
    children = d.prepare('SELECT * FROM customer_family WHERE parent_id=? ORDER BY name').all(self.customer_id);
    if (self.parent_id) {
      siblings = d.prepare('SELECT * FROM customer_family WHERE parent_id=? AND customer_id<>? ORDER BY name')
        .all(self.parent_id, self.customer_id);
    }
  } catch (e) {}
  const all = [...new Set([
    self.customer_id,
    ...(parent ? [parent.customer_id] : []),
    ...children.map(c => c.customer_id),
    ...siblings.map(c => c.customer_id),
  ])];
  return { self, parent, children, siblings, all };
}

/** Contacts across the whole family, tagged with which record they came from. */
function familyContacts(customerId) {
  const f = family(customerId);
  const out = [];
  for (const id of f.all) {
    let cs = [];
    try { cs = db.listCustomerContacts(id) || []; } catch (e) {}
    const rel = id === customerId ? 'this customer'
      : (f.parent && id === f.parent.customer_id) ? 'parent'
      : f.children.some(c => c.customer_id === id) ? 'child' : 'related';
    for (const c of cs) out.push({ ...c, fromCustomerId: id, relationship: rel });
  }
  // This customer's own contacts first, primaries above the rest.
  const rank = { 'this customer': 0, parent: 1, child: 2, related: 3 };
  return out.sort((a, b) => (rank[a.relationship] - rank[b.relationship])
    || (b.is_primary - a.is_primary)
    || String(a.name || a.email).localeCompare(String(b.name || b.email)));
}

module.exports = { refresh, family, familyContacts, row };
