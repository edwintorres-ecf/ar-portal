// What do we hold from the PO PDF for 2D-20105615? Its lines are
// "DBL1 - 210 Redstone Hill Road" — a site and a STREET, no year — so the
// "SITE - 20xx" pattern cannot see them.
const db = require('/home/ecf-admin/ar-portal/db'); const d = db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const led = pl.getPoLedger(sage.getCachedInvoices());
const p = led.find(x => x.poNumber === '2D-20105615');
console.log('ledger row keys with doc/desc:', Object.keys(p).filter(k => /doc|desc|site/i.test(k)).join(', '));
for (const k of Object.keys(p).filter(k => /doc|desc|site/i.test(k))) {
  console.log('   ' + k + ' = ' + JSON.stringify(p[k]).slice(0, 220));
}
// Where does the doc text live?
const t = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
console.log('\ntables mentioning doc:', t.filter(n => /doc/i.test(n)).join(', '));
