const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const mod = require('/home/ecf-admin/ar-portal/amazon-bu-workbook');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();

// Portal: does Pending by Site now carry the held money per site?
const sites = pl.getPendingBySite(invs, { snowOnly: false });
const master = db.getAmazonLocationMap();
const tot = sites.reduce((t, s) => ({
  pending: t.pending + (s.pending || 0),
  funds: t.funds + (s.fundsHold || 0),
  receipt: t.receipt + (s.goodsReceipt || 0),
}), { pending: 0, funds: 0, receipt: 0 });
console.log('PORTAL — Pending by Site, all sites:');
console.log('  pending (not submitted) :', M(tot.pending));
console.log('  funds hold (needs money):', M(tot.funds));
console.log('  goods receipt (no money):', M(tot.receipt));

console.log('\n  sites where the held money is the bigger problem:');
for (const s of sites.filter(x => (x.fundsHold || 0) + (x.goodsReceipt || 0) > (x.pending || 0) && (x.fundsHold || 0) + (x.goodsReceipt || 0) > 200000)
  .sort((a, b) => ((b.fundsHold || 0) + (b.goodsReceipt || 0)) - ((a.fundsHold || 0) + (a.goodsReceipt || 0))).slice(0, 6)) {
  console.log(`     ${String(s.site).padEnd(7)} pending ${M(s.pending).padStart(12)}  funds hold ${M(s.fundsHold).padStart(12)}  receipt ${M(s.goodsReceipt).padStart(12)}`);
}

// Report: do the two tie?
const a = mod.analyseBu(invs, { bu: 'NACF' });
const nacfSites = sites.filter(s => (master[s.site] || {}).businessUnit === 'NACF');
const portalFunds = nacfSites.reduce((t, s) => t + (s.fundsHold || 0), 0);
const portalReceipt = nacfSites.reduce((t, s) => t + (s.goodsReceipt || 0), 0);
console.log('\nNACF — portal vs report');
console.log('  funds hold   : portal', M(portalFunds), '· report', M(a.stalled.funds.amount));
console.log('  goods receipt: portal', M(portalReceipt), '· report', M(a.stalled.noFundingNeeded.amount));
