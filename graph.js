'use strict';
// ─── graph.js — shared Microsoft Graph client (app-only) ─────────────────────
// One client-credentials token cache + fetch helpers for every NEW code path
// (customer comms, inbound mail, dunning). Existing modules (ops-alerts,
// onedrive, po-doc-watcher, po-email-backfill, app.js MSAL) keep their own
// working token flows; new code must come through here instead of adding a
// fifth cache. 429/503 responses are retried once honoring Retry-After.
//
// The AR communications mailbox is AR_MAILBOX (invoices@eastcoastfacilities.com).
// It is resolved lazily via mailbox() so requiring this module never throws;
// callers that actually touch the mailbox fail loudly if the env var is absent.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Dedicated comms app registration when configured (AR_GRAPH_*): a separate
// Entra app holding ONLY Mail permissions, scoped by an Exchange
// ApplicationAccessPolicy to invoices@ — the shared AZURE_* registration
// (recruit calendars, OneDrive, SharePoint) stays untouched. Falls back to
// the shared app until the dedicated one is configured.
const TENANT_ID = process.env.AR_GRAPH_TENANT_ID || process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AR_GRAPH_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AR_GRAPH_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;
const GRAPH = 'https://graph.microsoft.com/v1.0';

let _token = null, _tokenExp = 0;
async function token() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('graph token error: ' + (data.error_description || data.error || 'no access_token'));
  _token = data.access_token; _tokenExp = Date.now() + data.expires_in * 1000;
  return _token;
}

// The shared AR communications mailbox. Throws only when actually used.
function mailbox() {
  const mb = (process.env.AR_MAILBOX || '').trim();
  if (!mb) throw new Error('AR_MAILBOX is not set in .env — comms features are unavailable');
  return mb;
}

// Canonical form for every email address persisted or compared by comms code.
// user_roles holds mixed-case UPNs and exact-match lookups exist elsewhere;
// inbound routing must never miss on case.
function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

// Application-level mailbox restriction (chosen over an Exchange
// ApplicationAccessPolicy because the app registration is shared with other
// systems): any /users/<mailbox>/ call through this client must target an
// approved mailbox. Guards against portal bugs reaching other mailboxes;
// does NOT protect against stolen app credentials used outside this code.
function assertMailboxAllowed(url) {
  const m = /\/users\/([^\/?]+)/i.exec(url);
  if (!m) return;
  const target = normEmail(decodeURIComponent(m[1]));
  if (!target.includes('@')) return;   // object ids, not addresses
  const allowed = new Set([
    normEmail(process.env.AR_MAILBOX || ''),
    'arclerk@eastcoastfacilities.com',
    ...(process.env.GRAPH_MAILBOX_ALLOWLIST || '').split(',').map(normEmail),
  ].filter(Boolean));
  if (!allowed.has(target)) throw new Error(`graph.js mailbox guard: ${target} is not an approved mailbox`);
}

async function gFetch(method, pathOrUrl, body, extraHeaders) {
  const url = /^https:/i.test(pathOrUrl) ? pathOrUrl : GRAPH + pathOrUrl;
  assertMailboxAllowed(url);
  const doFetch = async () => fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + (await token()),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(extraHeaders || {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let res = await doFetch();
  if (res.status === 429 || res.status === 503) {
    const wait = Math.min(60, parseInt(res.headers.get('retry-after') || '5', 10)) * 1000;
    await new Promise(r => setTimeout(r, wait));
    res = await doFetch();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`graph ${method} ${pathOrUrl} -> ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status === 204 || res.status === 202) return null;
  const ct = res.headers.get('content-type') || '';
  return /json/i.test(ct) ? res.json() : res.text();
}

const gGet = (p, h) => gFetch('GET', p, undefined, h);
const gPost = (p, b, h) => gFetch('POST', p, b, h);
const gPatch = (p, b, h) => gFetch('PATCH', p, b, h);
const gDelete = (p, h) => gFetch('DELETE', p, undefined, h);

module.exports = { token, mailbox, normEmail, gGet, gPost, gPatch, gDelete, GRAPH };
