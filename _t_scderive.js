// Derive against a COPY of the database, so nothing is written to production
// until the result is inspected.
'use strict';
require('dotenv').config();
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SRC = '/home/ecf-admin/ar-portal/ar-portal.db';
const TMP = '/tmp/_scderive.db';
try { fs.unlinkSync(TMP); } catch (e) {}
const src = new DatabaseSync(SRC, { readOnly: true });
src.exec(`VACUUM INTO '${TMP}'`);
src.close();
process.env.DB_PATH = TMP;

const sage = require('./sage');
const sc = require('./site-service-center');
const ok = (l, c, x) => console.log(`${c ? '  ✓' : '  ✗'} ${l}${x !== undefined ? ' : ' + x : ''}`);

(async () => {
  const inv = sage.getCachedInvoices().length ? sage.getCachedInvoices() : await sage.getInvoices();
  const db = require('./db').getDb();

  const before = db.prepare(`SELECT COUNT(*) n,
      SUM(CASE WHEN TRIM(COALESCE(service_center,''))<>'' THEN 1 ELSE 0 END) withSc
    FROM amazon_locations`).get();
  console.log(`before: ${before.withSc} of ${before.n} sites have a service centre\n`);

  const r = sc.derive(inv);
  console.log(`derivation:`);
  console.log(`  unambiguous assignments : ${r.assign.length}`);
  console.log(`  ambiguous (left alone)  : ${r.ambiguous.length}`);
  console.log(`  no evidence             : ${r.noEvidence.length}`);
  ok('every assignment maps to a real ECF location', r.assign.every(a => a.locationId),
    `${r.assign.filter(a => !a.locationId).length} without a location id`
    + (r.assign.filter(a => !a.locationId).length ? ': ' + r.assign.filter(a => !a.locationId).map(a => a.serviceCenter).slice(0, 3).join(', ') : ''));
  for (const a of r.assign.slice(0, 6)) {
    console.log(`    ${a.site.padEnd(6)} -> ${String(a.serviceCenter).padEnd(28)} ${a.locationId || '?'}   (${a.basis})`);
  }
  console.log('  ambiguous, needing a person:');
  for (const a of r.ambiguous.slice(0, 5)) {
    console.log(`    ${a.site.padEnd(6)} ${a.options.map(o => `${o.location} (${o.invoices})`).join('  vs  ')}`);
  }

  const applied = sc.apply(inv);
  const after = db.prepare(`SELECT COUNT(*) n,
      SUM(CASE WHEN TRIM(COALESCE(service_center,''))<>'' THEN 1 ELSE 0 END) withSc,
      SUM(CASE WHEN service_center_source='derived' THEN 1 ELSE 0 END) derived,
      SUM(CASE WHEN service_center_source='declared' THEN 1 ELSE 0 END) declared
    FROM amazon_locations`).get();
  console.log(`\nafter apply: ${after.withSc} of ${after.n} (${after.declared} declared, ${after.derived} derived)`);
  ok('declared values untouched', after.declared === before.withSc, `${after.declared} vs ${before.withSc} before`);
  ok('rows written', applied.written > 0, `${applied.written} updated, ${applied.created} new site rows`);

  // Re-running must be a no-op.
  const again = sc.apply(inv);
  const after2 = db.prepare(`SELECT SUM(CASE WHEN TRIM(COALESCE(service_center,''))<>'' THEN 1 ELSE 0 END) withSc FROM amazon_locations`).get();
  ok('IDEMPOTENT', after2.withSc === after.withSc, `${after2.withSc} still`);

  // What it does to PO coverage.
  require('./po-ledger').invalidatePoLedger();
  const ledger = require('./po-ledger').getPoLedger(inv);
  const covered = ledger.filter(p => p.siteServiceCenter).length;
  console.log(`\nPO coverage now: ${covered} of ${ledger.length} (${Math.round(covered / ledger.length * 100)}%)`);
  const bySc = {};
  for (const p of ledger.filter(x => x.siteServiceCenter)) {
    bySc[p.siteServiceCenter] = (bySc[p.siteServiceCenter] || 0) + 1;
  }
  for (const [k, v] of Object.entries(bySc).sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(30)} ${v}`);

  const pend = sc.unassigned(inv);
  console.log(`\nstill needing a person: ${pend.length} sites`);
  for (const p of pend.slice(0, 6)) console.log(`    ${p.site.padEnd(6)} ${p.why}`);

  fs.unlinkSync(TMP);
  console.log('\n(ran against a copy; production untouched)');
})();
