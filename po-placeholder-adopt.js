'use strict';
// ─── po-placeholder-adopt.js ────────────────────────────────────────────────
// An invoice billed to a placeholder PO — "NEEDED KRB5", "TBD", "PO PENDING" —
// should adopt the real purchase order once Amazon issues one for that site.
//
// Until it does, the work is invisible to everything that reasons at PO level:
// the placeholder has no value and no document, so PO intake health flags it as
// defective, the funding analysis cannot tell whether the work is covered, and
// the invoice cannot be submitted. KRB5 carried $55,555 like this while its real
// PO, 2D-20583322, sat right beside it (Edwin 2026-09-15).
//
// The rule is deliberately narrow. Adopt ONLY when the site has exactly ONE
// real, open PO of the same service type. Where a site has several, picking one
// is a judgement about which budget the work belongs to, and that is a human's
// call — those are returned as `ambiguous` for someone to assign by hand.

const db = require('./db');
const poLedger = require('./po-ledger');
const siteLedger = require('./site-ledger');
const payee = require('./payee');

const PLACEHOLDER_RE = /needed|tbd|to be determined|pending|none|n\/a|po-msg|^-+$/i;

// The authority on whether a purchase order is real is AMAZON, not its shape.
// B997-22182169 is a genuine $130,206 order that no "2D-" rule would accept,
// while "987639" and "WO #534482" look plausible and are ours, not theirs
// (Edwin 2026-09-15: "the ones here without the 2D are not actual amazon PO's").
let _amazonPoSet = null, _amazonPoAt = 0;
function amazonPoSet() {
  if (_amazonPoSet && (Date.now() - _amazonPoAt) < 5 * 60 * 1000) return _amazonPoSet;
  const set = new Set();
  try { for (const k of Object.keys(require('./payee').getOpenPoMap().byPo || {})) set.add(k); } catch (e) {}
  try {
    const d = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'payee-po-details.spark.json'), 'utf8'));
    for (const k of Object.keys(d.details || {})) set.add(k);
  } catch (e) {}
  _amazonPoSet = set; _amazonPoAt = Date.now();
  return set;
}

/** Is this PO number a stand-in rather than a real Amazon order? */
function isPlaceholder(po) {
  const s = String(po || '').trim();
  if (!s) return true;
  // Amazon knows it — real, whatever it looks like.
  if (amazonPoSet().has(s)) return false;
  // Obvious notes to ourselves.
  if (PLACEHOLDER_RE.test(s)) return true;
  // Otherwise fall back to shape. Amazon orders are <prefix>-<6+ digits>;
  // a bare number or a work-order reference is not one of theirs.
  return !/^[A-Z0-9]{2,6}-\d{6,}$/i.test(s);
}

/**
 * Work out which placeholder invoices could adopt a real PO.
 * Pure — writes nothing. Returns { adopt, ambiguous, orphan }.
 */
function plan(invoices) {
  const ledger = poLedger.getPoLedger(invoices);
  const rows = siteLedger.buildAmazonRows(invoices, { payee })
    .filter(r => (r.amount || 0) > 0.005 && isPlaceholder(r.po));

  // Candidate POs per site: real, open, and not a placeholder themselves.
  const bySite = {};
  for (const p of ledger) {
    if (!p.siteCode || isPlaceholder(p.poNumber)) continue;
    if (p.poStatus && p.poStatus !== 'OPEN_FOR_INVOICING') continue;
    (bySite[p.siteCode] = bySite[p.siteCode] || []).push(p);
  }

  const adopt = [], ambiguous = [], orphan = [];
  for (const r of rows) {
    const site = r.site;
    const cands = (site && bySite[site]) || [];
    // Match the service type where we know it, so snow work never adopts a
    // landscaping order. The placeholder itself usually carries one — the
    // ledger classifies "NEEDED KRB5" as snow from purchase_orders.service_type
    // — and that is a far better signal than anything inferred from the site.
    const ph = ledger.find(p => p.poNumber === r.po);
    const svc = (ph && ph.serviceType && ph.serviceType !== 'unknown' ? ph.serviceType : null)
      || r.serviceType || guessService(r, ledger);
    const matched = svc ? cands.filter(p => p.serviceType === svc) : cands;
    const pool = matched.length ? matched : (svc ? [] : cands);

    if (pool.length === 1) {
      adopt.push({ recordNo: r.recordNo, invoiceId: r.invoiceId, amount: r.amount,
        site, from: r.po, to: pool[0].poNumber, service: pool[0].serviceType,
        poValue: pool[0].ceilingAmount, poAvailable: pool[0].available });
    } else if (pool.length > 1) {
      ambiguous.push({ recordNo: r.recordNo, invoiceId: r.invoiceId, amount: r.amount,
        site, from: r.po, options: pool.map(p => p.poNumber) });
    } else {
      orphan.push({ recordNo: r.recordNo, invoiceId: r.invoiceId, amount: r.amount, site, from: r.po, service: svc || null });
    }
  }
  return { adopt, ambiguous, orphan };
}

// A placeholder carries no service type of its own; take it from the other
// invoices at the site, or from the placeholder's own wording.
function guessService(r, ledger) {
  const txt = String(r.po || '').toLowerCase();
  if (/snow|ice|plow|salt/.test(txt)) return 'snow';
  const siteRows = ledger.filter(p => p.siteCode === r.site && p.serviceType);
  const counts = {};
  for (const p of siteRows) counts[p.serviceType] = (counts[p.serviceType] || 0) + 1;
  // Only infer when the site does one thing; otherwise leave it undecided.
  const kinds = Object.keys(counts);
  return kinds.length === 1 ? kinds[0] : null;
}

/** Apply the unambiguous adoptions. Returns what was changed. */
function apply(invoices, { actor = 'system (placeholder adoption)' } = {}) {
  const p = plan(invoices);
  for (const a of p.adopt) {
    db.setInvoicePoAssignment(a.recordNo, a.invoiceId, a.from, a.to,
      `Adopted the real PO for ${a.site}; was on placeholder "${a.from}"`, actor);
    try { db.auditLog(actor, 'po_placeholder_adopt', a.invoiceId, `${a.from} -> ${a.to} (${a.site}, ${Math.round(a.amount)})`); } catch (e) {}
  }
  // The ledger is memoised on the invoice array; assignments have just changed
  // underneath it, so force the next read to rebuild.
  try { poLedger.invalidatePoLedger(); } catch (e) {}
  return p;
}

module.exports = { plan, apply, isPlaceholder };
