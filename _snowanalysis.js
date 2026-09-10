// Find the pattern Edwin described: funds stranded in the wrong place. Two
// shapes of it —
//   (A) within ONE business unit, a site starved of PO funds while sister sites
//       sit on large unused balances;
//   (B) POs CLOSED by Amazon while still carrying material available funds.
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');

const SNOW_ONLY = process.argv.includes('--snow');
const invoices = sage.getCachedInvoices();
const master = db.getAmazonLocationMap();
const sites = pl.getPendingBySite(invoices, { snowOnly: SNOW_ONLY });

const $ = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

// ── Roll up by business unit ────────────────────────────────────────────────
const byBu = {};
for (const s of sites) {
  const bu = s.businessUnit || '(not in master)';
  const b = byBu[bu] = byBu[bu] || { bu, sites: [], pending: 0, available: 0, ceiling: 0, consumed: 0 };
  b.sites.push(s);
  b.pending += s.pending || 0;
  b.available += s.available || 0;
  b.ceiling += s.ceiling || 0;
  b.consumed += s.consumed || 0;
}

console.log(`=== ${SNOW_ONLY ? 'SNOW' : 'ALL'} — pending vs available by business unit ===`);
for (const b of Object.values(byBu).sort((a, c) => c.pending - a.pending)) {
  console.log(`${b.bu.padEnd(18)} ${b.sites.length.toString().padStart(4)} sites  pending ${$(b.pending).padStart(13)}  available ${$(b.available).padStart(13)}`);
}

// ── (A) Stranded funds inside a business unit ───────────────────────────────
console.log('\n=== (A) STARVED SITES NEXT TO SURPLUS SITES, SAME BUSINESS UNIT ===');
const strandedRows = [];
for (const b of Object.values(byBu)) {
  const starved = b.sites.filter(s => (s.pending || 0) > 50000 && (s.available || 0) < (s.pending || 0) * 0.25)
    .sort((x, y) => (y.pending || 0) - (x.pending || 0));
  const surplus = b.sites.filter(s => (s.available || 0) > 100000 && (s.pending || 0) < (s.available || 0) * 0.25)
    .sort((x, y) => (y.available || 0) - (x.available || 0));
  if (!starved.length || !surplus.length) continue;
  const surplusTotal = surplus.reduce((t, s) => t + (s.available || 0), 0);
  const starvedTotal = starved.reduce((t, s) => t + (s.pending || 0), 0);
  console.log(`\n${b.bu}: ${starved.length} starved site(s) needing ${$(starvedTotal)} · ${surplus.length} site(s) holding ${$(surplusTotal)} unused`);
  for (const s of starved.slice(0, 5)) {
    console.log(`   STARVED  ${String(s.site).padEnd(7)} pending ${$(s.pending).padStart(12)}  available ${$(s.available).padStart(12)}  (${s.count} invoices)`);
  }
  for (const s of surplus.slice(0, 5)) {
    console.log(`   SURPLUS  ${String(s.site).padEnd(7)} available ${$(s.available).padStart(12)}  pending ${$(s.pending).padStart(12)}`);
  }
  strandedRows.push({ bu: b.bu, starved, surplus, starvedTotal, surplusTotal,
    coverable: Math.min(starvedTotal, surplusTotal) });
}
const totalCoverable = strandedRows.reduce((t, r) => t + r.coverable, 0);
console.log(`\nTOTAL that could be covered by moving funds WITHIN a business unit: ${$(totalCoverable)}`);

// ── (B) Closed POs still holding funds ──────────────────────────────────────
console.log('\n=== (B) CLOSED POs STILL CARRYING AVAILABLE FUNDS ===');
const ledger = pl.getPoLedger(invoices);
const rows = (SNOW_ONLY ? ledger.filter(r => r.serviceType === 'snow') : ledger);
const closed = rows.filter(r => r.poStatus && r.poStatus !== 'OPEN_FOR_INVOICING' && (r.available || 0) > 1000)
  .sort((a, b) => (b.available || 0) - (a.available || 0));
console.log(`${closed.length} closed PO(s) holding ${$(closed.reduce((t, r) => t + (r.available || 0), 0))}`);
for (const r of closed.slice(0, 25)) {
  console.log(`   ${String(r.poNumber).padEnd(14)} ${String(r.siteCode || '-').padEnd(7)} ${String(r.businessUnit || '-').padEnd(11)} value ${$(r.ceilingAmount).padStart(12)}  used ${$(r.consumed).padStart(12)}  LEFT ${$(r.available).padStart(11)}  [${r.poStatus}]`);
}

// ── Scale of the whole problem ──────────────────────────────────────────────
const totalPending = sites.reduce((t, s) => t + (s.pending || 0), 0);
const totalAvail = sites.reduce((t, s) => t + (s.available || 0), 0);
const starvedAll = sites.filter(s => (s.pending || 0) > 0 && (s.available || 0) < (s.pending || 0));
console.log('\n=== SCALE ===');
console.log(`sites: ${sites.length} · pending upload ${$(totalPending)} · available on POs ${$(totalAvail)}`);
console.log(`sites where pending exceeds available: ${starvedAll.length}, short by ${$(starvedAll.reduce((t, s) => t + ((s.pending || 0) - (s.available || 0)), 0))}`);
