'use strict';
const fs = require('fs');
let src = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');

// Add logging of the XML being sent
src = src.replace(
  'const xml = buildXml(functionXml);\n    const res = await sagePost(xml);',
  'const xml = buildXml(functionXml);\n    if (offset === 0) console.log("[sage-debug] XML snippet:", xml.substring(300, 700));\n    const res = await sagePost(xml);'
);

fs.writeFileSync('/home/ecf-admin/ar-portal/sage.js', src);
console.log('done');
