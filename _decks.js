const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const fr = require('/home/ecf-admin/ar-portal/amazon-funds-report');
const fs = require('fs');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const OUT = '/tmp/ecf-decks'; fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const invs = sage.getCachedInvoices();

const write = (a, name) => new Promise((res, rej) => {
  const doc = fr.buildDeck(a);
  const f = `${OUT}/${name}`;
  const out = fs.createWriteStream(f);
  doc.pipe(out);
  out.on('finish', () => {
    const b = fs.readFileSync(f);
    res({ pages: (b.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, bytes: b.length });
  });
  out.on('error', rej);
});

(async () => {
  const combined = fr.analyse(invs, { snowOnly: true });
  let r = await write(combined, `ecf-amazon-case-study-snow-${stamp}.pdf`);
  console.log('combined'.padEnd(12) + String(combined.totals.sites).padStart(4) + ' sites  ' + M(combined.totals.pending).padStart(12)
    + '  short ' + M(combined.totals.shortfall).padStart(12) + '  ' + r.pages + ' pages');

  for (const b of combined.buList) {
    const a = fr.analyse(invs, { snowOnly: true, bu: b.bu });
    if (!a.sites.length) { console.log(String(b.bu).padEnd(12) + ' (no sites, skipped)'); continue; }
    const safe = String(b.bu).replace(/[^A-Za-z0-9]+/g, '-');
    r = await write(a, `ecf-amazon-case-study-${safe}-snow-${stamp}.pdf`);
    const b0 = a.buList[0] || {};
    console.log(String(b.bu).padEnd(12) + String(a.totals.sites).padStart(4) + ' sites  ' + M(a.totals.pending).padStart(12)
      + '  short ' + M(b0.shortfall).padStart(12) + '  spare ' + M(b0.surplus).padStart(12) + '  ' + r.pages + ' pages');
  }
  console.log('\nfiles:', fs.readdirSync(OUT).length);
})().catch(e => { console.error('FAILED', e.message, e.stack.split('\n')[1]); process.exit(1); });
