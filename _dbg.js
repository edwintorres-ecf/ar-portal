require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const https = require('https');
const sage = require('/home/ecf-admin/ar-portal/sage');
const cfg = sage.getSageConfig();
const xml = (b) => `<?xml version="1.0" encoding="UTF-8"?>
<request><control><senderid>${cfg.senderId}</senderid><password>${cfg.senderPassword}</password><controlid>d-${Date.now()}</controlid><uniqueid>false</uniqueid><dtdversion>3.0</dtdversion><includewhitespace>false</includewhitespace></control>
<operation><authentication><login><userid>${cfg.userId}</userid><companyid>${cfg.companyId}</companyid><password>${cfg.userPassword}</password><locationid>${sage.SAGE_ENTITY}</locationid></login></authentication>
<content><function controlid="f1">${b}</function></content></operation></request>`;
const post = (x) => new Promise((res, rej) => {
  const b = 'xmlrequest=' + encodeURIComponent(x);
  const r = https.request({ hostname: 'api.intacct.com', path: '/ia/xml/xmlgw.phtml', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b) } },
    s => { let d = ''; s.on('data', c => d += c); s.on('end', () => res(d)); });
  r.on('error', rej); r.write(b); r.end();
});
(async () => {
  const legacy = await post(xml(`<readByQuery><object>CUSTOMER</object><fields>CUSTOMERID,NAME,STATUS,PARENTID,PARENTNAME</fields><query>STATUS = 'active'</query><pagesize>3</pagesize></readByQuery>`));
  console.log('LEGACY readByQuery:', /<status>failure<\/status>/.test(legacy)
    ? 'FAILED -> ' + (legacy.match(/<description2>([\s\S]*?)<\/description2>/) || [])[1]
    : 'ok, rows=' + [...legacy.matchAll(/<customer>/gi)].length);
  const modern = await post(xml(`<query><object>CUSTOMER</object><select><field>CUSTOMERID</field><field>NAME</field><field>PARENTID</field><field>PARENTNAME</field></select><filter><equalto><field>STATUS</field><value>active</value></equalto></filter><pagesize>3</pagesize></query>`));
  console.log('MODERN query    :', /<status>failure<\/status>/.test(modern)
    ? 'FAILED -> ' + (modern.match(/<description2>([\s\S]*?)<\/description2>/) || [])[1]
    : 'ok, total=' + (modern.match(/totalcount="(\d+)"/) || [])[1]);
  console.log(modern.slice(modern.indexOf('<CUSTOMER>'), modern.indexOf('<CUSTOMER>') + 300));
})().catch(e => console.log('ERR', e.message));
