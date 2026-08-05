'use strict';
/**
 * po-doc-watcher.js — watch the SharePoint folder where Amazon PO PDFs land and
 * reconcile it with the PO ledger.
 *
 * Folder (Accounting & Finance site → Documents library):
 *   01. AR & Customers/a. Customer Master Files/Amazon/Purchase Orders/2026
 *
 * Filenames encode everything we need without opening the PDF:
 *   PO-2D-16060738_v2_20241223.pdf  →  PO 2D-16060738, version 2, dated 2024-12-23
 * The version number IS the revision counter (v1 original, v2/v3 revisions).
 *
 * Read-only: lists the folder via Microsoft Graph (app/client-credentials, the
 * same registration onedrive.js uses — Sites.Read.All is already granted) and
 * writes a cache the ledger reads. Does not download PDFs (see the optional
 * amount cross-check follow-up).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;

// Accounting & Finance SharePoint site (resolved via /sites?search=Accounting).
const SITE_ID = process.env.PO_DOCS_SITE_ID
  || 'eastcoastfacilities.sharepoint.com,e6bfda85-4ff5-4582-9b24-e6886260694c,c0616ddd-c081-450c-8567-ddbc1f5310b4';
// Folder paths within the site's default Documents drive. Scans EVERY year
// folder listed (older POs' docs live in prior-year folders — scanning 2026
// alone left ~630 open POs with no doc and therefore no site attribution).
// 2024-and-earlier POs are out of tracking scope, so only current-era year
// folders are scanned (their docs would only ever attribute retired POs).
const PO_DOCS_YEARS = (process.env.PO_DOCS_YEARS || process.env.PO_DOCS_YEAR || '2025,2026')
  .split(',').map(s => s.trim()).filter(Boolean);
const PO_DOCS_BASE = '01. AR & Customers/a. Customer Master Files/Amazon/Purchase Orders';
// The base folder itself is scanned too: email-intake PDFs land there loose
// (e.g. "2026-05-18 - Amazon PO # 2D-21375690.pdf") before anyone renames and
// files them into a year folder.
const PO_DOCS_FOLDERS = process.env.PO_DOCS_FOLDER
  ? [process.env.PO_DOCS_FOLDER]
  : [PO_DOCS_BASE, ...PO_DOCS_YEARS.map(y => `${PO_DOCS_BASE}/${y}`)];

const OUT_PATH = path.join(__dirname, 'po-docs.json');
const FILENAME_RE = /^PO-(2D-\d+)_v(\d+)_(\d{8})\.pdf$/i;
// Site-shaped tokens that are never actually ECF site codes (form boilerplate,
// product SKUs, tax/legal codes seen in materials POs).
const NON_SITE_TOKENS = new Set(['PO2', 'X12', 'W9', 'USD1', 'NET6', 'COVID1', 'A100', 'SW6795', 'LLC1', 'US1', 'ID1', 'PM1']);
// Loose intake naming: any .pdf mentioning a 2D-number (e.g. "2026-05-18 -
// Amazon PO # 2D-21375690.pdf"). Treated as version 0 so a properly-filed
// PO-*_vN document always wins over the raw email drop.
const LOOSE_RE = /(2D-\d{6,})[^/]*\.pdf$/i;

let _token = null, _tokenExp = 0;
async function getToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Graph token error: ' + JSON.stringify(data).slice(0, 200));
  _token = data.access_token; _tokenExp = Date.now() + data.expires_in * 1000;
  return _token;
}

async function listFolder(folder) {
  const token = await getToken();
  const enc = encodeURIComponent(folder).replace(/%2F/g, '/');
  let url = `${GRAPH}/sites/${SITE_ID}/drive/root:/${enc}:/children?$select=name,webUrl,lastModifiedDateTime,size&$top=200`;
  const files = [];
  let guard = 0;
  while (url && guard++ < 30) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error(`Graph list → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    for (const f of (j.value || [])) { f._folder = folder; files.push(f); }
    url = j['@odata.nextLink'] || null;
  }
  return files;
}

function ymd(s) { return s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null; }

// Fetch a file's bytes through Graph (in memory — nothing is saved) and pull the
// PO total, internal version, ship-to site code, and revised marker out of the
// text. Amounts/site codes are a redundant cross-check against Payee Central.
async function fetchAndExtract(fileName, folder) {
  const { PDFParse } = require('pdf-parse');
  const enc = encodeURIComponent(folder || PO_DOCS_FOLDERS[PO_DOCS_FOLDERS.length - 1]).replace(/%2F/g, '/') + '/' + encodeURIComponent(fileName);
  // Graph throttles bulk downloads (observed: 910 straight 429s on a full
  // re-parse). Honor Retry-After and back off; a slow full pass beats a fast
  // one that loses 3/4 of its data.
  let res;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken();
    res = await fetch(`${GRAPH}/sites/${SITE_ID}/drive/root:/${enc}:/content`, { headers: { Authorization: 'Bearer ' + token } });
    if (res.ok) break;
    if ((res.status === 429 || res.status === 503) && attempt < 5) {
      const wait = (parseInt(res.headers.get('retry-after'), 10) || 15) * 1000;
      await new Promise(r => setTimeout(r, wait + attempt * 5000));
      continue;
    }
    throw new Error('fetch ' + res.status);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const parsed = await new PDFParse({ data: buf }).getText();
  const text = parsed.text || '';
  let amount = null;
  let m = text.match(/([\d,]+\.\d{2})\s*(?:USD\s*)?\n?\s*Purchase Order Total/i)
       || text.match(/USD\s+([\d,]+\.\d{2})\s*\n\s*Purchase Order Total/i);
  if (m) amount = parseFloat(m[1].replace(/,/g, ''));
  const pdfVersion = (text.match(/PURCHASE ORDER:\s*VERSION:\s*[\dA-Z-]+\s+(\d+)/i) || [])[1] || null;
  // Site extraction — Amazon FC codes are 3-4 upper letters + 1 digit (DTW1,
  // MDW5, HMW3). Layouts vary; try in confidence order:
  const shipTo = (text.match(/SHIP\s*TO:[\s\S]{0,220}?SEND INVOICES/i) || text.match(/SHIP\s*TO:[\s\S]{0,220}/i) || [''])[0];
  const isSite = (t) => t && /^[A-Z]{2,4}\d{1,2}$/.test(t) && !/^2D/.test(t) && !NON_SITE_TOKENS.has(t);
  let siteCode = null;
  //   1. Site is the FIRST token after "SHIP TO:" ("SHIP TO: MKE1 Non-Inventory",
  //      "SHIP TO: DVA5 11920 Balls Ford Rd") — the most common materials layout.
  { const s = (shipTo.match(/SHIP\s*TO:\s*([A-Z]{2,4}\d{1,2})\b/i) || [])[1]; if (isSite(s)) siteCode = s; }
  //   2. "(DTW1)" or "(EWR9 NI)" parenthesized in the SHIP TO block
  if (!isSite(siteCode)) { const p = (shipTo.match(/\(([A-Z]{2,4}\d{1,2})(?=[\s)])/) || [])[1]; siteCode = isSite(p) ? p : null; }
  //   3. "Attn: MDW5" in the SHIP TO block — "Amazon.com Services LLC … Attn: MDW5"
  if (!isSite(siteCode)) { const a = (shipTo.match(/Attn:\s*([A-Z]{2,4}\d{1,2})\b/i) || [])[1]; siteCode = a && isSite(a) ? a : null; }
  //   3. "SITE - 20xx" leading the line-item description ("1 DUJ3 - 2026 - …")
  if (!isSite(siteCode)) { const d = (text.match(/(?:^|\s)([A-Z]{2,4}\d{1,2})\s*-\s*20\d\d/) || [])[1]; siteCode = isSite(d) ? d : null; }
  //   4. any site-shaped token appearing in BOTH the description and elsewhere,
  //      or the most frequent site-shaped token (>=2) anywhere (last resort)
  if (!isSite(siteCode)) {
    const counts = {};
    for (const mm of text.matchAll(/\b([A-Z]{2,4}\d{1,2})\b/g)) { const t = mm[1]; if (isSite(t)) counts[t] = (counts[t] || 0) + 1; }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2) siteCode = best[0];
  }
  if (!isSite(siteCode)) siteCode = null;
  const revised = /\*\*\* REVISED \*\*\*/i.test(text);
  // Line-item description carries the service type (Snow Removal / Landscaping / striping…)
  const descMatch = text.match(/Unit Price\s*Total([\s\S]*?)INVOICE INFORMATION/i);
  let description = descMatch ? descMatch[1].replace(/\s+/g, ' ').trim().slice(0, 200) : null;
  // Word-boundary matters: bare /ice/ falsely matches "Services", "Office", etc.
  const isSnow = description ? /\bsnow\b|\bice\b/i.test(description) : false;
  // Signals resolved GLOBALLY in scanPoDocs (need the whole corpus):
  //  - descLeadSite: a site-shaped token leading the description ("HMW3 yard sweep")
  //  - shipToAddr: normalized street+city of the SHIP TO block, so a learned
  //    address→site map can attribute pure-materials POs (no site token at all).
  const descLeadSite = description ? (description.match(/^\s*\d*\s*([A-Z]{2,4}\d{1,2})\b/) || [])[1] || null : null;
  // Address between "Services LLC" and the Attn/SEND line. [\s\S] (not .) so it
  // spans the newlines present in raw PDF text; then collapse to a stable key.
  const addrM = shipTo.match(/Services LLC([\s\S]+?)(?:Attn:|SEND INVOICES)/i);
  const shipToAddr = addrM
    ? addrM[1].replace(/\s+/g, ' ').replace(/[.,]/g, '')
        .replace(/^\s*\([A-Z0-9]+\)\s*/, '')      // strip a leading "(ORH3)" so all PO types key alike
        .replace(/\d{5}(-\d{4})?\s*$/, '')          // drop trailing ZIP
        .trim().toUpperCase().slice(0, 90)
    : null;
  return { amount, pdfVersion: pdfVersion ? parseInt(pdfVersion, 10) : null, docSiteCode: siteCode, pdfRevised: revised, description, isSnow, descLeadSite, shipToAddr: shipToAddr || null, siteExtractV: 6 };
}

