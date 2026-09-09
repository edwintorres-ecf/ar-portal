'use strict';
/**
 * site-ledger.js — one resolved Amazon site per invoice, and WHY.
 *
 * The problem: an Amazon invoice's site is only sometimes on the invoice. Sage's
 * SHIPTO.CONTACTNAME is hand-entered, so of 2,789 open Amazon invoices 260 carry
 * something that is not a site code at all: 223 say "Amazon.com Services LLC",
 * 23 say "BOS PKG", 13 say "DRI PKG PROVIDENCE1/6", one says "CW Amazon
 * Services". Those 260 are worth $5.5M and they cannot be filed under a business
 * unit until something says where the work happened.
 *
 * The answer is not a cleverer regex. Every existing surface resolves the site
 * ad hoc, inline, slightly differently, and none of them records WHERE the
 * answer came from — so a wrong site is untraceable and a human fix does not
 * stick anywhere another view can see it. This module makes the resolution a
 * first-class record: one row per invoice with the site, the source, a
 * confidence, and the evidence.
 *
 * PRINCIPLE: never guess silently. A tier that infers rather than reads is
 * recorded as `suggested` and is NOT applied as fact. "BOS PKG" is genuinely
 * ambiguous — the PO universe has both BOS3 and BOS7 — so it is surfaced with
 * both candidates for a human, not quietly assigned to whichever sorts first.
 * A wrong site silently applied would misfile revenue under a business unit and
 * nobody would ever know to look.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const AMAZON_CUSTOMERS = ['C-00403', 'C-00566'];

// Canonical Amazon site code: 2-4 letters then 1-2 digits, e.g. DBL1, EWR9, BOS3.
const CANONICAL_RE = /^[A-Z]{2,4}[0-9]{1,2}$/;

// Same collapse po-ledger uses: "DBU3 PKG HEMPSTEAD3" is site DBU3. Anchored at
// the START, so a trailing building number cannot be mistaken for the site.
function normalizeSite(raw) {
  const s = String(raw || '').trim().toUpperCase();
  const m = /^([A-Z]{2,4}[0-9]{1,2})(?=$|[^A-Z0-9])/.exec(s);
  return m ? m[1] : '';
}

function isCanonical(s) {
  return CANONICAL_RE.test(String(s || '').trim().toUpperCase());
}

// ─── The universe of real site codes ────────────────────────────────────────
// Built from everything that has ever told us a site authoritatively, so a
// derived guess can be checked against reality instead of being trusted.
function buildSiteUniverse(invoices, poDetails, poDocs, poPins) {
  const set = new Set();
  for (const i of invoices || []) {
    const n = normalizeSite(i.siteCode);
    if (isCanonical(n)) set.add(n);
  }
  for (const d of Object.values(poDetails || {})) {
    const n = normalizeSite(d && d.site);
    if (isCanonical(n)) set.add(n);
  }
  for (const d of Object.values(poDocs || {})) {
    const n = normalizeSite(d && (d.site || d.siteCode));
    if (isCanonical(n)) set.add(n);
  }
  for (const s of Object.values(poPins || {})) {
    const n = normalizeSite(s);
    if (isCanonical(n)) set.add(n);
  }
  return set;
}

// ─── Inference from a non-canonical ship-to ─────────────────────────────────
// "DRI PKG PROVIDENCE1" carries a real signal: prefix DRI, trailing 1, and DRI1
// exists. "BOS PKG" carries a prefix and nothing else. "DRI PKG PROVIDENCE6"
// implies DRI6, which does NOT exist, so the trailing digit is not reliably the
// site number and must never be applied on its own.
//
// Returns { candidates[], note } and never a decision.
function deriveCandidates(raw, universe) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return { candidates: [], note: 'no ship-to' };

  const pm = /^([A-Z]{2,4})\b/.exec(s);
  const prefix = pm ? pm[1] : '';
  if (!prefix) return { candidates: [], note: 'no site-shaped prefix' };

  const samePrefix = [...universe].filter(c => c.startsWith(prefix)).sort();
  if (!samePrefix.length) return { candidates: [], note: `no known site starts with ${prefix}` };

  // A trailing digit anywhere after the prefix, e.g. "…PROVIDENCE1".
  const dm = /([0-9]{1,2})\s*$/.exec(s);
  if (dm) {
    const implied = prefix + String(parseInt(dm[1], 10));
    if (universe.has(implied)) {
      return { candidates: [implied], note: `ship-to "${raw}" implies ${implied}, which exists` };
    }
    // The ship-to points at a site we have never seen. Even when exactly one
    // same-prefix site exists, that is a CONFLICT, not a suggestion: "DRI PKG
    // PROVIDENCE6" naming DRI6 while only DRI1 is known most likely means a
    // real building we have no record of, and quietly filing it under DRI1
    // would invent revenue at the wrong site.
    return {
      conflict: true,
      candidates: samePrefix,
      note: `ship-to "${raw}" implies ${implied}, which does NOT exist; known ${prefix} sites: ${samePrefix.join(', ')}`,
    };
  }
  return {
    candidates: samePrefix,
    note: samePrefix.length === 1
      ? `only known ${prefix} site is ${samePrefix[0]}`
      : `ambiguous: ${samePrefix.join(', ')}`,
  };
}

// ─── Inputs ─────────────────────────────────────────────────────────────────
function readJson(file, pick) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    return (pick ? pick(raw) : raw) || {};
  } catch (e) { return {}; }
}

function loadPoPins() {
  const out = {};
  try {
    for (const r of db.getDb().prepare("SELECT po_number, site_code FROM purchase_orders WHERE site_code IS NOT NULL AND site_code != ''").all()) {
      out[r.po_number] = r.site_code;
    }
  } catch (e) { /* table may not exist on a fresh database */ }
  return out;
}

