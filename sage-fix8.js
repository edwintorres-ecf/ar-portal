'use strict';
const fs = require('fs');
let src = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');

// Remove the bad LOCATION.* and CUSTENTITY.* fields
src = src.replace('          <field>LOCATION.LOCATIONID</field>\n', '');
src = src.replace('          <field>LOCATION.NAME</field>\n', '');
src = src.replace('          <field>CUSTENTITY.NAME</field>\n', '');

// Also fix the debug XML snippet log — it fires even when res.length is large due to wrong condition
// Remove the "if (offset === 0)" XML snippet log to reduce noise
src = src.replace(
  '    if (offset === 0) console.log("[sage-debug] XML snippet:", xml.substring(300, 700));\n    ',
  ''
);

// Fix totalcount attr regex — it might be that data block structure differs
// Let's log the actual data tag line  
src = src.replace(
  "if (offset === 0) console.log('[sage] Total invoices in Sage:', totalCountAttr ? totalCountAttr[1] : 'unknown', '| numremaining:', numRemaining);",
  "const dataLine = res.match(/<data[^>]*>/); console.log('[sage] data tag:', dataLine ? dataLine[0] : 'NOT FOUND'); console.log('[sage] numremaining:', numRemaining);"
);

fs.writeFileSync('/home/ecf-admin/ar-portal/sage.js', src);
console.log('done');
