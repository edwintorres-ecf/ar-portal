const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const ad = require('/home/ecf-admin/ar-portal/po-placeholder-adopt');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const p = ad.plan(sage.getCachedInvoices());
console.log('WOULD ADOPT (' + p.adopt.length + '):');
for (const a of p.adopt) console.log('   ' + String(a.invoiceId).padEnd(14) + M(a.amount).padStart(11)
  + '  ' + a.site + '  "' + a.from + '"  ->  ' + a.to + '  (' + a.service + ', PO ' + M(a.poValue) + ', avail ' + M(a.poAvailable) + ')');
console.log('\nAMBIGUOUS — needs a human (' + p.ambiguous.length + '):');
for (const a of p.ambiguous) console.log('   ' + String(a.invoiceId).padEnd(14) + M(a.amount).padStart(11) + '  ' + a.site + '  options: ' + a.options.join(', '));
console.log('\nNO REAL PO AT THE SITE YET (' + p.orphan.length + '):');
for (const a of p.orphan) console.log('   ' + String(a.invoiceId).padEnd(14) + M(a.amount).padStart(11) + '  ' + a.site + '  "' + a.from + '"  service=' + a.service);
