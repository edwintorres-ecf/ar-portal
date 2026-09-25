'use strict';
// ─── site-alias.js ──────────────────────────────────────────────────────────
// One physical Amazon site, more than one site code.
//
// Amazon renames sites. The old code keeps every PO, invoice and dollar we ever
// booked under it; the new code arrives empty. Both sit in `amazon_locations`
// as separate rows, so one site is counted twice in every rollup and its
// history is split between two halves that never meet:
//
//   MDT2 / KRB5   600 Principio Pkwy W   KRB5 has 7 POs and $463,485; MDT2 none
//   DOB5 / HBO2   34 Market St, Everett  HBO2 has the PO; DOB5 none
//   WGR5 / DGS2   1115 McDonald Rd       $95,257 under one, $5,727 under the other
//
// They can also disagree about themselves: WGR5 is business unit R2L with no
// service centre while DGS2 is Logistics under FacilityCare. Same building.
//
// ─── WHY THIS IS CONFIRM-FIRST ──────────────────────────────────────────────
// Merging two codes that are NOT the same site would silently move money
// between sites and business units, and nothing downstream would question it.
// So an alias does nothing until a person confirms it. `map()` and `resolve()`
// return CONFIRMED pairs only; proposals are inert until someone says yes.
//
// Direction cannot be guessed either. Omnia lists DOB5 and MDT2 but not HBO2 —
// which suggests the first code is the new name — yet for the third pair it
// lists DGS2 and NOT WGR5, while WGR5 carries the newer PO. Edwin confirmed
// KRB5 as the real code for MDT2/KRB5 (2026-09-24); the rest wait.

const db = require('./db');

// ─── USES THE EXISTING STORE ────────────────────────────────────────────────
// `site_aliases` already existed — Edwin set MDT2 -> KRB5 and MDT9 -> QYY4 on
// 2026-09-09 — with columns (alias, canonical_code, note, set_by, set_at) and
// helpers db.setSiteAlias / db.getSiteAliasMap. It was only ever read by
// site-ledger.js, never by po-ledger, which is why one renamed site still
// counted twice everywhere else.
//
// This module does NOT create a second table. It adds the missing pieces on
// top: a `status` so a candidate can sit unconfirmed, address-based detection,
// and resolution at the point every site code passes through.
function ensureTable() {
  const d = db.getDb();
  try {
    d.exec(`CREATE TABLE IF NOT EXISTS site_aliases (
      alias          TEXT PRIMARY KEY,
      canonical_code TEXT NOT NULL,
      note           TEXT,
      set_by         TEXT,
      set_at         TEXT DEFAULT (datetime('now'))
    )`);
    const cols = d.prepare('PRAGMA table_info(site_aliases)').all().map(c => c.name);
    if (!cols.includes('status')) {
      d.exec("ALTER TABLE site_aliases ADD COLUMN status TEXT");
      // Anything already here was typed by a person, so it is confirmed.
      d.exec("UPDATE site_aliases SET status='confirmed' WHERE status IS NULL");
      console.log('[site-alias] added status; existing rows marked confirmed');
    }
    if (!cols.includes('evidence')) d.exec('ALTER TABLE site_aliases ADD COLUMN evidence TEXT');
    if (!cols.includes('decided_by')) d.exec('ALTER TABLE site_aliases ADD COLUMN decided_by TEXT');
    if (!cols.includes('decided_at')) d.exec('ALTER TABLE site_aliases ADD COLUMN decided_at TEXT');
    d.exec("UPDATE site_aliases SET status='confirmed' WHERE status IS NULL OR TRIM(status)=''");
  } catch (e) { console.error('[site-alias] table:', e.message); }
}

const up = (s) => String(s || '').toUpperCase().trim();

