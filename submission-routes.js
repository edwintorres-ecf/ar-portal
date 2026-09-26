'use strict';
// ─── submission-routes.js ───────────────────────────────────────────────────
// How does an invoice actually REACH each customer, and is there any record
// that it did?
//
// Edwin 2026-09-25: "while amazon is the largest volume we do have other
// customers and portals we need to submit invoices to."
//
// Amazon has a whole pipeline — Needs Upload, EDI 810, Payee Central
// reconciliation, and the standing rule that not-in-Payee means not submitted.
// The other $2.6M across 151 customers had NO route recorded anywhere, so an
// invoice could sit posted in Sage, never submitted, and nothing would surface
// it.
//
// ─── WHAT THIS DOES NOT CLAIM ───────────────────────────────────────────────
// It does not say an invoice was never sent. Almost all non-Amazon billing
// happens outside the portal today — 27 outbound messages exist in total — so
// "no record" is the overwhelmingly common state and means exactly that: THE
// PORTAL HAS NO RECORD. Calling $2.6M "not submitted" on that basis would be a
// fabrication dressed as a finding.
//
// What it does do is make the gap visible per customer, so the route can be
// written down once and the ones with no route at all stand out.

const db = require('./db');

// Amazon has its own pipeline; including it here would bury the customers this
// exists for under one that already has an answer.
//
// ONLY C-00403. `C-00566 CW Amazon Services` is Cushman & Wakefield managing
// Amazon property — it is billed to CW, NOT through Payee Central, and its
// invoices are uploaded to CW's portal by hand. Excluding it (copied from
// dunning.js, where pairing them is right for a different reason) hid a
// customer that genuinely needs a route. Checked 2026-09-26: 0 of its 19 open
// invoices are in the Payee feed and 0 are in the Amazon Needs Upload queue,
// against 1,347 of 1,552 for C-00403.
const AMAZON = new Set(['C-00403']);

const CHANNELS = {
  portal: { label: 'Customer portal', note: 'Submitted through the customer’s own AP system' },
  email:  { label: 'Email to AP',     note: 'Invoice emailed to an AP address' },
  edi:    { label: 'EDI / API',       note: 'Transmitted machine to machine' },
  mail:   { label: 'Post',            note: 'Printed and posted' },
  none:   { label: 'No route needed', note: 'Paid without a submission, e.g. collected at the office' },
};

const round = (n) => Math.round((n || 0) * 100) / 100;

/**
 * One row per customer with open AR, the route on record, and whatever
 * evidence of submission the portal actually holds.
 */
function build(invoices, opts = {}) {
  const includeAmazon = !!opts.includeAmazon;

  const accounts = {};
  try { for (const a of db.getAllCustomerAccounts()) accounts[a.customer_id] = a; } catch (e) { /* none yet */ }

  // The only submission evidence the portal owns: an outbound message that
  // carried the invoice. `message_invoices` links them; a message still in
  // draft or failed is not evidence of anything.
  const emailed = {};
  try {
    for (const r of db.getDb().prepare(`
      SELECT mi.record_no AS rec, MAX(m.sent_at) AS at, COUNT(*) AS n
      FROM message_invoices mi JOIN messages m ON m.id = mi.message_id
      WHERE m.direction='out' AND m.status='sent'
      GROUP BY mi.record_no`).all()) emailed[String(r.rec)] = { at: r.at, n: r.n };
  } catch (e) { /* comms tables absent — every row degrades to "no record" */ }

  const byCustomer = {};
  for (const inv of invoices) {
    const cid = inv.customerId || '(none)';
    if (!includeAmazon && AMAZON.has(cid)) continue;
    const amount = parseFloat(inv.totalDue || 0) || 0;
    if (amount <= 0.005) continue;
    const c = byCustomer[cid] = byCustomer[cid] || {
      customerId: cid, customerName: inv.customerName || '',
      count: 0, amount: 0, oldestDays: 0, pastDue: 0, pastDueAmount: 0,
      withRecord: 0, withRecordAmount: 0, invoices: [],
    };
    const ev = emailed[String(inv.recordNo)] || null;
    c.count++; c.amount += amount;
    if ((inv.daysOverdue || 0) > 0) { c.pastDue++; c.pastDueAmount += amount; }
    if ((inv.daysOverdue || 0) > c.oldestDays) c.oldestDays = inv.daysOverdue || 0;
    if (ev) { c.withRecord++; c.withRecordAmount += amount; }
    c.invoices.push({
      recordNo: inv.recordNo, invoiceId: inv.invoiceId, amount,
      invoiceDate: inv.whenCreated || '', dueDate: inv.whenDue || '',
      daysOverdue: inv.daysOverdue || 0, bucket: inv.bucket || '',
      locationName: inv.locationName || '',
      sentAt: ev ? ev.at : null,
    });
  }

  const rows = Object.values(byCustomer).map(c => {
    const a = accounts[c.customerId] || {};
    const channel = (a.submission_channel || '').trim();
    return {
      ...c,
      amount: round(c.amount), pastDueAmount: round(c.pastDueAmount),
      withRecordAmount: round(c.withRecordAmount),
      channel,
      channelLabel: channel ? ((CHANNELS[channel] || {}).label || channel) : '',
      portal: a.submission_portal || '',
      url: a.submission_url || '',
      ref: a.submission_ref || '',
      notes: a.submission_notes || '',
      setBy: a.submission_set_by || '',
      setAt: a.submission_set_at || '',
      houseAccount: !!a.house_account,
      // The question this screen exists to answer.
      routeKnown: !!channel,
      invoices: c.invoices.sort((x, y) => y.amount - x.amount),
    };
  }).sort((a, b) => b.amount - a.amount);

  const sum = (list) => ({ customers: list.length,
    count: list.reduce((t, r) => t + r.count, 0),
    amount: round(list.reduce((t, r) => t + r.amount, 0)) });

  const unrouted = rows.filter(r => !r.routeKnown);
  const byChannel = Object.keys(CHANNELS).map(k => ({ key: k, ...CHANNELS[k],
    ...sum(rows.filter(r => r.channel === k)) })).filter(x => x.customers);

  return {
    generatedAt: new Date().toISOString(),
    channels: CHANNELS,
    totals: sum(rows),
    unrouted: sum(unrouted),
    withRecord: {
      count: rows.reduce((t, r) => t + r.withRecord, 0),
      amount: round(rows.reduce((t, r) => t + r.withRecordAmount, 0)),
    },
    byChannel,
    rows,
  };
}

module.exports = { build, CHANNELS, AMAZON };
