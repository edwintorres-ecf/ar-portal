const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const mod = require('/home/ecf-admin/ar-portal/amazon-bu-workbook');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();
for (const bu of ['NACF', 'Logistics', 'ATS']) {
  const a = mod.analyseBu(invs, { bu });
  const k = a.asks;
  const sum = k.coverage.amount + k.newPo.amount + k.goodsReceipt.amount + k.ourBacklog.amount;
  console.log(`\n=== ${bu} — stalled ${M(a.stalled.total.amount)}`);
  console.log(`   1. additional PO coverage : ${M(k.coverage.amount).padStart(13)}  ${String(k.coverage.count).padStart(4)} inv · ${a.coverageList.length} sites`);
  console.log(`   2. a first PO             : ${M(k.newPo.amount).padStart(13)}  ${String(k.newPo.count).padStart(4)} inv · ${k.newPo.sites.join(', ') || 'none'}`);
  console.log(`   3. goods receipts         : ${M(k.goodsReceipt.amount).padStart(13)}  ${String(k.goodsReceipt.count).padStart(4)} inv`);
  console.log(`   ours to submit            : ${M(k.ourBacklog.amount).padStart(13)}  ${String(k.ourBacklog.count).padStart(4)} inv`);
  console.log(`   of coverage, sat on a placeholder: ${M(k.unassignedAmount)} (${k.unassignedCount} inv)`);
  console.log(`   reconciles: ${Math.abs(sum - a.stalled.total.amount) < 1 ? 'OK' : 'MISMATCH ' + M(sum) + ' vs ' + M(a.stalled.total.amount)}`);
  for (const c of a.coverageList.slice(0, 3)) {
    console.log(`      ${c.site.padEnd(7)} needs ${M(c.amount).padStart(13)} · ${c.poCount} POs issued, ${c.exhaustedCount} used up · committed ${M(c.committed)} · left ${M(c.left)}`);
  }
}
const krb = mod.analyseBu(invs, { bu: 'NACF' }).coverageList.find(c => c.site === 'KRB5');
console.log('\nKRB5 now:', krb ? `${M(krb.amount)} coverage needed · ${krb.poCount} POs issued, ${krb.exhaustedCount} used up` : 'not in the coverage list');
