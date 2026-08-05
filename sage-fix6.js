'use strict';
const fs = require('fs');
let src = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');

// Remove the 4 non-queryable fields from the select block
// LOCATIONID, LOCATIONNAME, PONUMBER, RECORDURL are not queryable via XML query API
src = src.replace('          <field>LOCATIONID</field>\n', '');
src = src.replace('          <field>LOCATIONNAME</field>\n', '');
src = src.replace('          <field>PONUMBER</field>\n', '');
src = src.replace('          <field>RECORDURL</field>\n', '');

// Also remove the RECORDURL from the push object (set to null)
src = src.replace(
  "const recordUrl    = extractTag(block, 'RECORDURL')  || null;",
  "const recordUrl    = null; // RECORDURL not queryable via XML API"
);

// Fix locationId/locationName — try LOCATION.NAME and LOCATION.LOCATIONID instead
// Actually these might come back as empty — fill from what we have
// For now just make them gracefully null
src = src.replace(
  "const locId      = extractTag(block, 'LOCATIONID')   || '';",
  "const locId      = extractTag(block, 'LOCATIONID') || extractTag(block, 'LOCATION') || '';"
);
src = src.replace(
  "const locName    = extractTag(block, 'LOCATIONNAME') || locId;",
  "const locName    = extractTag(block, 'LOCATIONNAME') || locId || '';"
);

// And PO number
src = src.replace(
  "poNumber: extractTag(block, 'PONUMBER') || '',",
  "poNumber: extractTag(block, 'PONUMBER') || extractTag(block, 'PO_NUMBER') || '',"
);

fs.writeFileSync('/home/ecf-admin/ar-portal/sage.js', src);
console.log('Fields removed. Checking remaining occurrences:');
console.log('LOCATIONID fields:', (src.match(/LOCATIONID/g)||[]).length);
console.log('PONUMBER fields:', (src.match(/PONUMBER/g)||[]).length);
console.log('RECORDURL fields:', (src.match(/RECORDURL/g)||[]).length);
