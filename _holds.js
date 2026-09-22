const payee = require('./payee');
const sage = require('./sage');
const money = n => '$' + Math.round(n || 0).toLocaleString('en-US');
const amt = s => parseFloat(String(s || '').replace(/[^0-9.-]/g, '')) || 0;
const idx = payee.getIndex();
const HOLD = /insufficient po funds/i;
const holdByPo = {};
for (const v of Object.values(idx)) {
  if (!v.po || !HOLD.test(v.status || '')) continue;
  holdByPo[v.po] = holdByPo[v.po] || { n: 0, amt: 0 };
  holdByPo[v.po].n++; holdByPo[v.po].amt += amt(v.amount);
}
console.log('POs with invoices on Insufficient PO Funds Hold:', Object.keys(holdByPo).length);

const nu = require('./po-ledger').getNeedsUpload(sage.getCachedInvoices());
const zero = nu.filter(r => r.poZeroFunds);
const held = nu.filter(r => holdByPo[r.assignedPo]);
console.log('\nNeeds Upload rows:', nu.length);
console.log('  flagged today by poZeroFunds ("⛔ PO $0 funds") :', zero.length, money(zero.reduce((t, r) => t + r.amount, 0)));
console.log('  whose PO actually has invoices ON HOLD          :', held.length, money(held.reduce((t, r) => t + r.amount, 0)));
console.log('\nthe difference — flagged as dead but the PO is NOT holding anything:');
for (const r of zero.filter(r => !holdByPo[r.assignedPo])) {
  const all = Object.values(idx).filter(v => v.po === r.assignedPo);
  const st = {}; for (const v of all) st[v.status] = (st[v.status] || 0) + 1;
  console.log('  ', r.invoiceId.padEnd(12), r.assignedPo.padEnd(14), money(r.amount).padStart(10),
    '| Amazon holds', String(all.length).padStart(2), 'invoices on it:', JSON.stringify(st));
}
