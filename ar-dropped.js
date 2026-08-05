'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });

// Directly call queryAllInvoices via sage internal - need to check what's in AR
// that's NOT in our Omnia prefix list
// We'll monkey-patch getInvoices to intercept arInvoices before the filter

const sage = require('/home/ecf-admin/ar-portal/sage');

// We can't directly call queryAllInvoices since it's not exported.
// But getInvoices calls it. Let's check the cached invoices and also
// compare to what Sage says the total is.

// Strategy: getInvoices returns 3236 (Omnia-prefix only from ARINVOICE).
// We need to know if there are non-Omnia-prefix invoices in ARINVOICE.
// Check by looking at the sage.js file's queryAllInvoices output before prefix filter.

// Actually we can modify getInvoices temporarily - but cleaner: 
// look at what RECORDID prefixes exist in ARINVOICE for TOTALDUE > 0 
// by page-fetching and collecting all prefixes

// Use the sage module's exported computeAgingBucket to test it's loaded
console.log('sage loaded ok, computeAgingBucket:', typeof sage.computeAgingBucket);

// Get invoices and then check what's in ARINVOICE raw by fetching with no prefix filter
// We need to access queryAllInvoices - let's check if sage exports it
console.log('sage exports:', Object.keys(sage).join(', '));
process.exit(0);
