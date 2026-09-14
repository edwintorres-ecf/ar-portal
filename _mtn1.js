// MTN1 shows BOTH available funds and invoices held for insufficient funds.
// If that is real, "the money is at the wrong SITE" is the wrong diagnosis for
// it — the money is at the right site, on the wrong PO.
const db = require('/home/ecf-admin/ar-portal/db'); const d = db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n || 0)).toLocaleString('en-US');
const SITE = process.argv[2] || 'MTN1';

const invs = sage.getCachedInvoices();
const led = pl.getPoLedger(invs);
const rows = sl.buildAmazonRows(invs, { payee }).filter(r => (r.amount || 0) > 0.005);

console.log(`=== ${SITE} — every PO`);
for (const p of led.filter(x => x.siteCode === SITE).sort((a, b) => (b.available || 0) - (a.available || 0))) {
  console.log('   ' + String(p.poNumber).padEnd(14) + String(p.serviceType || '').padEnd(10)
    + 'value ' + M(p.ceilingAmount).padStart(12) + '  billed ' + M(p.consumed).padStart(12)
    + '  AVAILABLE ' + M(p.available).padStart(12) + '  waiting ' + M(p.pendingUpload || 0).padStart(11)
    + '  ' + (p.poStatus || ''));
}
console.log(`\n=== ${SITE} — open invoices by status and PO`);
const mine = rows.filter(r => r.site === SITE);
const byStatus = {};
for (const r of mine) {
  const st = r.payeeStatus || 'Not submitted';
  byStatus[st] = byStatus[st] || { n: 0, a: 0, pos: {} };
  byStatus[st].n++; byStatus[st].a += r.amount;
  byStatus[st].pos[r.po || '(none)'] = (byStatus[st].pos[r.po || '(none)'] || 0) + r.amount;
}
for (const [st, v] of Object.entries(byStatus).sort((a, b) => b[1].a - a[1].a)) {
  console.log('   ' + st.padEnd(30) + M(v.a).padStart(12) + String(v.n).padStart(4) + ' inv');
  for (const [po, amt] of Object.entries(v.pos).sort((a, b) => b[1] - a[1])) {
    const L = led.find(x => x.poNumber === po);
    console.log('        on ' + String(po).padEnd(14) + M(amt).padStart(12) + '   that PO has ' + M(L ? L.available : 0) + ' left');
  }
}
