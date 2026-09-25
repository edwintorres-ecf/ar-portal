const sa = require('./site-alias');
const sage = require('./sage');
const $ = n => '$' + Math.round(n || 0).toLocaleString('en-US');

// Snapshot site attribution BEFORE any alias is confirmed.
const before = {};
for (const p of require('./po-ledger').getPoLedger(sage.getCachedInvoices())) before[p.poNumber] = p.siteCode || null;
require('fs').writeFileSync('/tmp/alias-before.json', JSON.stringify(before));
console.log('snapshot: site attribution for', Object.keys(before).length, 'POs\n');

// Edwin 2026-09-24: "KRB5 is the real one, the others will need confirmation"
sa.confirm('MDT2', 'KRB5', 'Edwin.Torres@eastcoastfacilities.com');
console.log('CONFIRMED  MDT2 -> KRB5   (Edwin)');

const PROPOSALS = [
  ['HBO2', 'DOB5', 'Amazon 2026-27 award pairs them as "DOB5 - HBO2"; master has both at 34 Market St, Everett MA. HBO2 holds the PO and the open AR; DOB5 is in Omnia and HBO2 is not.'],
  ['DGS2', 'WGR5', 'Amazon 2026-27 award pairs them as "WGR5 - DGS2"; master has both at 1115 McDonald Rd, Hayesville NC. WGR5 has the newer PO (Jul 2026) but Omnia lists DGS2 and NOT WGR5. They also disagree: WGR5 is BU R2L with no service centre, DGS2 is Logistics under FacilityCare.'],
];
for (const [alias, canon, ev] of PROPOSALS) {
  sa.propose(alias, canon, { evidence: ev, source: 'award pairing + shared address' });
  console.log(`PROPOSED   ${alias} -> ${canon}   (needs confirmation)`);
}
for (const c of sa.detect()) {
  const [a, b] = c.codes;
  sa.propose(b, a, { evidence: `Both at ${c.address}, ${c.city} ${c.state}.`
    + (c.disagreement.length ? ` They disagree on ${c.disagreement.join(' and ')}.` : ''),
    source: 'shared street address in the location master' });
  console.log(`PROPOSED   ${b} -> ${a}   (${c.city}, ${c.state})`);
}
console.log('\nconfirmed map:', JSON.stringify(sa.map()));
console.log('awaiting a decision:', sa.list('proposed').map(r => `${r.alias_code}->${r.canonical_code}`).join(', '));
