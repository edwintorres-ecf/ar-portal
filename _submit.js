// Of the work not yet submitted against a REAL PO, how much could go in today
// because the PO still has room? That is our backlog, not Amazon's problem, and
// asking them to fund it would be wrong.
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
const isPlaceholder = (po) => !po || /needed|tbd|pending|none|n\/a/i.test(String(po));

// Group unsubmitted invoices by PO and compare with what that PO still has.
const byPoGroup = {};
for (const r of rows) {
  if (r.payeeStatus || (r.amount || 0) <= 0.005) continue;
  if (isPlaceholder(r.po) || !byPo[r.po]) continue;
  const g = byPoGroup[r.po] = byPoGroup[r.po] || { amt: 0, n: 0, bu: r.businessUnit, site: r.site };
  g.amt += r.amount; g.n++;
}

const res = {};
for (const [po, g] of Object.entries(byPoGroup)) {
  const L = byPo[po];
  const avail = L && L.available != null ? L.available : 0;
  const canSubmit = Math.max(0, Math.min(g.amt, avail));
  const needsFunds = Math.max(0, g.amt - Math.max(0, avail));
  const bu = g.bu || '(none)';
  const b = res[bu] = res[bu] || { canSubmit: 0, needsFunds: 0, pos: 0, posNeeding: 0 };
  b.canSubmit += canSubmit; b.needsFunds += needsFunds; b.pos++;
  if (needsFunds > 0) b.posNeeding++;
}

console.log('BU'.padEnd(12), 'could submit today'.padStart(20), 'genuinely needs funds'.padStart(23), 'POs needing a top-up'.padStart(22));
let tc = 0, tn = 0, tp = 0;
for (const [bu, b] of Object.entries(res).sort((x, y) => y[1].needsFunds - x[1].needsFunds)) {
  tc += b.canSubmit; tn += b.needsFunds; tp += b.posNeeding;
  console.log(bu.padEnd(12), M(b.canSubmit).padStart(20), M(b.needsFunds).padStart(23), String(b.posNeeding + ' of ' + b.pos).padStart(22));
}
console.log('TOTAL'.padEnd(12), M(tc).padStart(20), M(tn).padStart(23), String(tp).padStart(22));
console.log('\nOf the ' + M(tc + tn) + ' not yet submitted against a real PO:');
console.log('   ' + M(tc) + ' can be submitted right now — our backlog, no ask');
console.log('   ' + M(tn) + ' genuinely needs the PO topped up');
