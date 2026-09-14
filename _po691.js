const db = require('/home/ecf-admin/ar-portal/db'); const d = db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n || 0)).toLocaleString('en-US');
const PO = '2D-19170691';

const invs = sage.getCachedInvoices();
const p = pl.getPoLedger(invs).find(x => x.poNumber === PO);
console.log('ledger:', JSON.stringify({ value: p.ceilingAmount, ceilingSource: p.ceilingSource, scrapedCeiling: p.scrapedCeiling,
  consumed: p.consumed, available: p.available, docAmount: p.docAmount, poStatus: p.poStatus }, null, 0));

// Amazon's own scraped view of this PO
let det = {};
try { det = (JSON.parse(require('fs').readFileSync('/home/ecf-admin/ar-portal/payee-po-details.spark.json', 'utf8')).details || {})[PO] || {}; } catch (e) {}
console.log('amazon detail page:', JSON.stringify(det).slice(0, 300));

// What does po_consumption hold for this PO?
const cons = d.prepare('SELECT invoice_number, amount, released_at FROM po_consumption WHERE po_number=?').all(PO);
const live = cons.filter(c => !c.released_at);
console.log('\npo_consumption rows:', cons.length, '· live', live.length, '· live total', M(live.reduce((t, c) => t + (c.amount || 0), 0)));

// The held invoices — are they in there?
const held = sl.buildAmazonRows(invs, { payee }).filter(r => r.po === PO && /Insufficient/.test(r.payeeStatus || ''));
console.log('\nheld invoices on this PO:', held.length, M(held.reduce((t, r) => t + r.amount, 0)));
for (const r of held) {
  const pid = payee.toPayeeId(r.invoiceId);
  const row = d.prepare('SELECT amount, released_at FROM po_consumption WHERE po_number=? AND invoice_number=?').get(PO, pid);
  console.log('   ' + String(r.invoiceId).padEnd(13) + M(r.amount).padStart(11)
    + '  in po_consumption: ' + (row ? (row.released_at ? 'RELEASED' : 'live ' + M(row.amount)) : 'NO ROW'));
}