// ─── Resolution ─────────────────────────────────────────────────────────────
// Order is authority, not convenience:
//   1 manual-invoice  a human pinned THIS invoice. Always wins, never recomputed.
//   2 ship-to         the invoice's own ship-to is already a real site code.
//   3 po-manual       a human pinned the PO's site.
//   4 po-amazon       Amazon's own Ship To on the PO detail page.
//   5 po-doc          the PO document's extracted site.
//   6 suggested       inferred from a non-canonical ship-to. NOT applied.
//   7 unresolved      nothing said anything. Goes to the review queue.
// A retired code is folded to the current one at EVERY tier, not just at the
// ship-to, because an old code can just as easily come off a PO document or a
// human pin made years ago. The hop is written into the evidence so the ledger
// still shows what the invoice actually said.
function canonicalize(site, ctx) {
  const s = String(site || '').trim().toUpperCase();
  if (!s) return { site: s, via: '' };
  const hit = ctx.aliases[s];
  if (!hit) return { site: s, via: '' };
  return { site: hit.canonical, via: `${s} is a retired code for ${hit.canonical}${hit.note ? `, ${hit.note}` : ''}` };
}

function withAlias(result, ctx) {
  const { site, via } = canonicalize(result.site, ctx);
  if (!via) return result;
  return { ...result, site, aliasedFrom: result.site, evidence: `${result.evidence}; ${via}` };
}

// A code on a PO HEADER is not necessarily where the work happened. Amazon puts
// its Nashville HQ (BNA12) on the header of multi-site blanket POs whose real
// sites are the line items, so accepting the header would file several sites'
// revenue under a corporate address. Blocked codes are refused as an answer and
// the invoice falls through to review with whatever line-item sites we can see.
function siteCodesIn(text, ctx) {
  const out = [];
  for (const m of String(text || '').toUpperCase().matchAll(/\b[A-Z]{2,4}[0-9]{1,2}\b/g)) {
    const c = m[0];
    if (ctx.blocked[c] || out.includes(c)) continue;
    if (ctx.master[c] || ctx.universe.has(c)) out.push(c);
  }
  return out;
}

