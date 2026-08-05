'use strict';
const fs = require('fs');
let src = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');

// Remove <locationid>E-ECF</locationid> from the auth login block
// Auth at company level (like ar-aging.js) so LOCATIONID/LOCATIONNAME fields work in queries
src = src.replace(
  '        <locationid>E-ECF</locationid>\n      </login>',
  '      </login>'
);

// Remove LOCATION field from select (it's a nested object not a flat field)
src = src.replace('          <field>LOCATION</field>\n', '');

// Remove locationKey from parseInvoices (no longer needed)
src = src.replace(
  "      locationKey: extractTag(block, 'LOCATION') || '',\n",
  ''
);

// Fix locId/locName to use proper flat fields (now that auth is at company level)
src = src.replace(
  "const locId      = extractTag(block, 'LOCATIONID') || extractTag(block, 'LOCATION.LOCATIONID') || '';",
  "const locId      = extractTag(block, 'LOCATIONID') || '';"
);
src = src.replace(
  "const locName    = extractTag(block, 'LOCATION.NAME') || extractTag(block, 'LOCATIONNAME') || locId || '';",
  "const locName    = extractTag(block, 'LOCATIONNAME') || locId || '';"
);

// Update enrichLocations: since LOCATIONID/LOCATIONNAME now come directly from query,
// skip the map enrichment and just use the values already on the invoice
const OLD_ENRICH_CALL = `  let invoices = await queryAllInvoices();
  invoices = await enrichLocations(invoices);`;
const NEW_ENRICH_CALL = `  let invoices = await queryAllInvoices();
  // Location fields (LOCATIONID, LOCATIONNAME) are returned directly by the query
  // at company-level auth scope — no enrichment step needed`;
src = src.replace(OLD_ENRICH_CALL, NEW_ENRICH_CALL);

fs.writeFileSync('/home/ecf-admin/ar-portal/sage.js', src);
console.log('Auth fixed. Verifying...');
console.log('locationid in auth:', src.includes('<locationid>E-ECF</locationid>'));
console.log('LOCATION field in select:', src.includes('<field>LOCATION</field>'));
console.log('syntax check next...');
