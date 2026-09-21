'use strict';
// ─── omnia-site-centers.js ──────────────────────────────────────────────────
// Load the service-centre assignment for every Amazon site FROM OMNIA.
//
// Omnia is where operations actually decides who looks after a site, so it
// outranks both of the sources we had before:
//
//   omnia    — exported from Omnia's location master (this file)
//   declared — typed into amazon_locations by hand, over the years
//   derived  — inferred from which ECF branch bills the site
//              (see site-service-center.js)
//
// Edwin supplied the export on 2026-09-21: 805 rows, 729 distinct sites.
//
// Three things about the export that the naive read gets wrong:
//
// 1. SUB-LOCATIONS. 97 rows are parking decks and satellite lots of a site
//    already in the list — "BDL4 PKG", "DBK6 PKG 3", "DOB7 1". They are the
//    same site for billing, so the suffix is stripped. Where a base site and
//    its PKG rows disagree, see rule 3.
//
// 2. SEVERAL CODES IN ONE CELL. "MCI3 IMO1", "VEA9 CAE1", "MIA1 OSY" are one
//    Omnia location serving more than one Amazon site code. Both MCI3 and MIA1
//    carry live POs, so dropping these rows would lose real assignments. Each
//    whitespace token is taken, and accepted if it looks like a site code or is
//    already in our master — which is what keeps "OSY", "FC", "YARD" out.
//
// 3. FacilityCare IS OMNIA'S DEFAULT BUCKET. 516 of 805 rows carry it — 64% —
//    including all 20 sites we have against Atlanta. So it is treated as a
//    weaker signal than a named branch:
//      · a named branch from Omnia overwrites anything, including a declared
//        value, because Omnia is the system of record;
//      · FacilityCare fills a blank and replaces a derived guess, but it will
//        NOT erase a branch a person declared. Overwriting there would hide
//        those POs from the crew that actually works the site, which is the
//        exact failure this whole feature exists to prevent.
//    Every one of those is reported instead, so a person can confirm the move.

const fs = require('fs');
const db = require('./db');
const { normSc } = require('./site-service-center');

const FACILITY_CARE = 'FacilityCare';

// Amazon site codes are 2-5 letters + 1-2 digits (BDL4, DAE7, MCI3). Omnia also
// carries a handful of airport-style codes with no digit (KCVG, KBWI); those are
// accepted only when our own master already knows them.
const SHAPE = /^[A-Z]{2,5}\d{1,2}$/;

const shortName = (full) => String(full || '').replace(/\s*service\s*cent(er|re)\s*$/i, '').trim();

/** Strip the sub-location suffix: "DBK6 PKG 3" -> "DBK6", "DOB7 1" -> "DOB7". */
function stripSuffix(code) {
  return String(code || '').toUpperCase().trim()
    .replace(/\s+PKG\s*\d*$/, '')
    .replace(/\s+\d+$/, '')
    .trim();
}

/** The site codes a single Omnia row refers to. Usually one; sometimes two. */
function codesIn(cell, known) {
  const base = stripSuffix(cell);
  if (!base) return [];
  const tokens = base.split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (t === 'PKG') continue;
    if (SHAPE.test(t) || known.has(t)) out.push(t);
  }
  return [...new Set(out)];
}