function resolveOne(inv, ctx) {
  const rec = String(inv.recordNo);

  const ov = ctx.overrides[rec];
  if (ov && ov.site_code) {
    return withAlias({ site: normalizeSite(ov.site_code) || ov.site_code, source: 'manual-invoice', confidence: 'certain',
             evidence: `pinned by ${ov.set_by || 'unknown'} on ${(ov.set_at || '').slice(0, 10)}`, candidates: [] }, ctx);
  }

  const own = normalizeSite(inv.siteCode);
  if (isCanonical(own)) {
    return withAlias({ site: own, source: 'ship-to', confidence: 'certain',
             evidence: `invoice ship-to "${String(inv.siteCode).trim()}"`, candidates: [] }, ctx);
  }

  const assign = ctx.assignments[rec];
  const po = String((assign && assign.assigned_po) || inv.poNumber || '').trim();
  if (po) {
    const pin = normalizeSite(ctx.poPins[po]);
    if (isCanonical(pin) && !ctx.blocked[pin]) {
      return withAlias({ site: pin, source: 'po-manual', confidence: 'strong',
               evidence: `PO ${po} site pinned to ${pin}`, candidates: [] }, ctx);
    }
    const det = ctx.poDetails[po];
    const amz = normalizeSite(det && det.site);
    if (isCanonical(amz) && !ctx.blocked[amz]) {
      return withAlias({ site: amz, source: 'po-amazon', confidence: 'strong',
               evidence: `Amazon Ship To on PO ${po}`, candidates: [] }, ctx);
    }
    const doc = ctx.poDocs[po];
    const docSite = normalizeSite(doc && (doc.site || doc.siteCode));
    if (isCanonical(docSite) && !ctx.blocked[docSite]) {
      return withAlias({ site: docSite, source: 'po-doc', confidence: 'strong',
               evidence: `PO ${po} document ship-to`, candidates: [] }, ctx);
    }
  }

  // The PO named a blocked header code. Say so explicitly and offer the line
  // sites we can actually see, rather than reporting a bare "unresolved".
  if (po) {
    const det2 = ctx.poDetails[po];
    const headerCode = normalizeSite(det2 && det2.site);
    if (headerCode && ctx.blocked[headerCode]) {
      const lineSites = siteCodesIn(det2 && det2.desc, ctx);
      return {
        site: '', source: 'header-only-po', confidence: 'ambiguous',
        evidence: `PO ${po} ship-to is ${headerCode}, ${ctx.blocked[headerCode] || 'not a service site'}`
          + (lineSites.length ? `; line items name ${lineSites.join(', ')} but a blanket PO covers more lines than we store`
                              : '; no line-item site is visible in what we hold'),
        candidates: lineSites,
      };
    }
  }

  const { candidates, note, conflict } = deriveCandidates(inv.siteCode, ctx.universe);
  if (candidates.length === 1 && !conflict) {
    return { site: '', source: 'suggested', confidence: 'suggested',
             evidence: note, candidates };
  }
  if (candidates.length) {
    return { site: '', source: 'suggested', confidence: 'ambiguous',
             evidence: note, candidates };
  }
  return { site: '', source: 'unresolved', confidence: 'none',
           evidence: po ? `PO ${po} has no site in any source` : (note || 'no ship-to and no PO'),
           candidates: [] };
}

function buildContext(invoices) {
  const poDetails = readJson('payee-po-details.spark.json', r => r.details);
  const poDocs = readJson('po-docs.json', r => r.byPo);
  const poPins = loadPoPins();
  let overrides = {}, assignments = {}, master = {};
  try { overrides = db.getAllInvoiceSiteOverrides(); } catch (e) { /* older schema */ }
  try { assignments = db.getAllPoAssignments(); } catch (e) { /* older schema */ }
  try { master = db.getAmazonLocationMap(); } catch (e) { /* master not loaded */ }
  let aliases = {};
  try { aliases = db.getSiteAliasMap(); } catch (e) { /* no alias table yet */ }
  let blocked = {};
  try { blocked = db.getBlockedSiteCodes(); } catch (e) { /* no blocklist table yet */ }
  // The master is the authority for gate 2, so its codes join the universe a
  // derived guess is checked against.
  const universe = buildSiteUniverse(invoices, poDetails, poDocs, poPins);
  for (const code of Object.keys(master)) universe.add(code);
  for (const a of Object.keys(aliases)) universe.add(a);
  return { poDetails, poDocs, poPins, overrides, assignments, master, aliases, blocked, universe };
}

function amazonInvoices(all) {
  return (all || []).filter(i => AMAZON_CUSTOMERS.includes(i.customerId));
}

