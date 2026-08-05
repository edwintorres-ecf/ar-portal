// ─── PO site backfill from the arclerk PO-email PDFs ──────────────────────────
// For every PO with no site attribution, pull Amazon's original PO PDF from the
// arclerk mailbox (Graph Mail.Read), extract the site with the SAME tiered
// logic po-doc-watcher uses, and write it as an authoritative manual assignment
// (db.setPoSite — wins the whole site chain). Accurate: the source is Amazon's
// own document, not a guess.
require('dotenv').config();
const { PDFParse } = require('pdf-parse');
const db = require('./db');
const sage = require('./sage');
const poLedger = require('./po-ledger');

const T = process.env.AZURE_TENANT_ID, C = process.env.AZURE_CLIENT_ID, S = process.env.AZURE_CLIENT_SECRET;
const MAILBOX = process.env.PO_MAILBOX || 'arclerk@eastcoastfacilities.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const NON_SITE = new Set(['PO2', 'X12', 'W9', 'USD1', 'NET6', 'COVID1', 'A100', 'SW6795', 'LLC1', 'US1', 'ID1', 'PM1']);
const isSite = (t) => t && /^[A-Z]{2,4}\d{1,2}$/.test(t) && !/^2D/.test(t) && !NON_SITE.has(t);

let _tok = null, _exp = 0;
async function token() {
  if (_tok && Date.now() < _exp - 60000) return _tok;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: C, client_secret: S, scope: 'https://graph.microsoft.com/.default' });
  const r = await fetch(`https://login.microsoftonline.com/${T}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j = await r.json(); _tok = j.access_token; _exp = Date.now() + j.expires_in * 1000; return _tok;
}
async function g(url) {
  const r = await fetch(GRAPH + url, { headers: { Authorization: 'Bearer ' + (await token()), ConsistencyLevel: 'eventual' } });
  if (!r.ok) throw new Error('graph ' + r.status);
  return r.json();
}

// Same extraction tiers as po-doc-watcher v6 (SHIP TO first token → paren → Attn
// → desc "SITE - 20xx" → desc-lead → frequency).
function extractSite(text) {
  const shipTo = (text.match(/SHIP\s*TO:[\s\S]{0,220}?SEND INVOICES/i) || text.match(/SHIP\s*TO:[\s\S]{0,220}/i) || [''])[0];
  let s = (shipTo.match(/SHIP\s*TO:\s*([A-Z]{2,4}\d{1,2})\b/i) || [])[1];
  if (isSite(s)) return s;
  s = (shipTo.match(/\(([A-Z]{2,4}\d{1,2})(?=[\s)])/) || [])[1];
  if (isSite(s)) return s;
  s = (shipTo.match(/Attn:\s*([A-Z]{2,4}\d{1,2})\b/i) || [])[1];
  if (isSite(s)) return s;
  s = (text.match(/(?:^|\s)([A-Z]{2,4}\d{1,2})\s*-\s*20\d\d/) || [])[1];
  if (isSite(s)) return s;
  const desc = (text.match(/Unit Price\s*Total([\s\S]*?)INVOICE INFORMATION/i) || [])[1];
  s = desc ? (desc.match(/^\s*\d*\s*([A-Z]{2,4}\d{1,2})\b/) || [])[1] : null;
  if (isSite(s)) return s;
  const counts = {};
  for (const m of text.matchAll(/\b([A-Z]{2,4}\d{1,2})\b/g)) { if (isSite(m[1])) counts[m[1]] = (counts[m[1]] || 0) + 1; }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null;
}

// Find the PO's email, download its PDF attachment(s), extract the site.
async function siteFromEmail(po) {
  const enc = encodeURIComponent(`"${po}"`);
  const res = await g(`/users/${MAILBOX}/messages?$search=${enc}&$top=5&$select=id,subject,hasAttachments,receivedDateTime`);
  const msgs = (res.value || []).filter(m => m.hasAttachments);
  for (const m of msgs) {
    const atts = await g(`/users/${MAILBOX}/messages/${encodeURIComponent(m.id)}/attachments`);
    for (const a of (atts.value || [])) {
      if (!/pdf/i.test(a.contentType || '') && !/\.pdf$/i.test(a.name || '')) continue;
      if (!a.contentBytes) continue;
      // Only trust a PDF that actually names this PO (avoid a batch attachment)
      const buf = Buffer.from(a.contentBytes, 'base64');
      let text = '';
      try { text = (await new PDFParse({ data: buf }).getText()).text || ''; } catch (e) { continue; }
      if (!text.includes(po) && !text.includes(po.replace('-', ''))) continue;
      const site = extractSite(text);
      if (site) return { site, source: m.subject, date: m.receivedDateTime };
    }
  }
  return null;
}

// Backfill sites from PO emails. `poList` optional; defaults to every ledger PO
// with no site. `verbose` logs per-PO. Returns a summary. Safe to run on a
// schedule — it only touches POs still lacking a site, which trends to zero.
async function runBackfill(poList, verbose = true) {
  let targets = poList;
  if (!targets) {
    let invs = sage.getCachedInvoices(); if (!invs.length) invs = await sage.getInvoices();
    targets = poLedger.getPoLedger(invs).filter(r => !r.siteCode).map(r => r.poNumber);
  }
  if (verbose) console.log(`[po-email-backfill] scanning ${targets.length} PO email(s)…`);
  let assigned = 0, noEmail = 0, noSite = 0;
  for (const po of targets) {
    try {
      const hit = await siteFromEmail(po);
      if (hit && hit.site) {
        db.setPoSite(po, hit.site, 'po-email-backfill');
        try { db.auditLog('po-email-backfill', 'po_site_assign', po, `${hit.site} (from PO email)`); } catch (e) {}
        if (verbose) console.log(`  ✓ ${po} -> ${hit.site}`);
        assigned++;
      } else if (hit === null) { if (verbose) console.log(`  · ${po} -> no PO email / no PDF found`); noEmail++; }
      else { if (verbose) console.log(`  ? ${po} -> PDF found but no site in it`); noSite++; }
    } catch (e) { if (verbose) console.log(`  ! ${po} -> ${e.message}`); }
    await new Promise(r => setTimeout(r, 400));
  }
  const summary = { targets: targets.length, assigned, noEmail, noSite };
  if (verbose) console.log(`[po-email-backfill] DONE — assigned ${assigned}, no-email ${noEmail}, no-site-in-pdf ${noSite}, of ${targets.length}`);
  return summary;
}

module.exports = { runBackfill, siteFromEmail, extractSite };

if (require.main === module) {
  const only = process.argv[2] ? process.argv[2].split(',') : null;
  runBackfill(only).then(() => process.exit(0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
}
