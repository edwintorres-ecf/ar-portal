const db = require('./db');
const payee = require('./payee');
const idx = payee.getIndex();
const money = n => '$' + Math.round(n || 0).toLocaleString('en-US');
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const rows = db.all(`SELECT created_at, record_no, detail FROM audit_log
  WHERE action='edi_transmit' AND detail LIKE '%-> OK%'
    AND created_at >= '2026-09-16' AND created_at < '2026-09-17' ORDER BY created_at`);
console.log('--- 2026-09-16 transmits, resolved correctly ---');
let landed = 0; const missing = [];
for (const r of rows) {
  const id = (String(r.detail).match(/^(\S+)\s/) || [])[1] || '';
  const key = norm(id);
  // suffix-aware: AST002765, AST002765A, AST002765B ...
  const hits = Object.keys(idx).filter(k => k === key || (k.startsWith(key) && /^[A-Z]$/.test(k.slice(key.length))));
  if (hits.length) { landed++; console.log(`  ✓ ${id.padEnd(13)} -> ${hits.join(', ')}  ${idx[hits[0]].status}`); }
  else { missing.push(id); console.log(`  ✗ ${id.padEnd(13)} NOT IN PAYEE`); }
}
console.log(`\nlanded ${landed} / missing ${missing.length}: ${missing.join(', ') || 'none'}`);

console.log('\n--- rejection emails: full table scan for this invoice ---');
const rej = db.all('SELECT * FROM edi_rejections');
console.log('rejection rows on file:', rej.length);
for (const r of rej) {
  const blob = JSON.stringify(r).toUpperCase();
  if (/002765/.test(blob)) console.log('  HIT', JSON.stringify(r).slice(0, 400));
}
const sep = rej.filter(r => String(r.received_at || '').startsWith('2026-09-16') || String(r.received_at || '').startsWith('2026-09-17'));
console.log(`  rejections received 16-17 Sep: ${sep.length}`);
for (const r of sep.slice(0, 8)) console.log('   ', r.received_at, '|', r.invoice_key, '|', String(r.error || '').slice(0, 90));
