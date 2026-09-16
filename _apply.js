const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const ad = require('/home/ecf-admin/ar-portal/po-placeholder-adopt');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();

const before = pl.getPoLedger(invs).filter(p => p.siteCode === 'KRB5');
console.log('BEFORE:');
for (const p of before) console.log('   ' + String(p.poNumber).padEnd(16) + (p.serviceType || '').padEnd(9) + 'avail ' + M(p.available).padStart(11) + '  waiting ' + M(p.pendingUpload || 0).padStart(11));

const r = ad.apply(invs, { actor: 'edwin.torres@eastcoastfacilities.com' });
console.log('\napplied: ' + r.adopt.length + ' adopted · ' + r.ambiguous.length + ' ambiguous · ' + r.orphan.length + ' orphan');

const after = pl.getPoLedger(invs).filter(p => p.siteCode === 'KRB5');
console.log('\nAFTER:');
for (const p of after) console.log('   ' + String(p.poNumber).padEnd(16) + (p.serviceType || '').padEnd(9) + 'avail ' + M(p.available).padStart(11) + '  waiting ' + M(p.pendingUpload || 0).padStart(11));
console.log('\nplaceholders left in the ledger:', pl.getPoLedger(invs).filter(p => ad.isPlaceholder(p.poNumber)).map(p => p.poNumber).join(', ') || 'none');
