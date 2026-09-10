const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();

const all = pl.getPoLedger(invs).filter(r => r.siteCode === 'ORH3');
console.log('ORH3 — every PO the ledger knows about:', all.length);
console.log('PO'.padEnd(16), 'service'.padEnd(10), 'ordered'.padEnd(12), 'value'.padStart(12), 'billed'.padStart(12), 'available'.padStart(12), ' status');
let tAll = 0, tSnow = 0, tSeason = 0, tSnowSeason = 0;
const START = Date.parse('2025-07-01'), END = Date.parse('2026-07-01');
for (const r of all.sort((a, b) => (b.available || 0) - (a.available || 0))) {
  const t = Date.parse(String(r.orderDate || r.docDate || ''));
  const inSeason = isNaN(t) ? true : (t >= START && t < END);
  const isSnow = r.serviceType === 'snow';
  tAll += r.available || 0;
  if (isSnow) tSnow += r.available || 0;
  if (inSeason) tSeason += r.available || 0;
  if (isSnow && inSeason) tSnowSeason += r.available || 0;
  console.log(String(r.poNumber).padEnd(16), String(r.serviceType || '-').padEnd(10),
    String(r.orderDate || r.docDate || 'undated').padEnd(12),
    M(r.ceilingAmount).padStart(12), M(r.consumed).padStart(12), M(r.available).padStart(12),
    ' ' + (r.poStatus || '') + (inSeason ? '' : '   <-- NEXT SEASON'));
}
console.log('\nTOTAL available, every PO            :', M(tAll));
console.log('TOTAL available, snow POs only       :', M(tSnow));
console.log('TOTAL available, 2025-26 POs only    :', M(tSeason));
console.log('TOTAL available, snow AND 2025-26    :', M(tSnowSeason));

// What the Pending by Site screen shows.
const pbsAll = pl.getPendingBySite(invs, { snowOnly: false }).find(s => s.site === 'ORH3');
const pbsSnow = pl.getPendingBySite(invs, { snowOnly: true }).find(s => s.site === 'ORH3');
console.log('\nPending by Site (all services):', pbsAll ? M(pbsAll.available) : 'n/a');
console.log('Pending by Site (snow only)   :', pbsSnow ? M(pbsSnow.available) : 'n/a');
