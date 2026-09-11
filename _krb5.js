const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();

const rows = sl.buildAmazonRows(invs, { payee }).filter(r => r.site === 'KRB5');
console.log('KRB5 open invoices:', rows.length, M(rows.reduce((t, r) => t + r.amount, 0)));
const assigns = db.getAllPoAssignments();
for (const r of rows.sort((a, b) => b.amount - a.amount).slice(0, 12)) {
  const a = assigns[r.recordNo];
  console.log(`  ${String(r.invoiceId).padEnd(13)} ${M(r.amount).padStart(12)}  po=${String(r.po || '(none)').padEnd(16)}`
    + ` assigned=${a ? a.assigned_po : '-'}  status=${r.payeeStatus || '(not submitted)'}`);
}
console.log('\nKRB5 POs in the ledger:');
for (const p of pl.getPoLedger(invs).filter(p => p.siteCode === 'KRB5').sort((a, b) => (b.ceilingAmount || 0) - (a.ceilingAmount || 0))) {
  console.log(`  ${p.poNumber.padEnd(16)} ordered ${String(p.orderDate || p.docDate || '?').padEnd(14)} value ${M(p.ceilingAmount).padStart(12)} billed ${M(p.consumed).padStart(12)} left ${M(p.available).padStart(12)}  ${p.poStatus || ''}`);
}
