'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });

// Use getInvoices which runs the full ARINVOICE query + ECI query
const sage = require('/home/ecf-admin/ar-portal/sage');

sage.getInvoices(true).then(invs => {
  const byPrefix = {};
  const byBucket = {};
  const bySource = {};
  let totalDue = 0;

  for (const i of invs) {
    const prefix = (i.invoiceId || '').split('-')[0] || 'unknown';
    byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
    byBucket[i.bucket || 'unknown'] = (byBucket[i.bucket || 'unknown'] || 0) + 1;
    bySource[i.source || 'unknown'] = (bySource[i.source || 'unknown'] || 0) + 1;
    totalDue += i.totalDue || 0;
  }

  // Sort prefixes by count desc
  const sortedPrefixes = Object.entries(byPrefix).sort((a,b) => b[1]-a[1]);

  console.log('\n=== INVOICE COUNT BREAKDOWN ===');
  console.log('TOTAL OPEN INVOICES:', invs.length);
  console.log('TOTAL DUE:          $' + totalDue.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}));
  console.log('\nBy prefix:');
  for (const [p, c] of sortedPrefixes) console.log('  ' + p + ': ' + c);
  console.log('\nBy aging bucket:');
  for (const [b, c] of Object.entries(byBucket)) console.log('  ' + b + ': ' + c);
  console.log('\nBy source:');
  for (const [s, c] of Object.entries(bySource)) console.log('  ' + s + ': ' + c);

  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
