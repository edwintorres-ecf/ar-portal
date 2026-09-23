'use strict';
// ─── po-intake-health.js ────────────────────────────────────────────────────
// Catch a defective purchase order ON ARRIVAL, not months later when an invoice
// against it gets held.
//
// Why this exists. Snow POs do not trickle in — they land in a batch. July 2026
// brought 255 snow POs worth $44.0M in a single month; October 2025 brought 93.
// A PO that arrives without a ceiling amount cannot be checked for headroom, so
// we submit against it blind and find out it was short when Amazon puts the
// invoice in "Insufficient PO Funds Hold". That bucket is currently $4.8M
// (Edwin 2026-09-15, planning for the 2026-27 season).
//
// Every defect here is one we can see the day the PO arrives and fix before a
// single invoice is billed against it.

const db = require('./db');
const poLedger = require('./po-ledger');

// Ordered worst-first. `blocking` means we cannot safely bill against this PO.
const CHECKS = [
  // "No PO value" used to be ONE blocking check over every PO with no ceiling.
  // It was 59 POs, and 50 of them were simply ones Amazon publishes as "--" —
  // 15 of those already had invoices ACCEPTED against them. Calling a PO we are
  // successfully billing "cannot safely be billed against" is how a screen
  // teaches people to ignore it (Edwin 2026-09-23).
  //
  // The two halves are genuinely different problems with different fixes, so
  // they are now two checks. Together they cover exactly what the single one did.
  {
    key: 'no-ceiling', blocking: true,
    label: 'PO not visible in Amazon’s open-PO list',
    why: 'Amazon does not list this PO as open, so we have no value, no status and no confirmation it exists on their side. Submissions to a PO in this state vanish without an error — this is the July 17 failure mode.',
    test: (p) => p.ceilingAmount == null && !p.poStatus,
  },
  {
    key: 'value-unpublished', blocking: false,
    label: 'Amazon publishes no value for the PO',
    why: 'Amazon lists the PO as open but shows its amount as "--", so headroom cannot be checked before sending. That is a blind spot, NOT a blocker: POs in this state routinely accept and pay invoices. The PO document usually carries the real value — file it and this clears.',
    test: (p) => p.ceilingAmount == null && !!p.poStatus,
  },
  {
    key: 'no-site', blocking: true,
    label: 'No site resolved',
    why: 'The PO cannot be attributed to a site, so its funds are invisible to the site and business-unit views everyone works from.',
    test: (p) => !p.siteCode,
  },
  {
    key: 'no-business-unit', blocking: false,
    label: 'Site not in the Amazon master',
    why: 'The site has no business unit, so this PO drops out of every per-BU report. Fix by adding the site to the location master.',
    test: (p) => !!p.siteCode && !String(p.businessUnit || '').trim(),
  },
  {
    key: 'ceiling-discrepancy', blocking: true,
    label: 'PO value disagrees with the document',
    why: 'Amazon’s figure and the PO document do not match. One of them is wrong and we do not know which, so the headroom we are working to is unreliable.',
    test: (p) => !!p.ceilingDiscrepancy,
  },
  {
    key: 'no-document', blocking: false,
    label: 'No PO document',
    why: 'Nothing to check the value, the site or the line items against. Everything about this PO is taken on trust from the feed.',
    test: (p) => !p.hasDoc,
  },
  {
    key: 'closed-with-funds', blocking: false,
    label: 'Closed with money still on it',
    why: 'Nothing can be billed against a closed PO, so any balance left is stranded unless Amazon reopens it.',
    test: (p) => !!p.poStatus && p.poStatus !== 'OPEN_FOR_INVOICING' && (p.available || 0) > 500,
  },
  {
    key: 'overdrawn', blocking: false,
    label: 'Already billed past its value',
    why: 'We have invoiced more than the order carries. Whatever is over is held and needs funding or crediting.',
    test: (p) => (p.available || 0) < -0.5,
  },
];

/**
 * Evaluate every PO. `snowOnly` narrows to snow work for in-season triage;
 * the default is everything, because a defective landscaping PO is still a
 * defective PO.
 */
