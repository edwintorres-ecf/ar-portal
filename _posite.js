// The PO line item names the site the work is for. The SHIP TO block names where
// paperwork goes. On 2D-19170693 they disagree: ship-to PPO4, line item
// "OKC2 - 2026 - Snow Removal Ancillary Service" — and Edwin says OKC2 is right.
// Before changing the precedence globally, find every PO where they disagree.
const db = require('/home/ecf-admin/ar-portal/db'); const d = db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

const led = pl.getPoLedger(sage.getCachedInvoices());
const LINE = /(?:^|\s)([A-Z]{2,5}\d)\s*-\s*20\d\d/;

const clash = [];
for (const p of led) {
  const desc = p.docDescription || p.description || '';
  const m = String(desc).match(LINE);
  if (!m) continue;
  const lineSite = m[1];
  if (!p.siteCode || lineSite === p.siteCode) continue;
  clash.push({ po: p.poNumber, resolved: p.siteCode, lineSite, bu: p.businessUnit,
    value: p.ceilingAmount, avail: p.available, svc: p.serviceType,
    manual: p.siteManual, fromAmazon: p.siteFromAmazon, desc: String(desc).slice(0, 52) });
}
clash.sort((a, b) => (b.value || 0) - (a.value || 0));
console.log('POs where the LINE ITEM site differs from the resolved site:', clash.length, 'of', led.length);
for (const c of clash.slice(0, 20)) {
  console.log('   ' + c.po.padEnd(14) + ('resolved=' + c.resolved).padEnd(16) + ('line=' + c.lineSite).padEnd(12)
    + M(c.value).padStart(12) + '  ' + (c.svc || '').padEnd(10)
    + (c.manual ? 'MANUAL ' : '') + (c.fromAmazon ? 'from-amazon ' : '') + ' | ' + c.desc);
}
