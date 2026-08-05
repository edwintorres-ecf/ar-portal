'use strict';
/**
 * omnia.js — Omnia PDF client for ECF AR Portal
 *
 * Runs directly on ecf-spark. Uses local Chromium (snap) via playwright-core
 * to authenticate with Omnia and fetch invoice PDFs via the JWT API.
 *
 * Prefixes served: S-, SPI-, AST-, ASTM-, SS-, STM-
 * ECI- and other Intacct-native invoices: not in Omnia.
 */

const path = require('path');
const { chromium } = require('./node_modules/playwright-core');

const OMNIA_BASE     = 'https://ecf.omnia-sds.com';
const CHROMIUM_PATH  = '/usr/bin/chromium-browser';
const OMNIA_PREFIXES = /^(S|SPI|AST|ASTM|SS|STM)-/i;

// Token cache
let _browser  = null;
let _context  = null;
let _token    = null;
let _tokenTs  = 0;
let _loginPromise = null; // mutex — only one login at a time
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 min

function log(msg) { console.log(`[omnia] ${msg}`); }

async function ensureBrowser() {
  if (_browser) {
    try {
      // quick connectivity check
      if (_browser.isConnected()) return _browser;
    } catch {}
  }
  log('Launching Chromium...');
  _browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  return _browser;
}

async function refreshToken() {
  const email    = process.env.OMNIA_EMAIL    || 'Edwin.Torres@eastcoastfacilities.com';
  const password = process.env.OMNIA_PASSWORD || process.env.OMNIA_PASS || '';

  if (!password) throw new Error('OMNIA_PASSWORD not set in environment');

  if (_context) { try { await _context.close(); } catch {} }
  const browser = await ensureBrowser();
  _context = await browser.newContext({ acceptDownloads: false });
  const page = await _context.newPage();

  log('Logging in to Omnia...');
  await page.goto(`${OMNIA_BASE}/login`);
  await page.waitForLoadState('networkidle');
  await page.locator('input').nth(0).fill(email);
  await page.locator('input').nth(1).fill(password);
  await page.click('button:has-text("Login")');
  await page.waitForURL(u => !String(u).includes('/login'), { timeout: 30000 });
  await page.waitForLoadState('networkidle');

  const raw = await page.evaluate(() => localStorage.getItem('access_token'));
  _token   = raw ? ((() => { try { return JSON.parse(raw); } catch { return raw; } })()) : null;
  _tokenTs = Date.now();
  await page.close();

  if (!_token) throw new Error('Omnia login succeeded but no access_token in localStorage');
  // Close browser to free RAM — token is cached in-process; re-launch only on expiry
  try { await _context.close(); _context = null; } catch {}
  try { await _browser.close(); _browser = null; } catch {}
  log('Token acquired');
  return _token;
}

async function getToken() {
  if (_token && Date.now() - _tokenTs < TOKEN_TTL_MS) return _token;
  // Mutex: if login already in flight, wait for it
  if (_loginPromise) return _loginPromise;
  _loginPromise = refreshToken().finally(() => { _loginPromise = null; });
  return _loginPromise;
}

/**
 * Fetch invoice PDF from Omnia API.
 * Returns: { found, buf, contentType, filename } or { found: false, error }
 */
