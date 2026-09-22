const payee = require('./payee');
const sage = require('./sage');
const idx = payee.getIndex();
const money = n => '$' + Math.round(n || 0).toLocaleString('en-US');
const amt = s => parseFloat(String(s || '').replace(/[^0-9.-]/g, '')) || 0;

// Everything Amazon holds, grouped by the PO it was billed against.
const byPo = {};
for (const [id, v] of Object.entries(idx)) {
  const po = v.po || '(none)';
  (byPo[po] = byPo[po] || []).push({ id, status: v.status, amount: amt(v.amount), entry: v.entryDate });
}

const open = payee.getOpenPoMap().byPo;
const ZERO = Object.values(open).filter(p => !p.amount || p.amount === 0);
console.log('POs Amazon lists as OPEN with amount 0/"--":', ZERO.length);
let withInvoices = 0, totalBilled = 0;
for (const p of ZERO) {
  const inv = byPo[p.poNumber] || [];
  if (inv.length) { withInvoices++; totalBilled += inv.reduce((t, i) => t + i.amount, 0); }
}
console.log(`  of those, ${withInvoices} ALREADY have invoices accepted in Payee, totalling ${money(totalBilled)}`);

console.log('\n--- the three $0 POs that currently have invoices queued ---');
for (const po of ['2D-20507144', '2D-19504100', '2D-19506287']) {
  const inv = (byPo[po] || []).sort((a, b) => new Date(b.entry) - new Date(a.entry));
  const st = {};
  for (const i of inv) st[i.status] = (st[i.status] || 0) + 1;
  console.log(`\n${po}  — Amazon open-PO amount: ${JSON.stringify((open[po] || {}).poAmountWithCurrency)}`);
  console.log(`  invoices Amazon holds: ${inv.length}, ${money(inv.reduce((t, i) => t + i.amount, 0))}`);
  console.log('  by status:', JSON.stringify(st));
  console.log('  most recent 5:');
  for (const i of inv.slice(0, 5)) console.log(`    ${i.id.padEnd(13)} ${String(i.entry).padEnd(14)} ${money(i.amount).padStart(11)}  ${i.status}`);
}
