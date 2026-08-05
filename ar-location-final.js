'use strict';
/**
 * ar-location-final.js
 * Final location enrichment: use ARINVOICEITEM readByQuery batched by RECORDKEY.
 * - Auth stays at E-ECF entity scope (correct 4,782 invoice set)
 * - After loading invoices, batch 50 RECORDNO values per readByQuery call
 * - Store first line item's location per invoice in invoice_location SQLite table
 * - Never re-fetch already-cached invoices
 * Patches sage.js in place.
 */

const fs = require('fs');
const SPARK_SAGE = '/home/ecf-admin/ar-portal/sage.js';

let src = fs.readFileSync(SPARK_SAGE, 'utf8');

// 1. Restore E-ECF locationid in auth (needed for the correct invoice set)
src = src.replace(
  '      </login>',
  '        <locationid>E-ECF</locationid>\n      </login>'
);

// 2. Rebuild enrichLocations to use batched ARINVOICEITEM readByQuery
const OLD_ENRICH_FN_START = '// ─── Location Map ───────────────────────────────────────────────────────────';
const OLD_ENRICH_FN_END   = 'module.exports = {';

// Find and replace everything between the two markers
const startIdx = src.indexOf(OLD_ENRICH_FN_START);
const endIdx   = src.indexOf(OLD_ENRICH_FN_END);

if (startIdx === -1 || endIdx === -1) {
  console.error('ERROR: could not find enrichLocation markers');
  process.exit(1);
}

const NEW_ENRICH = `// ─── Location Enrichment via ARINVOICEITEM ──────────────────────────────────
// Batches 50 invoice RECORDNO values per readByQuery call on ARINVOICEITEM.
// Results stored in SQLite invoice_location table — never re-fetched.
// First line item's location is used as the invoice location.

const LOCATION_BATCH = 50;

async function fetchAndCacheLocations(recordNos) {
  const batches = [];
  for (let i = 0; i < recordNos.length; i += LOCATION_BATCH) {
    batches.push(recordNos.slice(i, i + LOCATION_BATCH));
  }

  for (const batch of batches) {
    const query = batch.map(rn => \`RECORDKEY = \${rn}\`).join(' OR ');
    const functionXml = \`
      <readByQuery>
        <object>ARINVOICEITEM</object>
        <fields>RECORDNO,RECORDKEY,LOCATIONID,LOCATIONNAME</fields>
        <query>\${query}</query>
        <pagesize>1000</pagesize>
      </readByQuery>
    \`;
    const xml = buildXml(functionXml);
    try {
      const res = await sagePost(xml);
      const status = extractTag(res, 'status');
      if (status !== 'success') continue;

      // Parse all line items; keep first location seen per RECORDKEY
      const seen = {};
      const re = /<arinvoiceitem>([\s\S]*?)<\/arinvoiceitem>/gi;
      let m;
      while ((m = re.exec(res)) !== null) {
        const block  = m[1];
        const recKey = extractTag(block, 'RECORDKEY') || '';
        if (!recKey || seen[recKey]) continue;
        seen[recKey] = {
          locationId:   extractTag(block, 'LOCATIONID')   || '',
          locationName: extractTag(block, 'LOCATIONNAME') || '',
        };
      }

      // Store in SQLite
      for (const [recKey, loc] of Object.entries(seen)) {
        db.setLocation(recKey, loc.locationId, loc.locationName);
      }

      // Mark any in this batch that had no items (no line items = blank location)
      for (const rn of batch) {
        if (!seen[rn]) db.setLocation(String(rn), '', '');
      }
    } catch (e) {
      // On error, mark the batch as blank so we don't retry forever
      for (const rn of batch) db.setLocation(String(rn), '', '');
    }

    // Small delay between batches
    await new Promise(r => setTimeout(r, 100));
  }
}

async function enrichLocations(invoices) {
  const allRecordNos = invoices.map(i => i.recordNo).filter(Boolean);
  const missing = db.getMissingLocationRecordNos(allRecordNos);

  if (missing.length > 0) {
    console.log(\`[sage] Fetching locations for \${missing.length} invoices (\${Math.ceil(missing.length / LOCATION_BATCH)} API calls)...\`);
    await fetchAndCacheLocations(missing);
    console.log('[sage] Location enrichment complete');
  } else {
    console.log('[sage] All locations cached');
  }

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

src = src.substring(0, startIdx) + NEW_ENRICH + src.substring(endIdx);

// 3. Restore the enrichLocations call in getInvoices
src = src.replace(
  `  let invoices = await queryAllInvoices();
  // Location fields (LOCATIONID, LOCATIONNAME) are returned directly by the query
  // at company-level auth scope -- no enrichment step needed`,
  `  let invoices = await queryAllInvoices();
  invoices = await enrichLocations(invoices);`
);

// 4. Export enrichLocations if not already there
if (!src.includes('enrichLocations,')) {
  src = src.replace('  getInvoices,', '  getInvoices,\n  enrichLocations,');
}

fs.writeFileSync(SPARK_SAGE, src);
console.log('sage.js patched');
