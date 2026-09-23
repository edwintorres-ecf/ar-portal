const award = require('./amazon-award');
const rows = JSON.parse(require('fs').readFileSync('/tmp/award-final.json', 'utf8'));
const n = award.load(rows, { season: '2026-27', source: 'Hatton award email 2026-09-14 (OCR, verified)' });
console.log('loaded', n, 'awarded sites for 2026-27');
console.log('seasons on file:', JSON.stringify(award.seasons()));

console.log('\n--- season inference sanity check ---');
const sage = require('./sage');
const led = require('./po-ledger').getPoLedger(sage.getCachedInvoices());
const snow = led.filter(p => p.serviceType === 'snow');
const bySeason = {};
for (const p of snow) { const s = award.seasonOfPo(p) || '(none)'; bySeason[s] = (bySeason[s] || 0) + 1; }
console.log('snow POs by inferred season:', JSON.stringify(bySeason));
const ex = snow.find(p => /TUL5/.test(String(p.docDescription || '')));
if (ex) console.log(`example: ${ex.poNumber} raised ${ex.orderDate} -> season ${award.seasonOfPo(ex)}  |  "${String(ex.docDescription).slice(0,52)}"`);
