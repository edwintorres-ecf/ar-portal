// "Insufficient PO Funds Hold $4,284,400" — is that the face value of the held
// invoices, or the extra money actually needed? They are different numbers.
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const invs = sage.getCachedInvoices();
const rows = sl.buildAmazonRows(invs, { payee });
const ledger = pl.getPoLedger(invs);
const byPo = {}; for (const r of ledger) byPo[r.poNumber] = r;

for (const BU of ['NACF', 'Logistics', 'ATS']) {
  const held = rows.filter(r => r.businessUnit === BU && /Insufficient/.test(r.payeeStatus || ''));
  const face = held.reduce((t, r) => t + (r.amount || 0), 0);

  // Group by PO: the funding gap is per PO, not per invoice — several held
  // invoices draw on the same balance.
  const byPoHeld = {};
  for (const r of held) {
    const po = r.po || '(no PO)';
    byPoHeld[po] = (byPoHeld[po] || 0) + (r.amount || 0);
  }
  let incremental = 0;
  const lines = [];
  for (const [po, amt] of Object.entries(byPoHeld)) {
    const L = byPo[po];
    const avail = L && L.available != null ? L.available : 0;
    // Only the part the PO cannot absorb. A negative balance means the PO is
    // already over, so the whole held amount plus the overdraw is unfunded.
    const gap = avail >= 0 ? Math.max(0, amt - avail) : amt + Math.abs(avail);
    incremental += gap;
    lines.push({ po, amt, avail, gap, site: L ? L.siteCode : '' });
  }
  lines.sort((a, b) => b.gap - a.gap);
  console.log(`\n=== ${BU} — Insufficient PO Funds Hold`);
  console.log(`   face value of held invoices : ${M(face)}  (${held.length} invoices, ${Object.keys(byPoHeld).length} POs)`);
  console.log(`   extra PO funding needed     : ${M(incremental)}`);
  console.log(`   difference                  : ${M(face - incremental)}  (absorbed by funds still on those POs)`);
  for (const l of lines.slice(0, 5)) {
    console.log(`      ${l.po.padEnd(14)} ${String(l.site || '').padEnd(7)} held ${M(l.amt).padStart(13)}  available ${M(l.avail).padStart(12)}  needs ${M(l.gap).padStart(13)}`);
  }
}
