'use strict';
// ─── corrigo-refs.js ────────────────────────────────────────────────────────
// The Corrigo work order reference is already on our invoices — in the Sage PO
// field, because that is where whoever billed it typed the WO number.
//
//   ECI-020749  CONE06700043
//   ECI-021008  WO# CONE03001410
//   ECI-021023  CONE00302834
//
// This normalises them, which is the whole prerequisite for matching anything
// Corrigo sends us against anything we have billed. It needs NO API
// credentials, so it is useful on its own the day it ships.
//
// The same shape of problem as Amazon PO numbers: a real reference typed by a
// person, into a free-text field, with a prefix some of the time. Treated the
// same way — capture permissively, judge centrally, and FLAG what cannot be
// resolved rather than guessing.

const db = require('./db');

// Corrigo work order numbers we have seen are a 4-letter customer tag plus
// digits: CONE06700043. The tag is the customer (CONE = CyrusOne), so it is
// NOT hardcoded to CONE — a Westinghouse or Diageo order will carry its own.
const WO_RE = /\b([A-Z]{3,6})(\d{6,12})\b/;

/**
 * Pull a work order reference out of whatever someone typed.
 * Returns null when there is nothing WO-shaped, which is a finding, not a bug.
 */
function parseRef(raw) {
  const s = String(raw || '').toUpperCase().trim();
  if (!s) return null;
  // Strip the label people prepend: "WO# CONE03001410", "WO CONE…", "W/O …"
  const cleaned = s.replace(/^W[\/.]?O\s*#?\s*/i, '').trim();
  const m = cleaned.match(WO_RE);
  if (!m) return null;
  return { ref: m[1] + m[2], tag: m[1], number: m[2], raw: s, tidied: cleaned !== s };
}

/**
 * Every open invoice for the Corrigo customers, with its reference resolved.
 *
 * `customerIds` defaults to whoever is routed to Corrigo on the customer
 * record, so adding a customer to that route brings them in here with no code
 * change.
 */
function build(invoices, opts = {}) {
  let ids = opts.customerIds;
  if (!ids) {
    try {
      ids = db.getDb().prepare(
        `SELECT customer_id FROM customer_accounts WHERE submission_portal = 'Corrigo'`
      ).all().map(r => r.customer_id);
    } catch (e) { ids = []; }
  }
  const want = new Set(ids);

  const rows = [];
  for (const inv of invoices) {
    if (!want.has(inv.customerId)) continue;
    const amount = parseFloat(inv.totalDue || 0) || 0;
    if (amount <= 0.005) continue;
    const parsed = parseRef(inv.poNumber);
    rows.push({
      recordNo: inv.recordNo,
      invoiceId: inv.invoiceId,
      customerId: inv.customerId,
      customerName: inv.customerName || '',
      amount,
      invoiceDate: inv.whenCreated || '',
      dueDate: inv.whenDue || '',
      daysOverdue: inv.daysOverdue || 0,
      serviceCenter: inv.locationName || '',
      rawRef: String(inv.poNumber || '').trim(),
      ref: parsed ? parsed.ref : null,
      tag: parsed ? parsed.tag : null,
      tidied: parsed ? parsed.tidied : false,
    });
  }

  const round = (n) => Math.round((n || 0) * 100) / 100;
  const withRef = rows.filter(r => r.ref);
  const without = rows.filter(r => !r.ref);

  // A reference on more than one invoice is normal — a work order can be
  // billed in stages — but it is worth seeing, because it is also what a
  // copy-paste error looks like.
  const byRef = {};
  for (const r of withRef) (byRef[r.ref] = byRef[r.ref] || []).push(r);
  const shared = Object.entries(byRef).filter(([, v]) => v.length > 1)
    .map(([ref, v]) => ({ ref, count: v.length, amount: round(v.reduce((t, x) => t + x.amount, 0)),
      invoices: v.map(x => x.invoiceId) }))
    .sort((a, b) => b.amount - a.amount);

  const byTag = {};
  for (const r of withRef) {
    byTag[r.tag] = byTag[r.tag] || { tag: r.tag, count: 0, amount: 0 };
    byTag[r.tag].count++; byTag[r.tag].amount = round(byTag[r.tag].amount + r.amount);
  }

  return {
    generatedAt: new Date().toISOString(),
    customerIds: [...want],
    totals: { count: rows.length, amount: round(rows.reduce((t, r) => t + r.amount, 0)) },
    resolved: { count: withRef.length, amount: round(withRef.reduce((t, r) => t + r.amount, 0)) },
    // The gap that matters: billed work with no work order to tie it to.
    unresolved: { count: without.length, amount: round(without.reduce((t, r) => t + r.amount, 0)) },
    tidied: withRef.filter(r => r.tidied).length,
    distinctRefs: Object.keys(byRef).length,
    byTag: Object.values(byTag).sort((a, b) => b.amount - a.amount),
    sharedRefs: shared,
    rows: rows.sort((a, b) => b.amount - a.amount),
  };
}

module.exports = { parseRef, build, WO_RE };
