const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const invs = sage.getCachedInvoices();
const T = (label, fn) => { const t = process.hrtime.bigint(); const r = fn(); const ms = Number(process.hrtime.bigint() - t) / 1e6; console.log('   ' + label.padEnd(28) + ms.toFixed(0).padStart(6) + ' ms'); return r; };

console.log('invoices: ' + invs.length);
const led = T('getPoLedger', () => pl.getPoLedger(invs));
T('getNeedsUpload', () => pl.getNeedsUpload(invs));
T('buildAmazonRows', () => sl.buildAmazonRows(invs, { payee }));
T('getPendingBySite (w/ ledger)', () => pl.getPendingBySite(invs, { snowOnly: false, ledger: led }));
T('getPendingBySite again', () => pl.getPendingBySite(invs, { snowOnly: false, ledger: led }));

// The held-invoice walk inside getPendingBySite: one resolveInvoice per invoice.
const amazon = invs.filter(i => { try { return payee.isAmazonInvoice(i); } catch (e) { return false; } });
T('resolveInvoice x' + amazon.length, () => { let n = 0; for (const i of amazon) { const pid = payee.toPayeeId(i.invoiceId); if (pid && payee.resolveInvoice(pid)) n++; } return n; });
T('payee.getIndex()', () => Object.keys(payee.getIndex() || {}).length);
