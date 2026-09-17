'use strict';
// ─── ar-snapshot.js ─────────────────────────────────────────────────────────
// One row a day describing where the Amazon book stood.
//
// Why: on 2026-09-15 the "no business unit" open AR moved $52,000 in ninety
// minutes and there was no way to say where it went, because nothing recorded
// the earlier state. Every figure in this portal is computed live from the Sage
// cache and the Payee feed, both of which are replaced on a timer — so the
// moment a number changes, the number it changed FROM is gone.
//
// This is deliberately a small, wide row rather than a warehouse: the question
// it has to answer is "what moved, and when", not "reconstruct the book".
// (Edwin 2026-09-15, ahead of the October PO influx.)

const db = require('./db');
const poLedger = require('./po-ledger');
const siteLedger = require('./site-ledger');
const payee = require('./payee');

const r2 = (n) => Math.round((n || 0) * 100) / 100;

/** Compute today's figures. Pure — does not write. */
function capture(invoices, { sage } = {}) {
  const ledger = poLedger.getPoLedger(invoices);
  const rows = siteLedger.buildAmazonRows(invoices, { payee }).filter(r => (r.amount || 0) > 0.005);
  const snowPos = new Set(ledger.filter(p => p.serviceType === 'snow').map(p => p.poNumber));

  const byStatus = {};
  for (const r of rows) {
    const k = r.amazonSettled ? 'Paid — needs applying' : (r.payeeStatus || 'Not submitted');
    byStatus[k] = byStatus[k] || { count: 0, amount: 0 };
    byStatus[k].count++; byStatus[k].amount = r2(byStatus[k].amount + r.amount);
  }

  const snowRows = rows.filter(r => snowPos.has(r.po));
  const sum = (l) => r2(l.reduce((t, r) => t + (r.amount || 0), 0));

  // Intake health and the unblock split, from the modules that own them, so a
  // snapshot can never disagree with the screen it came from.
  let intake = null, unblock = null, noBu = null;
  try { intake = require('./po-intake-health').analyse(invoices).totals; } catch (e) {}
  try {
    const a = require('./amazon-funds-report').analyse(invoices, { snowOnly: true });
    if (a.unblock) unblock = {
      release: a.unblock.release.amount, sameSite: a.unblock.sameSite.amount,
      sameBu: a.unblock.sameBu.amount, newMoney: a.unblock.newMoney.amount,
      total: a.unblock.total, count: a.unblock.count,
    };
  } catch (e) {}
  try { noBu = require('./amazon-no-bu-report').analyse(invoices).totals; } catch (e) {}

  let sageFetchedAt = null, feedAt = null;
  try { const c = (sage || require('./sage')).getCacheAge(); sageFetchedAt = c && c.fetchedAt; } catch (e) {}
  try { feedAt = payee.feedMeta().generatedAt; } catch (e) {}

  return {
    taken_at: new Date().toISOString(),
    sage_fetched_at: sageFetchedAt,
    payee_feed_at: feedAt,
    invoices_cached: (invoices || []).length,
    open_ar: sum(rows),
    open_ar_count: rows.length,
    snow_ar: sum(snowRows),
    snow_ar_count: snowRows.length,
    pos_total: ledger.length,
    pos_snow: ledger.filter(p => p.serviceType === 'snow').length,
    po_available: r2(ledger.reduce((t, p) => t + Math.max(0, p.available || 0), 0)),
    po_overdrawn: r2(ledger.reduce((t, p) => t + Math.min(0, p.available || 0), 0)),
    intake_blocking: intake ? intake.blocking : null,
    intake_at_risk: intake ? intake.atRisk : null,
    no_bu_sites: noBu ? noBu.sites : null,
    no_bu_available: noBu ? noBu.poAvailable : null,
    detail: JSON.stringify({ byStatus, unblock, intake, noBu }),
  };
}

/** Capture and store. One row per calendar day (ET); a re-run replaces it. */
function take(invoices, opts) {
  const snap = capture(invoices, opts);
  // The ET calendar day, and it has to be derived in one step.
  //
  // This previously formatted the instant into an ET string, re-parsed that
  // string as LOCAL time, then called .toISOString() — which converts back to
  // UTC and undoes the timezone shift entirely. The key was therefore the UTC
  // day wearing an ET label, so every snapshot taken after 8pm ET was filed
  // under TOMORROW. Caught on 2026-09-16, when a 21:58 ET run created a second
  // row dated the 17th holding the 16th's figures: two rows for one day, and a
  // day-over-day delta computed against the wrong baseline. en-CA formats as
  // YYYY-MM-DD directly, so there is no round trip to get wrong.
  const day = new Date(snap.taken_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const d = db.getDb();
  const cols = Object.keys(snap);
  d.prepare(`INSERT INTO ar_snapshots (day, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
             ON CONFLICT(day) DO UPDATE SET ${cols.map(c => `${c}=excluded.${c}`).join(', ')}`)
    .run(day, ...cols.map(c => snap[c]));
  return { day, ...snap };
}

/** Most recent `days` rows, oldest first, with day-over-day deltas attached. */
function history(days = 30) {
  const d = db.getDb();
  const rows = d.prepare('SELECT * FROM ar_snapshots ORDER BY day DESC LIMIT ?').all(days).reverse();
  const NUM = ['open_ar', 'snow_ar', 'po_available', 'intake_at_risk', 'no_bu_available', 'open_ar_count', 'pos_total', 'intake_blocking'];
  return rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const delta = {};
    if (prev) for (const k of NUM) delta[k] = r2((r[k] || 0) - (prev[k] || 0));
    let detail = null;
    try { detail = JSON.parse(r.detail || 'null'); } catch (e) {}
    return { ...r, detail, delta };
  });
}

module.exports = { capture, take, history };
