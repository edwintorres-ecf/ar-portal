'use strict';
const fs = require('fs');
let src = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');

// Replace the debug snippet line with a useful one
src = src.replace(
  'console.log("[sage-debug] raw snippet:", res.substring(0,300)); const batch = parseInvoices(res);',
  'const arinvCount = (res.match(/<ARINVOICE>/gi)||[]).length; const tcMatch = res.match(/<totalcount>(\\d+)/); console.log("[sage-debug] res_len:", res.length, "ARINVOICE_blocks:", arinvCount, "totalcount:", tcMatch ? tcMatch[1] : "none"); const batch = parseInvoices(res);'
);

fs.writeFileSync('/home/ecf-admin/ar-portal/sage.js', src);
console.log('patched');
