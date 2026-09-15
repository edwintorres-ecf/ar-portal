// If an invoice with no site of its own inherited its PO's site/BU, what moves?
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const invs = sage.getCachedInvoices();
const ledger = pl.getPoLedger(invs);
const byPo = {}; for (const p of ledger) byPo[p.poNumber] = p;
const rows = sl.buildAmazonRows(invs, { payee }).filter(r => (r.amount || 0) > 0.005);

const noSite = rows.filter(r => !r.site);
console.log('open Amazon invoices with NO site of their own: ' + noSite.length + ' · ' + M(noSite.reduce((t, r) => t + r.amount, 0)));

let gain = 0, gainAmt = 0, stillNone = 0, stillNoneAmt = 0;
const byBu = {};
for (const r of noSite) {
  const L = byPo[r.po];
  const bu = L && L.businessUnit ? L.businessUnit : '';
  if (bu) {
    gain++; gainAmt += r.amount;
    byBu[bu] = byBu[bu] || { n: 0, a: 0 }; byBu[bu].n++; byBu[bu].a += r.amount;
  } else { stillNone++; stillNoneAmt += r.amount; }
}
console.log('   would inherit a BU from their PO : ' + gain + ' · ' + M(gainAmt));
console.log('   would still have none            : ' + stillNone + ' · ' + M(stillNoneAmt));
console.log('\nwhere they would land:');
for (const [k, v] of Object.entries(byBu).sort((a, b) => b[1].a - a[1].a)) console.log('   ' + k.padEnd(14) + M(v.a).padStart(12) + String(v.n).padStart(4) + ' inv');

console.log('\nthe invoices, with the PO they would inherit from:');
for (const r of noSite.sort((a, b) => b.amount - a.amount).slice(0, 14)) {
  const L = byPo[r.po] || {};
  console.log('   ' + String(r.invoiceId).padEnd(14) + M(r.amount).padStart(10) + '  PO=' + String(r.po || '(none)').padEnd(14)
    + ' -> site ' + String(L.siteCode || '?').padEnd(8) + ' BU ' + String(L.businessUnit || '(none)').padEnd(12) + (r.payeeStatus || 'Not submitted'));
}
