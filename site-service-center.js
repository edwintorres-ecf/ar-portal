'use strict';
// ─── site-service-center.js ─────────────────────────────────────────────────
// Which service centre looks after an Amazon site.
//
// This is the join that makes POs visible to the people doing the work. Field
// staff need to check a PO arrived and carries enough value BEFORE they start,
// so they can ask for an uplift instead of discovering the shortfall at billing
// (Edwin 2026-09-21).
//
// The problem: `amazon_locations.service_center` is hand-maintained and was
// filled for 367 of 1,050 sites, so only 47% of POs could be attributed to a
// service centre. Amazon's own master has no such column, and its OMNIA
// Location Id uses a different namespace (LOC-002396) from our Sage locations
// (L-ECF-BLT), so it cannot bridge them.
//
// The fix: WHICH ECF LOCATION BILLS THE SITE is evidence of who works it. A
// site invoiced solely out of Trenton is a Trenton site. That derivation covers
// 109 of the 165 unassigned sites and lifts PO coverage from 47% to 85%.
//
// Two rules, both load-bearing:
//   1. A DERIVED value never overwrites a DECLARED one. A person's assignment
//      always wins; this only fills blanks.
//   2. Ambiguity is never guessed. A site genuinely split between two centres
//      is left for a human and reported, because a wrong centre is worse than
//      an empty one — it shows the PO to the wrong crew and hides it from the
//      right one.

const db = require('./db');

// amazon_locations.service_center holds short names ("Baltimore", "Cincinatti")
// while Sage locations are full ("Baltimore Service Center"). Normalise both to
// compare. The Cincinatti/Cincinnati spelling differs between the two systems.
function normSc(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/service\s*cent(er|re)/g, '')
    .replace(/[^a-z]/g, '')
    .replace(/cincinatti/, 'cincinnati');
}

/** ECF billing locations, keyed by normalised name. */
function ecfLocations(invoices) {
  const out = {};
  for (const i of invoices || []) {
    if (!i.locationId || !i.locationName) continue;
    if (String(i.locationId).toUpperCase() === 'E-ECF') continue;   // the company, not a centre
    out[normSc(i.locationName)] = { locationId: i.locationId, locationName: i.locationName };
  }
  return out;
}

// ONE canonical spelling per centre, or the filter splits in half.
// amazon_locations already uses short names ("Hartford"); Sage uses the long
// form ("Hartford Service Center"). Writing the long form created BOTH —
// "Hartford" 80 POs and "Hartford Service Center" 62 — so a field user picking
// their centre would have seen less than half their work. Existing declared
// spellings win; anything new is shortened the same way.
//
// Values loaded from the Omnia export count as declared here: Omnia is the
// system of record for the assignment (omnia-site-centers.js), so a derivation
// must land on Omnia's spelling, not invent a second one beside it.
function canonicalNames() {
  const map = {};
  try {
    for (const r of db.getDb().prepare(`SELECT DISTINCT service_center AS sc FROM amazon_locations
        WHERE TRIM(COALESCE(service_center,''))<>''
          AND COALESCE(service_center_source,'declared') IN ('declared','omnia')`).all()) {
      map[normSc(r.sc)] = String(r.sc).trim();
    }
  } catch (e) {}
  return map;
}
const shortName = (full) => String(full || '').replace(/\s*service\s*cent(er|re)\s*$/i, '').trim();
function canonical(full, known) {
  const k = normSc(full);
  return (known && known[k]) || shortName(full);
}

// Amazon site codes are 2-5 letters + a digit (BDL4, DAE7). Restricting to
// Amazon invoices is not enough on its own: non-Amazon rows carry things like
// "FOUR SEASONS AT PARKLAND(CC-00607)" and "1 LEE BLVD" in the same field, and
// the first version created 233 junk site rows from them.
const AMAZON_CUSTOMER = 'C-00403';
const isSiteCode = (s) => /^[A-Z]{2,5}\d{1,2}$/.test(String(s || '').toUpperCase().trim());

function ensureColumn() {
  const d = db.getDb();
  try {
    const cols = d.prepare('PRAGMA table_info(amazon_locations)').all().map(c => c.name);
    if (!cols.includes('service_center_source')) {
      d.exec("ALTER TABLE amazon_locations ADD COLUMN service_center_source TEXT");
      // Everything already set was set by a person.
      d.exec("UPDATE amazon_locations SET service_center_source='declared' "
        + "WHERE TRIM(COALESCE(service_center,''))<>''");
      console.log('[site-sc] added service_center_source; existing values marked declared');
    }
  } catch (e) { console.error('[site-sc] migration:', e.message); }
}

/**
 * Work out a service centre for every site that lacks one, from who bills it.
 * Pure — writes nothing. Returns { assign, ambiguous, noEvidence }.
 */
