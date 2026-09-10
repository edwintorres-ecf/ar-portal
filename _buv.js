const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const mod = require('/home/ecf-admin/ar-portal/amazon-bu-workbook');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();

console.log('Business units available:');
for (const b of mod.listBusinessUnits(invs)) console.log('  ', b.bu.padEnd(14), String(b.invoices).padStart(5), 'open invoices', M(b.amount).padStart(14));

mod.buildBuWorkbook(invs, { bu: 'NACF', seasonKey: '2025-26' }).then(async (out) => {
  const a = out.analysis;
  console.log('\n=== NACF SUMMARY ===');
  console.log('Pending Goods Receipt Hold :', String(a.stalled.pgr.count).padStart(4), M(a.stalled.pgr.amount).padStart(14));
  console.log('Insufficient PO Funds Hold :', String(a.stalled.funds.count).padStart(4), M(a.stalled.funds.amount).padStart(14));
  console.log('Invoice cannot be delivered:', String(a.stalled.undeliverable.count).padStart(4), M(a.stalled.undeliverable.amount).padStart(14));
  console.log('TOTAL STALLED              :', String(a.stalled.total.count).padStart(4), M(a.stalled.total.amount).padStart(14));
  console.log('Excess funding available   :', String(a.excessPos.length).padStart(4), M(a.excess).padStart(14), 'POs with spare');
  console.log('Variance of funding needed :', ' '.repeat(4), M(a.variance).padStart(14));
  console.log('sheets:', out.workbook.worksheets.map(w => w.name).join(' | '));
  const s2 = out.workbook.getWorksheet('Detail by PO');
  const s3 = out.workbook.getWorksheet('Detail by site code');
  console.log('Detail by PO rows:', s2.rowCount, '· Detail by site rows:', s3.rowCount);
  await out.workbook.xlsx.writeFile('/tmp/nacf.xlsx');
  console.log('written /tmp/nacf.xlsx');
  process.exit(0);
}).catch(e => { console.error('ERR', e.message, e.stack.split('\n')[1]); process.exit(1); });
