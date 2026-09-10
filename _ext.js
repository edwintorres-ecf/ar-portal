const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const mod = require('/home/ecf-admin/ar-portal/amazon-bu-workbook');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
mod.buildBuWorkbook(sage.getCachedInvoices(), { bu: 'NACF' }).then(async (out) => {
  const a = out.analysis;
  console.log('NACF, everything to date');
  console.log('  stalled  ', M(a.stalled.total.amount));
  console.log('  excess   ', M(a.excess), 'across', a.excessSites.length, 'sites');
  console.log('  variance ', M(a.variance));
  console.log('  of the available, sitting on', a.upcomingSeasonLabel, 'POs:', M(a.nextSeasonTotal));
  const orh = a.siteList.find(s => s.site === 'ORH3');
  console.log('  ORH3:', M(orh.available), 'total ·', M(orh.nextSeason), 'of it on', a.upcomingSeasonLabel, 'POs');
  await out.workbook.xlsx.writeFile('/tmp/nacf.xlsx');
  console.log('written');
  process.exit(0);
}).catch(e => { console.error('ERR', e.message, e.stack.split('\n')[1]); process.exit(1); });
