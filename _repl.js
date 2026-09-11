// Is the pattern top-ups, or a sequence of replacement POs? Count how often a
// site's PO is fully consumed and followed by a new one.
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const ledger = pl.getPoLedger(sage.getCachedInvoices());
const real = ledger.filter(p => p.siteCode && !/needed|tbd|msg|pending/i.test(p.poNumber));
const bySite = {};
for (const p of real) (bySite[p.siteCode] = bySite[p.siteCode] || []).push(p);

let multi = 0, singles = 0, fullyConsumedChains = 0;
const examples = [];
for (const [site, list] of Object.entries(bySite)) {
  if (list.length === 1) { singles++; continue; }
  multi++;
  list.sort((a, b) => String(a.orderDate || a.docDate || '').localeCompare(String(b.orderDate || b.docDate || '')));
  // A "replacement" pattern: earlier POs fully consumed, a later one issued.
  const exhausted = list.filter(p => (p.available || 0) <= 0.5 && (p.ceilingAmount || 0) > 0);
  if (exhausted.length >= 2) {
    fullyConsumedChains++;
    examples.push({ site, n: list.length, exhausted: exhausted.length,
      value: list.reduce((t, p) => t + (p.ceilingAmount || 0), 0), bu: (db.getAmazonLocationMap()[site] || {}).businessUnit });
  }
}
console.log('sites with a single PO           :', singles);
console.log('sites with several POs           :', multi);
console.log('sites with 2+ fully consumed POs :', fullyConsumedChains, '(the replacement pattern)');
console.log('\nlongest chains:');
for (const e of examples.sort((a, b) => b.n - a.n).slice(0, 10)) {
  console.log(`   ${e.site.padEnd(7)} ${String(e.bu || '').padEnd(11)} ${String(e.n).padStart(3)} POs, ${e.exhausted} fully consumed, ${M(e.value)} committed in total`);
}
