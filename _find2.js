require('dotenv').config();
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SITE_ID = process.env.PO_DOCS_SITE_ID
  || require('fs').readFileSync('po-doc-watcher.js', 'utf8').match(/PO_DOCS_SITE_ID\s*\|\|\s*'([^']+)'/)?.[1];
async function token() {
  const body = new URLSearchParams({ grant_type: 'client_credentials',
    client_id: process.env.AZURE_CLIENT_ID, client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default' });
  const r = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j = await r.json();
  if (!j.access_token) throw new Error(JSON.stringify(j).slice(0, 200));
  return j.access_token;
}
(async () => {
  const t = await token();
  for (const q of ['20599848', 'PO-2D-20599848']) {
    const url = `${GRAPH}/sites/${SITE_ID}/drive/root/search(q='${q}')?$top=50`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + t } });
    const j = await res.json();
    if (!res.ok) { console.log(q, '-> HTTP', res.status, JSON.stringify(j).slice(0, 200)); continue; }
    console.log(`\n"${q}" — ${(j.value || []).length} hit(s) anywhere in the drive:`);
    for (const f of j.value || []) {
      console.log(`  ${String(f.lastModifiedDateTime).slice(0, 10)}  ${f.name}`);
      console.log(`     ${(f.parentReference && f.parentReference.path || '').replace('/drive/root:', '')}`);
    }
  }
})();