async function fetchInvoicePdf(invoiceId) {
  if (!invoiceId) return { found: false, error: 'No invoice ID' };

  let token;
  try { token = await getToken(); } catch (e) {
    return { found: false, error: 'Omnia login failed: ' + e.message };
  }

  const apiUrl = `${OMNIA_BASE}/api/Invoice/GetInvoicePdf/${encodeURIComponent(invoiceId)}`;

  async function attempt(tok) {
    const res = await fetch(apiUrl, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
      signal:  AbortSignal.timeout(30000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(`HTTP ${res.status}`);
    }
    if (res.status === 404) {
      return { found: false, error: `Invoice ${invoiceId} not found in Omnia` };
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { found: false, error: `Omnia API ${res.status}: ${txt.slice(0, 200)}` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.slice(0, 4).toString('ascii').startsWith('%PDF')) {
      return { found: false, error: `Omnia response for ${invoiceId} is not a PDF` };
    }

    return {
      found:       true,
      buf,
      contentType: 'application/pdf',
      filename:    `${invoiceId}.pdf`,
      source:      'omnia',
    };
  }

  try {
    return await attempt(token);
  } catch (e) {
    if (e.message.startsWith('HTTP 4')) {
      // Token expired — force refresh and retry once
      log(`Token expired for ${invoiceId}, refreshing...`);
      _token = null;
      try {
        const tok2 = await getToken();
        return await attempt(tok2);
      } catch (e2) {
        return { found: false, error: 'Omnia retry failed: ' + e2.message };
      }
    }
    return { found: false, error: e.message };
  }
}

/** Returns true if this invoiceId is served by Omnia */
function isOmniaInvoice(invoiceId) {
  return OMNIA_PREFIXES.test(invoiceId || '');
}

/** Warm up token on module load (non-blocking) */
function warmUp() {
  if (process.env.OMNIA_PASSWORD || process.env.OMNIA_PASS) {
    getToken().then(() => log('Token warmed up')).catch(e => log('Warm-up failed: ' + e.message));
  } else {
    log('OMNIA_PASSWORD not set — skipping warm-up (will auth on first request)');
  }
}

// ─── Invoice List (for AR portal unified view) ─────────────────────────────

const OMNIA_INVOICE_PREFIXES = /^(S|SPI|AST|ASTM|SS|STM)-/i;

/**
 * Fetch all Omnia invoices for the AR portal.
 * Paginates through POST /api/Invoice/GetInvoices and flattens plan→region→invoice.
 * Returns normalized invoice objects (same shape used by sage.js getInvoices).
 * computeAgingBucket must be passed in to avoid circular require.
 */
async function fetchOmniaInvoices(computeAgingBucket) {
  let token;
  try { token = await getToken(); } catch (e) {
    throw new Error('Omnia login failed: ' + e.message);
  }

  const PAGE_SIZE = 1000;
  let page = 1;
  let totalRecords = null;
  const allInvoices = [];
  let retried = false;

  while (true) {
    let res;
    try {
      res = await fetch(OMNIA_BASE + '/api/Invoice/GetInvoices', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageSize: PAGE_SIZE, page }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new Error('Omnia GetInvoices network error: ' + e.message);
    }

    if ((res.status === 401 || res.status === 403) && !retried) {
      log('Token expired during invoice fetch, refreshing...');
      _token = null;
      token = await getToken();
      retried = true;
      continue;
    }

    if (!res.ok) throw new Error('Omnia GetInvoices HTTP ' + res.status);

    const j = await res.json();
    if (!j.isValid) throw new Error('Omnia GetInvoices error: ' + (j.message || 'unknown'));

    const collection = j.data && j.data.collection ? j.data.collection : [];
    const paging = j.data && j.data.pagingModel ? j.data.pagingModel : {};
    if (totalRecords === null) totalRecords = paging.totalRecords || 0;
    retried = false;

    for (const plan of collection) {
      for (const region of (plan.regions || [])) {
        for (const inv of (region.invoices || [])) {
          if (!OMNIA_INVOICE_PREFIXES.test(inv.invoiceId || '')) continue;

          const amount = parseFloat(String(inv.amount || '0').replace(/[^0-9.\-]/g, '')) || 0;
          const invoiceDate = inv.invoiceDate ? inv.invoiceDate.split('T')[0] : null;
          const aging = computeAgingBucket ? computeAgingBucket(invoiceDate) : { bucket: 'current', daysOverdue: 0 };

          allInvoices.push({
            recordNo:      inv.id || '',
            invoiceId:     inv.invoiceId || '',
            customerId:    '',
            customerName:  inv.accountName || '',
            locationId:    '',
            locationName:  inv.locationName || '',
            whenCreated:   invoiceDate,
            whenDue:       invoiceDate,
            totalEntered:  amount,
            totalDue:      amount,
            currency:      'USD',
            state:         'Open',
            poNumber:      '',
            description:   inv.planName || inv.workTicketId || '',
            bucket:        aging.bucket,
            daysOverdue:   aging.daysOverdue,
            source:        'omnia',
            omniaStatus:   plan.invoiceStatus,
            omniaUploaded: plan.uploadedStatus,
            serviceCenter: inv.serviceCenter || '',
            workTicketId:  inv.workTicketId || '',
          });
        }
      }
    }

    const fetched = (page - 1) * PAGE_SIZE + collection.length;
    if (collection.length < PAGE_SIZE || fetched >= totalRecords) break;
    page++;
    if (page > 50) { log('Safety cap reached at page 50'); break; }
  }

  log('Fetched ' + allInvoices.length + ' Omnia invoices (total plans: ' + totalRecords + ')');
  return allInvoices;
}

module.exports = { fetchInvoicePdf, isOmniaInvoice, warmUp, fetchOmniaInvoices };
