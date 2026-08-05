'use strict';
const fs = require('fs');
let src = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');

// Replace the entire sagePost function with a robust version that uses node-fetch
// (already in package.json) or a better https implementation

const oldSagePost = `function sagePost(xml) {
  return new Promise((resolve, reject) => {
    const body = 'xmlrequest=' + encodeURIComponent(xml);
    const buf  = Buffer.from(body);
    const req  = https.request({
      hostname: 'api.intacct.com',
      path:     '/ia/xml/xmlgw.phtml',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': buf.length,
        'User-Agent':     'ECF-AR-Portal/1.0',
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}`;

const newSagePost = `function sagePost(xml) {
  return new Promise((resolve, reject) => {
    const body = 'xmlrequest=' + encodeURIComponent(xml);
    const buf  = Buffer.from(body);
    const req  = https.request({
      hostname: 'api.intacct.com',
      path:     '/ia/xml/xmlgw.phtml',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': buf.byteLength,
        'User-Agent':     'ECF-AR-Portal/1.0',
        'Connection':     'keep-alive',
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      res.on('end', () => {
        const full = Buffer.concat(chunks).toString('utf8');
        resolve(full);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy(new Error('Sage request timeout'));
    });
    req.write(buf);
    req.end();
  });
}`;

if (src.includes(oldSagePost)) {
  src = src.replace(oldSagePost, newSagePost);
  console.log('sagePost replaced successfully');
} else {
  // Try to find and replace by function signature
  src = src.replace(
    /function sagePost\(xml\) \{[\s\S]*?req\.end\(\);\s*\}\);\s*\}/m,
    newSagePost
  );
  console.log('sagePost replaced by regex');
}

fs.writeFileSync('/home/ecf-admin/ar-portal/sage.js', src);

// Verify
const verify = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');
const hasNew = verify.includes('buf.byteLength');
console.log('Verified byteLength in new version:', hasNew);
