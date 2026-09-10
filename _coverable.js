// Does "coverable within BU" mean what a reader thinks it means?
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const mod = require('/home/ecf-admin/ar-portal/amazon-funds-report');

const sites = pl.getPendingBySite(sage.getCachedInvoices(), { snowOnly: true });
const cur = mod.analyse(sage.getCachedInvoices(), { snowOnly: true });
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const byBu = {};
for (const s of sites) {
  const bu = s.businessUnit || '(not in master)';
  const b = byBu[bu] = byBu[bu] || { bu, n: 0, pending: 0, available: 0, shortfall: 0, surplus: 0, negCount: 0, negAvail: 0 };
  const p = s.pending || 0, a = s.available || 0;
  b.n++; b.pending += p; b.available += a;
  b.shortfall += Math.max(0, p - a);
  b.surplus += Math.max(0, a - p);
  if (a < 0) { b.negCount++; b.negAvail += a; }
}

console.log('BU'.padEnd(16), 'sites'.padStart(6), 'pending'.padStart(13), 'available'.padStart(13),
  'shortfall'.padStart(13), 'surplus'.padStart(13), 'min()'.padStart(13), 'SHIPPED'.padStart(13));
for (const b of Object.values(byBu).sort((x, y) => y.pending - x.pending)) {
  const shipped = (cur.buList.find(x => x.bu === b.bu) || {}).coverable || 0;
  console.log(
    b.bu.padEnd(16), String(b.n).padStart(6), M(b.pending).padStart(13), M(b.available).padStart(13),
    M(b.shortfall).padStart(13), M(b.surplus).padStart(13),
    M(Math.min(b.shortfall, b.surplus)).padStart(13), M(shipped).padStart(13),
    b.negCount ? `  (${b.negCount} sites overdrawn ${M(b.negAvail)})` : '');
}

// Where does the difference come from for Logistics?
const L = sites.filter(s => (s.businessUnit || '') === 'Logistics');
const starved = L.filter(s => (s.pending || 0) > 50000 && (s.available || 0) < (s.pending || 0) * 0.25);
const anyShort = L.filter(s => (s.pending || 0) > (s.available || 0));
console.log('\nLOGISTICS');
console.log('  sites short of funds (any amount):', anyShort.length, M(anyShort.reduce((t, s) => t + ((s.pending || 0) - (s.available || 0)), 0)));
console.log('  sites counted as "starved" by the threshold:', starved.length, M(starved.reduce((t, s) => t + (s.pending || 0), 0)));
console.log('  short sites EXCLUDED by the threshold:');
for (const s of anyShort.filter(s => !starved.includes(s)).sort((a, b) => (b.pending - b.available) - (a.pending - a.available))) {
  console.log(`     ${String(s.site).padEnd(7)} pending ${M(s.pending).padStart(11)}  available ${M(s.available).padStart(11)}  short ${M((s.pending || 0) - (s.available || 0)).padStart(11)}`);
}
