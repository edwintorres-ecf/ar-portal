// Two different asks: top up an existing PO, or raise a new one. Work with no
// PO at all cannot be "topped up" — there is nothing to top up.
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const invs = sage.getCachedInvoices();
const rows = sl.buildAmazonRows(invs, { payee });
const ledger = pl.getPoLedger(invs);
const byPo = {}; for (const r of ledger) byPo[r.poNumber] = r;

// A placeholder is not a real PO — "NEEDED KRB5" and the like mean we are
// waiting for one to be issued.
const isPlaceholder = (po) => !po || /needed|tbd|pending|none|n\/a/i.test(String(po));

const out = {};
for (const r of rows) {
  const bu = r.businessUnit || '(none)';
  const b = out[bu] = out[bu] || { receipt: 0, topupHeld: 0, topupNotSub: 0, newPo: 0, nR: 0, nH: 0, nT: 0, nN: 0, newPoSites: new Set(), topupPos: new Set() };
  const st = r.payeeStatus || '';
  if (st === 'Pending Goods Receipt Hold') { b.receipt += r.amount; b.nR++; }
  else if (/Insufficient/.test(st)) { b.topupHeld += r.amount; b.nH++; if (r.po) b.topupPos.add(r.po); }
  else if (!st && r.amount > 0.005) {
    if (isPlaceholder(r.po) || !byPo[r.po]) { b.newPo += r.amount; b.nN++; if (r.site) b.newPoSites.add(r.site); }
    else { b.topupNotSub += r.amount; b.nT++; b.topupPos.add(r.po); }
  }
}

console.log('BU'.padEnd(12), 'goods receipt'.padStart(15), 'top up: held'.padStart(15), 'top up: not sub'.padStart(17), 'NEW PO needed'.padStart(15));
let T = { receipt: 0, topupHeld: 0, topupNotSub: 0, newPo: 0 };
for (const [bu, b] of Object.entries(out).sort((x, y) => (y[1].topupHeld + y[1].topupNotSub + y[1].newPo) - (x[1].topupHeld + x[1].topupNotSub + x[1].newPo))) {
  T.receipt += b.receipt; T.topupHeld += b.topupHeld; T.topupNotSub += b.topupNotSub; T.newPo += b.newPo;
  console.log(bu.padEnd(12), M(b.receipt).padStart(15), M(b.topupHeld).padStart(15), M(b.topupNotSub).padStart(17), M(b.newPo).padStart(15),
    ` (${b.nN} inv, ${b.newPoSites.size} sites need a new PO · ${b.topupPos.size} POs to top up)`);
}
console.log('TOTAL'.padEnd(12), M(T.receipt).padStart(15), M(T.topupHeld).padStart(15), M(T.topupNotSub).padStart(17), M(T.newPo).padStart(15));
console.log('\nASK 1 — add funds to existing POs :', M(T.topupHeld + T.topupNotSub));
console.log('ASK 2 — issue new POs             :', M(T.newPo));
console.log('ASK 3 — record goods receipts     :', M(T.receipt), '(no money)');

// What do the no-PO invoices actually look like?
const noPo = rows.filter(r => !r.payeeStatus && r.amount > 0.005 && (isPlaceholder(r.po) || !byPo[r.po]));
const bySite = {};
for (const r of noPo) { const k = r.site || '(no site)'; bySite[k] = bySite[k] || { amt: 0, n: 0, bu: r.businessUnit }; bySite[k].amt += r.amount; bySite[k].n++; }
console.log('\nSites needing a NEW PO (top 10):');
for (const [site, v] of Object.entries(bySite).sort((a, b) => b[1].amt - a[1].amt).slice(0, 10)) {
  console.log(`   ${site.padEnd(10)} ${String(v.bu || '').padEnd(11)} ${M(v.amt).padStart(13)}  ${v.n} invoice(s)`);
}
const placeholders = [...new Set(noPo.map(r => r.po).filter(p => p && isPlaceholder(p)))];
console.log('\nplaceholder PO values seen:', placeholders.slice(0, 12).join(', ') || '(none)');
