'use strict';
/**
 * ar-location-patch2.js
 * Revised location strategy:
 *
 * 1. Fetch all LOCATION records from Sage once → build recordNo→{locationId, locationName} map
 * 2. Store map in SQLite location_cache table (or just a single JSON blob)
 * 3. In the ARINVOICE query, add LOCATION (numeric key) to select fields
 * 4. Merge locations by joining on the map — zero per-invoice API calls
 *
 * This replaces the readByQuery-per-invoice approach.
 */

const fs = require('fs');

const SPARK_DB   = '/home/ecf-admin/ar-portal/db.js';
const SPARK_SAGE = '/home/ecf-admin/ar-portal/sage.js';

// ─── PATCH db.js: add location_map table ──────────────────────────────────

let dbSrc = fs.readFileSync(SPARK_DB, 'utf8');

// Add location_map table (keyed by Sage recordno integer)
const OLD_LOC_TABLE = `    CREATE TABLE IF NOT EXISTS invoice_location (
      record_no    TEXT PRIMARY KEY,
      location_id  TEXT,
      location_name TEXT,
      fetched_at   TEXT DEFAULT (datetime('now'))
    );`;

const NEW_LOC_TABLES = `    CREATE TABLE IF NOT EXISTS invoice_location (
      record_no    TEXT PRIMARY KEY,
      location_id  TEXT,
      location_name TEXT,
      fetched_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS location_map (
      sage_recordno  INTEGER PRIMARY KEY,
      location_id    TEXT NOT NULL,
      location_name  TEXT NOT NULL,
      fetched_at     TEXT DEFAULT (datetime('now'))
    );`;

dbSrc = dbSrc.replace(OLD_LOC_TABLE, NEW_LOC_TABLES);

// Add location_map helpers
const OLD_LOC_HELPERS = `// ─── Invoice Location Cache ────────────────────────────────────────────────`;
const NEW_LOC_HELPERS = `// ─── Location Map (Sage LOCATION objects → ID/name) ───────────────────────

function getLocationMap() {
  const d = getDb();
  const rows = d.prepare('SELECT sage_recordno, location_id, location_name FROM location_map').all();
  const map = {};
  rows.forEach(r => { map[r.sage_recordno] = { locationId: r.location_id, locationName: r.location_name }; });
  return map;
}

function setLocationMapEntries(entries) {
  const d = getDb();
  const stmt = d.prepare('INSERT OR REPLACE INTO location_map (sage_recordno, location_id, location_name) VALUES (?, ?, ?)');
  for (const e of entries) {
    stmt.run(e.recordNo, e.locationId, e.locationName);
  }
}

function locationMapSize() {
  const d = getDb();
  return d.prepare('SELECT COUNT(*) as c FROM location_map').get().c;
}

// ─── Invoice Location Cache ────────────────────────────────────────────────`;

dbSrc = dbSrc.replace(OLD_LOC_HELPERS, NEW_LOC_HELPERS);

// Add to module.exports
dbSrc = dbSrc.replace(
  '  getMissingLocationRecordNos,\n};',
  '  getMissingLocationRecordNos,\n  getLocationMap,\n  setLocationMapEntries,\n  locationMapSize,\n};'
);

fs.writeFileSync(SPARK_DB, dbSrc);
console.log('✓ db.js: location_map table + helpers added');

// ─── PATCH sage.js ─────────────────────────────────────────────────────────

let sageSrc = fs.readFileSync(SPARK_SAGE, 'utf8');

// 1. Add LOCATION field to the ARINVOICE query select block
sageSrc = sageSrc.replace(
  '          <field>DESCRIPTION</field>',
  '          <field>DESCRIPTION</field>\n          <field>LOCATION</field>'
);

// 2. Add locationKey to parseInvoices
sageSrc = sageSrc.replace(
  "      bucket,\n      daysOverdue,\n    });",
  "      bucket,\n      daysOverdue,\n      locationKey: extractTag(block, 'LOCATION') || '',\n    });"
);

// 3. Replace enrichLocations with new location-map approach
const OLD_ENRICH = `// ─── Location Enrichment ────────────────────────────────────────────────────
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
}`;

const NEW_ENRICH = `// ─── Location Map ───────────────────────────────────────────────────────────
// Fetches ALL Sage LOCATION objects once, stores in SQLite location_map.
// Subsequent startups use the cached map — zero API calls.
// Invoice LOCATION field (numeric key) is joined against the map.

async function fetchLocationMap() {
  const mapSize = db.locationMapSize();
  if (mapSize > 0) {
    console.log(\`[sage] Using cached location map (\${mapSize} entries)\`);
    return db.getLocationMap();
  }

  console.log('[sage] Fetching LOCATION map from Sage...');
  const functionXml = \`
    <readByQuery>
      <object>LOCATION</object>
      <fields>RECORDNO,LOCATIONID,NAME</fields>
      <query>STATUS = 'active'</query>
      <pagesize>100</pagesize>
    </readByQuery>
  \`;
  const xml = buildXml(functionXml);
  const res = await sagePost(xml);
  const status = extractTag(res, 'status');
  if (status !== 'success') {
    const err = extractTag(res, 'description2') || 'unknown error';
    console.warn('[sage] Location map fetch failed:', err, '— locations will be blank');
    return {};
  }

  const entries = [];
  const re = /<LOCATION>([\s\S]*?)<\/LOCATION>/gi;
  let m;
  while ((m = re.exec(res)) !== null) {
    const block = m[1];
    const recNo = parseInt(extractTag(block, 'RECORDNO') || '0');
    const locId = extractTag(block, 'LOCATIONID') || '';
    const name  = extractTag(block, 'NAME') || locId;
    if (recNo) entries.push({ recordNo: recNo, locationId: locId, locationName: name });
  }

  if (entries.length > 0) {
    db.setLocationMapEntries(entries);
    console.log(\`[sage] Location map cached: \${entries.length} locations\`);
  }

  return db.getLocationMap();
}

async function enrichLocations(invoices) {
  const locMap = await fetchLocationMap();

  return invoices.map(inv => {
    const key = parseInt(inv.locationKey || '0');
    const loc = key ? locMap[key] : null;
    return {
      ...inv,
      locationId:   loc ? loc.locationId   : '',
      locationName: loc ? loc.locationName : '',
    };
  });
}`;

sageSrc = sageSrc.replace(OLD_ENRICH, NEW_ENRICH);

fs.writeFileSync(SPARK_SAGE, sageSrc);
console.log('✓ sage.js: location map approach applied');
console.log('\nDone. Restart portal on ecf-spark.');
