// My "multi-site PO" test was: does this PO carry open invoices from more than
// one site code? Edwin's PO documents show 2D-21907390 and 2D-21976622 are each
// issued for ONE site with ONE line item. So a second site on the PO is not
// evidence of a multi-site PO — it is evidence that something is billed wrong.
const db = require('/home/ecf-admin/ar-portal/db'); const d = db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const invs = sage.getCachedInvoices();
const led = pl.getPoLedger(invs);
const byPo = {}; for (const p of led) byPo[p.poNumber] = p;
const rows = sl.buildAmazonRows(invs, { payee });

for (const PO of ['2D-21907390', '2D-21976622', '2D-20105615']) {
  const L = byPo[PO] || {};
  console.log(`\n=== ${PO}   ledger site ${L.siteCode || '?'}   bu ${L.businessUnit || '-'}   value ${M(L.ceilingAmount)}   left ${M(L.available)}`);
  for (const r of rows.filter(x => x.po === PO)) {
    // How was this invoice's site decided? That is the thing to doubt.
    const ev = d.prepare('SELECT site_code, source, confidence, evidence FROM invoice_site_ledger WHERE invoice_id=?').get(r.invoiceId || '');
    console.log('   ' + String(r.invoiceId || r.payeeId).padEnd(13)
      + String(r.site || '?').padEnd(7)
      + M(r.amount).padStart(12)
      + '  ' + String(r.payeeStatus || 'not submitted').padEnd(28)
      + (ev ? ` via ${ev.source}/${ev.confidence}: ${String(ev.evidence || '').slice(0, 58)}` : ' (no site-ledger row)'));
  }
}
