const sage = require('./sage');
(async () => {
  const inv = sage.getCachedInvoices().length ? sage.getCachedInvoices() : await sage.getInvoices();
  const led = require('./po-ledger').getPoLedger(inv);
  const byPo = {};
  for (const r of led) byPo[r.poNumber] = r;
  const nu = require('./po-ledger').getNeedsUpload(inv);
  const c = {}; let amt = {};
  for (const i of nu) {
    const r = byPo[i.assignedPo];
    const k = r ? (r.serviceType || 'unknown') : 'PO not in ledger';
    c[k] = (c[k] || 0) + 1;
    amt[k] = (amt[k] || 0) + (i.amount || 0);
  }
  console.log('Needs Upload rows:', nu.length);
  for (const [k, v] of Object.entries(c).sort((a, b) => b[1] - a[1]))
    console.log('  ', k.padEnd(18), String(v).padStart(4), '$' + Math.round(amt[k]).toLocaleString('en-US'));
  const review = nu.filter(i => byPo[i.assignedPo] && byPo[i.assignedPo].needsServiceReview).length;
  console.log('flagged needsServiceReview:', review);
})();
