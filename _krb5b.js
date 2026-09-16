const db = require('/home/ecf-admin/ar-portal/db'); const d = db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const fs = require('fs');

// Every PO Amazon shows as open, and every PO detail we have scraped —
// looking for a KRB5 PO that is not yet in our ledger.
let open = {}; try { open = payee.getOpenPoMap().byPo || {}; } catch (e) {}
console.log('Amazon open-PO map entries:', Object.keys(open).length);
let details = {}; try { details = JSON.parse(fs.readFileSync('/home/ecf-admin/ar-portal/payee-po-details.spark.json', 'utf8')).details || {}; } catch (e) {}
console.log('scraped PO details:', Object.keys(details).length);

const led = pl.getPoLedger(sage.getCachedInvoices());
const known = new Set(led.map(p => p.poNumber));

console.log('\nPOs whose scraped detail names site KRB5:');
for (const [po, v] of Object.entries(details)) {
  if (String(v.site || '') !== 'KRB5' && !/KRB5/i.test(String(v.desc || ''))) continue;
  console.log('   ' + po.padEnd(16) + 'site=' + String(v.site || '?').padEnd(7)
    + 'amount ' + M(v.poAmount).padStart(12) + '  available ' + M(v.available).padStart(12)
    + '  ' + String(v.status || '') + (known.has(po) ? '' : '   <-- NOT IN OUR LEDGER')
    + '  ' + String(v.desc || '').slice(0, 46));
}

console.log('\nPOs in Amazon open map not in our ledger (any site), newest 12:');
const missing = Object.entries(open).filter(([po]) => !known.has(po));
console.log('   count:', missing.length);
for (const [po, v] of missing.slice(0, 12)) {
  console.log('   ' + po.padEnd(16) + JSON.stringify(v).slice(0, 120));
}

// The real PO's line item, to confirm it is the KRB5 season PO.
const real = led.find(p => p.poNumber === '2D-20583322');
console.log('\n2D-20583322 line item:', String(real && real.docDescription || '').slice(0, 110));
console.log('   docUrl:', (real && real.docUrl) ? 'yes' : 'none', '· docVersion', real && real.docVersion);
