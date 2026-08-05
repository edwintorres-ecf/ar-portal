'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const sage = require('/home/ecf-admin/ar-portal/sage');

async function run() {
  // Use cached invoices from running portal
  let invs = sage.getCachedInvoices();
  if (invs.length === 0) {
    console.log('No cache, fetching...');
    invs = await sage.getInvoices();
  }

  const eci = invs.filter(i => /^ECI-/i.test(i.invoiceId || '')).slice(0, 10);
  console.log('ECI- count in cache:', invs.filter(i => /^ECI-/i.test(i.invoiceId || '')).length);

  // Test several invoices to find one with a SUPDOC
  for (const inv of eci) {
    process.stdout.write('Testing ' + inv.invoiceId + ' (recordNo: ' + inv.recordNo + ')... ');
    const result = await sage.fetchEciPdf(inv.invoiceId);
    if (result.ok) {
      console.log('PDF FOUND! size:', result.buffer.length, 'bytes');
      require('fs').writeFileSync('/tmp/test-eci-output.pdf', result.buffer);
      console.log('Saved to /tmp/test-eci-output.pdf');
      break;
    } else {
      console.log('no PDF:', result.error);
    }
  }
  process.exit(0);
}
run().catch(e => { console.error('ERROR:', e.message, e.stack); process.exit(1); });
