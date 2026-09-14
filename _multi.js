// How common is a PO that spans more than one site? If Amazon already issues
// them, "funds are locked to a site" is a choice, not a constraint.
const db = require('/home/ecf-admin/ar-portal/db'); const d = db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const invs = sage.getCachedInvoices();
const led = pl.getPoLedger(invs);
const snow = new Set(led.filter(p => p.serviceType === 'snow').map(p => p.poNumber));
const byPo = {}; for (const p of led) byPo[p.poNumber] = p;

// Sites per PO, from OPEN invoices (a lower bound — paid ones are out of cache).
const sites = {};
for (const r of sl.buildAmazonRows(invs, { payee })) {
  if (!r.po || !r.site) continue;
  (sites[r.po] = sites[r.po] || new Set()).add(r.site);
}
const multi = Object.entries(sites).filter(([po, s]) => s.size > 1 && snow.has(po));
multi.sort((a, b) => b[1].size - a[1].size);
console.log(`snow POs carrying MORE THAN ONE site: ${multi.length} of ${Object.keys(sites).filter(p => snow.has(p)).length} snow POs with open invoices`);
for (const [po, s] of multi.slice(0, 12)) {
  const L = byPo[po] || {};
  console.log('   ' + po.padEnd(14) + String(s.size).padStart(2) + ' sites  ' + [...s].slice(0, 6).join(' ')
    + (s.size > 6 ? ' …' : '') + '   labelled ' + String(L.siteCode || '?').padEnd(7) + ' value ' + M(L.ceilingAmount));
}

// The NACF example sites.
console.log('\nNACF example sites:');
const bySite = {};
for (const p of led) {
  if (p.serviceType !== 'snow') continue;
  const k = p.siteCode || '(none)';
  bySite[k] = bySite[k] || { avail: 0, pend: 0, pos: 0, bu: p.businessUnit };
  bySite[k].avail += p.available || 0;
  bySite[k].pend += p.pendingUpload || 0;
  bySite[k].pos++;
}
for (const s of ['BDL3', 'ORH3', 'LUK2']) {
  const v = bySite[s];
  console.log('   ' + s.padEnd(7), String(v && v.bu || '').padEnd(8),
    'available', M(v ? v.avail : 0).padStart(12), ' waiting to bill', M(v ? v.pend : 0).padStart(12), ' ' + (v ? v.pos : 0) + ' POs');
}
