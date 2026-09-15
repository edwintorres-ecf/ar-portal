const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const nb = require('/home/ecf-admin/ar-portal/amazon-no-bu-report');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();

let t = Date.now();
const rows = sl.buildAmazonRows(invs, { payee }).filter(r => (r.amount || 0) > 0.005);
console.log('buildAmazonRows:', Date.now() - t, 'ms ·', rows.length, 'rows');
t = Date.now(); sl.buildAmazonRows(invs, { payee }); console.log('second call   :', Date.now() - t, 'ms (index memoised)');

console.log('\ninvoices with no site at all now:', rows.filter(r => !r.site).length);
console.log('inherited from their PO          :', rows.filter(r => r.siteFromPo).length);
for (const r of rows.filter(r => r.siteFromPo)) {
  console.log('   ' + String(r.invoiceId).padEnd(14) + M(r.amount).padStart(10) + '  site=' + String(r.site).padEnd(7)
    + ' BU=' + String(r.businessUnit || '(none)').padEnd(12) + ' source=' + r.siteSource + '  PO=' + r.po);
}

const a = nb.analyse(invs, { snowOnly: true });
console.log('\nno-BU report, SNOW : ' + a.totals.sites + ' sites · open AR ' + M(a.totals.openAr)
  + ' · ' + a.totals.invoices + ' invoices · available ' + M(a.totals.poAvailable));
console.log('   ' + a.siteList.map(s => `${s.site} ${M(s.poAvailable)}`).join(' · '));
const b = nb.analyse(invs, { snowOnly: false });
console.log('no-BU report, ALL  : ' + b.totals.sites + ' sites · open AR ' + M(b.totals.openAr)
  + ' · ' + b.totals.invoices + ' invoices · available ' + M(b.totals.poAvailable));
