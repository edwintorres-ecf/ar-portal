// Are the revised PO documents sitting in a mailbox, unfiled?
require('dotenv').config();
const GRAPH = 'https://graph.microsoft.com/v1.0';
const T = process.env.AZURE_TENANT_ID, C = process.env.AZURE_CLIENT_ID, S = process.env.AZURE_CLIENT_SECRET;
let _t = null, _e = 0;
async function token() {
  if (_t && Date.now() < _e - 60000) return _t;
  const b = new URLSearchParams({ grant_type: 'client_credentials', client_id: C, client_secret: S, scope: 'https://graph.microsoft.com/.default' });
  const r = await fetch(`https://login.microsoftonline.com/${T}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() });
  const j = await r.json(); _t = j.access_token; _e = Date.now() + j.expires_in * 1000; return _t;
}
async function g(u) {
  const r = await fetch(GRAPH + u, { headers: { Authorization: 'Bearer ' + (await token()), ConsistencyLevel: 'eventual' } });
  if (!r.ok) throw new Error('graph ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}
(async () => {
  const boxes = ['arclerk@eastcoastfacilities.com', 'ar@eastcoastfacilities.com',
    'invoices@eastcoastfacilities.com', 'accountsreceivable@eastcoastfacilities.com'];
  for (const mb of boxes) {
    try {
      const res = await g(`/users/${mb}/messages?$search="Revised Purchase Order"&$top=100&$select=subject,receivedDateTime,hasAttachments`);
      const all = res.value || [];
      const withAtt = all.filter(m => m.hasAttachments);
      console.log(`\n${mb}`);
      console.log(`  "Revised Purchase Order": ${all.length} message(s), ${withAtt.length} with attachments`);
      const pos = new Set();
      for (const m of all) { const x = (m.subject || '').match(/2D-\d{6,}/); if (x) pos.add(x[0]); }
      console.log(`  distinct POs named in subjects: ${pos.size}`);
      for (const m of all.slice(0, 4)) console.log(`    ${String(m.receivedDateTime).slice(0, 10)}  ${m.subject}`);
    } catch (e) { console.log(`\n${mb}\n  ${e.message}`); }
  }
})();
