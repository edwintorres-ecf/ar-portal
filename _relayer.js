const fs = require('fs');
const o = require('./omnia-site-centers');
const ssc = require('./site-service-center');
const db = require('./db').getDb();
const sage = require('./sage');
const ROOT = process.cwd();
(async () => {
  ssc.ensureColumn();
  const f = `${ROOT}/backups/amazon_locations-service_center-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.mkdirSync(`${ROOT}/backups`, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(db.prepare('SELECT * FROM amazon_locations').all()));
  console.log('revert file:', f);

  const inv = sage.getCachedInvoices().length ? sage.getCachedInvoices() : await sage.getInvoices();
  const r = await o.load('/tmp/omnia_sc.xlsx', inv);
  console.log('omnia layer written :', r.omnia.written, '| new', r.omnia.created, '| respelled', r.omnia.respelled);
  console.log('billing layer       :', r.billing.written, '| stale cleared', r.billing.cleared, '| ambiguous', r.billing.ambiguous.length);
  console.log('rows re-resolved    :', r.billing.resolved);

  const l = require('./po-ledger').getPoLedger(inv);
  const n = l.filter(p => p.siteServiceCenter).length;
  console.log(`\nPO coverage : ${n}/${l.length} (${Math.round(n / l.length * 100)}%)`);
  console.log('sources     :', JSON.stringify(db.prepare("SELECT COALESCE(service_center_source,'(none)') s, COUNT(*) n FROM amazon_locations WHERE TRIM(COALESCE(service_center,''))<>'' GROUP BY s").all()));
  console.log('layers set  :', JSON.stringify(db.prepare(`SELECT
      SUM(CASE WHEN TRIM(COALESCE(sc_omnia,''))<>'' THEN 1 ELSE 0 END) omnia,
      SUM(CASE WHEN TRIM(COALESCE(sc_billing,''))<>'' THEN 1 ELSE 0 END) billing,
      SUM(CASE WHEN TRIM(COALESCE(sc_manual,''))<>'' THEN 1 ELSE 0 END) manual
    FROM amazon_locations`).get()));
  console.log('Atlanta rows:', db.prepare("SELECT COUNT(*) n FROM amazon_locations WHERE service_center='Atlanta'").get().n);
})();