/** Resolve without writing. Used by the coverage report and by tests. */
function resolveAll(allInvoices) {
  const invoices = amazonInvoices(allInvoices);
  const ctx = buildContext(invoices);
  return invoices.map(inv => {
    const r = resolveOne(inv, ctx);
    // A resolved site that the master has never heard of is a REAL condition,
    // not an error to swallow: we are invoicing somewhere Amazon's own location
    // list does not carry, so it has no business unit and would silently vanish
    // from a BU-gated view. Surface it instead.
    const loc = r.site ? ctx.master[r.site] : null;
    return {
      recordNo: String(inv.recordNo),
      invoiceId: inv.invoiceId || '',
      amount: parseFloat(inv.totalDue || 0) || 0,
      rawShipTo: String(inv.siteCode || '').trim(),
      locationName: inv.locationName || '',
      po: String(((ctx.assignments[String(inv.recordNo)] || {}).assigned_po) || inv.poNumber || '').trim(),
      ...r,
      businessUnit: loc ? loc.businessUnit : '',
      region: loc ? loc.region : '',
      zone: loc ? loc.zone : '',
      inMaster: !!loc,
      siteNotInMaster: !!(r.site && !loc),
    };
  });
}

/** Resolve and persist. Idempotent: safe to run on every refresh. */
function rebuild(allInvoices) {
  const rows = resolveAll(allInvoices);
  let buCount = 0;
  const d = db.getDb();
  const stmt = d.prepare(`
    INSERT INTO invoice_site_ledger (record_no, invoice_id, site_code, source, confidence, evidence, candidates, amount, resolved_at)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(record_no) DO UPDATE SET
      invoice_id=excluded.invoice_id, site_code=excluded.site_code, source=excluded.source,
      confidence=excluded.confidence, evidence=excluded.evidence, candidates=excluded.candidates,
      amount=excluded.amount, resolved_at=datetime('now')
  `);
  d.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(r.recordNo, r.invoiceId, r.site, r.source, r.confidence, r.evidence,
               r.candidates.length ? r.candidates.join('|') : null, r.amount);
      buCount += r.businessUnit ? 1 : 0;
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  const sum = summarize(rows);
  sum.withBusinessUnit = buCount;
  return sum;
}

function summarize(rows) {
  const bySource = {}, byBu = {};
  let resolved = 0, resolvedAmt = 0, open = 0, openAmt = 0, notInMaster = 0, notInMasterAmt = 0;
  const add = (bag, key, amt) => {
    bag[key] = bag[key] || { count: 0, amount: 0 };
    bag[key].count++;
    bag[key].amount = Math.round((bag[key].amount + amt) * 100) / 100;
  };
  for (const r of rows) {
    add(bySource, r.source, r.amount);
    if (r.site) { resolved++; resolvedAmt += r.amount; } else { open++; openAmt += r.amount; }
    if (r.siteNotInMaster) { notInMaster++; notInMasterAmt += r.amount; }
    // A site with no business unit cannot be filed under gate 2; count it as
    // its own bucket rather than letting it disappear into a blank key.
    add(byBu, r.businessUnit || (r.site ? '(site not in master)' : '(no site yet)'), r.amount);
  }
  return {
    total: rows.length,
    resolved, resolvedAmount: Math.round(resolvedAmt * 100) / 100,
    needsReview: open, needsReviewAmount: Math.round(openAmt * 100) / 100,
    coveragePct: rows.length ? Math.round((resolved / rows.length) * 1000) / 10 : 0,
    notInMaster, notInMasterAmount: Math.round(notInMasterAmt * 100) / 100,
    bySource, byBusinessUnit: byBu,
  };
}

/** The work queue: everything a human still has to decide, worst first. */
function getNeedsReview() {
  const d = db.getDb();
  const rows = d.prepare(`
    SELECT record_no, invoice_id, site_code, source, confidence, evidence, candidates, amount
    FROM invoice_site_ledger WHERE site_code IS NULL OR site_code = ''
    ORDER BY amount DESC
  `).all();
  return rows.map(r => ({
    recordNo: r.record_no, invoiceId: r.invoice_id, source: r.source,
    confidence: r.confidence, evidence: r.evidence, amount: r.amount,
    candidates: r.candidates ? r.candidates.split('|') : [],
  }));
}

