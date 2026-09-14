// Everything Amazon that has no business unit. This is a data-hygiene report,
// not an Amazon-facing one, so it is NOT snow-filtered by default: a site
// missing from the master is missing for landscaping too.
const db = require('/home/ecf-admin/ar-portal/db'); const d = db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const invs = sage.getCachedInvoices();
const led = pl.getPoLedger(invs);
const rows = sl.buildAmazonRows(invs, { payee }).filter(r => (r.amount || 0) > 0.005);

const noBuRows = rows.filter(r => !(r.businessUnit || '').trim());
console.log('OPEN INVOICES with no business unit: ' + noBuRows.length + ' · ' + M(noBuRows.reduce((t, r) => t + r.amount, 0)));
const bySite = {};
for (const r of noBuRows) {
  const k = r.site || '(no site code)';
  bySite[k] = bySite[k] || { n: 0, a: 0, pos: new Set(), statuses: {} };
  bySite[k].n++; bySite[k].a += r.amount; if (r.po) bySite[k].pos.add(r.po);
  const st = r.payeeStatus || 'Not submitted';
  bySite[k].statuses[st] = (bySite[k].statuses[st] || 0) + 1;
}
console.log('\nby site:');
for (const [k, v] of Object.entries(bySite).sort((a, b) => b[1].a - a[1].a)) {
  console.log('   ' + String(k).padEnd(14) + M(v.a).padStart(12) + String(v.n).padStart(4) + ' inv  ' + v.pos.size + ' PO(s)  ' + JSON.stringify(v.statuses));
}

const noBuPos = led.filter(p => !(p.businessUnit || '').trim());
console.log('\nPOs with no business unit: ' + noBuPos.length + ' · value ' + M(noBuPos.reduce((t, p) => t + (p.ceilingAmount || 0), 0))
  + ' · available ' + M(noBuPos.reduce((t, p) => t + (p.available || 0), 0)));
for (const p of noBuPos.sort((a, b) => (b.available || 0) - (a.available || 0)).slice(0, 15)) {
  console.log('   ' + String(p.poNumber).padEnd(14) + String(p.siteCode || '(none)').padEnd(10) + (p.serviceType || '').padEnd(12)
    + M(p.ceilingAmount).padStart(12) + ' left ' + M(p.available).padStart(11) + '  ' + (p.poStatus || ''));
}

// Are these sites simply absent from the master, or present with a blank BU?
const master = db.getAmazonLocationMap();
console.log('\nsite -> master lookup:');
for (const k of Object.keys(bySite)) {
  const m = master[k];
  console.log('   ' + String(k).padEnd(14) + (m ? 'IN MASTER, business_unit="' + (m.business_unit || '') + '"' : 'NOT IN MASTER'));
}
