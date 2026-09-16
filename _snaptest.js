const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const snap = require('/home/ecf-admin/ar-portal/ar-snapshot');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const t = Date.now();
const s = snap.take(sage.getCachedInvoices(), { sage });
console.log('captured in ' + (Date.now() - t) + 'ms for ' + s.day);
console.log('   open AR        ' + M(s.open_ar).padStart(14) + '   ' + s.open_ar_count + ' invoices');
console.log('   snow AR        ' + M(s.snow_ar).padStart(14) + '   ' + s.snow_ar_count + ' invoices');
console.log('   POs            ' + String(s.pos_total).padStart(14) + '   ' + s.pos_snow + ' snow');
console.log('   PO available   ' + M(s.po_available).padStart(14) + '   overdrawn ' + M(s.po_overdrawn));
console.log('   intake blocking' + String(s.intake_blocking).padStart(14) + '   at risk ' + M(s.intake_at_risk));
console.log('   no-BU sites    ' + String(s.no_bu_sites).padStart(14) + '   available ' + M(s.no_bu_available));
const d = JSON.parse(s.detail);
console.log('   by status      ' + Object.entries(d.byStatus).sort((a,b)=>b[1].amount-a[1].amount).map(([k,v])=>k+' '+M(v.amount)).join(' · ').slice(0,150));
console.log('   unblock        ' + JSON.stringify(d.unblock));
// idempotent?
snap.take(sage.getCachedInvoices(), { sage });
const h = snap.history(10);
console.log('\nhistory rows: ' + h.length + ' (re-running must NOT create a second row for today)');
for (const r of h) console.log('   ' + r.day + '  open AR ' + M(r.open_ar).padStart(13)
  + (Object.keys(r.delta).length ? '   Δ ' + M(r.delta.open_ar) : '   (first)'));
