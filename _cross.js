// A PO issued for ONE site that carries invoices from ANOTHER site is not a
// multi-site PO — it is work billed against the wrong PO. Measure it.
const db = require('/home/ecf-admin/ar-portal/db'); const d = db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const invs = sage.getCachedInvoices();
const led = pl.getPoLedger(invs);
const byPo = {}; for (const p of led) byPo[p.poNumber] = p;
const rows = sl.buildAmazonRows(invs, { payee });

console.log('=== 2D-21976622 rows not at DOB4 ===');
for (const r of rows.filter(x => x.po === '2D-21976622' && x.site !== 'DOB4')) {
  console.log('   ' + String(r.invoiceId).padEnd(13) + String(r.site).padEnd(7) + M(r.amount).padStart(11) + '  ' + (r.payeeStatus || 'not submitted'));
}

// Across every snow PO: value billed from a site OTHER than the PO's own site.
const off = [];
for (const p of led) {
  if (p.serviceType !== 'snow' || !p.siteCode) continue;
  const mine = rows.filter(r => r.po === p.poNumber && r.site && r.site !== p.siteCode);
  if (!mine.length) continue;
  const amt = mine.reduce((t, r) => t + (r.amount || 0), 0);
  const sites = [...new Set(mine.map(r => r.site))];
  off.push({ po: p.poNumber, poSite: p.siteCode, bu: p.businessUnit, amt, n: mine.length, sites, value: p.ceilingAmount });
}
off.sort((a, b) => b.amt - a.amt);
console.log('\n=== snow POs carrying invoices from a DIFFERENT site than the PO ===');
console.log('   ' + off.length + ' POs · ' + M(off.reduce((t, x) => t + x.amt, 0)) + ' · ' + off.reduce((t, x) => t + x.n, 0) + ' invoices');
for (const o of off.slice(0, 12)) {
  console.log('   ' + o.po.padEnd(14) + ('PO=' + o.poSite).padEnd(10) + String(o.bu || '-').padEnd(11)
    + M(o.amt).padStart(12) + '  ' + o.n + ' inv from ' + o.sites.join(',').slice(0, 30));
}
