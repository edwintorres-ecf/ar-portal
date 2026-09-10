const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const fs = require('fs');
const mod = require('/home/ecf-admin/ar-portal/amazon-funds-report');

const invs = sage.getCachedInvoices();
const a = mod.analyse(invs, { snowOnly: true });
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

console.log('BU'.padEnd(16), 'pending'.padStart(12), 'available'.padStart(13), 'shortfall'.padStart(12), 'surplus'.padStart(12), 'coverable'.padStart(12), ' sanity');
for (const b of a.buList) {
  const ok = b.coverable <= b.pending + 0.5 ? 'ok' : 'COVERABLE > PENDING';
  console.log(b.bu.padEnd(16), M(b.pending).padStart(12), M(b.available).padStart(13),
    M(b.shortfall).padStart(12), M(b.surplus).padStart(12), M(b.coverable).padStart(12), ' ' + ok);
}
const t = a.totals;
console.log('\nTOTALS pending', M(t.pending), '| shortfall', M(t.shortfall), '| coverable', M(t.coverable));
console.log('overdrawn:', t.overdrawnSites, 'sites,', M(Math.abs(t.overdrawn)));
console.log('coverable <= pending:', t.coverable <= t.pending ? 'ok' : 'STILL WRONG');
console.log('shortfall <= pending:', t.shortfall <= t.pending ? 'ok' : 'STILL WRONG');

mod.buildWorkbook(invs, { snowOnly: true }).then(async (out) => {
  console.log('\nworkbook sheets:', out.workbook.worksheets.map(w => w.name).join(' | '));
  await out.workbook.xlsx.writeFile('/tmp/funds.xlsx');
  const ws = fs.createWriteStream('/tmp/casestudy.pdf');
  mod.buildDeck(a).pipe(ws);
  ws.on('finish', () => { console.log('pdf + xlsx written'); process.exit(0); });
}).catch(e => { console.error('ERR', e.message); process.exit(1); });
