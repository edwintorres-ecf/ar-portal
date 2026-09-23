const sage = require('./sage');
const db = require('./db');
const led = require('./po-ledger').getPoLedger(sage.getCachedInvoices());
const AMZ = (po) => /^[0-9A-Z]{1,3}-[0-9]{6,}$/i.test(String(po || '').trim());
const money = n => '$' + Math.round(n || 0).toLocaleString('en-US');
console.log('ledger rows whose PO number is NOT Amazon-shaped:');
for (const p of led.filter(x => !AMZ(x.poNumber))) {
  const tracked = db.get('SELECT po_number, updated_by, created_at FROM purchase_orders WHERE po_number=?', [p.poNumber]);
  console.log(`  ${String(p.poNumber).padEnd(14)} site=${String(p.siteCode || '-').padEnd(6)} ceiling=${p.ceilingAmount == null ? 'none' : money(p.ceilingAmount)}`
    + ` consumed=${money(p.consumed)} pending=${money(p.pendingUpload)} inAmazonOpenList=${!!p.poStatus}`
    + ` | tracked by ${tracked ? tracked.created_by + ' on ' + String(tracked.created_at).slice(0, 10) : 'not in purchase_orders'}`);
}
