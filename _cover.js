require('dotenv').config();
const sage = require('./sage');
const GRAPH = 'https://graph.microsoft.com/v1.0';
const MB = 'arclerk@eastcoastfacilities.com';
let _t = null, _e = 0;
async function token() {
  if (_t && Date.now() < _e - 60000) return _t;
  const b = new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default' });
  const r = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() });
  const j = await r.json(); _t = j.access_token; _e = Date.now() + j.expires_in * 1000; return _t;
}
async function g(u) {
  const r = await fetch(u.startsWith('http') ? u : GRAPH + u,
    { headers: { Authorization: 'Bearer ' + (await token()), ConsistencyLevel: 'eventual' } });
  if (!r.ok) throw new Error('graph ' + r.status);
  return r.json();
}
(async () => {
  // Every Amazon PO email, revised or not. $search caps pages, so walk them.
  const byPo = new Map();
  let url = `/users/${MB}/messages?$search="Purchase Order"&$top=100&$select=subject,receivedDateTime,hasAttachments`;
  let pages = 0;
  while (url && pages++ < 30) {
    const j = await g(url);
    for (const m of j.value || []) {
      const po = (m.subject || '').match(/2D-\d{6,}/);
      if (!po || !m.hasAttachments) continue;
      const revised = /revised/i.test(m.subject || '');
      const prev = byPo.get(po[0]);
      if (!prev || m.receivedDateTime > prev.at) byPo.set(po[0], { at: m.receivedDateTime, revised, subject: m.subject });
    }
    url = j['@odata.nextLink'] || null;
  }
  console.log(`PO emails with attachments in ${MB}: ${byPo.size} distinct POs (${pages} pages)`);
  const revisedCount = [...byPo.values()].filter(v => v.revised).length;
  console.log(`  of which the latest email is a REVISION: ${revisedCount}`);

  const inv = sage.getCachedInvoices();
  const a = require('./po-intake-health').analyse(inv);
  const has = (po) => byPo.has(po);
  const groups = {
    'PO value disagrees with the document': 'ceiling-discrepancy',
    'No PO document': 'no-document',
    'Amazon publishes no value for the PO': 'value-unpublished',
    'PO not visible in Amazon’s open-PO list': 'no-ceiling',
    'No site resolved': 'no-site',
  };
  console.log('\nhow much of intake health has an email waiting for it:');
  for (const [label, key] of Object.entries(groups)) {
    const c = a.checks.find(x => x.key === key);
    const covered = c.pos.filter(has);
    console.log(`  ${label.padEnd(40)} ${String(covered.length).padStart(3)} of ${String(c.count).padStart(3)}`);
  }
  const all = a.pos.map(p => p.poNumber);
  console.log(`\n  ANY defect                               ${all.filter(has).length} of ${all.length}`);
})();