// Small concurrency limiter so we don't fire hundreds of parses at once.
async function mapLimit(items, limit, fn) {
  const results = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return results;
}

async function scanPoDocs(opts = {}) {
  const parseContent = opts.parseContent !== false; // default: also extract amounts
  const force = opts.force === true;                 // re-parse even cached files
  const files = [];
  for (const folder of PO_DOCS_FOLDERS) {
    try {
      files.push(...await listFolder(folder));
    } catch (e) {
      console.warn(`[po-doc-watcher] folder "${folder}" list failed (${e.message.slice(0, 100)}) — continuing with other years`);
    }
  }
  const byPo = {};
  let matched = 0, unmatched = 0;
  for (const f of files) {
    let poNumber, version, docDate;
    const m = FILENAME_RE.exec(f.name || '');
    if (m) {
      poNumber = m[1].toUpperCase(); version = parseInt(m[2], 10); docDate = ymd(m[3]);
    } else {
      const lm = LOOSE_RE.exec(f.name || '');
      if (!lm) { unmatched++; continue; }
      poNumber = lm[1].toUpperCase(); version = 0;
      const dm = (f.name || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      docDate = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
    }
    matched++;
    const rec = { name: f.name, folder: f._folder, version, docDate, webUrl: f.webUrl || null, modified: f.lastModifiedDateTime || null };
    if (!byPo[poNumber]) byPo[poNumber] = { poNumber, latestVersion: 0, versionCount: 0, files: [], latestFile: null };
    const entry = byPo[poNumber];
    entry.files.push(rec);
    entry.versionCount = entry.files.length;
    // Higher version wins; same version across year folders → later doc date wins.
    if (version > entry.latestVersion || (version === entry.latestVersion && (!entry.latestFile || (rec.docDate || '') >= (entry.latestFile.docDate || '')))) {
      entry.latestVersion = version; entry.latestFile = rec;
    }
  }
  for (const e of Object.values(byPo)) e.revised = e.latestVersion > 1;

  // ── PDF content cross-check ──────────────────────────────────────────────
  // Carry forward already-extracted amounts (keyed by exact filename) so each
  // scan only parses newly-arrived PDFs — steady-state this is nearly free.
  let parsedNew = 0, parseErrors = 0;
  if (parseContent) {
    let prevByFile = {};
    if (!force) {
      try {
        const prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
        for (const e of Object.values(prev.byPo || {})) {
          // Reuse a cached parse UNLESS this file needs a site-extraction retry:
          // keep it if it's already on the current extractor (v3) OR it already
          // has a site. Only pre-v3 entries still missing a site get re-parsed —
          // ~57 PDFs, not all ~1,900, so no Graph 429 storm.
          // v4 adds shipToAddr/descLeadSite (needed on ALL docs to learn the
          // address→site map), so anything below v4 re-parses once.
          if (e.latestFile && e.docAmount !== undefined && (e.siteExtractV === 6 || e.docSiteCode)) {
            prevByFile[e.latestFile.name] = { docAmount: e.docAmount, pdfVersion: e.pdfVersion, docSiteCode: e.docSiteCode, pdfRevised: e.pdfRevised, description: e.description, isSnow: e.isSnow, descLeadSite: e.descLeadSite, shipToAddr: e.shipToAddr, docParseError: e.docParseError, siteExtractV: e.siteExtractV };
          }
        }
      } catch (e) { /* first run */ }
    }

    const toParse = [];
    for (const e of Object.values(byPo)) {
      if (!e.latestFile) continue;
      const cached = prevByFile[e.latestFile.name];
      if (cached) { Object.assign(e, cached); }   // unchanged file — reuse
      else toParse.push(e);
    }
    await mapLimit(toParse, 2, async (e) => {
      try {
        await new Promise(r => setTimeout(r, 250));   // gentle pacing for Graph
        const x = await fetchAndExtract(e.latestFile.name, e.latestFile.folder);
        e.docAmount = x.amount;
        e.pdfVersion = x.pdfVersion;
        e.docSiteCode = x.docSiteCode;
        e.pdfRevised = x.pdfRevised;
        e.description = x.description;
        e.isSnow = x.isSnow;
        e.descLeadSite = x.descLeadSite;
        e.shipToAddr = x.shipToAddr;
        e.siteExtractV = x.siteExtractV;
        e.docParseError = null;
        parsedNew++;
      } catch (err) {
        e.docAmount = e.docAmount ?? null;
        e.docParseError = err.message.slice(0, 120);
        parseErrors++;
      }
    });
  }

  // ── Global site backfill (needs the whole corpus) ────────────────────────
  // Learn an address→site map from every PO that DID resolve a site, then
  // attribute the ones that didn't: pure-materials POs ship to the same
  // physical FCs as the snow/service POs, so their SHIP TO address reveals the
  // site even when no site token appears anywhere in their own document.
  const entries = Object.values(byPo);
  const addrVotes = {};   // shipToAddr -> { SITE: count }
  for (const e of entries) {
    if (e.docSiteCode && e.shipToAddr) {
      (addrVotes[e.shipToAddr] = addrVotes[e.shipToAddr] || {})[e.docSiteCode] =
        ((addrVotes[e.shipToAddr] || {})[e.docSiteCode] || 0) + 1;
    }
  }
  const addrToSite = {};
  for (const [addr, votes] of Object.entries(addrVotes)) {
    const win = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    // Only trust an address with a single unambiguous site (no split FCs).
    if (win.length === 1 || win[0][1] > win[1][1]) addrToSite[addr] = win[0][0];
  }
  let backfillDesc = 0, backfillAddr = 0;
  const validSite = (t) => t && /^[A-Z]{2,4}\d{1,2}$/.test(t) && !NON_SITE_TOKENS.has(t);
  for (const e of entries) {
    if (e.docSiteCode) continue;
    if (validSite(e.descLeadSite)) { e.docSiteCode = e.descLeadSite; e.siteSource = 'desc-lead'; backfillDesc++; continue; }
    if (e.shipToAddr && addrToSite[e.shipToAddr]) { e.docSiteCode = addrToSite[e.shipToAddr]; e.siteSource = 'address-map'; backfillAddr++; }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'po-doc-watcher',
    folder: PO_DOCS_FOLDERS.join(' + '),
    totalFiles: files.length,
    matchedFiles: matched,
    unmatchedFiles: unmatched,
    distinctPos: Object.keys(byPo).length,
    parsedNew,
    parseErrors,
    backfillDesc,
    backfillAddr,
    knownAddresses: Object.keys(addrToSite).length,
    byPo,
  };
  const tmp = OUT_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, OUT_PATH);
  console.log(`[po-doc-watcher] ${matched} files / ${out.distinctPos} POs (${unmatched} non-matching); parsed ${parsedNew} new PDF(s), ${parseErrors} parse error(s); backfilled ${backfillDesc} by desc + ${backfillAddr} by address (${out.knownAddresses} addresses learned) → ${OUT_PATH}`);
  return out;
}

module.exports = { scanPoDocs };

if (require.main === module) {
  scanPoDocs().then(() => process.exit(0)).catch(e => { console.error('[po-doc-watcher] FAILED:', e.message); process.exit(1); });
}
