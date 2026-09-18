// For every PO flagged with a ceiling discrepancy, parse the NEWEST document we
// hold and ask whether it matches Amazon. That is the difference between "the
// document disagrees with Amazon" and "we are reading the wrong document".
'use strict';
require('dotenv').config();
const fs = require('fs');
const { PDFParse } = require('pdf-parse');
const sage = require('./sage');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SITE_ID = process.env.PO_DOCS_SITE_ID
  || 'eastcoastfacilities.sharepoint.com,e6bfda85-4ff5-4582-9b24-e6886260694c,c0616ddd-c081-450c-8567-ddbc1f5310b4';

let _tok = null, _tokAt = 0;
async function getToken() {
  if (_tok && Date.now() - _tokAt < 45 * 60 * 1000) return _tok;
  const body = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID, client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`, { method: 'POST', body });
  const j = await r.json();
  _tok = j.access_token; _tokAt = Date.now();
  return _tok;
}
async function textOf(folder, name) {
  const enc = encodeURIComponent(folder).replace(/%2F/g, '/') + '/' + encodeURIComponent(name);
  for (let a = 0; ; a++) {
    const res = await fetch(`${GRAPH}/sites/${SITE_ID}/drive/root:/${enc}:/content`,
      { headers: { Authorization: 'Bearer ' + (await getToken()) } });
    if (res.ok) return (await new PDFParse({ data: Buffer.from(await res.arrayBuffer()) }).getText()).text || '';
    if ((res.status === 429 || res.status === 503) && a < 4) {
      await new Promise(r => setTimeout(r, ((parseInt(res.headers.get('retry-after'), 10) || 10) * 1000) + a * 3000));
      continue;
    }
    throw new Error('fetch ' + res.status);
  }
}
const amountOf = t => {
  const m = t.match(/([\d,]+\.\d{2})\s*(?:USD\s*)?\n?\s*Purchase Order Total/i)
         || t.match(/USD\s+([\d,]+\.\d{2})\s*\n\s*Purchase Order Total/i);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
};
const internalV = t => (t.match(/PURCHASE ORDER:\s*VERSION:\s*[\dA-Z-]+\s+(\d+)/i) || [])[1] || null;

(async () => {
  const inv = sage.getCachedInvoices().length ? sage.getCachedInvoices() : await sage.getInvoices();
  const health = require('./po-intake-health').analyse(inv);
  const flagged = health.pos.filter(p => p.defects.includes('ceiling-discrepancy'));
  const ledger = require('./po-ledger').getPoLedger(inv);
  const docs = JSON.parse(fs.readFileSync('po-docs.json', 'utf8'));

  console.log(`${flagged.length} POs flagged with a ceiling discrepancy\n`);
  const money = n => n == null ? '?' : '$' + n.toLocaleString('en-US');
  let resolves = 0, stays = 0, unknown = 0, recovered = 0;

  for (const p of flagged) {
    const rec = docs.byPo[p.poNumber];
    const led = ledger.find(l => l.poNumber === p.poNumber) || {};
    const amazon = led.ceilingAmount;
    if (!rec || !rec.files || !rec.files.length) { console.log(`${p.poNumber}  no document`); unknown++; continue; }
    const key = f => `${f.docDate || ''}|${f.modified || ''}`;
    const newest = rec.files.slice().sort((a, b) => key(b).localeCompare(key(a)))[0];
    const usingNewest = newest.name === rec.latestFile.name;

    let amt = null, iv = null, err = null;
    try { const t = await textOf(newest.folder, newest.name); amt = amountOf(t); iv = internalV(t); }
    catch (e) { err = e.message; }

    const match = amt != null && amazon != null && Math.abs(amt - amazon) < 0.01;
    if (err || amt == null) unknown++;
    else if (match) { resolves++; if (!usingNewest) recovered++; }
    else stays++;

    console.log(`${p.poNumber.padEnd(15)} amazon ${money(amazon).padEnd(13)} portal-doc ${money(rec.docAmount).padEnd(13)}`
      + ` newest-doc ${(err ? 'ERR' : money(amt)).padEnd(13)} ${match ? '✓ RESOLVES' : (err || amt == null ? '? unreadable' : '✗ still differs')}`
      + `${usingNewest ? '' : '   (reading a stale file)'}`);
    if (!usingNewest) console.log(`${''.padEnd(15)} using ${rec.latestFile.name} (${rec.latestFile.docDate}), newest ${newest.name} (${newest.docDate}), internal v${iv || '?'}`);
  }

  console.log(`\nresolves by reading the newest document : ${resolves}  (${recovered} of them only because the newest file was not the one in use)`);
  console.log(`genuinely still disagree                : ${stays}`);
  console.log(`could not read                          : ${unknown}`);
})();
