// Measure contact-extraction coverage across a real sample of PO PDFs before
// wiring anything into the watcher.
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const fs = require('fs');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SITE_ID = process.env.PO_DOCS_SITE_ID
  || 'eastcoastfacilities.sharepoint.com,e6bfda85-4ff5-4582-9b24-e6886260694c,c0616ddd-c081-450c-8567-ddbc1f5310b4';

async function getToken() {
  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID, client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token');
  return j.access_token;
}

// ─── candidate extractor ────────────────────────────────────────────────────
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

function extractContacts(text) {
  const out = { name: null, email: null, source: null, attnName: null, revisedBy: null };

  // 1. The labelled field. Amazon prints a header row then a values row:
  //    "ORDER DATE: \t PURCHASER CONTACT: \t TERMS: ..." then
  //    "09/09/2025 \t Amber Steward (ambstew@amazon.com) \t 60 NET"
  const block = text.match(/PURCHASER CONTACT:[^\n]*\n([^\n]*)/i);
  if (block) {
    const line = block[1];
    const m = line.match(/([A-Za-z][A-Za-z.'\- ]{1,60}?)\s*\(\s*(<EMAIL>)\s*\)/.source.replace('<EMAIL>', EMAIL_RE.source));
    const re = new RegExp(/([A-Za-z][A-Za-z.'\- ]{1,60}?)\s*\(\s*([\w.+-]+@[\w-]+\.[\w.-]+)\s*\)/);
    const hit = line.match(re);
    if (hit) { out.name = hit[1].trim(); out.email = hit[2].trim().toLowerCase(); out.source = 'purchaser-contact'; }
    else {
      const justEmail = line.match(EMAIL_RE);
      if (justEmail) { out.email = justEmail[0].toLowerCase(); out.source = 'purchaser-contact-email'; }
    }
  }

  // 2. "Attn: <Name>" in the SHIP TO block — a person, not a site code.
  const shipTo = (text.match(/SHIP\s*TO:[\s\S]{0,300}?(?:SEND INVOICES|ORDER DATE)/i) || [''])[0];
  const attn = shipTo.match(/Attn:\s*([^\n]+)/i);
  if (attn) {
    const v = attn[1].trim();
    if (!/^[A-Z]{2,4}\d{1,2}$/.test(v) && v !== '-' && v.length > 2) out.attnName = v.slice(0, 60);
  }

  // 3. Who revised it, when revised.
  const rev = text.match(/REVISED BY:[^\n]*\n([^\n]*)/i);
  if (rev) {
    const re2 = new RegExp(/([A-Za-z][A-Za-z.'\- ]{1,60}?)\s*\(\s*([\w.+-]+@[\w-]+\.[\w.-]+)\s*\)/);
    const hit = rev[1].match(re2);
    if (hit) out.revisedBy = { name: hit[1].trim(), email: hit[2].toLowerCase() };
  }

  // 4. Last resort: any amazon.com address anywhere in the document.
  if (!out.email) {
    const any = text.match(/[\w.+-]+@amazon\.com/i);
    if (any) { out.email = any[0].toLowerCase(); out.source = 'anywhere'; }
  }
  return out;
}

(async () => {
  const { PDFParse } = require('pdf-parse');
  const doc = JSON.parse(fs.readFileSync('/home/ecf-admin/ar-portal/po-docs.json', 'utf8'));
  const entries = Object.entries(doc.byPo).filter(([, d]) => d.latestFile);
  // Spread the sample across the corpus rather than taking the first N.
  const N = Number(process.argv[2] || 24);
  const step = Math.max(1, Math.floor(entries.length / N));
  const sample = entries.filter((_, i) => i % step === 0).slice(0, N);
  const token = await getToken();
  const stats = { total: 0, name: 0, email: 0, attn: 0, revised: 0, none: 0, bySource: {} };
  const rows = [];
  for (const [po, d] of sample) {
    const f = d.latestFile;
    const enc = encodeURIComponent(f.folder).replace(/%2F/g, '/') + '/' + encodeURIComponent(f.name);
    let res;
    for (let a = 0; ; a++) {
      res = await fetch(`${GRAPH}/sites/${SITE_ID}/drive/root:/${enc}:/content`, { headers: { Authorization: 'Bearer ' + token } });
      if (res.ok) break;
      if ((res.status === 429 || res.status === 503) && a < 3) { await new Promise(r => setTimeout(r, 8000)); continue; }
      break;
    }
    if (!res.ok) { rows.push([po, 'FETCH ' + res.status]); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const text = (await new PDFParse({ data: buf }).getText()).text || '';
    const c = extractContacts(text);
    stats.total++;
    if (c.name) stats.name++;
    if (c.email) { stats.email++; stats.bySource[c.source] = (stats.bySource[c.source] || 0) + 1; }
    if (c.attnName) stats.attn++;
    if (c.revisedBy) stats.revised++;
    if (!c.email && !c.attnName) stats.none++;
    rows.push([po, d.docSiteCode || '-', c.name || '-', c.email || '-', c.attnName || '-', c.revisedBy ? c.revisedBy.email : '-']);
  }
  for (const r of rows) console.log(r.join('  |  '));
  console.log('\n--- coverage over ' + stats.total + ' PO documents ---');
  console.log('name:', stats.name, ' email:', stats.email, ' attn:', stats.attn, ' revisedBy:', stats.revised, ' nothing:', stats.none);
  console.log('email source:', JSON.stringify(stats.bySource));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
