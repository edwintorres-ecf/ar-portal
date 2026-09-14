const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const led = pl.getPoLedger(sage.getCachedInvoices());
const withDoc = led.filter(p => p.docDescription && String(p.docDescription).trim());
const parsed = withDoc.filter(p => (p.lineSites || []).length > 0);
console.log('POs total              :', led.length);
console.log('with a parsed document :', withDoc.length);
console.log('line sites extracted   :', parsed.length, '(' + Math.round(parsed.length / withDoc.length * 100) + '% of those with a doc)');
console.log('multi-site             :', parsed.filter(p => p.multiSite).length);
console.log('\nsample of docDescriptions where NO line site was extracted:');
for (const p of withDoc.filter(p => !(p.lineSites || []).length).slice(0, 5)) {
  console.log('   ' + p.poNumber + ' :: ' + String(p.docDescription).slice(0, 90));
}