function derive(invoices, { dominanceShare = 0.8 } = {}) {
  ensureColumn();
  const d = db.getDb();
  const locs = ecfLocations(invoices);
  const known = canonicalNames();

  const rows = d.prepare(`SELECT site_code, service_center, service_center_source
    FROM amazon_locations`).all();
  const declared = new Set(rows.filter(r => String(r.service_center || '').trim()
    && r.service_center_source !== 'derived').map(r => r.site_code));
  const inMasterSet = new Set(rows.map(r => r.site_code));

  // Who invoices each site, by volume.
  const billers = {};
  for (const i of invoices || []) {
    if (i.customerId !== AMAZON_CUSTOMER) continue;      // Amazon sites only
    const s = String(i.siteCode || '').toUpperCase().trim();
    if (!isSiteCode(s) || !i.locationName) continue;     // and only real site codes
    if (String(i.locationId).toUpperCase() === 'E-ECF') continue;
    billers[s] = billers[s] || {};
    billers[s][i.locationName] = (billers[s][i.locationName] || 0) + 1;
  }

  const assign = [], ambiguous = [], noEvidence = [];
  for (const [site, counts] of Object.entries(billers)) {
    if (declared.has(site)) continue;                 // a person already said
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((t, e) => t + e[1], 0);
    const [top, second] = entries;
    const sole = entries.length === 1;
    const dominant = !sole && top[1] >= total * dominanceShare;
    if (!sole && !dominant) {
      ambiguous.push({ site, options: entries.map(([n, c]) => ({ location: n, invoices: c })), inMaster: inMasterSet.has(site) });
      continue;
    }
    const loc = locs[normSc(top[0])];
    assign.push({
      site,
      serviceCenter: canonical(top[0], known),
      billedBy: top[0],
      locationId: loc ? loc.locationId : null,
      invoices: top[1],
      share: Math.round(top[1] / total * 100),
      basis: sole ? 'only centre that bills it' : `${Math.round(top[1] / total * 100)}% of its invoicing`,
      inMaster: inMasterSet.has(site),
    });
  }

  // Sites in the master that nobody has ever invoiced — no evidence either way.
  // Only real site codes; the table has accumulated some non-site rows.
  for (const r of rows) {
    if (String(r.service_center || '').trim()) continue;
    if (billers[r.site_code]) continue;
    if (!isSiteCode(r.site_code)) continue;
    noEvidence.push({ site: r.site_code });
  }
  return { assign, ambiguous, noEvidence };
}

/** Write the unambiguous derivations. Never touches a declared value. */
function apply(invoices, opts) {
  const d = db.getDb();
  const r = derive(invoices, opts);
  const upd = d.prepare(`UPDATE amazon_locations
    SET service_center=?, service_center_source='derived'
    WHERE site_code=? AND (service_center_source IS NULL OR service_center_source='derived'
                           OR TRIM(COALESCE(service_center,''))='')`);
  const ins = d.prepare(`INSERT OR IGNORE INTO amazon_locations
    (site_code, service_center, service_center_source, loaded_at, source)
    VALUES (?,?, 'derived', datetime('now'), 'billing-location')`);
  let written = 0, created = 0;
  for (const a of r.assign) {
    if (!a.inMaster) { ins.run(a.site, a.serviceCenter); created++; }
    const res = upd.run(a.serviceCenter, a.site);
    if (res.changes) written++;
  }
  return { ...r, written, created };
}

/**
 * The sites a person actually needs to assign — the master assignment list.
 *
 * Deliberately NOT every blank row. The master carries 883 Amazon sites and we
 * have never worked most of them; listing those buries the handful that matter
 * under hundreds that do not. A site earns a place here only if it carries a
 * PO or we have invoiced it, and it is ranked by the PO value that stays
 * invisible until someone assigns it.
 */
function unassigned(invoices, { ledger } = {}) {
  const d = db.getDb();
  const r = derive(invoices);
  const led = ledger || (() => { try { return require('./po-ledger').getPoLedger(invoices); } catch (e) { return []; } })();

  const assigned = new Set();
  try {
    for (const row of d.prepare(`SELECT site_code FROM amazon_locations
        WHERE TRIM(COALESCE(service_center,''))<>''`).all()) assigned.add(row.site_code);
  } catch (e) {}
  // A derive pass would fill these, so do not ask a person for them.
  for (const a of r.assign) assigned.add(a.site);

  const ambiguousBy = {};
  for (const a of r.ambiguous) ambiguousBy[a.site] = a.options;

  const bySite = {};
  for (const p of led) {
    const s = String(p.siteCode || '').toUpperCase();
    if (!isSiteCode(s) || assigned.has(s)) continue;
    bySite[s] = bySite[s] || { site: s, pos: 0, value: 0, pending: 0, businessUnit: p.businessUnit || '' };
    bySite[s].pos++;
    bySite[s].value += p.ceilingAmount || 0;
    bySite[s].pending += p.pendingUpload || 0;
  }
  // Sites we invoice but that carry no PO still need a centre, or their POs are
  // invisible the moment one arrives.
  for (const i of invoices || []) {
    if (i.customerId !== AMAZON_CUSTOMER) continue;
    const s = String(i.siteCode || '').toUpperCase().trim();
    if (!isSiteCode(s) || assigned.has(s) || bySite[s]) continue;
    bySite[s] = { site: s, pos: 0, value: 0, pending: 0, businessUnit: '' };
  }

  return Object.values(bySite).map(x => ({
    ...x,
    why: ambiguousBy[x.site] ? 'billed by more than one service centre' : 'no service centre set',
    options: ambiguousBy[x.site] || [],
  })).sort((a, b) => b.value - a.value || a.site.localeCompare(b.site));
}

/** Every service centre we know, for pickers. */
function centres() {
  try {
    return db.getDb().prepare(`SELECT service_center AS name, COUNT(*) AS sites
      FROM amazon_locations WHERE TRIM(COALESCE(service_center,''))<>''
      GROUP BY service_center ORDER BY service_center`).all();
  } catch (e) { return []; }
}

module.exports = { derive, apply, unassigned, centres, normSc, ensureColumn };
