require('dotenv').config();
const { PDFParse } = require('pdf-parse');
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
  const r = await fetch(GRAPH + u, { headers: { Authorization: 'Bearer ' + (await token()), ConsistencyLevel: 'eventual' } });
  if (!r.ok) throw new Error('graph ' + r.status);
  return r.json();
}
async function pdfFor(po) {
  const res = await g(`/users/${MB}/messages?$search="${po}"&$top=20&$select=id,subject,receivedDateTime,hasAttachments`);
  const msgs = (res.value || []).filter(m => m.hasAttachments && (m.subject || '').includes(po))
    .sort((a, b) => String(b.receivedDateTime).localeCompare(String(a.receivedDateTime)));
  for (const m of msgs) {
    const atts = await g(`/users/${MB}/messages/${encodeURIComponent(m.id)}/attachments`);
    for (const a of atts.value || []) {
      if (!/pdf/i.test(a.contentType || '') && !/\.pdf$/i.test(a.name || '')) continue;
      if (!a.contentBytes) continue;
      let text = '';
      try { text = (await new PDFParse({ data: Buffer.from(a.contentBytes, 'base64') }).getText()).text || ''; } catch (e) { continue; }
      if (!text.includes(po)) continue;
      const mm = text.match(/([\d,]+\.\d{2})\s*(?:USD\s*)?\n?\s*Purchase Order Total/i)
             || text.match(/USD\s+([\d,]+\.\d{2})\s*\n\s*Purchase Order Total/i);
      return { amount: mm ? parseFloat(mm[1].replace(/,/g, '')) : null };
    }
  }
  return null;
}
(async () => {
  const a = require('./po-intake-health').analyse(sage.getCachedInvoices());
  for (const key of ['no-document', 'value-unpublished']) {
    const c = a.checks.find(x => x.key === key);
    let found = 0, withAmount = 0, none = 0;
    for (const po of c.pos) {
      try {
        const r = await pdfFor(po);
        if (r) { found++; if (r.amount != null) withAmount++; } else none++;
      } catch (e) { none++; }
      await new Promise(r => setTimeout(r, 350));
    }
    console.log(`${c.label}: ${c.count} POs -> email PDF found for ${found}, of which ${withAmount} carry a value (no email: ${none})`);
  }
})();
