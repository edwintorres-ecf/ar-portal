// Does Sage expose a parent/child relationship on CUSTOMER?
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const https = require('https');
const sage = require('/home/ecf-admin/ar-portal/sage');
const cfg = sage.getSageConfig();
function xml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<request><control><senderid>${cfg.senderId}</senderid><password>${cfg.senderPassword}</password><controlid>p-${Date.now()}</controlid><uniqueid>false</uniqueid><dtdversion>3.0</dtdversion><includewhitespace>false</includewhitespace></control>
<operation><authentication><login><userid>${cfg.userId}</userid><companyid>${cfg.companyId}</companyid><password>${cfg.userPassword}</password><locationid>${sage.SAGE_ENTITY}</locationid></login></authentication>
<content><function controlid="f1">${body}</function></content></operation></request>`;
}
function post(x) { return new Promise((res, rej) => {
  const b = 'xmlrequest=' + encodeURIComponent(x);
  const r = https.request({ hostname: 'api.intacct.com', path: '/ia/xml/xmlgw.phtml', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b) } },
    s => { let d = ''; s.on('data', c => d += c); s.on('end', () => res(d)); });
  r.on('error', rej); r.write(b); r.end();
}); }
(async () => {
  // PARENTID / PARENTNAME are the standard Intacct fields for the hierarchy.
  const q = `<query><object>CUSTOMER</object>
    <select><field>CUSTOMERID</field><field>NAME</field><field>PARENTID</field><field>PARENTNAME</field><field>STATUS</field></select>
    <filter><isnotnull><field>PARENTID</field></isnotnull></filter>
    <pagesize>60</pagesize></query>`;
  const r = await post(xml(q));
  if (/<status>failure<\/status>/.test(r)) {
    console.log('query failed:', (r.match(/<description2>([\s\S]*?)<\/description2>/) || [])[1]);
    return;
  }
  const total = (r.match(/totalcount="(\d+)"/) || [])[1];
  console.log('customers WITH a parent:', total);
  let n = 0;
  for (const m of r.matchAll(/<CUSTOMER>([\s\S]*?)<\/CUSTOMER>/g)) {
    const g = (t) => (m[1].match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>')) || [])[1] || '';
    if (n++ < 18) console.log('   ' + g('CUSTOMERID').padEnd(10) + g('NAME').slice(0, 34).padEnd(36)
      + ' parent=' + g('PARENTID').padEnd(10) + g('PARENTNAME').slice(0, 30));
  }
})().catch(e => console.log('ERR', e.message));
