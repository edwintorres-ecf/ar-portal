const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const ih = require('/home/ecf-admin/ar-portal/po-intake-health');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();
const a = ih.analyse(invs);
const t = a.totals;
console.log('POs checked ' + t.posChecked + ' · clean ' + t.clean + ' · with defects ' + t.posWithDefects
  + ' · BLOCKING ' + t.blocking + ' · ready ' + t.readyPct + '%');
console.log('money waiting behind a defective PO: ' + M(t.atRisk) + '\n');
for (const c of a.checks) {
  if (!c.count) continue;
  console.log('   ' + (c.blocking ? 'BLOCK ' : '      ') + c.label.padEnd(36) + String(c.count).padStart(4) + ' POs   at risk ' + M(c.atRisk).padStart(12));
}
console.log('\nworst POs:');
for (const p of a.pos.slice(0, 10)) {
  console.log('   ' + p.poNumber.padEnd(14) + String(p.siteCode || '?').padEnd(8) + String(p.serviceType || '').padEnd(11)
    + 'waiting ' + M(p.atRisk).padStart(12) + '  ' + p.defects.join(', '));
}
const sw = ih.sweep(invs);
console.log('\nsweep: ' + sw.newly.length + ' newly defective · ' + sw.resolved.length + ' resolved');
const sw2 = ih.sweep(invs);
console.log('second sweep (should be 0 new): ' + sw2.newly.length + ' newly · ' + sw2.resolved.length + ' resolved');