// Omnia writes its xlsx with every element namespace-prefixed (<x:sheet>,
// <x:c>), which ExcelJS's reader does not accept — it throws "Cannot read
// properties of undefined (reading 'sheets')". The sheet is a flat grid of
// strings, so it is read from the XML directly rather than pre-converting the
// file by hand every time Edwin sends a fresh export.
const unesc = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');
const colOf = (ref) => {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Read the Omnia location export (.xlsx, whatever extension it arrived with). */
async function parse(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const read = async (name) => {
    const f = zip.file(name);
    return f ? f.async('string') : '';
  };

  const shared = [];
  for (const si of (await read('xl/sharedStrings.xml')).split(/<(?:\w+:)?si>/).slice(1)) {
    // A shared string can be split across runs; join every <t> inside it.
    shared.push((si.match(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g) || [])
      .map(t => unesc(t.replace(/<[^>]+>/g, ''))).join(''));
  }

  const sheetName = Object.keys(zip.files).find(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const grid = [];
  for (const row of (await read(sheetName)).split(/<(?:\w+:)?row[ >]/).slice(1)) {
    const cells = [];
    const re = /<(?:\w+:)?c\s([^>]*?)\/?>([\s\S]*?)(?:<\/(?:\w+:)?c>|$)/g;
    let m;
    while ((m = re.exec(row))) {
      const attrs = m[1], body = m[2];
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const v = (/<(?:\w+:)?(?:v|t)[^>]*>([\s\S]*?)<\/(?:\w+:)?(?:v|t)>/.exec(body) || [])[1];
      if (v == null) continue;
      cells[colOf((/\br="([^"]+)"/.exec(attrs) || [])[1])] =
        type === 's' ? (shared[+v] || '') : unesc(v);
    }
    grid.push(cells);
  }
  if (!grid.length) throw new Error('export has no rows');

  const header = (grid[0] || []).map(h => String(h || '').trim().toLowerCase());
  const idx = (name) => header.indexOf(name.toLowerCase());
  const cSite = idx('SiteCode'), cSc = idx('ServiceCenter'), cId = idx('Id');
  const cActive = idx('IsActive'), cCust = idx('IntacctCustomerId'), cAddr = idx('Address');
  if (cSite < 0 || cSc < 0) throw new Error('export has no SiteCode/ServiceCenter column');

  const rows = [];
  for (const r of grid.slice(1)) {
    const val = (c) => (c < 0 ? '' : String(r[c] == null ? '' : r[c]).trim());
    const site = val(cSite);
    if (!site) continue;
    rows.push({
      rawSite: site,
      serviceCenter: val(cSc),
      omniaId: val(cId),
      active: val(cActive).toLowerCase() !== 'false',
      customerId: val(cCust),
      address: val(cAddr),
    });
  }
  return rows;
}

/**
 * Collapse the export to one assignment per site code.
 * A named branch always beats FacilityCare when a site's rows disagree
 * (DCA1 and HGR6 each have one of each).
 */
function collapse(rows, known) {
  const bySite = new Map();
  for (const r of rows) {
    if (!r.active) continue;
    const named = r.serviceCenter && r.serviceCenter !== FACILITY_CARE;
    for (const code of codesIn(r.rawSite, known)) {
      const cur = bySite.get(code);
      if (!cur || (named && !cur.named)) {
        bySite.set(code, {
          site: code, serviceCenter: r.serviceCenter, named,
          omniaId: r.omniaId, address: r.address, rawSite: r.rawSite,
        });
      }
    }
  }
  return [...bySite.values()];
}

/**
 * One spelling per centre or the pickers split in half. amazon_locations uses
 * short names ("Trenton"); Omnia uses the long form ("Trenton Service Center").
 * Existing spellings win, so nothing that is already right gets churned — with
 * one deliberate exception: our master spells it "Cincinatti" and Omnia spells
 * it correctly, so Omnia's spelling is adopted and the old rows are renamed
 * together. A half-renamed centre is the bug, not the misspelling.
 */
const RESPELL = { cincinnati: 'Cincinnati' };
function canonicalNames() {
  const map = {};
  try {
    // Ordered so the answer never depends on row order: a spelling a person
    // declared wins, then the one more sites already use.
    for (const r of db.getDb().prepare(`SELECT service_center AS sc,
          SUM(CASE WHEN COALESCE(service_center_source,'declared')='derived' THEN 0 ELSE 1 END) AS solid,
          COUNT(*) AS n
        FROM amazon_locations WHERE TRIM(COALESCE(service_center,''))<>''
        GROUP BY service_center ORDER BY solid DESC, n DESC`).all()) {
      const k = normSc(r.sc);
      if (!map[k]) map[k] = String(r.sc).trim();
    }
  } catch (e) {}
  return { ...map, ...RESPELL };
}

/** What loading this export would change. Pure — writes nothing. */
function plan(rows) {
  const d = db.getDb();
  require('./site-service-center').ensureColumn();
  const cur = new Map();
  for (const r of d.prepare(`SELECT site_code, service_center, service_center_source, omnia_loc_id
      FROM amazon_locations`).all()) cur.set(String(r.site_code).toUpperCase(), r);

  const known = new Set(cur.keys());
  const names = canonicalNames();
  const canon = (full) => names[normSc(full)] || shortName(full);

  const out = {
    agree: [], fillBlank: [], overrideDerived: [], overrideDeclared: [],
    keptDeclared: [], newSite: [], skipped: [],
  };
  for (const s of collapse(rows, known)) {
    if (!s.serviceCenter) { out.skipped.push({ ...s, why: 'no service centre in Omnia' }); continue; }
    const want = canon(s.serviceCenter);
    const c = cur.get(s.site);
    const item = { site: s.site, to: want, omniaId: s.omniaId, named: s.named, rawSite: s.rawSite };
    if (!c) { out.newSite.push(item); continue; }
    const have = String(c.service_center || '').trim();
    const src = c.service_center_source || 'declared';
    if (!have) out.fillBlank.push(item);
    else if (normSc(have) === normSc(want)) out.agree.push({ ...item, from: have, respell: have !== want });
    else if (src === 'derived') out.overrideDerived.push({ ...item, from: have });
    else if (s.named) out.overrideDeclared.push({ ...item, from: have });
    else out.keptDeclared.push({ ...item, from: have });     // FacilityCare vs a declared branch
  }
  return out;
}

/** Write it. Everything except `keptDeclared`, which is left for a person. */
function apply(rows) {
  const d = db.getDb();
  const p = plan(rows);
  const names = canonicalNames();

  const upd = d.prepare(`UPDATE amazon_locations
    SET service_center=?, service_center_source='omnia',
        omnia_loc_id=COALESCE(NULLIF(TRIM(COALESCE(omnia_loc_id,'')),''), ?)
    WHERE site_code=?`);
  const ins = d.prepare(`INSERT OR IGNORE INTO amazon_locations
    (site_code, service_center, service_center_source, omnia_loc_id, loaded_at, source)
    VALUES (?,?, 'omnia', ?, datetime('now'), 'omnia-export')`);

  let written = 0, created = 0;
  for (const i of [...p.fillBlank, ...p.overrideDerived, ...p.overrideDeclared, ...p.agree]) {
    if (upd.run(i.to, i.omniaId || null, i.site).changes) written++;
  }
  for (const i of p.newSite) { ins.run(i.site, i.to, i.omniaId || null); created++; }

  // Rename the stragglers so one centre never exists under two spellings. Any
  // row still on an old spelling — including sites Omnia never mentioned —
  // moves with the rest.
  let respelled = 0;
  const ren = d.prepare('UPDATE amazon_locations SET service_center=? WHERE service_center=?');
  for (const r of d.prepare(`SELECT DISTINCT service_center AS sc FROM amazon_locations
      WHERE TRIM(COALESCE(service_center,''))<>''`).all()) {
    const want = names[normSc(r.sc)];
    if (want && want !== r.sc) respelled += ren.run(want, r.sc).changes;
  }
  return { ...p, written, created, respelled };
}

module.exports = { parse, plan, apply, collapse, codesIn, stripSuffix, FACILITY_CARE };
