const fs = require('fs');
const sage = require('./sage');
const db = require('./db').getDb();
(async () => {
  const inv = sage.getCachedInvoices();
  const f = `/home/ecf-admin/ar-portal/backups/amazon_locations-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(f, JSON.stringify(db.prepare('SELECT * FROM amazon_locations').all()));
  console.log('revert file:', f);

  const before = db.prepare('SELECT COUNT(*) n FROM amazon_locations').get().n;
  const r = await require('./omnia-site-centers').load('/tmp/omnia_sc.xlsx', inv);
  console.log(`omnia: written ${r.omnia.written} · new rows ${r.omnia.created} | billing ${r.billing.written}`);
  console.log(`amazon_locations: ${before} -> ${db.prepare('SELECT COUNT(*) n FROM amazon_locations').get().n}`);
  for (const s of ['KJAX', 'KBWI', 'IZON', 'TOWN', 'RCER', 'MOND', 'BOS', 'DIL']) {
    const row = db.prepare('SELECT site_code, service_center, service_center_source FROM amazon_locations WHERE site_code=?').get(s);
    console.log(`  ${s.padEnd(5)} ${row ? row.service_center + ' (' + row.service_center_source + ')' : 'not in master'}`);
  }
})();
