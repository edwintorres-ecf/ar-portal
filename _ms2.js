const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const led = pl.getPoLedger(sage.getCachedInvoices());
const byPo = {}; for (const p of led) byPo[p.poNumber] = p;

console.log('2D-20105615 ->', JSON.stringify({ site: byPo['2D-20105615'].siteCode, lineSites: byPo['2D-20105615'].lineSites, multi: byPo['2D-20105615'].multiSite }));
console.log('2D-19170693 ->', JSON.stringify({ site: byPo['2D-19170693'].siteCode, lineSites: byPo['2D-19170693'].lineSites }));
console.log('2D-21907390 ->', JSON.stringify({ site: byPo['2D-21907390'].siteCode, lineSites: byPo['2D-21907390'].lineSites }));
console.log('2D-21976622 ->', JSON.stringify({ site: byPo['2D-21976622'].siteCode, lineSites: byPo['2D-21976622'].lineSites }));

const multi = led.filter(p => p.multiSite);
const snowMulti = multi.filter(p => p.serviceType === 'snow');
console.log('\nMULTI-SITE POs (from the PO document): ' + multi.length + ' total · ' + snowMulti.length + ' snow · ' + M(multi.reduce((t, p) => t + (p.ceilingAmount || 0), 0)));
for (const p of multi.sort((a, b) => (b.ceilingAmount || 0) - (a.ceilingAmount || 0)).slice(0, 15)) {
  console.log('   ' + p.poNumber.padEnd(14) + String(p.lineSites.length).padStart(2) + ' sites  '
    + p.lineSites.join(' ').padEnd(28) + M(p.ceilingAmount).padStart(12) + '  left ' + M(p.available).padStart(11)
    + '  ' + (p.serviceType || '') + '  shipto=' + (p.docSiteCode || '?'));
}
