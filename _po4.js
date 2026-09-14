// Which sites actually bill against a given PO? The PO ledger labels each PO
// with ONE site code, but Amazon issues blanket POs covering several — and when
// it does, the single label is wrong for every site but one.
const db = require('/home/ecf-admin/ar-portal/db');
const d = db.getDb();
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const PO = process.argv[2] || '2D-20105615';

const rows = d.prepare('SELECT invoice_number, amount FROM po_consumption WHERE po_number=? AND released_at IS NULL').all(PO);
const led = d.prepare("SELECT invoice_id, site_code, source FROM invoice_site_ledger WHERE site_code IS NOT NULL AND site_code != ''").all();
const byId = {};
for (const r of led) byId[String(r.invoice_id).replace(/-/g, '')] = r;

const by = {};
let miss = 0;
for (const r of rows) {
  const hit = byId[String(r.invoice_number).replace(/-/g, '')];
  if (!hit) { miss++; continue; }
  by[hit.site_code] = by[hit.site_code] || { n: 0, a: 0, src: hit.source };
  by[hit.site_code].n++; by[hit.site_code].a += r.amount || 0;
}
console.log(PO + ' — sites billing against it:');
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].a - a[1].a)) {
  console.log('   ' + String(k).padEnd(8), M(v.a).padStart(12), String(v.n).padStart(3) + ' inv   via ' + v.src);
}
console.log('   distinct sites:', Object.keys(by).length, '· unresolved:', miss, 'of', rows.length);
