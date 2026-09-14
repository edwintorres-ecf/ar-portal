// Proposed: take the first valid site token after a line number, whatever
// follows it. Measure what it would change BEFORE touching the ledger.
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const SITE_OK = /^[A-Z]{2,5}\d$/;
const WIDE = /(?:^|\s)\d{1,3}\s+([A-Z]{2,5}\d)\b/g;

const led = pl.getPoLedger(sage.getCachedInvoices());
let extracted = 0, changed = [], multi = [];
for (const p of led) {
  const d = String(p.docDescription || '');
  if (!d.trim()) continue;
  const sites = [];
  for (const m of d.matchAll(WIDE)) { const s = m[1].toUpperCase(); if (SITE_OK.test(s) && !sites.includes(s)) sites.push(s); }
  if (!sites.length) continue;
  extracted++;
  if (sites.length > 1) multi.push({ po: p.poNumber, sites, value: p.ceilingAmount, svc: p.serviceType, avail: p.available });
  if (!p.siteManual && p.siteCode && sites[0] !== p.siteCode) {
    changed.push({ po: p.poNumber, now: p.siteCode, would: sites[0], value: p.ceilingAmount, svc: p.serviceType, desc: d.slice(0, 60) });
  }
}
console.log('line sites extracted : ' + extracted + ' (was 616)');
console.log('siteCode WOULD CHANGE: ' + changed.length);
for (const c of changed.slice(0, 15)) console.log('   ' + c.po.padEnd(14) + (c.now + ' -> ' + c.would).padEnd(16) + M(c.value).padStart(11) + '  ' + (c.svc || '').padEnd(10) + c.desc);
console.log('\nmulti-site POs: ' + multi.length + ' · ' + M(multi.reduce((t, x) => t + (x.value || 0), 0)));
for (const m of multi.sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 10)) {
  console.log('   ' + m.po.padEnd(14) + String(m.sites.length).padStart(2) + '  ' + m.sites.join(' ').padEnd(30) + M(m.value).padStart(12) + '  left ' + M(m.avail).padStart(11) + '  ' + (m.svc || ''));
}
