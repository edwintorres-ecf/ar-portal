'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const sage = require('/home/ecf-admin/ar-portal/sage');

async function run() {
  // Test a few ECI- invoices for line items
  let invs = sage.getCachedInvoices();
  if (invs.length === 0) invs = await sage.getInvoices();

  const eci = invs.filter(i => /^ECI-/i.test(i.invoiceId || '')).slice(0, 10);

  for (const inv of eci) {
    try {
      const lines = await sage.getInvoiceLines(inv.invoiceId);
      if (lines.length > 0) {
        console.log('FOUND lines for', inv.invoiceId, ':', lines.length, 'lines');
        console.log('  First:', JSON.stringify(lines[0]).slice(0, 200));
        break;
      } else {
        process.stdout.write(inv.invoiceId + ': 0 lines  ');
      }
    } catch (e) {
      console.log(inv.invoiceId, 'ERROR:', e.message);
    }
  }
  console.log('\nDone');
  process.exit(0);
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
