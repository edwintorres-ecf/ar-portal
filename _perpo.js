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
const money = n => n == null ? 'n/a' : '$' + Math.round(n).toLocaleString('en-US');

async function latestPoPdf(po) {
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
      let amt = null;
      const mm = text.match(/([\d,]+\.\d{2})\s*(?:USD\s*)?\n?\s*Purchase Order Total/i)
             || text.match(/USD\s+([\d,]+\.\d{2})\s*\n\s*Purchase Order Total/i);
      if (mm) amt = parseFloat(mm[1].replace(/,/g, ''));
      const ver = (text.match(/PURCHASE ORDER:\s*VERSION:\s*[\dA-Z-]+\s+(\d+)/i) || [])[1] || null;
      const rev = (text.match(/REVISED DATE:\s*([\d/]+)/i) || [])[1] || null;
      return { amount: amt, version: ver, revised: rev, subject: m.subject, at: m.receivedDateTime, file: a.name };
    }
  }
  return null;
}

(async () => {
  const inv = sage.getCachedInvoices();
  const dc = require('./po-doc-recheck').latest();
  console.log('Checking the mailbox for each ceiling-discrepancy PO:\n');
  let match = 0, found = 0;
  for (const d of dc) {
    try {
      const e = await latestPoPdf(d.poNumber);
      if (!e) { console.log(`  ${d.poNumber}  no email found`); continue; }
      found++;
      const agrees = e.amount != null && d.amazon != null && Math.abs(e.amount - d.amazon) <= 1;
      if (agrees) match++;
      console.log(`  ${d.poNumber}  Amazon ${money(d.amazon).padStart(12)} | filed ${money(d.newest).padStart(11)} | EMAIL ${money(e.amount).padStart(12)} v${e.version} rev ${e.revised || '-'}  ${agrees ? '<< EMAIL MATCHES AMAZON' : ''}`);
    } catch (err) { console.log(`  ${d.poNumber}  ! ${err.message}`); }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`\nemails found ${found}/${dc.length}; the emailed PDF matches Amazon on ${match}`);
})();
