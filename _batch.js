const db = require('./db');
const payee = require('./payee');
const idx = payee.getIndex();
const money = n => '$' + Math.round(n || 0).toLocaleString('en-US');
const amt = s => parseFloat(String(s || '').replace(/[^0-9.-]/g, '')) || 0;
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

console.log('--- every EDI transmit on 2026-09-16, did it land? ---');
const rows = db.all(`SELECT created_at, record_no, detail FROM audit_log
  WHERE action='edi_transmit' AND detail LIKE '%-> OK%'
    AND created_at >= '2026-09-16' AND created_at < '2026-09-17' ORDER BY created_at`);
console.log('transmits that day:', rows.length);
let landed = 0, missing = [];
for (const r of rows) {
  const id = (String(r.detail).match(/^(\S+)\s/) || [])[1] || '';
  const po = (String(r.detail).match(/PO=(\S+)/) || [])[1] || '';
  const hit = payee.resolveInvoice(id);
  if (hit) landed++;
  else missing.push({ id, po, at: r.created_at });
}
console.log(`landed in Payee: ${landed}   |   never landed: ${missing.length}`);
for (const m of missing) console.log('   MISSING', m.id.padEnd(13), m.po.padEnd(14), m.at);

console.log('\n--- what DID land on 2D-20507144 that day, and for how much ---');
const same = Object.entries(idx).filter(([, v]) => v.po === '2D-20507144' && v.entryDate === 'Sep 16, 2026')
  .map(([id, v]) => ({ id, amount: amt(v.amount), status: v.status }))
  .sort((a, b) => b.amount - a.amount);
for (const s of same) console.log('   ', s.id.padEnd(13), money(s.amount).padStart(11), ' ', s.status);
console.log('   largest that landed:', money(Math.max(...same.map(s => s.amount))));
console.log('   AST-002765 was:     ', money(317761));
