// Dump the raw text of a few PO PDFs so we can see exactly what contact fields
// Amazon prints, before writing any extractor for them.
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const fs = require('fs');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SITE_ID = process.env.PO_DOCS_SITE_ID
  || 'eastcoastfacilities.sharepoint.com,e6bfda85-4ff5-4582-9b24-e6886260694c,c0616ddd-c081-450c-8567-ddbc1f5310b4';
const TENANT = process.env.AZURE_TENANT_ID;
const CLIENT = process.env.AZURE_CLIENT_ID;
const SECRET = process.env.AZURE_CLIENT_SECRET;

async function getToken() {
  const body = new URLSearchParams({
    client_id: CLIENT, client_secret: SECRET,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

(async () => {
  const { PDFParse } = require('pdf-parse');
  const doc = JSON.parse(fs.readFileSync('/home/ecf-admin/ar-portal/po-docs.json', 'utf8'));
  const entries = Object.entries(doc.byPo);
  const wanted = process.argv[2] ? entries.filter(([po]) => po === process.argv[2]) : entries.slice(0, Number(process.argv[3] || 3));
  const token = await getToken();
  for (const [po, d] of wanted) {
    const f = d.latestFile;
    if (!f) continue;
    const enc = encodeURIComponent(f.folder).replace(/%2F/g, '/') + '/' + encodeURIComponent(f.name);
    const res = await fetch(`${GRAPH}/sites/${SITE_ID}/drive/root:/${enc}:/content`, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) { console.log(po, 'fetch', res.status); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const parsed = await new PDFParse({ data: buf }).getText();
    console.log('\n========================= ' + po + ' (' + f.name + ') =========================');
    console.log(parsed.text);
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
