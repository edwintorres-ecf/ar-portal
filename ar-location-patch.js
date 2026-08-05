'use strict';
/**
 * ar-location-patch.js
 * Patches db.js and sage.js on ecf-spark to add per-invoice location caching.
 *
 * Strategy:
 * - Add `invoice_location` table to SQLite (record_no PK, location_id, location_name, fetched_at)
 * - Add getLocation / setLocation helpers to db.js
 * - Add enrichLocations(invoices) to sage.js:
 *     - Look up each invoice's record_no in SQLite
 *     - For those missing: fetch from Sage via readByQuery LOCATIONID on ARINVOICE
 *       (Sage allows readByQuery with a filter, which returns LOCATIONID even though
 *        query doesn't — or fall back to read by RECORDNO)
 *     - Store in SQLite, never re-fetch
 * - Merge location into invoice objects before returning from getInvoices()
 */

const fs = require('fs');
const path = require('path');

const SPARK_DB    = '/home/ecf-admin/ar-portal/db.js';
const SPARK_SAGE  = '/home/ecf-admin/ar-portal/sage.js';

// ─── PATCH db.js ──────────────────────────────────────────────────────────

let dbSrc = fs.readFileSync(SPARK_DB, 'utf8');

// 1. Add location_cache table to initSchema
const OLD_SCHEMA_END = `    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_email);
  \`);
}`;

const NEW_SCHEMA_END = `    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_email);

    CREATE TABLE IF NOT EXISTS invoice_location (
      record_no    TEXT PRIMARY KEY,
      location_id  TEXT,
      location_name TEXT,
      fetched_at   TEXT DEFAULT (datetime('now'))
    );
  \`);
}`;

if (dbSrc.includes(OLD_SCHEMA_END)) {
  dbSrc = dbSrc.replace(OLD_SCHEMA_END, NEW_SCHEMA_END);
  console.log('✓ db.js: added invoice_location table');
} else {
  console.error('✗ db.js: schema end not found');
  process.exit(1);
}

// 2. Add getLocation / setLocation / getMissingLocationRecordNos helpers before module.exports
const OLD_EXPORTS = `module.exports = {
  getDb,`;

const LOCATION_HELPERS = `// ─── Invoice Location Cache ────────────────────────────────────────────────

function getLocation(recordNo) {
  const d = getDb();
  return d.prepare('SELECT location_id, location_name FROM invoice_location WHERE record_no=?').get(recordNo) || null;
}

function setLocation(recordNo, locationId, locationName) {
  const d = getDb();
  d.prepare(\`
    INSERT OR REPLACE INTO invoice_location (record_no, location_id, location_name, fetched_at)
    VALUES (?, ?, ?, datetime('now'))
  \`).run(recordNo, locationId || '', locationName || '');
}

function getMissingLocationRecordNos(recordNos) {
  // Returns those not yet in the cache
  const d = getDb();
  const stmt = d.prepare('SELECT record_no FROM invoice_location WHERE record_no=?');
  return recordNos.filter(rn => !stmt.get(rn));
}

`;

dbSrc = dbSrc.replace(OLD_EXPORTS, LOCATION_HELPERS + OLD_EXPORTS);

// 3. Add to module.exports
dbSrc = dbSrc.replace(
  '  getAuditLog,\n};',
  '  getAuditLog,\n  getLocation,\n  setLocation,\n  getMissingLocationRecordNos,\n};'
);

fs.writeFileSync(SPARK_DB, dbSrc);
console.log('✓ db.js patched and written');

// ─── PATCH sage.js ─────────────────────────────────────────────────────────

let sageSrc = fs.readFileSync(SPARK_SAGE, 'utf8');

// Add db require at top (after the dotenv line)
if (!sageSrc.includes("require('./db')")) {
  sageSrc = sageSrc.replace(
    "require('dotenv').config",
    "const db = require('./db');\nrequire('dotenv').config"
  );
  console.log('✓ sage.js: added db require');
}

// Add enrichLocations function before module.exports
const ENRICH_FN = `
// ─── Location Enrichment ────────────────────────────────────────────────────
// Fetches location for invoices not yet in the SQLite cache.
// Uses Sage readByQuery filtered by RECORDNO — returns LOCATIONID field.
// Called after queryAllInvoices; runs in background, resolves when done.

async function fetchLocationFromSage(recordNo) {
  const cfg = getSageConfig();
  const controlId = 'loc-' + Date.now() + '-' + recordNo;
  const functionXml = \`
    <readByQuery>
      <object>ARINVOICE</object>
      <fields>RECORDNO,LOCATIONID,LOCATIONNAME</fields>
      <query>RECORDNO = \${recordNo}</query>
      <pagesize>1</pagesize>
    </readByQuery>
  \`;
  const xml = buildXml(functionXml);
  try {
    const res = await sagePost(xml);
    const status = extractTag(res, 'status');
    if (status !== 'success') return null;
    const locId   = extractTag(res, 'LOCATIONID')   || '';
    const locName = extractTag(res, 'LOCATIONNAME') || locId;
    return { locationId: locId, locationName: locName };
  } catch (e) {
    return null;
  }
}

async function enrichLocations(invoices) {
  // Step 1: find which record_nos are missing from cache
  const allRecordNos = invoices.map(i => i.recordNo).filter(Boolean);
  const missing = db.getMissingLocationRecordNos(allRecordNos);

  if (missing.length === 0) {
    console.log('[sage] All locations cached — no Sage calls needed');
  } else {
    console.log(\`[sage] Fetching location for \${missing.length} invoices from Sage...\`);
    // Batch in groups of 10 with small delay to avoid rate-limiting
    const BATCH = 10;
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      await Promise.all(batch.map(async rn => {
        const loc = await fetchLocationFromSage(rn);
        db.setLocation(rn, loc ? loc.locationId : '', loc ? loc.locationName : '');
      }));
      if (i + BATCH < missing.length) {
        await new Promise(r => setTimeout(r, 200)); // 200ms between batches
      }
    }
    console.log(\`[sage] Location fetch complete for \${missing.length} invoices\`);
  }

  // Step 2: merge cached locations into invoice objects
  return invoices.map(inv => {
    const loc = db.getLocation(inv.recordNo);
    return {
      ...inv,
      locationId:   loc ? loc.location_id   : '',
      locationName: loc ? loc.location_name : '',
    };
  });
}

`;

// Insert before module.exports
const MOD_EXPORTS_MARKER = 'module.exports = {';
sageSrc = sageSrc.replace(MOD_EXPORTS_MARKER, ENRICH_FN + MOD_EXPORTS_MARKER);

// Update getInvoices to call enrichLocations after queryAllInvoices
// Current pattern: invoices = await queryAllInvoices(); then cache/return
sageSrc = sageSrc.replace(
  '  const invoices = await queryAllInvoices();',
  '  let invoices = await queryAllInvoices();\n  invoices = await enrichLocations(invoices);'
);

// Export enrichLocations
sageSrc = sageSrc.replace(
  '  getInvoices,',
  '  getInvoices,\n  enrichLocations,'
);

fs.writeFileSync(SPARK_SAGE, sageSrc);
console.log('✓ sage.js patched and written');
console.log('\nAll patches applied. Restart the portal on ecf-spark to take effect.');
