'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const sage = require('/home/ecf-admin/ar-portal/sage');

// Access sage internals by requiring and calling through the module
// Use a trick: call queryEciInvoices which is exported

async function run() {
  // queryEciInvoices queries SODOCUMENT with DOCPARID='Sales Invoice' filter
  // Let's see if it returns any ECI- invoices at all
  console.log('Calling queryEciInvoices...');
  const eciOe = await sage.queryEciInvoices();
  console.log('SODOCUMENT ECI results:', eciOe.length);
  if (eciOe.length > 0) {
    console.log('First 3:');
    eciOe.slice(0, 3).forEach(i => console.log(' ', i.invoiceId, 'recordNo:', i.recordNo, 'supdocId:', i.supdocId));
  }

  // Also try fetchEciPdf with the RECORDNO approach (not invoice ID)
  // for one of the ARINVOICE ECI records
  // The ARINVOICE recordNo for ECI-021455 is 172862
  // But SODOCUMENT has its own recordNo — they're different
  // Let's check: does ARINVOICE have a SUPDOCID field?

  process.exit(0);
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