/** Record a candidate pair. Inert until confirmed. */
function propose(alias, canonical, { evidence = '', source = '' } = {}) {
  ensureTable();
  const a = up(alias), c = up(canonical);
  if (!a || !c || a === c) throw new Error('need two different site codes');
  db.getDb().prepare(`INSERT INTO site_aliases
    (alias, canonical_code, status, evidence, note, set_by, set_at)
    VALUES (?,?, 'proposed', ?, ?, ?, datetime('now'))
    ON CONFLICT(alias) DO UPDATE SET
      canonical_code=excluded.canonical_code, evidence=excluded.evidence
    WHERE site_aliases.status='proposed'`).run(a, c, evidence, source, source);
  return get(a);
}

/**
 * A person says these are the same site, and which code is the real one.
 * `canonical` may flip the direction the proposal was filed in.
 */
function confirm(alias, canonical, by) {
  ensureTable();
  const a = up(alias), c = up(canonical);
  if (!a || !c || a === c) throw new Error('need two different site codes');
  const d = db.getDb();
  // Confirming the reverse direction: drop any row pointing the other way.
  d.prepare('DELETE FROM site_aliases WHERE alias=? AND canonical_code=?').run(c, a);
  d.prepare(`INSERT INTO site_aliases
    (alias, canonical_code, status, set_by, set_at, decided_by, decided_at)
    VALUES (?,?, 'confirmed', ?, datetime('now'), ?, datetime('now'))
    ON CONFLICT(alias) DO UPDATE SET
      canonical_code=excluded.canonical_code, status='confirmed',
      decided_by=excluded.decided_by, decided_at=excluded.decided_at`).run(a, c, by || null, by || null);
  invalidate();
  // The retired code usually holds the details; carry them across now rather
  // than leaving the canonical site reading as unknown.
  const inherited = inheritFromAlias(a, c);
  if (inherited.filled.length) console.log(`[site-alias] ${c} inherited from ${a}: ${inherited.filled.join(', ')}`);
  return { ...get(a), inherited: inherited.filled };
}

// Master-data columns a renamed site should carry over. Deliberately NOT the
// service centre: that has its own precedence stack (omnia < billing < manual,
// each in its own column) and writing it here would bypass it — see
// site-service-center.js.
const INHERITABLE = [
  ['business_unit', 'businessUnit'],
  ['region', 'region'],
  ['zone', 'zone'],
  ['city', 'city'],
  ['state', 'state'],
  ['address', 'address'],
  ['site_type', 'siteType'],
];

/**
 * A rename leaves the site's details on the RETIRED code.
 *
 * Amazon issues the new code as a bare row; everything we know about the
 * building — business unit, city, address — stays behind on the old one. The
 * canonical site then reads as having no BU and drops out of every rollup that
 * groups by it. DOB5 was exactly this: HBO2 carried `GSF` and `Everett`, DOB5
 * carried neither, and it sat in the "sites with no business unit" report
 * holding a $36,869 PO (2026-09-25).
 *
 * FILLS BLANKS ONLY. A value already on the canonical row is never replaced —
 * the new code is the one Amazon is using now, so where the two disagree the
 * canonical is the better answer, and a silent overwrite would be the harm
 * this is trying to prevent.
 */
function inheritFromAlias(alias, canonical) {
  const d = db.getDb();
  const a = up(alias), c = up(canonical);
  const filled = [];
  try {
    const from = d.prepare('SELECT * FROM amazon_locations WHERE site_code=?').get(a);
    const to = d.prepare('SELECT * FROM amazon_locations WHERE site_code=?').get(c);
    // Nothing to copy from, or no row to copy into. The second case is a real
    // possibility — a brand-new code Amazon has issued but nobody has loaded —
    // and it is left alone rather than invented here.
    if (!from || !to) return { filled, reason: !from ? 'alias not in the master' : 'canonical not in the master' };
    const blank = (v) => v === null || v === undefined || String(v).trim() === '';
    for (const [col, label] of INHERITABLE) {
      if (!blank(to[col]) || blank(from[col])) continue;
      d.prepare(`UPDATE amazon_locations SET ${col}=? WHERE site_code=?`).run(from[col], c);
      filled.push(`${label}=${from[col]}`);
    }
  } catch (e) {
    return { filled, reason: e.message };
  }
  return { filled, reason: null };
}

