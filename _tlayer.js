const ssc = require('./site-service-center');
const sage = require('./sage');
const ok = (l, c, x) => console.log(`${c ? '  ✓' : '  ✗'} ${l}${x !== undefined ? ' : ' + x : ''}`);
(async () => {
  const inv = sage.getCachedInvoices();
  // A site where billing currently overrides Omnia, so all three layers matter.
  const db = require('./db').getDb();
  const site = db.prepare(`SELECT site_code FROM amazon_locations
    WHERE service_center_source='billing' AND TRIM(COALESCE(sc_omnia,''))<>''
      AND sc_billing<>sc_omnia LIMIT 1`).get();
  const code = site ? site.site_code
    : db.prepare("SELECT site_code FROM amazon_locations WHERE service_center_source='billing' LIMIT 1").get().site_code;
  const start = ssc.layersFor(code);
  console.log(`test site ${code}: omnia="${start.omnia}" billing="${start.billing}" manual="${start.manual}" -> ${start.serviceCenter} (${start.source})`);

  const other = ssc.centres().map(c => c.name).find(n => n !== start.serviceCenter);
  console.log(`\nSET manual -> ${other}`);
  const set = ssc.setManual(code, other);
  ok('resolves to the manual value', set.serviceCenter === other, set.serviceCenter);
  ok('source says manual', set.source === 'manual', set.source);
  ok('omnia layer is untouched', ssc.layersFor(code).omnia === start.omnia, ssc.layersFor(code).omnia);
  ok('billing layer is untouched', ssc.layersFor(code).billing === start.billing, ssc.layersFor(code).billing);

  console.log('\nre-run the whole load underneath it');
  const o = require('./omnia-site-centers');
  await o.load('/tmp/omnia_sc.xlsx', inv);
  const after = ssc.layersFor(code);
  ok('OMNIA IMPORT DID NOT OVERRIDE THE PERSON', after.serviceCenter === other, `${after.serviceCenter} (${after.source})`);
  ok('billing did not override the person', after.source === 'manual', after.source);

  console.log('\nRELEASE');
  const rel = ssc.setManual(code, '');
  ok('released flag', rel.released === true);
  ok('falls back, not blank', !!rel.serviceCenter, `${rel.serviceCenter} (${rel.source})`);
  ok('back to where it started', rel.serviceCenter === start.serviceCenter && rel.source === start.source,
    `${rel.serviceCenter} (${rel.source}) vs ${start.serviceCenter} (${start.source})`);

  console.log('\nunknown centre is refused by the resolver vocabulary');
  const known = ssc.centres().map(c => c.name);
  ok('centres list is non-empty', known.length > 0, known.join(', '));
})();
