// Exercise the real sweepRejections/internalContactForSite out of app.js
// against live data, without starting the web server.
const fs = require('fs');
const src = fs.readFileSync('/home/ecf-admin/ar-portal/app.js', 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  // Start at the BODY brace, not a brace inside a destructured parameter
  // default like `({ notify = false } = {})`.
  const bodyStart = src.indexOf(') {', i);
  let d = 0, j = bodyStart + 2;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
}
const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const payee = require('/home/ecf-admin/ar-portal/payee');
const siteLedger = require('/home/ecf-admin/ar-portal/site-ledger');

const body = 'const REJECTED_STATUSES = new Set(["Rejected"]);\n'
  + grab('internalContactForSite') + '\n' + grab('sweepRejections')
  + '\n; return { sweepRejections, internalContactForSite };';
const M = new Function('db', 'sage', 'payee', 'siteLedger', 'notifyUser', 'portalBaseUrl', body)(
  db, sage, payee, siteLedger, async () => {}, () => 'https://ar.eastcoastfacilities.com');

const r = M.sweepRejections({ notify: false });
console.log('SWEEP:', JSON.stringify(r));
for (const row of db.listRejections()) {
  console.log('  ', row.payee_id, '|', row.invoice_id, '|', row.site_code || '(no site)', '|',
    row.business_unit || '-', '| $' + (row.amount || 0).toFixed(2), '| ->', row.routed_to || 'NOBODY');
}
console.log('summary:', JSON.stringify(db.rejectionSummary()));
