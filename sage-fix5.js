'use strict';
const fs = require('fs');
let src = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');

// Print full response when it's small (959 bytes = something wrong)
src = src.replace(
  'const arinvCount = (res.match(/<ARINVOICE>/gi)||[]).length;',
  'if (res.length < 2000) console.log("[sage-debug] FULL RESPONSE:", res);\n    const arinvCount = (res.match(/<ARINVOICE>/gi)||[]).length;'
);

fs.writeFileSync('/home/ecf-admin/ar-portal/sage.js', src);
console.log('done');
