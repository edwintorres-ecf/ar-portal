// Where exactly do the two disagree on NACF's funds hold?
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();
const master = db.getAmazonLocationMap();

// Report side
const rows = sl.buildAmazonRows(invs, { payee })
  .filter(r => r.businessUnit === 'NACF' && /Insufficient/.test(r.payeeStatus || ''));
console.log('report: ', rows.length, 'invoices', M(rows.reduce((t, r) => t + r.amount, 0)));

// Portal side
const sites = pl.getPendingBySite(invs, { snowOnly: false });
const nacf = sites.filter(s => (master[s.site] || {}).businessUnit === 'NACF');
console.log('portal: ', M(nacf.reduce((t, s) => t + (s.fundsHold || 0), 0)),
  'across', nacf.filter(s => s.fundsHold > 0).length, 'sites');

// Per-site compare
const rBySite = {};
for (const r of rows) rBySite[r.site || '(no site)'] = (rBySite[r.site || '(no site)'] || 0) + r.amount;
const pBySite = {};
for (const s of sites) if (s.fundsHold > 0) pBySite[s.site] = s.fundsHold;
// Compare only sites that belong to NACF on BOTH sides.
const all = new Set([...Object.keys(rBySite), ...Object.keys(pBySite)]
  .filter(site => ((master[site] || {}).businessUnit || '') === 'NACF'));
let diffTotal = 0;
for (const site of [...all].sort()) {
  const r = rBySite[site] || 0, p = pBySite[site] || 0;
  if (Math.abs(r - p) < 1) continue;
  diffTotal += (r - p);
  console.log(`  ${String(site).padEnd(10)} report ${M(r).padStart(13)}  portal ${M(p).padStart(13)}  diff ${M(r - p).padStart(13)}`);
}
console.log('  net difference across NACF sites:', M(diffTotal));
// Invoices the report counts whose site has NO business unit in the master.
const orphan = rows.filter(r => !r.site || !(master[r.site] || {}).businessUnit);
console.log('  report invoices with a site that has no BU:', orphan.length, M(orphan.reduce((t, r) => t + r.amount, 0)));
