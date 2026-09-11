const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const mod = require('/home/ecf-admin/ar-portal/amazon-bu-workbook');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const invs = sage.getCachedInvoices();
(async () => {
  for (const bu of ['NACF', 'Logistics']) {
    const a = mod.analyseBu(invs, { bu });
    console.log(`\n=== ${bu} ===`);
    console.log('  stalled total            ', M(a.stalled.total.amount));
    console.log('   — needs funding         ', M(a.stalled.needsFunding.amount), `(${a.stalled.needsFunding.count} invoices)`);
    console.log('   — goods receipt only    ', M(a.stalled.noFundingNeeded.amount), `(${a.stalled.noFundingNeeded.count} invoices)`);
    console.log('  short across sites       ', M(a.totalShort), `(${a.shortSites.length} sites)`);
    console.log('  excess available         ', M(a.excess), `(${a.excessSites.length} sites)`);
    console.log('  VARIANCE OF FUNDING      ', M(a.variance));
  }
  const out = await mod.buildBuWorkbook(invs, { bu: 'Logistics' });
  await out.workbook.xlsx.writeFile('/tmp/log.xlsx');
  console.log('\nLogistics workbook sheets:', out.workbook.worksheets.map(w => w.name).join(' | '));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message, e.stack.split('\n')[1]); process.exit(1); });
