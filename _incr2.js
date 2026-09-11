// The funding need depends on whether Amazon has ALREADY drawn a held invoice
// against the PO:
//   - drawn  -> it is inside `available` already; the need is the overdraw
//   - undrawn-> `available` knows nothing about it; the need is its full value
// Counting every held invoice at face value on top of a negative balance would
// double-count the drawn ones.
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
const d = db.getDb();
const drawnStmt = d.prepare('SELECT amount, released_at FROM po_consumption WHERE po_number=? AND invoice_number=?');

let grandFace = 0, grandNeed = 0;
for (const BU of ['NACF', 'Logistics', 'ATS', 'GSF', 'R2L']) {
  const held = rows.filter(r => r.businessUnit === BU && /Insufficient/.test(r.payeeStatus || ''));
  if (!held.length) continue;

  const po = {};
  for (const r of held) {
    const k = r.po || '(no PO)';
    po[k] = po[k] || { face: 0, drawn: 0, undrawn: 0, n: 0 };
    const row = r.payeeId ? drawnStmt.get(k, r.payeeId) : null;
    const isDrawn = !!(row && !row.released_at);
    po[k].face += r.amount || 0;
    po[k].n++;
    if (isDrawn) po[k].drawn += r.amount || 0; else po[k].undrawn += r.amount || 0;
  }

  let face = 0, need = 0;
  const lines = [];
  for (const [k, v] of Object.entries(po)) {
    const L = byPo[k];
    const avail = L && L.available != null ? L.available : 0;
    // Drawn invoices are already reflected in `avail`; if that pushed it
    // negative, the overdraw is the money required for them.
    const needDrawn = Math.max(0, -avail);
    // Undrawn invoices need their full value, less any positive headroom left.
    const needUndrawn = Math.max(0, v.undrawn - Math.max(0, avail));
    const total = needDrawn + needUndrawn;
    face += v.face; need += total;
    lines.push({ po: k, site: L ? L.siteCode : '', ...v, avail, total });
  }
  grandFace += face; grandNeed += need;
  lines.sort((a, b) => b.total - a.total);
  console.log(`\n=== ${BU}`);
  console.log(`   held at face value      : ${M(face)}  (${held.length} invoices)`);
  console.log(`   additional funds needed : ${M(need)}`);
  for (const l of lines.slice(0, 4)) {
    console.log(`      ${l.po.padEnd(14)} ${String(l.site).padEnd(6)} face ${M(l.face).padStart(12)}  drawn ${M(l.drawn).padStart(12)}  undrawn ${M(l.undrawn).padStart(12)}  avail ${M(l.avail).padStart(11)}  NEED ${M(l.total).padStart(12)}`);
  }
}
console.log(`\nALL BUs — held at face ${M(grandFace)} · additional funds actually needed ${M(grandNeed)}`);
