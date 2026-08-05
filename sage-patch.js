'use strict';
// Patch sage.js: fix locationid placement in XML auth block
const fs = require('fs');
const src = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');

// Remove the bad locationid we injected earlier (after companyid)
// and place it correctly inside login block after password
let patched = src;

// Remove the bad injection
patched = patched.replace(
  '</companyid>\n        <locationid>East Coast Facilities Inc.</locationid>',
  '</companyid>'
);

// Now inject correctly — after userPassword line inside login block
patched = patched.replace(
  '<password>${escXml(cfg.userPassword)}</password>',
  '<password>${escXml(cfg.userPassword)}</password>\n        <locationid>E-ECF</locationid>'
);

fs.writeFileSync('/home/ecf-admin/ar-portal/sage.js', patched);
console.log('Patched. Verifying...');
// Show the auth block
const lines = patched.split('\n');
const idx = lines.findIndex(l => l.includes('userid'));
console.log(lines.slice(idx - 1, idx + 8).join('\n'));
