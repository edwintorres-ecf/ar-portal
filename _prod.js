const sage = require('./sage');
const money = n => '$' + Math.round(n || 0).toLocaleString('en-US');
(async () => {
  const inv = sage.getCachedInvoices();
  const b = require('./po-intake-health').analyse(inv);
  console.log(`BEFORE: ${b.totals.posWithDefects} defects · ${b.totals.blocking} blocking · ${money(b.totals.atRisk)} at risk`);
  const r = await require('./po-mail-docs').ingest(null, { invoices: inv });
  console.log('ingest:', JSON.stringify(r));
})();
