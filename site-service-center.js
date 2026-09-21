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
// WHICH ECF LOCATION BILLS THE SITE is evidence of who works it. A site
// invoiced solely out of Trenton is a Trenton site.
//
// ─── PRECEDENCE (Edwin 2026-09-21) ──────────────────────────────────────────
// "Use omnia as the base and then override as billings are generated."
//
//   manual   a person set it in the portal. Nothing overrides a person.
//   billing  observed: this branch actually invoices the site. THIS FILE.
//   omnia    the assignment Omnia holds (omnia-site-centers.js). The base.
//
// Billing outranks Omnia because an invoice is something that happened, while
// Omnia's field is something somebody typed. As work is billed, the map
// corrects itself.
//
// One rule survives from the earlier design, and it is load-bearing:
// AMBIGUITY IS NEVER GUESSED. A site genuinely split between two branches
// keeps whatever Omnia says, because a wrong centre is worse than a plain one
// — it shows the PO to the wrong crew and hides it from the right one.

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

// Lowest authority first. Anything not in this list (the historic 'declared',
// which turned out to be Amazon land-RFP bid data rather than anyone's
// decision) ranks below all of them and is freely replaced.
const PRECEDENCE = ['omnia', 'billing', 'manual'];
const rank = (src) => {
  const i = PRECEDENCE.indexOf(String(src || ''));
  return i < 0 ? -1 : i;
};

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
          AND COALESCE(service_center_source,'') IN ('omnia','manual')`).all()) {
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

// ─── The three layers, each in its own column ───────────────────────────────
// `service_center` is the RESOLVED value and stays exactly where every reader
// already expects it; `service_center_source` says which layer won.
//
// Keeping the layers apart is what makes the model reversible. When manual
// simply overwrote the one field, releasing an override could only blank the
// site — the Omnia answer underneath it had already been destroyed, and the
// only way back was to re-import the export. Now each layer is remembered, so
// releasing a manual override falls straight back to billing, and billing back
// to Omnia.
const LAYER_COL = { omnia: 'sc_omnia', billing: 'sc_billing', manual: 'sc_manual' };

function ensureColumn() {
  const d = db.getDb();
  try {
    const cols = d.prepare('PRAGMA table_info(amazon_locations)').all().map(c => c.name);

    // 1. The source label. 'declared' was the original guess that anything
    //    already set had been set by a person. It had not: 63 of 63 traced back
    //    to an Amazon land-RFP bid file, which is where the phantom "Atlanta"
    //    centre came from. The label is kept only so old rows stay
    //    recognisable, and it ranks below every real layer.
    if (!cols.includes('service_center_source')) {
      d.exec('ALTER TABLE amazon_locations ADD COLUMN service_center_source TEXT');
      d.exec("UPDATE amazon_locations SET service_center_source='declared' "
        + "WHERE TRIM(COALESCE(service_center,''))<>''");
      console.log('[site-sc] added service_center_source; pre-existing values marked declared (unverified)');
    }

    // 2. 'derived' was this file's old label, from when it could only fill
    //    blanks. Same evidence, so it keeps the same rows.
    const ren = d.prepare("UPDATE amazon_locations SET service_center_source='billing' "
      + "WHERE service_center_source='derived'").run();
    if (ren.changes) console.log(`[site-sc] renamed ${ren.changes} 'derived' rows to 'billing'`);

    // 3. The per-layer columns, backfilled from whichever layer currently owns
    //    the single field. Must come last: it reads service_center_source.
    if (!cols.includes('sc_omnia')) {
      for (const col of Object.values(LAYER_COL)) {
        if (!cols.includes(col)) d.exec(`ALTER TABLE amazon_locations ADD COLUMN ${col} TEXT`);
      }
      for (const [layer, col] of Object.entries(LAYER_COL)) {
        const r = d.prepare(`UPDATE amazon_locations SET ${col}=service_center
          WHERE TRIM(COALESCE(service_center,''))<>'' AND service_center_source=?`).run(layer);
        if (r.changes) console.log(`[site-sc] backfilled ${r.changes} rows into ${col}`);
      }
    }
  } catch (e) { console.error('[site-sc] migration:', e.message); }
}

/**
 * Collapse the layers into `service_center` / `service_center_source` for every
 * row. The single authority on what a site's centre IS.
 *
 * A value no layer claims is cleared. That is what finally removed the RFP bid
 * data: it was never Omnia's, never billing's and nobody's decision, so once
 * the layers became explicit it had nowhere to live.
 */
function resolveAll() {
  ensureColumn();
  const d = db.getDb();
  const r = d.prepare(`UPDATE amazon_locations SET
      service_center = COALESCE(NULLIF(TRIM(COALESCE(sc_manual,'')),''),
                                NULLIF(TRIM(COALESCE(sc_billing,'')),''),
                                NULLIF(TRIM(COALESCE(sc_omnia,'')),''), ''),
      service_center_source = CASE
        WHEN TRIM(COALESCE(sc_manual,''))  <> '' THEN 'manual'
        WHEN TRIM(COALESCE(sc_billing,'')) <> '' THEN 'billing'
        WHEN TRIM(COALESCE(sc_omnia,''))   <> '' THEN 'omnia'
        ELSE NULL END
    WHERE service_center IS NOT COALESCE(NULLIF(TRIM(COALESCE(sc_manual,'')),''),
                                         NULLIF(TRIM(COALESCE(sc_billing,'')),''),
                                         NULLIF(TRIM(COALESCE(sc_omnia,'')),''), '')
       OR service_center_source IS NOT CASE
        WHEN TRIM(COALESCE(sc_manual,''))  <> '' THEN 'manual'
        WHEN TRIM(COALESCE(sc_billing,'')) <> '' THEN 'billing'
        WHEN TRIM(COALESCE(sc_omnia,''))   <> '' THEN 'omnia'
        ELSE NULL END`).run();
  return { resolved: r.changes };
}

/** The three layers for one site, plus which one is in force. */
function layersFor(site) {
  ensureColumn();
  const r = db.getDb().prepare(`SELECT site_code, service_center, service_center_source,
      sc_omnia, sc_billing, sc_manual FROM amazon_locations WHERE site_code=?`)
    .get(String(site || '').toUpperCase().trim());
  if (!r) return null;
  return {
    site: r.site_code,
    serviceCenter: r.service_center || '',
    source: r.service_center_source || '',
    omnia: r.sc_omnia || '',
    billing: r.sc_billing || '',
    manual: r.sc_manual || '',
  };
}

/**
 * Work out a service centre for every site from who bills it. This no longer
 * only fills blanks: an unambiguous billing observation OVERRIDES Omnia.
 * Pure — writes nothing. Returns { assign, ambiguous, noEvidence }.
 */
function derive(invoices, { dominanceShare = 0.8 } = {}) {
  ensureColumn();
  const d = db.getDb();
  const locs = ecfLocations(invoices);
  const known = canonicalNames();

  const rows = d.prepare(`SELECT site_code, service_center, service_center_source
    FROM amazon_locations`).all();
  // Note there is no "skip the ones a person set" list here. Billing is
  // computed for every site and stored in its own layer; resolveAll() is what
  // decides that a manual override sits above it. So releasing an override
  // exposes billing's current answer rather than a blank.
  const current = {};
  for (const r of rows) current[r.site_code] = String(r.service_center || '').trim();
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
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((t, e) => t + e[1], 0);
    const [top] = entries;
    const sole = entries.length === 1;
    const dominant = !sole && top[1] >= total * dominanceShare;
    if (!sole && !dominant) {
      // Split between branches — leave Omnia's answer alone rather than pick.
      ambiguous.push({
        site, keeping: current[site] || '',
        options: entries.map(([n, c]) => ({ location: n, invoices: c })),
        inMaster: inMasterSet.has(site),
      });
      continue;
    }
    const loc = locs[normSc(top[0])];
    const serviceCenter = canonical(top[0], known);
    assign.push({
      site,
      serviceCenter,
      was: current[site] || '',
      moves: !!current[site] && normSc(current[site]) !== normSc(serviceCenter),
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

/** Write the unambiguous billing observations. Only a manual override is safe. */
function apply(invoices, opts) {
  const d = db.getDb();
  const r = derive(invoices, opts);
  // Writes the billing LAYER only. What the site resolves to is decided by
  // resolveAll(), so a manual override above it is untouched by construction
  // rather than by remembering to exclude it here.
  const upd = d.prepare('UPDATE amazon_locations SET sc_billing=? WHERE site_code=?');
  const ins = d.prepare(`INSERT OR IGNORE INTO amazon_locations
    (site_code, sc_billing, loaded_at, source)
    VALUES (?,?, datetime('now'), 'billing-location')`);
  let written = 0, created = 0, moved = 0;
  for (const a of r.assign) {
    if (!a.inMaster) { ins.run(a.site, a.serviceCenter); created++; }
    const res = upd.run(a.serviceCenter, a.site);
    if (res.changes) { written++; if (a.moves) moved++; }
  }
  // Billing evidence that has gone away should stop counting: a site we no
  // longer invoice out of anywhere falls back to Omnia rather than keeping a
  // stale branch forever.
  const keep = new Set(r.assign.map(a => a.site));
  let cleared = 0;
  for (const row of d.prepare("SELECT site_code FROM amazon_locations WHERE TRIM(COALESCE(sc_billing,''))<>''").all()) {
    if (!keep.has(row.site_code)) {
      cleared += d.prepare('UPDATE amazon_locations SET sc_billing=NULL WHERE site_code=?').run(row.site_code).changes;
    }
  }
  const res = resolveAll();
  return { ...r, written, created, moved, cleared, ...res };
}

/**
 * A person's override. The top of the precedence list, so nothing — not a
 * fresh Omnia export, not next month's invoicing — moves it again.
 * Pass an empty centre to release the site back to billing/Omnia.
 */
function setManual(site, serviceCenter) {
  ensureColumn();
  const d = db.getDb();
  const code = String(site || '').toUpperCase().trim();
  if (!code) throw new Error('site code required');
  const name = String(serviceCenter || '').trim();
  const want = name ? canonical(name, canonicalNames()) : null;
  d.prepare(`INSERT OR IGNORE INTO amazon_locations (site_code, loaded_at, source)
    VALUES (?, datetime('now'), 'manual')`).run(code);
  d.prepare('UPDATE amazon_locations SET sc_manual=? WHERE site_code=?').run(want, code);
  resolveAll();
  return { ...layersFor(code), released: !want };
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

module.exports = {
  derive, apply, unassigned, centres, normSc, ensureColumn,
  setManual, resolveAll, layersFor, canonicalNames, canonical, isSiteCode,
  PRECEDENCE, rank, LAYER_COL,
};
