'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const sage = require('/home/ecf-admin/ar-portal/sage');

async function run() {
  // Get a sample ECI- invoice from cache
  const invs = sage.getCachedInvoices();
  const eci = invs.filter(i => /^ECI-/i.test(i.invoiceId || '')).slice(0, 5);

  if (eci.length === 0) {
    console.log('No ECI- invoices in cache yet — waiting for cache...');
    await sage.getInvoices();
    return run();
  }

  console.log('Sample ECI- invoices:');
  for (const i of eci) {
    console.log(' ', i.invoiceId, 'recordNo:', i.recordNo, 'source:', i.source, 'supdocId:', i.supdocId || '(none)');
  }

  // Test PDF fetch on the first one
  const testInv = eci[0];
  console.log('\nTesting fetchEciPdf for:', testInv.invoiceId);
  const result = await sage.fetchEciPdf(testInv.invoiceId);
  console.log('Result:', { ok: result.ok, error: result.error, bufferLen: result.buffer ? result.buffer.length : 0, mimeType: result.mimeType });

  process.exit(0);
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
