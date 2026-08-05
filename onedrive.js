'use strict';
/**
 * onedrive.js — OneDrive/Graph API PDF search for ECF AR Portal
 * Searches Atlas/Invoices/ for PDF matching invoice number patterns.
 */

require('dotenv').config();

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const USER_EMAIL = 'edwin.torres@eastcoastfacilities.com';
const TENANT_ID  = process.env.AZURE_TENANT_ID;
const CLIENT_ID  = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;

// ─── Token cache ────────────────────────────────────────────────────────────
let _tokenCache = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_tokenCache && Date.now() < _tokenExpiry - 60000) return _tokenCache;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  });

  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('OneDrive token error: ' + JSON.stringify(data));

  _tokenCache = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in * 1000);
  return _tokenCache;
}

async function graphGet(path, params = {}) {
  const token = await getToken();
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const res = await fetch(`${GRAPH_BASE}${path}${qs}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Graph ${path} → ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Get Edwin's drive ID ───────────────────────────────────────────────────
let _driveId = null;
async function getDriveId() {
  if (_driveId) return _driveId;
  const data = await graphGet(`/users/${USER_EMAIL}/drive`);
  _driveId = data.id;
  return _driveId;
}

// ─── Folder cache ────────────────────────────────────────────────────────────
// Cache Omnia-PDFs folder listing to avoid repeated API calls per request
let _omniaCache = null;
let _omniaCacheTime = 0;
const OMNIA_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function getOmniaFolder(driveId, token) {
  if (_omniaCache && Date.now() - _omniaCacheTime < OMNIA_CACHE_TTL) return _omniaCache;
  const res = await fetch(
    `${GRAPH_BASE}/drives/${driveId}/root:/Atlas/Invoices/Omnia-PDFs:/children` +
    `?$select=id,name,@microsoft.graph.downloadUrl&$top=999`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  _omniaCache = data.value || [];
  _omniaCacheTime = Date.now();
  console.log(`[onedrive] Omnia-PDFs cached: ${_omniaCache.length} files`);
  return _omniaCache;
}

// ─── Search for invoice PDF ──────────────────────────────────────────────────
/**
 * Search for a PDF matching the invoice number.
 * Strategy by prefix:
 *   S-xxxx  → Atlas/Invoices/Omnia-PDFs/S-xxxx.pdf (exact/partial match)
 *   ECI-    → Sage RECORDURL handled in app.js before this call; fallback Graph search
 *   SPI-,AST-,SS-,STM-,ASTM- → Graph search across drive
 * Returns { found, downloadUrl, itemId, driveId, name, source } or { found: false }
 */
async function findInvoicePdf(invoiceId, recordNo) {
  try {
    const driveId = await getDriveId();
    const token = await getToken();

    // Strategy 1: S- prefix → Omnia-PDFs folder (fast cached lookup)
    if (invoiceId && /^S-/i.test(invoiceId)) {
      const items = await getOmniaFolder(driveId, token);

      // Exact filename match: S-6227.pdf
      const target = invoiceId.toUpperCase() + '.pdf';
      let match = items.find(item => item.name && item.name.toUpperCase() === target);

      // Partial: strip leading zeros — S-06227 vs S-6227
      if (!match) {
        const numPart = invoiceId.replace(/^S-0*/i, '').replace(/^0+/, '');
        match = items.find(item => {
          if (!item.name || !item.name.toUpperCase().startsWith('S-')) return false;
          const itemNum = item.name.replace(/^S-0*/i, '').replace('.pdf', '').replace(/^0+/, '');
          return itemNum === numPart;
        });
      }

      if (match) {
        return {
          found: true,
          name: match.name,
          itemId: match.id,
          driveId,
          downloadUrl: match['@microsoft.graph.downloadUrl'] || null,
          source: 'omnia',
        };
      }
    }

    // Strategy 2: Graph search (works for ECI-, SPI-, AST-, etc.)
    const searchTerms = [];
    if (invoiceId) searchTerms.push(invoiceId);
    if (recordNo && String(recordNo) !== invoiceId) searchTerms.push(String(recordNo));

    for (const term of searchTerms) {
      try {
        const searchRes = await fetch(
          `${GRAPH_BASE}/drives/${driveId}/root/search(q='${encodeURIComponent(term)}')` +
          `?$select=id,name,@microsoft.graph.downloadUrl,parentReference&$top=10`,
          { headers: { Authorization: 'Bearer ' + token } }
        );
        if (searchRes.ok) {
          const data = await searchRes.json();
          const items = (data.value || []).filter(i => i.name && i.name.toLowerCase().endsWith('.pdf'));
          const match = items.find(item => item.name.toLowerCase().includes(term.toLowerCase()));
          if (match) {
            return {
              found: true,
              name: match.name,
              itemId: match.id,
              driveId,
              downloadUrl: match['@microsoft.graph.downloadUrl'] || null,
              source: 'onedrive',
            };
          }
        }
      } catch (e) {
        console.log(`[onedrive] search error for '${term}':`, e.message);
      }
    }

    return { found: false };
  } catch (e) {
    console.error('[onedrive] findInvoicePdf error:', e.message);
    return { found: false, error: e.message };
  }
}

/**
 * Get a temporary download URL for a known item.
 */
async function getDownloadUrl(driveId, itemId) {
  const token = await getToken();
  const res = await fetch(`${GRAPH_BASE}/drives/${driveId}/items/${itemId}/content`, {
    headers: { Authorization: 'Bearer ' + token },
    redirect: 'manual',
  });
  if (res.status === 302 || res.status === 301) {
    return res.headers.get('location');
  }
  const data = await graphGet(`/drives/${driveId}/items/${itemId}?$select=@microsoft.graph.downloadUrl`);
  return data['@microsoft.graph.downloadUrl'] || null;
}

module.exports = {
  findInvoicePdf,
  getDownloadUrl,
  getDriveId,
  getToken,
};
