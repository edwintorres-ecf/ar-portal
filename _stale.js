// MTN1: $89,653 held for "Insufficient PO Funds" on a PO that Amazon's OWN
// detail page says has $92,506 available. The funds are there, on the right PO,
// at the right site — the hold was simply never released.
//
// If that is widespread, part of what we are asking Amazon to FUND is already
// funded, and the real ask is "re-drive these, don't pay them again".
const db = require('/home/ecf-admin/ar-portal/db'); const d = db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n || 0)).toLocaleString('en-US');

const invs = sage.getCachedInvoices();
const led = pl.getPoLedger(invs);
const byPo = {}; for (const p of led) byPo[p.poNumber] = p;
const rows = sl.buildAmazonRows(invs, { payee }).filter(r => (r.amount || 0) > 0.005);
const held = rows.filter(r => /Insufficient/.test(r.payeeStatus || ''));

// Group the held invoices by PO and compare with what that PO says it has left.
const g = {};
for (const r of held) {
  const k = r.po || '(none)';
  g[k] = g[k] || { amt: 0, n: 0, site: r.site, bu: r.businessUnit };
  g[k].amt += r.amount; g[k].n++;
}
let coveredAmt = 0, coveredN = 0, coveredPos = 0;
let shortAmt = 0, shortN = 0, shortPos = 0;
const covered = [];
for (const [po, v] of Object.entries(g)) {
  const L = byPo[po];
  const avail = L && L.available != null ? L.available : 0;
  if (avail >= v.amt - 0.5) {
    coveredAmt += v.amt; coveredN += v.n; coveredPos++;
    covered.push({ po, ...v, avail, value: L ? L.ceilingAmount : null, svc: L ? L.serviceType : '' });
  } else {
    shortAmt += Math.max(0, v.amt - Math.max(0, avail)); shortN += v.n; shortPos++;
  }
}
console.log('INSUFFICIENT PO FUNDS HOLD — ' + held.length + ' invoices · ' + M(held.reduce((t, r) => t + r.amount, 0)));
console.log('');
console.log('  the PO ALREADY has enough to cover them : ' + M(coveredAmt).padStart(13) + '  ' + coveredN + ' invoices on ' + coveredPos + ' POs');
console.log('  genuinely needs more PO funding         : ' + M(shortAmt).padStart(13) + '  ' + shortN + ' invoices on ' + shortPos + ' POs');
console.log('');
console.log('POs holding invoices they can already pay for:');
covered.sort((a, b) => b.amt - a.amt);
for (const c of covered.slice(0, 15)) {
  console.log('   ' + c.po.padEnd(14) + String(c.site || '?').padEnd(7) + String(c.bu || '').padEnd(11)
    + 'held ' + M(c.amt).padStart(12) + '  PO has ' + M(c.avail).padStart(12) + ' of ' + M(c.value).padStart(12) + '  ' + (c.svc || ''));
}
