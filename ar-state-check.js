'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });

const sage = require('/home/ecf-admin/ar-portal/sage');

// Get all invoices and check raw state breakdown
// Also check if we're missing any non-Omnia-prefix invoices
sage.getInvoices(true).then(invs => {
  const byPrefix = {};
  const byState = {};
  let eciCount = 0;
  let noPrefix = 0;

  for (const i of invs) {
    const prefix = (i.invoiceId || '').split('-')[0] || '(blank)';
    byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
    const state = i.state || '(blank)';
    byState[state] = (byState[state] || 0) + 1;
    if (/^ECI-/i.test(i.invoiceId || '')) eciCount++;
    if (!i.invoiceId) noPrefix++;
  }

  console.log('TOTAL:', invs.length);
  console.log('ECI- count (should be 0 from ARINVOICE):', eciCount);
  console.log('No invoiceId:', noPrefix);
  console.log('By prefix:', JSON.stringify(byPrefix, null, 2));
  console.log('By state:', JSON.stringify(byState, null, 2));

  // How many are actually in "Posted" vs other states
  const posted = invs.filter(i => i.state === 'Posted' || i.state === 'Open');
  const other = invs.filter(i => i.state !== 'Posted' && i.state !== 'Open');
  console.log('\nPosted/Open count:', posted.length);
  console.log('Other state count:', other.length);
  if (other.length > 0) {
    console.log('Other state samples:', other.slice(0, 5).map(i => ({ id: i.invoiceId, state: i.state, due: i.totalDue })));
  }

  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
