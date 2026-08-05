'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const sage = require('/home/ecf-admin/ar-portal/sage');

async function run() {
  let invs = sage.getCachedInvoices();
  if (invs.length === 0) invs = await sage.getInvoices();

  const eci = invs.filter(i => /^ECI-/i.test(i.invoiceId || ''));
  console.log('ECI- total:', eci.length);

  const withSupdoc = eci.filter(i => i.supdocId && i.supdocId.trim());
  const withoutSupdoc = eci.filter(i => !i.supdocId || !i.supdocId.trim());
  console.log('ECI- with supdocId:', withSupdoc.length);
  console.log('ECI- without supdocId:', withoutSupdoc.length);

  if (withSupdoc.length > 0) {
    console.log('\nSample with supdocId:');
    withSupdoc.slice(0, 3).forEach(i => console.log(' ', i.invoiceId, 'supdocId:', i.supdocId));

    // Test fetching a PDF
    const testInv = withSupdoc[0];
    console.log('\nFetching PDF for:', testInv.invoiceId, 'supdocId:', testInv.supdocId);
    const result = await sage.fetchEciPdf(testInv.invoiceId, testInv.supdocId);
    console.log('Result:', { ok: result.ok, error: result.error, bufferLen: result.buffer ? result.buffer.length : 0 });
    if (result.ok && result.buffer) {
      require('fs').writeFileSync('/tmp/test-eci-out.pdf', result.buffer);
      console.log('Saved /tmp/test-eci-out.pdf');
    }
  } else {
    console.log('\nNo ECI- invoices have supdocId — testing ARINVOICE lookup for first 3...');
    for (const inv of eci.slice(0, 3)) {
      const result = await sage.fetchEciPdf(inv.invoiceId, '');
      console.log(inv.invoiceId, '->', result.ok ? 'PDF found (' + result.buffer.length + ' bytes)' : 'no PDF: ' + result.error);
    }
  }
  process.exit(0);
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
