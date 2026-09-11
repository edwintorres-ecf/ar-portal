const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const rows = sl.buildAmazonRows(sage.getCachedInvoices(), { payee });
const byBu = {};
for (const r of rows) {
  const bu = r.businessUnit || '(none)';
  const b = byBu[bu] = byBu[bu] || { pgr: 0, pgrN: 0, funds: 0, fundsN: 0, undel: 0, undelN: 0 };
  if (r.payeeStatus === 'Pending Goods Receipt Hold') { b.pgr += r.amount; b.pgrN++; }
  else if (r.payeeStatus === 'Insufficient PO Funds Hold' || r.payeeStatus === 'Insufficient Amazon PO Manager Hold') { b.funds += r.amount; b.fundsN++; }
  else if (!r.payeeStatus && r.amount > 0.005) { b.undel += r.amount; b.undelN++; }
}
console.log('BU'.padEnd(12), 'PGR (no funds needed)'.padStart(24), 'Funds hold'.padStart(18), 'Cannot deliver'.padStart(18), 'NEEDS FUNDING'.padStart(18));
let tp=0,tf=0,tu=0;
for (const [bu, b] of Object.entries(byBu).sort((x,y)=>(y[1].funds+y[1].undel)-(x[1].funds+x[1].undel))) {
  tp+=b.pgr; tf+=b.funds; tu+=b.undel;
  console.log(bu.padEnd(12), (M(b.pgr)+' ('+b.pgrN+')').padStart(24), M(b.funds).padStart(18), M(b.undel).padStart(18), M(b.funds+b.undel).padStart(18));
}
console.log('TOTAL'.padEnd(12), M(tp).padStart(24), M(tf).padStart(18), M(tu).padStart(18), M(tf+tu).padStart(18));
console.log('\nStalled overall:', M(tp+tf+tu), '· of which requiring NO additional funds (goods receipt only):', M(tp));