/** Not the same site. Kept as a tombstone so it is not proposed again. */
function reject(alias, by) {
  ensureTable();
  db.getDb().prepare(`UPDATE site_aliases SET status='rejected', decided_by=?, decided_at=datetime('now')
    WHERE alias=?`).run(by || null, up(alias));
  invalidate();
  return get(up(alias));
}

function get(alias) {
  ensureTable();
  try { return db.getDb().prepare('SELECT * FROM site_aliases WHERE alias=?').get(up(alias)) || null; }
  catch (e) { return null; }
}

function list(status) {
  ensureTable();
  try {
    return status
      ? db.getDb().prepare('SELECT * FROM site_aliases WHERE status=? ORDER BY alias').all(status)
      : db.getDb().prepare('SELECT * FROM site_aliases ORDER BY status, alias').all();
  } catch (e) { return []; }
}

// Cached because normalizeSite() is called for every invoice and PO row.
let _map = null;
function invalidate() { _map = null; }

/** { ALIAS: CANONICAL } for CONFIRMED pairs only. */
function map() {
  if (_map) return _map;
  _map = {};
  try {
    for (const r of list('confirmed')) {
      const a = up(r.alias), c = up(r.canonical_code);
      if (a && c && a !== c) _map[a] = c;
    }
    // One hop only. A chain (A->B, B->C) would be a data error, and following
    // it blindly risks a cycle; collapse what is safe and leave the rest.
    for (const [a, c] of Object.entries(_map)) {
      if (_map[c] && _map[c] !== a) _map[a] = _map[c];
    }
  } catch (e) { _map = {}; }
  return _map;
}

/** The real code for a site code. Unknown or unconfirmed codes pass through. */
function resolve(code) {
  const c = up(code);
  if (!c) return code;
  return map()[c] || c;
}

/** Every code a site answers to, canonical first. */
function codesFor(canonical) {
  const c = up(canonical);
  const extra = Object.entries(map()).filter(([, v]) => v === c).map(([k]) => k);
  return [c, ...extra];
}

/**
 * Candidate pairs found by street address in the location master.
 *
 * Deliberately only the house number and street: suite and unit differ between
 * an FC and its parking deck, and comparing full strings finds nothing.
 */
function detect() {
  const normAddr = (a) => String(a || '').toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(SUITE|STE|UNIT|BLDG|BUILDING)\b.*$/, '')
    .replace(/\b(ROAD)\b/g, 'RD').replace(/\b(STREET)\b/g, 'ST')
    .replace(/\b(PARKWAY)\b/g, 'PKWY').replace(/\b(DRIVE)\b/g, 'DR')
    .replace(/\b(AVENUE)\b/g, 'AVE').replace(/\b(WEST)\b/g, 'W').replace(/\b(EAST)\b/g, 'E')
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 4).join(' ');

  const rows = Object.values(db.getAmazonLocationMap()).filter(r => r.address && r.address.trim());
  const byAddr = {};
  for (const r of rows) {
    const k = normAddr(r.address);
    if (k.length < 8) continue;
    (byAddr[k] = byAddr[k] || []).push(r);
  }
  const decided = new Set(list().flatMap(r => [up(r.alias), up(r.canonical_code)]));
  const out = [];
  for (const [addr, group] of Object.entries(byAddr)) {
    const codes = [...new Set(group.map(r => up(r.siteCode)))];
    if (codes.length < 2) continue;
    if (codes.every(c => decided.has(c))) continue;
    out.push({
      address: addr,
      city: group[0].city || '', state: group[0].state || '',
      codes,
      disagreement: [
        [...new Set(group.map(r => r.businessUnit || '—'))].length > 1 ? 'business unit' : null,
        [...new Set(group.map(r => r.serviceCenter || '—'))].length > 1 ? 'service center' : null,
      ].filter(Boolean),
    });
  }
  return out;
}

module.exports = { ensureTable, propose, confirm, reject, get, list, map, resolve, codesFor, detect,
  invalidate, inheritFromAlias, INHERITABLE };
