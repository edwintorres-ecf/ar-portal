const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();

// What does Pending by Site call "pending"?
const sites = pl.getPendingBySite(invs, { snowOnly: false });
const master = db.getAmazonLocationMap();
const pendByBu = {};
for (const s of sites) {
  const bu = (master[s.site] || {}).businessUnit || '(none)';
  pendByBu[bu] = (pendByBu[bu] || 0) + (s.pending || 0);
}
const rows = sl.buildAmazonRows(invs, { payee });
const need = {}, pgr = {}, undel = {};
for (const r of rows) {
  const bu = r.businessUnit || '(none)';
  if (r.payeeStatus === 'Pending Goods Receipt Hold') pgr[bu] = (pgr[bu] || 0) + r.amount;
  else if (/Insufficient/.test(r.payeeStatus || '')) need[bu] = (need[bu] || 0) + r.amount;
  else if (!r.payeeStatus && r.amount > 0.005) undel[bu] = (undel[bu] || 0) + r.amount;
}
console.log('BU'.padEnd(12), 'portal "Pending"'.padStart(18), 'cannot deliver'.padStart(16), 'funds hold'.padStart(16), 'goods receipt'.padStart(16));
for (const bu of ['NACF', 'Logistics', 'ATS', 'GSF', 'R2L']) {
  console.log(bu.padEnd(12), M(pendByBu[bu]).padStart(18), M(undel[bu]).padStart(16), M(need[bu]).padStart(16), M(pgr[bu]).padStart(16));
}
console.log('\nDoes the portal’s "Pending" equal "cannot deliver"?',
  Math.abs((pendByBu.NACF||0) - (undel.NACF||0)) < 1000 ? 'yes' : 'NO');
console.log('So the funds-hold and goods-receipt money is NOT in the Pending by Site column at all.');

// Aging tab — does it separate them, and does it say anything about funding?
const aging = pl.getPayeeAging();
console.log('\nAging tab buckets:');
for (const b of aging.buckets) console.log('  ', String(b.count).padStart(4), M(b.amount).padStart(14), b.status, '—', (b.reason || '').slice(0, 70));
