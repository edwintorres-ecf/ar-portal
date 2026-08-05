'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const sage = require('/home/ecf-admin/ar-portal/sage');
const { generateEciPdf } = require('/home/ecf-admin/ar-portal/eci-pdf-gen');
const fs = require('fs');

async function run() {
  let invs = sage.getCachedInvoices();
  if (invs.length === 0) invs = await sage.getInvoices();

  const eci = invs.filter(i => /^ECI-/i.test(i.invoiceId || ''));
  console.log('ECI- count:', eci.length);

  // Pick a test invoice
  const testInv = eci[0];
  console.log('Testing:', testInv.invoiceId, 'recordNo:', testInv.recordNo);

  // Fetch lines
  console.log('Fetching lines...');
  let lines = [];
  try {
    lines = await sage.getInvoiceLines(testInv.invoiceId);
    console.log('Lines found:', lines.length);
    if (lines.length > 0) console.log('First line:', JSON.stringify(lines[0]));
  } catch (e) {
    console.warn('Line fetch failed:', e.message, '— will generate with header data only');
  }

  // Generate PDF
  console.log('Generating PDF...');
  const buf = await generateEciPdf(testInv, lines);
  console.log('PDF generated:', buf.length, 'bytes');

  fs.writeFileSync('/tmp/eci-test-output.pdf', buf);
  console.log('Saved to /tmp/eci-test-output.pdf');
  process.exit(0);
}
run().catch(e => { console.error('ERROR:', e.message, e.stack); process.exit(1); });
