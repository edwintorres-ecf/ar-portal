// Parse EVERY document we hold for a PO, newest-by-date first, and show what
// each one says. The watcher only ever parses the file with the highest "v"
// number, which is not necessarily the newest document.
'use strict';
require('dotenv').config();
const fs = require('fs');
const { PDFParse } = require('pdf-parse');

const GRAPH = 'https://graph.microsoft.com/v1.0';
// Not in .env — the watcher carries this as its default, so mirror it exactly.
const SITE_ID = process.env.PO_DOCS_SITE_ID
  || 'eastcoastfacilities.sharepoint.com,e6bfda85-4ff5-4582-9b24-e6886260694c,c0616ddd-c081-450c-8567-ddbc1f5310b4';
const PO = process.argv[2] || '2D-20300544';

async function getToken() {
  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    { method: 'POST', body });
  const j = await r.json();
  if (!j.access_token) throw new Error('token: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function textOf(folder, name, token) {
  // Same encoding as the watcher: folder segments kept as separators, file name escaped.
  const enc = encodeURIComponent(folder).replace(/%2F/g, '/') + '/' + encodeURIComponent(name);
  const res = await fetch(`${GRAPH}/sites/${SITE_ID}/drive/root:/${enc}:/content`,
    { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('fetch ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return (await new PDFParse({ data: buf }).getText()).text || '';
}

// Same extractors the watcher uses, so this is comparable rather than a second opinion.
const amountOf = t => {
  const m = t.match(/([\d,]+\.\d{2})\s*(?:USD\s*)?\n?\s*Purchase Order Total/i)
         || t.match(/USD\s+([\d,]+\.\d{2})\s*\n\s*Purchase Order Total/i);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
};
const versionOf = t => (t.match(/PURCHASE ORDER:\s*VERSION:\s*[\dA-Z-]+\s+(\d+)/i) || [])[1] || null;
const orderDate = t => (t.match(/ORDER\s*DATE[:\s]*([\d]{4}-[\d]{2}-[\d]{2}|[\d]{1,2}\/[\d]{1,2}\/[\d]{4})/i) || [])[1] || null;
const revDate  = t => (t.match(/REVISED[:\s]*([\d]{4}-[\d]{2}-[\d]{2}|[\d]{1,2}\/[\d]{1,2}\/[\d]{4})/i) || [])[1] || null;

(async () => {
  const docs = JSON.parse(fs.readFileSync('po-docs.json', 'utf8'));
  const rec = docs.byPo[PO];
  if (!rec) return console.log('no documents for ' + PO);
  const token = await getToken();

  console.log(`${PO} — ${rec.files.length} document(s) on SharePoint`);
  console.log(`currently used by the portal: ${rec.latestFile.name}  (docAmount $${(rec.docAmount || 0).toLocaleString('en-US')})\n`);

  const byDate = rec.files.slice().sort((a, b) =>
    String(b.docDate).localeCompare(String(a.docDate)) || String(b.modified).localeCompare(String(a.modified)));

  for (const f of byDate) {
    let line;
    try {
      const t = await textOf(f.folder, f.name, token);
      const amt = amountOf(t);
      const desc = (t.match(/\n\s*1\s+[A-Z]{2,5}\d[^\n]{0,90}/) || [''])[0].replace(/\s+/g, ' ').trim();
      line = `$${amt == null ? '?' : amt.toLocaleString('en-US')}`.padEnd(14)
        + `internal v${versionOf(t) || '?'}`.padEnd(14)
        + `order ${orderDate(t) || '?'}  revised ${revDate(t) || '—'}`;
      console.log(`${f.docDate}  ${f.name}`);
      console.log(`            ${line}`);
      if (desc) console.log(`            ${desc.slice(0, 96)}`);
    } catch (e) {
      console.log(`${f.docDate}  ${f.name}\n            FAILED: ${e.message}`);
    }
  }
})();
