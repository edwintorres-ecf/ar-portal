'use strict';
// ─── amazon-award.js ────────────────────────────────────────────────────────
// What Amazon awarded us for a snow season, and how much of it has actually
// turned into a purchase order.
//
// The portal only ever knew about POs that had ARRIVED. So the question people
// actually ask in September — "we were awarded 283 sites for $43M, where are
// the POs?" — was unanswerable, and the gap was invisible until invoices began
// holding in February for want of funds.
//
// ─── THE SEASON RULE ────────────────────────────────────────────────────────
// Amazon names a snow PO by the season's END year, and raises it the AUTUMN
// BEFORE:
//
//   "TUL5 - 2026 - Snow Removal Maintenance Contract"   raised Oct 31, 2025
//
// That is the 2025-26 season. So description year Y means season (Y-1)/Y, and
// the 2026-27 season will say **2027**.
//
// Getting this wrong is not a rounding error: matching the 2026-27 award
// against POs whose description says "2026" compares it to LAST season's 540
// POs and reports the season as most of the way ready when nothing has arrived
// at all (2026-09-23).

const db = require('./db');

const CURRENT_SEASON = process.env.SNOW_SEASON || '2026-27';

function ensureTable() {
  try {
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS amazon_award (
      season        TEXT NOT NULL,
      site_code     TEXT NOT NULL,
      state         TEXT,
      region        TEXT,
      amount        REAL,
      pricing_model TEXT,
      source        TEXT,
      loaded_at     TEXT,
      PRIMARY KEY (season, site_code)
    )`);
  } catch (e) { console.error('[amazon-award] table:', e.message); }
}

/** Replace a season's award outright. Amazon revises these — 240 sites became 283. */
function load(rows, { season = CURRENT_SEASON, source = 'award-email' } = {}) {
  ensureTable();
  const d = db.getDb();
  const ins = d.prepare(`INSERT INTO amazon_award
    (season, site_code, state, region, amount, pricing_model, source, loaded_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(season, site_code) DO UPDATE SET
      state=excluded.state, region=excluded.region, amount=excluded.amount,
      pricing_model=excluded.pricing_model, source=excluded.source, loaded_at=excluded.loaded_at`);
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM amazon_award WHERE season=?').run(season);
    for (const r of rows) {
      const code = String(r.code || r.siteCode || '').toUpperCase().trim();
      if (!code) continue;
      ins.run(season, code, r.state || '', r.region || '',
        r.amount == null ? null : Number(r.amount), r.pricing || r.pricingModel || '', source);
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return list(season).length;
}

function list(season = CURRENT_SEASON) {
  ensureTable();
  try {
    return db.getDb().prepare('SELECT * FROM amazon_award WHERE season=? ORDER BY site_code').all(season)
      .map(r => ({ season: r.season, siteCode: r.site_code, state: r.state || '', region: r.region || '',
        amount: r.amount, pricingModel: r.pricing_model || '', source: r.source, loadedAt: r.loaded_at }));
  } catch (e) { return []; }
}

function seasons() {
  ensureTable();
  try {
    return db.getDb().prepare(`SELECT season, COUNT(*) sites, SUM(amount) total
      FROM amazon_award GROUP BY season ORDER BY season DESC`).all();
  } catch (e) { return []; }
}

/**
 * Which snow season a PO belongs to, as "2026-27".
 * The year named in the description wins — it is Amazon's own label. Falling
 * back to the order date, a PO raised Aug-Dec of year N is for season N/(N+1);
 * raised Jan-Jul it is the season already under way.
 */
function seasonOfPo(po) {
  const desc = String((po && po.docDescription) || '');
  const m = desc.match(/\b(20\d\d)\b/);
  if (m) {
    const end = Number(m[1]);
    // 2045 appears in a handful of documents and is not a season.
    if (end >= 2018 && end <= 2035) return `${end - 1}-${String(end).slice(2)}`;
  }
  const od = String((po && po.orderDate) || '');
  const d = new Date(od);
  if (!isNaN(d)) {
    const y = d.getFullYear(), mo = d.getMonth() + 1;
    const start = mo >= 8 ? y : y - 1;
    return `${start}-${String(start + 1).slice(2)}`;
  }
  return null;
}

/**
 * Award against reality for one season.
 *
 * `awarded`   every awarded site, with the POs that have arrived for it
 * `unawarded` sites carrying a PO for this season that were NOT awarded
 */
function readiness(invoices, { season = CURRENT_SEASON } = {}) {
  const award = list(season);
  const ledger = require('./po-ledger').getPoLedger(invoices);

  const snowForSeason = ledger.filter(p =>
    p.serviceType === 'snow' && p.siteCode && seasonOfPo(p) === season);
  const bySite = {};
  for (const p of snowForSeason) (bySite[p.siteCode] = bySite[p.siteCode] || []).push(p);

  const awarded = award.map(a => {
    const pos = bySite[a.siteCode] || [];
    const anyValue = pos.some(p => p.ceilingAmount != null);
    const poValue = anyValue ? pos.reduce((t, p) => t + (p.ceilingAmount || 0), 0) : null;
    // Only meaningful once a value is published; "--" POs are common and are
    // not a shortfall (see ar-portal-zero-value-po).
    const gap = (poValue != null && a.amount != null) ? Math.round((poValue - a.amount) * 100) / 100 : null;
    const pct = (gap != null && a.amount) ? poValue / a.amount : null;
    return {
      ...a,
      poCount: pos.length,
      poNumbers: pos.map(p => p.poNumber),
      poValue,
      poValueUnpublished: pos.length > 0 && !anyValue,
      gap,
      // Banded so the screen can sort by "worth a phone call".
      status: pos.length === 0 ? 'no-po'
        : !anyValue ? 'po-no-value'
        : pct != null && pct < 0.9 ? 'short'
        : pct != null && pct > 1.1 ? 'over'
        : 'matched',
      serviceCenter: pos.find(p => p.siteServiceCenter)?.siteServiceCenter || '',
      businessUnit: pos.find(p => p.businessUnit)?.businessUnit || '',
      pendingUpload: Math.round(pos.reduce((t, p) => t + (p.pendingUpload || 0), 0) * 100) / 100,
    };
  });

  const awardedCodes = new Set(award.map(a => a.siteCode));
  const unawarded = Object.entries(bySite)
    .filter(([site]) => !awardedCodes.has(site))
    .map(([site, pos]) => ({
      siteCode: site,
      poCount: pos.length,
      poNumbers: pos.map(p => p.poNumber),
      poValue: Math.round(pos.reduce((t, p) => t + (p.ceilingAmount || 0), 0) * 100) / 100,
      serviceCenter: pos.find(p => p.siteServiceCenter)?.siteServiceCenter || '',
    }))
    .sort((a, b) => b.poValue - a.poValue);

  const sum = (rows, f) => Math.round(rows.reduce((t, r) => t + (f(r) || 0), 0) * 100) / 100;
  const withPo = awarded.filter(a => a.poCount > 0);
  const byStatus = {};
  for (const a of awarded) byStatus[a.status] = (byStatus[a.status] || 0) + 1;

  const roll = (key) => {
    const out = {};
    for (const a of awarded) {
      const k = a[key] || '(none)';
      out[k] = out[k] || { sites: 0, awarded: 0, withPo: 0, poValue: 0 };
      out[k].sites++; out[k].awarded += a.amount || 0;
      if (a.poCount) { out[k].withPo++; out[k].poValue += a.poValue || 0; }
    }
    for (const v of Object.values(out)) {
      v.awarded = Math.round(v.awarded * 100) / 100;
      v.poValue = Math.round(v.poValue * 100) / 100;
    }
    return out;
  };

  return {
    season,
    awarded: awarded.sort((a, b) => (b.amount || 0) - (a.amount || 0)),
    unawarded,
    byStatus,
    byRegion: roll('region'),
    byServiceCenter: roll('serviceCenter'),
    byPricingModel: roll('pricingModel'),
    totals: {
      sites: awarded.length,
      awardedValue: sum(awarded, a => a.amount),
      sitesWithPo: withPo.length,
      poValue: sum(withPo, a => a.poValue),
      awaitingPo: awarded.length - withPo.length,
      awaitingValue: sum(awarded.filter(a => !a.poCount), a => a.amount),
      shortfall: sum(awarded.filter(a => a.status === 'short'), a => -a.gap),
      unawardedWithPo: unawarded.length,
    },
    loadedAt: award.length ? award[0].loadedAt : null,
  };
}

module.exports = { ensureTable, load, list, seasons, readiness, seasonOfPo, CURRENT_SEASON };