function analyse(invoices, { snowOnly = false } = {}) {
  let ledger = poLedger.getPoLedger(invoices);
  if (snowOnly) ledger = ledger.filter(p => p.serviceType === 'snow');

  // A placeholder with nothing behind it is a spent note to ourselves, not a
  // defective purchase order. "NEEDED KRB5" held $55,555 until its invoices
  // adopted the real PO; the row lingers because it is a tracked PO, and
  // reporting it forever would train people to ignore this screen. A
  // placeholder that STILL carries work stays flagged — that is the real thing
  // to fix (Edwin 2026-09-15).
  const spentPlaceholder = (p) => {
    try { if (!require('./po-placeholder-adopt').isPlaceholder(p.poNumber)) return false; } catch (e) { return false; }
    return !(p.pendingUpload > 0) && !(p.consumed > 0) && !(p.ceilingAmount > 0);
  };
  ledger = ledger.filter(p => !spentPlaceholder(p));

  const pos = [];
  for (const p of ledger) {
    const hits = CHECKS.filter(c => c.test(p));
    if (!hits.length) continue;
    pos.push({
      poNumber: p.poNumber,
      siteCode: p.siteCode || null,
      businessUnit: p.businessUnit || '',
      serviceType: p.serviceType || '',
      poStatus: p.poStatus || '',
      value: p.ceilingAmount,
      available: p.available,
      pendingUpload: p.pendingUpload || 0,
      docDate: p.docDate || null,
      docUrl: p.docUrl || null,
      defects: hits.map(c => c.key),
      blocking: hits.some(c => c.blocking),
      // Money already waiting behind a broken PO is the reason to fix it today
      // rather than at month end.
      atRisk: p.pendingUpload || 0,
    });
  }

  const byCheck = {};
  for (const c of CHECKS) {
    const hit = pos.filter(x => x.defects.includes(c.key));
    byCheck[c.key] = {
      key: c.key, label: c.label, why: c.why, blocking: c.blocking,
      count: hit.length,
      atRisk: Math.round(hit.reduce((t, x) => t + (x.atRisk || 0), 0) * 100) / 100,
      pos: hit.map(x => x.poNumber),
    };
  }

  const blocking = pos.filter(p => p.blocking);
  return {
    snowOnly,
    checks: CHECKS.map(c => byCheck[c.key]),
    pos: pos.sort((a, b) => (b.blocking - a.blocking) || (b.atRisk - a.atRisk)),
    totals: {
      posChecked: ledger.length,
      posWithDefects: pos.length,
      blocking: blocking.length,
      atRisk: Math.round(pos.reduce((t, p) => t + (p.atRisk || 0), 0) * 100) / 100,
      clean: ledger.length - pos.length,
      // The number to watch in season: what share of the book is ready to bill.
      readyPct: ledger.length ? Math.round((ledger.length - blocking.length) / ledger.length * 1000) / 10 : 100,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Persist state and return only what is NEW since the last sweep, so an alert
 * fires once per defect rather than every run. Returns { newly, resolved }.
 */
function sweep(invoices, { snowOnly = false } = {}) {
  const a = analyse(invoices, { snowOnly });
  const d = db.getDb();
  const now = new Date().toISOString();
  const prev = {};
  try {
    for (const r of d.prepare('SELECT po_number, defects, resolved_at FROM po_intake_health').all()) {
      prev[r.po_number] = r;
    }
  } catch (e) { return { newly: [], resolved: [], analysis: a }; }

  const newly = [], seen = new Set();
  const up = d.prepare(`INSERT INTO po_intake_health (po_number, defects, blocking, at_risk, first_seen_at, last_seen_at, resolved_at)
                        VALUES (?,?,?,?,?,?,NULL)
                        ON CONFLICT(po_number) DO UPDATE SET
                          defects=excluded.defects, blocking=excluded.blocking,
                          at_risk=excluded.at_risk, last_seen_at=excluded.last_seen_at, resolved_at=NULL`);
  for (const p of a.pos) {
    seen.add(p.poNumber);
    const was = prev[p.poNumber];
    const sig = p.defects.slice().sort().join(',');
    // New if we have never seen it, if it had been resolved, or if it picked up
    // a defect it did not have before.
    if (!was || was.resolved_at || String(was.defects || '') !== sig) newly.push(p);
    up.run(p.poNumber, sig, p.blocking ? 1 : 0, p.atRisk || 0, (was && was.first_seen_at) || now, now);
  }

  const resolved = [];
  const close = d.prepare('UPDATE po_intake_health SET resolved_at=? WHERE po_number=? AND resolved_at IS NULL');
  for (const [po, r] of Object.entries(prev)) {
    if (seen.has(po) || r.resolved_at) continue;
    close.run(now, po);
    resolved.push(po);
  }
  return { newly, resolved, analysis: a };
}

module.exports = { analyse, sweep, CHECKS };
