'use strict';
const fs = require('fs');
let src = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');

// Fix pagination: numremaining and totalcount are attributes on <data>, not child elements
// e.g. <data listtype="ARINVOICE" totalcount="4782" offset="0" count="1000" numremaining="3782">
src = src.replace(
  `    // Check if there are more pages
    const totalCountMatch = res.match(/<totalcount>(\\d+)<\\/totalcount>/i);
    const numRemainingMatch = res.match(/<numremaining>(\\d+)<\\/numremaining>/i);
    const numRemaining = numRemainingMatch ? parseInt(numRemainingMatch[1]) : 0;
    hasMore = numRemaining > 0;`,
  `    // Check if there are more pages — numremaining is a <data> attribute
    const dataAttrMatch = res.match(/<data[^>]+numremaining="(\\d+)"/i);
    const numRemaining = dataAttrMatch ? parseInt(dataAttrMatch[1]) : 0;
    const totalCountAttr = res.match(/<data[^>]+totalcount="(\\d+)"/i);
    if (offset === 0) console.log('[sage] Total invoices in Sage:', totalCountAttr ? totalCountAttr[1] : 'unknown', '| numremaining:', numRemaining);
    hasMore = numRemaining > 0;`
);

// Also add LOCATIONID/LOCATIONNAME as attributes query — try querying via LOCATION.LOCATIONID
// The Sage XML query API uses dot notation for related fields: LOCATION.LOCATIONID
// Add them back with dot notation
src = src.replace(
  '          <field>WHENCREATED</field>',
  '          <field>WHENCREATED</field>\n          <field>LOCATION.LOCATIONID</field>\n          <field>LOCATION.NAME</field>\n          <field>CUSTENTITY.NAME</field>'
);

// Update parser to read these
src = src.replace(
  "const locId      = extractTag(block, 'LOCATIONID') || extractTag(block, 'LOCATION') || '';",
  "const locId      = extractTag(block, 'LOCATIONID') || extractTag(block, 'LOCATION.LOCATIONID') || '';"
);
src = src.replace(
  "const locName    = extractTag(block, 'LOCATIONNAME') || locId || '';",
  "const locName    = extractTag(block, 'LOCATION.NAME') || extractTag(block, 'LOCATIONNAME') || locId || '';"
);

fs.writeFileSync('/home/ecf-admin/ar-portal/sage.js', src);
console.log('done');
