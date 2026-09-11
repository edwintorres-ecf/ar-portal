// Do "Pending Goods Receipt Hold" and "Insufficient PO Funds Hold" invoices
// already reduce the PO's available balance? If they do, comparing their value
// AGAINST available double-counts and overstates the funding need.
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const invs = sage.getCachedInvoices();
const rows = sl.buildAmazonRows(invs, { payee }).filter(r => r.businessUnit === 'NACF');
const ledger = pl.getPoLedger(invs);
const byPo = {}; for (const r of ledger) byPo[r.poNumber] = r;

// Amazon's own scraped "Available amount" per PO is the truth. Our `consumed`
// is what we think has been drawn. Compare them on POs that hold each kind.
const details = JSON.parse(require('fs').readFileSync('/home/ecf-admin/ar-portal/payee-po-details.spark.json', 'utf8')).details || {};

const kinds = {
  'Pending Goods Receipt Hold': rows.filter(r => r.payeeStatus === 'Pending Goods Receipt Hold'),
  'Insufficient PO Funds Hold': rows.filter(r => r.payeeStatus === 'Insufficient PO Funds Hold'),
};

for (const [kind, list] of Object.entries(kinds)) {
  const posOf = {};
  for (const r of list) if (r.po) posOf[r.po] = (posOf[r.po] || 0) + (r.amount || 0);
  console.log(`\n=== ${kind}: ${list.length} invoices, ${M(list.reduce((t, r) => t + r.amount, 0))} across ${Object.keys(posOf).length} POs`);
  let checked = 0;
  for (const [po, amt] of Object.entries(posOf).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    const L = byPo[po], d = details[po];
    if (!L) { console.log(`   ${po}: not in ledger`); continue; }
    const amazonAvail = d && d.available !== undefined && d.available !== null ? d.available : null;
    const impliedConsumed = (L.ceilingAmount != null && amazonAvail != null) ? L.ceilingAmount - amazonAvail : null;
    console.log(`   ${po.padEnd(14)} value ${M(L.ceilingAmount).padStart(12)}  ourConsumed ${M(L.consumed).padStart(12)}`
      + `  amazonAvail ${amazonAvail == null ? '   (none)  ' : M(amazonAvail).padStart(12)}`
      + `  amazonImpliedConsumed ${impliedConsumed == null ? '(n/a)' : M(impliedConsumed).padStart(12)}`
      + `   ${kind.slice(0, 12)} on it ${M(amt)}`);
    checked++;
  }
  if (!checked) console.log('   (no POs to check)');
}

// The decisive test: does our consumed figure INCLUDE these held invoices?
const d0 = db.getDb();
let inLedger = 0, total = 0;
for (const [kind, list] of Object.entries(kinds)) {
  for (const r of list) {
    if (!r.po || !r.payeeId) continue;
    total++;
    const row = d0.prepare('SELECT amount, released_at FROM po_consumption WHERE po_number=? AND invoice_number=?')
      .get(r.po, r.payeeId);
    if (row && !row.released_at) inLedger++;
  }
}
console.log(`\nHeld invoices counted as CONSUMING in po_consumption: ${inLedger} of ${total}`);