/** Whole ledger as a record_no -> row map, one query, for grid rendering. */
function getLedgerMap() {
  const d = db.getDb();
  const out = {};
  try {
    for (const r of d.prepare('SELECT * FROM invoice_site_ledger').all()) {
      out[r.record_no] = {
        siteCode: r.site_code || '', source: r.source, confidence: r.confidence,
        evidence: r.evidence || '', candidates: r.candidates ? r.candidates.split('|') : [],
      };
    }
  } catch (e) { /* not built yet */ }
  return out;
}

// ─── The Amazon view ────────────────────────────────────────────────────────
// Edwin's structure narrows Department → Business Unit → Site → PO → Invoice,
// but every filter must also work on its own, in any order. So this returns ONE
// flat row per invoice carrying every dimension, and the client groups it.
// Pre-aggregating the hierarchy server-side would hard-code the drill order and
// make "show me every Landscape invoice at one site regardless of BU" a second
// endpoint. A flat set is ~2,800 rows, which is nothing to group in the browser.

const DEPT_GROUPS = {
  'D-SNOW': 'Snow',
  'D-GRMT': 'Landscape',
  'D-ARBR': 'Projects',
  'D-LAPR': 'Projects',
  'D-PKLT': 'Projects',
  'D-IRMG': 'Projects',
};

// Built from the code list, NOT from what happens to appear in the data:
// D-ARBR currently has zero open invoices and must still be a pickable filter.
function departmentGroups() {
  const out = {};
  for (const [code, group] of Object.entries(DEPT_GROUPS)) {
    out[group] = out[group] || [];
    out[group].push(code);
  }
  return out;
}

function buildAmazonRows(allInvoices, opts = {}) {
  const payee = opts.payee || null;
  const invoices = amazonInvoices(allInvoices);
  const ledger = getLedgerMap();
  let depts = {}, master = {}, assignments = {};
  try { depts = db.getAllDepartments(); } catch (e) {}
  try { master = db.getAmazonLocationMap(); } catch (e) {}
  try { assignments = db.getAllPoAssignments(); } catch (e) {}

  let payeeIndex = {};
  if (payee) { try { payeeIndex = payee.getIndex() || {}; } catch (e) {} }

  return invoices.map(inv => {
    const rec = String(inv.recordNo);
    const dep = depts[rec] || {};
    const sl = ledger[rec] || {};
    const loc = sl.siteCode ? master[sl.siteCode] : null;
    const assigned = assignments[rec];
    const po = String((assigned && assigned.assigned_po) || inv.poNumber || '').trim();
    const pay = payeeIndex[inv.invoiceId] || null;
    return {
      recordNo: rec,
      invoiceId: inv.invoiceId || '',
      customerId: inv.customerId || '',
      amount: parseFloat(inv.totalDue || 0) || 0,
      billed: parseFloat(inv.totalEntered || 0) || 0,
      invoiceDate: inv.whenCreated || '',
      dueDate: inv.whenDue || '',
      daysOverdue: inv.daysOverdue || 0,
      bucket: inv.bucket || '',
      // gate 1
      deptId: dep.deptId || '',
      deptName: dep.deptName || '',
      deptGroup: DEPT_GROUPS[dep.deptId] || 'Unclassified',
      deptMixed: !!dep.mixed,
      // gate 2
      businessUnit: loc ? (loc.businessUnit || '') : '',
      region: loc ? (loc.region || '') : '',
      siteType: loc ? (loc.siteType || '') : '',
      // gate 3
      site: sl.siteCode || '',
      siteSource: sl.source || '',
      siteConfidence: sl.confidence || '',
      siteEvidence: sl.evidence || '',
      // gate 4
      po,
      poAssigned: !!(assigned && assigned.assigned_po),
      // gate 5 context
      payeeStatus: pay ? (pay.status || '') : '',
      serviceCenter: inv.locationName || '',
    };
  });
}

module.exports = {
  rebuild, resolveAll, getNeedsReview, getLedgerMap, summarize,
  normalizeSite, isCanonical, deriveCandidates, buildSiteUniverse,
  buildAmazonRows, departmentGroups, DEPT_GROUPS,
  AMAZON_CUSTOMERS,
};
