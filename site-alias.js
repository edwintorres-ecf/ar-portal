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

function ensureTable() {
  try {
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS site_aliases (
      alias_code     TEXT PRIMARY KEY,
      canonical_code TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'proposed',   -- proposed | confirmed | rejected
      evidence       TEXT,
      source         TEXT,
      created_at     TEXT,
      decided_by     TEXT,
      decided_at     TEXT
    )`);
    db.getDb().exec('CREATE INDEX IF NOT EXISTS idx_site_alias_canon ON site_aliases(canonical_code)');
  } catch (e) { console.error('[site-alias] table:', e.message); }
}

const up = (s) => String(s || '').toUpperCase().trim();

/** Record a candidate pair. Inert until confirmed. */
function propose(alias, canonical, { evidence = '', source = '' } = {}) {
  ensureTable();
  const a = up(alias), c = up(canonical);
  if (!a || !c || a === c) throw new Error('need two different site codes');
  db.getDb().prepare(`INSERT INTO site_aliases
    (alias_code, canonical_code, status, evidence, source, created_at)
    VALUES (?,?, 'proposed', ?, ?, datetime('now'))
    ON CONFLICT(alias_code) DO UPDATE SET
      canonical_code=excluded.canonical_code, evidence=excluded.evidence,
      source=excluded.source
    WHERE site_aliases.status='proposed'`).run(a, c, evidence, source);
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
  d.prepare('DELETE FROM site_aliases WHERE alias_code=? AND canonical_code=?').run(c, a);
  d.prepare(`INSERT INTO site_aliases
    (alias_code, canonical_code, status, evidence, source, created_at, decided_by, decided_at)
    VALUES (?,?, 'confirmed', '', '', datetime('now'), ?, datetime('now'))
    ON CONFLICT(alias_code) DO UPDATE SET
      canonical_code=excluded.canonical_code, status='confirmed',
      decided_by=excluded.decided_by, decided_at=excluded.decided_at`).run(a, c, by || null);
  invalidate();
  return get(a);
}

/** Not the same site. Kept as a tombstone so it is not proposed again. */
function reject(alias, by) {
  ensureTable();
  db.getDb().prepare(`UPDATE site_aliases SET status='rejected', decided_by=?, decided_at=datetime('now')
    WHERE alias_code=?`).run(by || null, up(alias));
  invalidate();
  return get(up(alias));
}

function get(alias) {
  ensureTable();
  try { return db.getDb().prepare('SELECT * FROM site_aliases WHERE alias_code=?').get(up(alias)) || null; }
  catch (e) { return null; }
}

function list(status) {
  ensureTable();
  try {
    return status
      ? db.getDb().prepare('SELECT * FROM site_aliases WHERE status=? ORDER BY alias_code').all(status)
      : db.getDb().prepare('SELECT * FROM site_aliases ORDER BY status, alias_code').all();
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
      const a = up(r.alias_code), c = up(r.canonical_code);
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
  const decided = new Set(list().map(r => up(r.alias_code)));
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

module.exports = { ensureTable, propose, confirm, reject, get, list, map, resolve, codesFor, detect, invalidate };
