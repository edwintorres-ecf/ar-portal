const sage = require('./sage');
const inv = sage.getCachedInvoices();
const hits = inv.filter(i => JSON.stringify(i).includes('534482'));
console.log('invoices referencing 534482:', hits.length);
for (const h of hits) {
  console.log(`  ${h.invoiceId}  cust ${h.customerId}  $${h.totalEntered}  site=${h.siteCode || '(none)'}  due ${h.dueDate || ''}`);
  for (const k of Object.keys(h)) if (String(h[k]).includes('534482')) console.log(`     field ${k} = ${JSON.stringify(h[k])}`);
}
const led = require('./po-ledger').getPoLedger(inv);
const row = led.find(p => String(p.poNumber).includes('534482'));
console.log('\nledger row:', row ? JSON.stringify({ po: row.poNumber, site: row.siteCode, ceiling: row.ceilingAmount, consumed: row.consumed, pending: row.pendingUpload, status: row.poStatus, invoices: row.consumedInvoiceCount }) : 'none');
