// Per business unit, counting ONLY the 2025-26 season's POs as available.
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const invs = sage.getCachedInvoices();
const ledger = pl.getPoLedger(invs).filter(r => r.serviceType === 'snow');
const needs = pl.getNeedsUpload(invs);
const START = Date.parse('2025-07-01'), END = Date.parse('2026-07-01');
const inSeason = (r) => { const t = Date.parse(String(r.orderDate || r.docDate || '')); return isNaN(t) ? true : (t >= START && t < END); };

const master = db.getAmazonLocationMap();
const seasonPos = ledger.filter(inSeason);
const poSite = {}; for (const r of ledger) poSite[r.poNumber] = r.siteCode;
const snowPoSet = new Set(ledger.map(r => r.poNumber));

// pending per site (snow), available per site from SEASON POs only
const bySite = {};
const touch = (site) => (bySite[site] = bySite[site] || { site, pending: 0, available: 0, n: 0 });
for (const i of needs) {
  if (!snowPoSet.has(i.assignedPo)) continue;
  const s = touch(i.siteCode || poSite[i.assignedPo] || '(no site)');
  s.pending += i.amount || 0; s.n++;
}
for (const r of seasonPos) touch(r.siteCode || '(no site)').available += (r.available || 0);

const byBu = {};
for (const s of Object.values(bySite)) {
  const bu = (master[s.site] || {}).businessUnit || '(not in master)';
  const b = byBu[bu] = byBu[bu] || { bu, pending: 0, available: 0, short: 0, spare: 0, sites: 0 };
  b.sites++; b.pending += s.pending; b.available += s.available;
  b.short += Math.max(0, s.pending - Math.max(0, s.available));
  b.spare += Math.max(0, s.available - s.pending);
}
console.log('2025-26 SEASON POs ONLY');
console.log('BU'.padEnd(16), 'pending'.padStart(13), 'available'.padStart(13), 'short by'.padStart(13), 'spare'.padStart(13), 'coverable'.padStart(13));
let tp = 0, ta = 0, ts = 0, tsp = 0, tc = 0;
for (const b of Object.values(byBu).sort((x, y) => y.pending - x.pending)) {
  const cov = Math.min(b.short, b.spare);
  tp += b.pending; ta += b.available; ts += b.short; tsp += b.spare; tc += cov;
  console.log(b.bu.padEnd(16), M(b.pending).padStart(13), M(b.available).padStart(13), M(b.short).padStart(13), M(b.spare).padStart(13), M(cov).padStart(13));
}
console.log('TOTAL'.padEnd(16), M(tp).padStart(13), M(ta).padStart(13), M(ts).padStart(13), M(tsp).padStart(13), M(tc).padStart(13));
console.log('\nGenuine funding gap the season cannot cover from itself:', M(ts - tc));
