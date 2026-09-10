// The available balances may include POs raised for the NEXT season. Those are
// not "sitting unused" — the work simply has not happened yet. Claiming them
// would be wrong, and Amazon would spot it.
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const ledger = pl.getPoLedger(sage.getCachedInvoices()).filter(r => r.serviceType === 'snow');
const cut = Date.parse('2026-07-01');
const dateOf = (r) => Date.parse(String(r.orderDate || r.docDate || ''));

const groups = { season2526: [], next2627: [], older: [], undated: [] };
for (const r of ledger) {
  const t = dateOf(r);
  if (isNaN(t)) groups.undated.push(r);
  else if (t >= cut) groups.next2627.push(r);
  else if (t >= Date.parse('2025-07-01')) groups.season2526.push(r);
  else groups.older.push(r);
}
for (const [k, list] of Object.entries(groups)) {
  const avail = list.reduce((t, r) => t + (r.available || 0), 0);
  const pend = list.reduce((t, r) => t + (r.pendingUpload || 0), 0);
  console.log(k.padEnd(12), String(list.length).padStart(5), 'POs  available', M(avail).padStart(13), '  pending', M(pend).padStart(13));
}
const nextAvail = groups.next2627.reduce((t, r) => t + (r.available || 0), 0);
const nextPending = groups.next2627.reduce((t, r) => t + (r.pendingUpload || 0), 0);
console.log('\nPOs dated on/after 2026-07-01 (next season):', groups.next2627.length,
  '· available', M(nextAvail), '· pending against them', M(nextPending));
console.log('If those are excluded, available for the 25-26 season falls from',
  M(ledger.reduce((t, r) => t + (r.available || 0), 0)), 'to',
  M(ledger.reduce((t, r) => t + (r.available || 0), 0) - nextAvail));
