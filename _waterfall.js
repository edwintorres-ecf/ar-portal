// The deck currently offers one answer — "move the money" — to four different
// problems. Edwin: MTN1 reads as a contradiction (funds available AND
// insufficient funds), and a PO covering 4 sites muddies a site-level story.
//
// Split what we cannot bill by WHAT ACTUALLY UNBLOCKS IT:
//   1 RELEASE  — held on a PO that already has the money (no money needed)
//   2 SAME SITE— the site has the funds, on a different PO
//   3 SAME BU  — another site in the same business unit has them
//   4 NEW MONEY— genuinely unfunded anywhere in the unit
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const pl = require('/home/ecf-admin/ar-portal/po-ledger');
const sl = require('/home/ecf-admin/ar-portal/site-ledger');
const M = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n || 0)).toLocaleString('en-US');

const invs = sage.getCachedInvoices();
const led = pl.getPoLedger(invs).filter(p => p.serviceType === 'snow');
const byPo = {}; for (const p of led) byPo[p.poNumber] = p;
const snowPos = new Set(led.map(p => p.poNumber));
const rows = sl.buildAmazonRows(invs, { payee }).filter(r => (r.amount || 0) > 0.005 && snowPos.has(r.po));

// Blocked = held for insufficient funds, or never submitted.
const blocked = rows.filter(r => /Insufficient/.test(r.payeeStatus || '') || !r.payeeStatus);

// Headroom per PO and per site, drawn down as we allocate.
const poLeft = {}; for (const p of led) poLeft[p.poNumber] = Math.max(0, p.available || 0);
const siteLeft = {}, buLeft = {};
for (const p of led) {
  const s = p.siteCode || '(none)';
  siteLeft[s] = (siteLeft[s] || 0) + Math.max(0, p.available || 0);
  const b = p.businessUnit || '(none)';
  buLeft[b] = (buLeft[b] || 0) + Math.max(0, p.available || 0);
}

const out = { release: 0, sameSite: 0, sameBu: 0, newMoney: 0 };
const n = { release: 0, sameSite: 0, sameBu: 0, newMoney: 0 };
const examples = { release: [], sameSite: [] };

// Biggest first so headroom is attributed to what it can actually clear.
for (const r of blocked.sort((a, b) => b.amount - a.amount)) {
  const amt = r.amount, po = r.po, site = r.site || '(none)', bu = r.businessUnit || '(none)';
  const isHeld = /Insufficient/.test(r.payeeStatus || '');
  if (isHeld && (poLeft[po] || 0) >= amt - 0.5) {
    out.release += amt; n.release++; poLeft[po] -= amt; siteLeft[site] -= amt; buLeft[bu] -= amt;
    examples.release.push({ inv: r.invoiceId, site, po, amt });
  } else if ((siteLeft[site] || 0) >= amt - 0.5) {
    out.sameSite += amt; n.sameSite++; siteLeft[site] -= amt; buLeft[bu] -= amt;
    examples.sameSite.push({ inv: r.invoiceId, site, po, amt });
  } else if ((buLeft[bu] || 0) >= amt - 0.5) {
    out.sameBu += amt; n.sameBu++; buLeft[bu] -= amt;
  } else {
    out.newMoney += amt; n.newMoney++;
  }
}

const tot = out.release + out.sameSite + out.sameBu + out.newMoney;
console.log('SNOW work we cannot bill: ' + M(tot) + ' · ' + blocked.length + ' invoices\n');
const line = (k, label) => console.log('   ' + label.padEnd(46) + M(out[k]).padStart(13) + String(n[k]).padStart(5) + ' inv   '
  + (tot ? Math.round(out[k] / tot * 100) : 0) + '%');
line('release', '1. Release it — the PO already has the money');
line('sameSite', '2. Move funds between POs at the SAME site');
line('sameBu', '3. Move funds from another site in the same BU');
line('newMoney', '4. Genuinely needs new money');

console.log('\ntop "release" cases:');
for (const e of examples.release.sort((a, b) => b.amt - a.amt).slice(0, 6)) console.log('   ' + String(e.site).padEnd(7) + String(e.po).padEnd(14) + M(e.amt).padStart(11) + '  ' + e.inv);
console.log('\ntop "same site, wrong PO" cases:');
for (const e of examples.sameSite.sort((a, b) => b.amt - a.amt).slice(0, 8)) console.log('   ' + String(e.site).padEnd(7) + String(e.po || '(no PO)').padEnd(14) + M(e.amt).padStart(11) + '  ' + e.inv);
