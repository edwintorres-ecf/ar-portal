// Does the snow data actually sit inside the 2025-26 season, and how much falls
// outside it? The deck is about to claim a season, so the claim has to be true.
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');

const invs = sage.getCachedInvoices();
const needs = pl.getNeedsUpload(invs);
const ledger = pl.getPoLedger(invs);
const snowPo = new Set(ledger.filter(r => r.serviceType === 'snow').map(r => r.poNumber));
const snowNeeds = needs.filter(i => snowPo.has(i.assignedPo));

const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const ym = (d) => {
  const t = Date.parse(String(d || ''));
  if (isNaN(t)) return 'unknown';
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
};

const byMonth = {};
for (const i of snowNeeds) {
  const k = ym(i.invoiceDate);
  byMonth[k] = byMonth[k] || { n: 0, amt: 0 };
  byMonth[k].n++; byMonth[k].amt += i.amount || 0;
}
console.log('Snow work waiting to be billed, by INVOICE month:');
for (const k of Object.keys(byMonth).sort()) {
  console.log('  ', k, String(byMonth[k].n).padStart(4), M(byMonth[k].amt).padStart(13));
}
console.log('total', snowNeeds.length, M(snowNeeds.reduce((t, i) => t + (i.amount || 0), 0)));

// A snow season runs Jul 1 -> Jun 30, so 2025-26 = 2025-07-01 .. 2026-06-30.
const inSeason = (d) => {
  const t = Date.parse(String(d || ''));
  if (isNaN(t)) return false;
  return t >= Date.parse('2025-07-01') && t < Date.parse('2026-07-01');
};
const within = snowNeeds.filter(i => inSeason(i.invoiceDate));
const outside = snowNeeds.filter(i => !inSeason(i.invoiceDate));
console.log('\nIN the 2025-26 season (Jul 2025 - Jun 2026):', within.length, M(within.reduce((t, i) => t + (i.amount || 0), 0)));
console.log('OUTSIDE it:', outside.length, M(outside.reduce((t, i) => t + (i.amount || 0), 0)));
for (const i of outside.slice(0, 15)) console.log('   ', i.invoiceId, i.invoiceDate, i.siteCode || '-', M(i.amount));

// PO order dates too — a PO raised for the season is the other anchor.
const poDates = {};
for (const r of ledger.filter(x => x.serviceType === 'snow' && x.orderDate)) {
  poDates[ym(r.orderDate)] = (poDates[ym(r.orderDate)] || 0) + 1;
}
console.log('\nSnow POs by order month:');
for (const k of Object.keys(poDates).sort()) console.log('  ', k, poDates[k]);
