// Edwin: entries without the 2D prefix are not actual Amazon POs.
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const AMZ = /^\d[A-Z]-\d{6,}$/i;

const led = pl.getPoLedger(sage.getCachedInvoices());
const bad = led.filter(p => !AMZ.test(String(p.poNumber || '').trim()));
console.log('ledger POs: ' + led.length + ' · NOT matching the Amazon 2D-###### form: ' + bad.length);
console.log('   value ' + M(bad.reduce((t, p) => t + (p.ceilingAmount || 0), 0))
  + ' · billed ' + M(bad.reduce((t, p) => t + (p.consumed || 0), 0))
  + ' · waiting ' + M(bad.reduce((t, p) => t + (p.pendingUpload || 0), 0)));
console.log('\nevery one of them:');
for (const p of bad.sort((a, b) => (b.pendingUpload || 0) - (a.pendingUpload || 0))) {
  console.log('   "' + String(p.poNumber).padEnd(18) + '" site=' + String(p.siteCode || '?').padEnd(7)
    + (p.serviceType || '').padEnd(11) + 'value ' + M(p.ceilingAmount).padStart(11)
    + ' billed ' + M(p.consumed).padStart(11) + ' waiting ' + M(p.pendingUpload || 0).padStart(11)
    + (p.tracked ? '  [tracked]' : '') + (p.hasDoc ? '  [has doc]' : ''));
}
// Does Amazon's own open-PO map know any of them?
const payee = require('/home/ecf-admin/ar-portal/payee');
let open = {}; try { open = payee.getOpenPoMap().byPo || {}; } catch (e) {}
const knownToAmazon = bad.filter(p => open[p.poNumber]);
console.log('\nrecognised by Amazon despite the format: ' + knownToAmazon.length
  + (knownToAmazon.length ? ' -> ' + knownToAmazon.map(p => p.poNumber).join(', ') : ''));
