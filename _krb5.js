const db = require('/home/ecf-admin/ar-portal/db'); const d = db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();
const led = pl.getPoLedger(invs);

console.log('=== every PO at KRB5 ===');
for (const p of led.filter(x => x.siteCode === 'KRB5').sort((a, b) => (b.available || 0) - (a.available || 0))) {
  console.log('   ' + String(p.poNumber).padEnd(16) + String(p.serviceType || '').padEnd(10)
    + 'value ' + M(p.ceilingAmount).padStart(12) + '  billed ' + M(p.consumed).padStart(12)
    + '  AVAIL ' + M(p.available).padStart(12) + '  waiting ' + M(p.pendingUpload || 0).padStart(11)
    + '  ' + (p.poStatus || '') + (p.docDate ? '  doc ' + p.docDate : ''));
}

console.log('\n=== invoices sitting on the placeholder ===');
const rows = sl.buildAmazonRows(invs, { payee }).filter(r => /needed/i.test(String(r.po || '')));
for (const r of rows) {
  console.log('   ' + String(r.invoiceId).padEnd(14) + M(r.amount).padStart(11) + '  site=' + String(r.site || '?').padEnd(7)
    + ' po="' + r.po + '"  ' + (r.payeeStatus || 'Not submitted') + (r.poAssigned ? '  [manually assigned]' : ''));
}

console.log('\n=== all placeholder POs in the ledger ===');
for (const p of led.filter(x => /needed|tbd|pending|n\/a/i.test(String(x.poNumber)))) {
  console.log('   "' + p.poNumber + '"  site=' + (p.siteCode || '?') + '  waiting ' + M(p.pendingUpload || 0));
}
console.log('\nassignment mechanism: db.getAllPoAssignments ->', typeof db.getAllPoAssignments);
