const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const BU = process.argv[2] || 'NACF';

const invs = sage.getCachedInvoices();
const rows = sl.buildAmazonRows(invs, { payee }).filter(r => r.businessUnit === BU);
const byStatus = {};
for (const r of rows) {
  const k = r.payeeStatus || '(not submitted)';
  byStatus[k] = byStatus[k] || { n: 0, amt: 0 };
  byStatus[k].n++; byStatus[k].amt += r.amount || 0;
}
console.log(BU, '— open invoices by Payee status');
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1].amt - a[1].amt)) {
  console.log('  ', String(v.n).padStart(5), M(v.amt).padStart(13), k);
}
const g = (k) => byStatus[k] || { n: 0, amt: 0 };
const pgr = g('Pending Goods Receipt Hold');
const ipf = g('Insufficient PO Funds Hold');
const notSub = g('(not submitted)');
console.log('\nSTALLED BILLING');
console.log('  Pending Goods Receipt Hold ', String(pgr.n).padStart(4), M(pgr.amt).padStart(13));
console.log('  Insufficient PO Funds Hold ', String(ipf.n).padStart(4), M(ipf.amt).padStart(13));
console.log('  Cannot be delivered        ', String(notSub.n).padStart(4), M(notSub.amt).padStart(13));
console.log('  TOTAL                      ', String(pgr.n + ipf.n + notSub.n).padStart(4), M(pgr.amt + ipf.amt + notSub.amt).padStart(13));

// Excess funding available in this BU, this season only.
const ledger = pl.getPoLedger(invs).filter(r => r.serviceType === 'snow' && r.businessUnit === BU);
const START = Date.parse('2025-07-01'), END = Date.parse('2026-07-01');
const inSeason = (r) => { const t = Date.parse(String(r.orderDate || r.docDate || '')); return isNaN(t) ? true : (t >= START && t < END); };
const seasonPos = ledger.filter(inSeason);
const avail = seasonPos.reduce((t, r) => t + Math.max(0, r.available || 0), 0);
console.log('\n  Excess funding available (25-26 snow POs):', M(avail), 'across', seasonPos.length, 'POs');
console.log('  Variance still needed:', M((pgr.amt + ipf.amt + notSub.amt) - avail));
