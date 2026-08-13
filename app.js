'use strict';
/**
 * app.js — ECF AR Aging Portal
 * East Coast Facilities Inc.
 * Port 3600 | Azure AD auth | Sage Intacct | OneDrive PDF
 */

require('dotenv').config();

const compression    = require('compression');
const express        = require('express');
const session        = require('express-session');
const path           = require('path');
const https          = require('https');
const fs             = require('fs');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const SqliteStore    = require('./session-store');

const sage    = require('./sage');
const omnia = require('./omnia');
const { generateEciPdf } = require('./eci-pdf-gen');
const db      = require('./db');
const payee   = require('./payee');
const { scrapePayeeCentral, scrapeOpenPOs } = require('./payee-scraper');
const { scrapePoDetails } = require('./payee-po-detail-scraper');
const { scanPoDocs } = require('./po-doc-watcher');
const poLedger = require('./po-ledger');
const ai       = require('./ai');
const ediBridge = require('./edi-bridge');
// Live EDI transmission stays OFF until explicitly armed via env. Dry-run
// (preview) is always available; the actual Transmit-to-Amazon path refuses
// to fire unless EDI_TRANSMIT_ARMED=true is set in .env.
const EDI_TRANSMIT_ARMED = process.env.EDI_TRANSMIT_ARMED === 'true';

// ─── Payee Central refresh controller ───────────────────────────────────────
// The scrape (invoice statuses, then the open-PO list) is a multi-minute
// headless-browser job. A single guarded controller is shared by the 30-min
// scheduler and the manual "Refresh" button so the two can never run at once
// (two Chromium logins would fight over the saved session).
let _payeeRefreshRunning = false;
let _payeeRefreshStarted = null;
let _payeeFailStreak = 0;
function doPayeeRefresh() {
  if (_payeeRefreshRunning) return { alreadyRunning: true, startedAt: _payeeRefreshStarted };
  _payeeRefreshRunning = true;
  _payeeRefreshStarted = new Date().toISOString();
  (async () => {
    const ops = require('./ops-alerts');
    try {
      const feed = await scrapePayeeCentral();
      payee.invalidateCache();
      _payeeFailStreak = 0;
      console.log(`[ar-portal] Payee Central refresh: ${feed.items.length} invoices at ${feed.generatedAt}`);
    } catch (e) {
      _payeeFailStreak++;
      console.warn(`[ar-portal] Payee Central refresh error (streak ${_payeeFailStreak}): ${e.message}`);
      // One failed scrape is routine (login hiccups). Three straight means the
      // pipeline is down and the feed is quietly going stale — page a human.
      if (_payeeFailStreak >= 3) {
        ops.raise('payee-refresh-streak', `Payee scrape failed ${_payeeFailStreak}x consecutively`,
          `Last error: ${e.message}\nThe feed is serving stale data until this recovers.`).catch(() => {});
      }
    }
    try {
      const out = await scrapeOpenPOs();
      payee.invalidateOpenPoCache();
      ops.ok('openpos-feed', `${out.total} POs`, out.total);
      console.log(`[ar-portal] Open-PO refresh: ${out.total} POs at ${out.generatedAt}`);
    } catch (e) {
      console.warn(`[ar-portal] Open-PO refresh error: ${e.message}`);
      ops.raise('openpos-refresh', 'Open-PO scrape failed', e.message, { minIntervalHours: 12, status: 'warn' }).catch(() => {});
    }
    _payeeRefreshRunning = false;
  })();
  return { started: true, startedAt: _payeeRefreshStarted };
}

// Per-PO detail scrape: walks every open PO's Payee Central detail page for
// Amazon's authoritative "Available amount" (the ledger's real "Value
// Remaining"). Heavier than the other scrapes (~1,100 page loads), so it runs
// on its own slower cadence and is guarded against overlap. The scraper itself
// degrades to stale-not-wrong and alerts on a high failure ratio.
let _poDetailRunning = false;
let _poDetailStartedAt = null;
function doPoDetailRefresh() {
  if (_poDetailRunning) return { alreadyRunning: true, startedAt: _poDetailStartedAt };
  _poDetailRunning = true;
  _poDetailStartedAt = new Date().toISOString();
  (async () => {
    const ops = require('./ops-alerts');
    try {
      const r = await scrapePoDetails();
      console.log(`[ar-portal] PO detail refresh: ok=${r.ok} failed=${r.failed} of ${r.total}`);
      if (r.total > 0) ops.ok('po-detail-feed', `${r.ok} POs, ${(r.failRatio * 100).toFixed(0)}% fail`, r.ok);
    } catch (e) {
      console.warn(`[ar-portal] PO detail refresh error: ${e.message}`);
      ops.raise('po-detail-refresh', 'PO detail scrape failed', e.message, { minIntervalHours: 12, status: 'warn' }).catch(() => {});
    }
    _poDetailRunning = false;
  })();
  return { started: true, startedAt: _poDetailStartedAt };
}

const app  = express();
app.set('trust proxy', 1); // Trust Cloudflare reverse proxy
app.use(compression());
const PORT = process.env.PORT || 3600;

// ─── Security headers ───────────────────────────────────────────────────────
// script-src/style-src allow 'unsafe-inline' because the entire frontend is one
// inline <script> block plus hundreds of inline onclick="" handlers and style=""
// attributes — a nonce-based CSP would block all of them (this is exactly what
// app.js.bak-nonce-fix/-strip-nonce tried and reverted). Everything else here is
// zero-risk and doesn't depend on frontend structure.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; '));
  next();
});

// ─── MSAL Config ────────────────────────────────────────────────────────────
const TENANT_ID     = process.env.AZURE_TENANT_ID;
const CLIENT_ID     = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || 'https://ar.eastcoastfacilities.com/auth/callback';

if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
  throw new Error('AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET must be set in .env');
}

const msalApp = new ConfidentialClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    clientSecret: CLIENT_SECRET,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, msg) => { if (level === 0) console.error('[msal]', msg); },
      piiLoggingEnabled: false,
      logLevel: 3,
    },
  },
});

const SCOPES = ['openid', 'profile', 'email', 'User.Read'];

// ─── SQLite Session Store ────────────────────────────────────────────────────
app.use(session({
  store: new SqliteStore({
    db: 'sessions.db',
    dir: __dirname,
    ttl: 7 * 24 * 60 * 60, // 7 days in seconds
  }),
  secret: process.env.SESSION_SECRET || 'ecf-ar-portal-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: true, // always secure — behind Cloudflare HTTPS
    sameSite: 'none', // required for cross-site OAuth redirect (Microsoft -> our callback)
  },
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Request Logger ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const hasCookie = req.headers.cookie && req.headers.cookie.includes('connect.sid');
  const sessionUser = req.session && req.session.user ? req.session.user.email : 'none';
  const reqStart = Date.now();
  // Log all auth + api paths
  if (req.path.startsWith('/auth/') || req.path.startsWith('/api/')) {
    const origJson = res.json.bind(res);
    const origRedirect = res.redirect.bind(res);
    res.json = function(data) {
      const bytes = Buffer.byteLength(JSON.stringify(data));
      console.log('[res]', req.method, req.path, res.statusCode, 'user:', sessionUser, 'handlerMs:', Date.now() - reqStart, 'bytes:', bytes);
      return origJson(data);
    };
    res.redirect = function(url) {
      console.log('[res-redirect]', req.method, req.path, '->', url, 'user:', sessionUser, 'handlerMs:', Date.now() - reqStart);
      return origRedirect(url);
    };
    console.log('[req]', req.method, req.path, 'hasCookie:', hasCookie, 'sessionUser:', sessionUser);
  }
  res.on('finish', () => {
    if (req.path.startsWith('/auth/') || req.path.startsWith('/api/')) {
      console.log('[fin]', req.method, req.path, res.statusCode, 'totalMs:', Date.now() - reqStart);
    }
  });
  next();
});
// Serve static files but force no-cache on HTML so updates are always picked up
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  }
}));

// ─── Auth Middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    // Sync role from DB on every request so admin changes take effect without re-login
    const fresh = db.getUserRole(req.session.user.email);
    if (fresh) {
      req.session.user.role             = fresh.role;
      req.session.user.location_filter  = fresh.location_filter || null;
      req.session.user.customer_filter  = fresh.customer_filter || null;
    }
    return next();
  }
  if (req.path.startsWith('/api/') || req.path === '/auth/me') {
    return res.status(401).json({ error: 'Unauthorized', loginUrl: '/auth/login' });
  }
  res.redirect('/auth/login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = req.session && req.session.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (roles.includes(user.role)) return next();
    return res.status(403).json({ error: 'Forbidden', required: roles, yours: user.role });
  };
}

function applyUserFilter(invoices, user) {
  let result = invoices;
  if (user.location_filter) {
    const locs = JSON.parse(user.location_filter);
    if (locs && locs.length > 0) {
      result = result.filter(inv => locs.includes(inv.locationId));
    }
  }
  if (user.customer_filter) {
    const custs = JSON.parse(user.customer_filter);
    if (custs && custs.length > 0) {
      result = result.filter(inv => custs.includes(inv.customerId));
    }
  }
  return result;
}

// ─── Auth Routes ────────────────────────────────────────────────────────────

app.get('/auth/login', async (req, res) => {
  try {
    const authUrl = await msalApp.getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri: REDIRECT_URI,
      prompt: 'select_account',
      domainHint: 'eastcoastfacilities.com',
    });
    res.redirect(authUrl);
  } catch (e) {
    console.error('[auth] login error:', e.message);
    res.status(500).send('Login failed: ' + e.message);
  }
});

app.get('/auth/callback', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  const { code, error, error_description } = req.query;
  console.log('[auth/callback] query:', JSON.stringify(req.query));
  if (error) {
    console.error('[auth/callback] Azure error:', error, error_description);
    return res.status(400).send(`Auth error: ${error} — ${error_description}`);
  }
  if (!code) return res.status(400).send('No auth code received');

  try {
    const tokenResp = await msalApp.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: REDIRECT_URI,
    });

    const account = tokenResp.account;
    const email   = account.username || '';
    const name    = account.name || email;
    const oid     = account.homeAccountId || '';

    // Domain check — must be @eastcoastfacilities.com
    if (!email.toLowerCase().endsWith('@eastcoastfacilities.com')) {
      return res.status(403).send('Access denied: only @eastcoastfacilities.com accounts are permitted.');
    }

    // Get or provision user role
    let userRole = db.getUserRole(email);
    if (!userRole) {
      userRole = db.provisionNewUser(email, name);
      db.auditLog(email, 'auto_provision', null, `Auto-provisioned as ${userRole.role}`);
    } else if (userRole.name !== name) {
      // Update name if changed
      db.updateUserRole(email, { name });
      userRole = db.getUserRole(email);
    }

    // Fetch M365 profile photo and job title from Graph API
    try {
      const accessToken = tokenResp.accessToken;
      const graphHeaders = { Authorization: `Bearer ${accessToken}` };
      // Fetch job title + phone (phone feeds the comms signature renderer)
      const profileRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=jobTitle,mobilePhone,businessPhones', { headers: graphHeaders });
      if (profileRes.ok) {
        const profile = await profileRes.json();
        if (profile.jobTitle) db.updateUserJobTitle(email, profile.jobTitle);
        const phone = profile.mobilePhone || (Array.isArray(profile.businessPhones) && profile.businessPhones[0]) || null;
        if (phone) db.updateUserPhone(email, phone);
      }
      // Fetch profile photo (48x48)
      const photoRes = await fetch('https://graph.microsoft.com/v1.0/me/photos/48x48/$value', { headers: graphHeaders });
      if (photoRes.ok) {
        const buf = Buffer.from(await photoRes.arrayBuffer());
        const photoDataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
        db.updateUserPhoto(email, photoDataUrl);
      }
    } catch (gErr) {
      console.error('[auth] Graph fetch error (non-fatal):', gErr.message);
    }
    const refreshedRole = db.getUserRole(email);

    req.session.user = {
      email,
      name,
      oid,
      role: refreshedRole ? refreshedRole.role : userRole.role,
      location_filter: refreshedRole ? (refreshedRole.location_filter || null) : (userRole.location_filter || null),
      customer_filter: refreshedRole ? (refreshedRole.customer_filter || null) : (userRole.customer_filter || null),
    };

    db.auditLog(email, 'login', null, `Login from ${req.ip}`);
    // Explicitly save session before redirect so cookie is set before browser follows
    req.session.save((saveErr) => {
      if (saveErr) console.error("[auth] session save error:", saveErr.message); else console.log("[auth] SUCCESS — session saved for:", email);
      res.redirect('/');
    });
  } catch (e) {
    console.error('[auth] callback error:', e.message);
    if (e.message && (e.message.includes('invalid_grant') || e.message.includes('AADSTS70008') || e.message.includes('expired'))) {
      req.session.destroy(() => res.redirect('/'));
    }
    res.status(500).send('Auth callback failed: ' + e.message);
  }
});

app.get('/auth/logout', (req, res) => {
  const email = req.session && req.session.user && req.session.user.email;
  if (email) db.auditLog(email, 'logout', null, null);
  req.session.destroy(() => {
    res.redirect(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=https://ar.eastcoastfacilities.com/`);
  });
});

app.get('/auth/me', requireAuth, (req, res) => {
  const real = req.session.realUser;
  res.json({
    ...req.session.user,
    impersonating: !!real,
    realUser: real ? { email: real.email, name: real.name, role: real.role } : null,
  });
});

// ─── Notification preferences (self-service opt-in) ───────────────────────
app.get('/api/me/notify-prefs', requireAuth, (req, res) => {
  try {
    res.json(db.getNotifyPrefs(req.session.user.email));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/me/notify-prefs', requireAuth, (req, res) => {
  try {
    const { notify_email, notify_mentions, notify_collector, notify_stop } = req.body || {};
    const next = db.updateNotifyPrefs(req.session.user.email, { notify_email, notify_mentions, notify_collector, notify_stop });
    db.auditLog(req.session.user.email, 'update_notify_prefs', null, JSON.stringify(next));
    res.json(next);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Impersonation (admin only) ───────────────────────────────────────────
// Lets an admin view the portal as another user — adopts that user's role and
// location/customer access filters — for support and verification. The real
// admin identity is preserved in the session for the exit path and audit.
app.post('/api/admin/impersonate/:email', requireAuth, requireRole('admin'), (req, res) => {
  try {
    if (req.session.realUser) return res.status(409).json({ error: 'Already impersonating — exit first' });
    const target = db.getUserRole(req.params.email);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const admin = req.session.user;
    if (target.email.toLowerCase() === admin.email.toLowerCase()) return res.status(400).json({ error: 'Cannot impersonate yourself' });
    req.session.realUser = { ...admin };
    req.session.user = {
      email: target.email,
      name: target.name || target.email,
      oid: admin.oid,
      role: target.role || 'viewer',
      location_filter: target.location_filter || null,
      customer_filter: target.customer_filter || null,
    };
    db.auditLog(admin.email, 'impersonate_start', null, `as ${target.email}`);
    req.session.save(() => res.json({ ok: true, user: req.session.user }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/impersonate-stop', requireAuth, (req, res) => {
  try {
    const real = req.session.realUser;
    if (!real) return res.status(400).json({ error: 'Not impersonating' });
    const wasImpersonating = req.session.user.email;
    req.session.user = { ...real };
    delete req.session.realUser;
    db.auditLog(real.email, 'impersonate_stop', null, `was ${wasImpersonating}`);
    req.session.save(() => res.json({ ok: true, user: req.session.user }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Refresh ────────────────────────────────────────────────────────────

app.post('/api/refresh', requireAuth, async (req, res) => {
  try {
    const invoices = await sage.getInvoices(true);
    const cacheInfo = sage.getCacheAge();
    db.auditLog(req.session.user.email, 'manual_refresh', null, `${invoices.length} invoices`);
    res.json({ ok: true, count: invoices.length, cacheInfo });
  } catch (e) {
    console.error('[api] refresh error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Invoices ───────────────────────────────────────────────────────────

app.get('/api/invoices', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) {
      invoices = await sage.getInvoices();
    }
    invoices = applyUserFilter(invoices, user);

    // Optional filters from query params
    const { bucket, locationId, customerId, search } = req.query;
    const filterCount = [bucket, locationId, customerId].filter(Boolean).length;

    if (filterCount === 1 && !search) {
      // Single-dimension filter — use index for O(1) lookup
      if (bucket)     invoices = sage.getByBucket(bucket);
      if (locationId) invoices = sage.getByLocation(locationId);
      if (customerId) invoices = sage.getByCustomer(customerId);
      // Apply user filter to the indexed slice
      invoices = applyUserFilter(invoices, user);
    } else {
      // Multi-filter or search — fall back to full array scan
      if (bucket)     invoices = invoices.filter(i => i.bucket === bucket);
      if (locationId) invoices = invoices.filter(i => i.locationId === locationId);
      if (customerId) invoices = invoices.filter(i => i.customerId === customerId);
    }

    if (search) {
      const s = search.toLowerCase();
      invoices = invoices.filter(i =>
        (i.invoiceId || '').toLowerCase().includes(s) ||
        (i.customerName || '').toLowerCase().includes(s) ||
        (i.locationName || '').toLowerCase().includes(s) ||
        (i.poNumber || '').toLowerCase().includes(s)
      );
    }

    // Attach PTP info
    const allPtp = db.getAllOpenPtp();
    const ptpMap = {};
    for (const p of allPtp) {
      if (!ptpMap[p.record_no]) ptpMap[p.record_no] = [];
      ptpMap[p.record_no].push(p);
    }

    const noteCounts = db.getNoteCounts();

    // Collector ownership + stop-service (invoice-level overrides customer-level)
    const acctByCust = {};
    for (const a of db.getAllCustomerAccounts()) acctByCust[a.customer_id] = a;
    const invColl = db.getAllInvoiceCollectors();
    const invStop = db.getAllInvoiceStopService();

    invoices = invoices.map(inv => {
      const acct = acctByCust[inv.customerId];
      const ic = invColl[inv.recordNo];
      const is = invStop[inv.recordNo];
      const collectorEmail = (ic && ic.collector_email) || (acct && acct.collector_email) || null;
      const collectorLevel = ic ? 'invoice' : (acct && acct.collector_email ? 'customer' : null);
      let stopService = null;
      if (is) {
        stopService = { level: 'invoice', effectiveDate: is.effective_date, issuedBy: is.issued_by, note: is.note };
      } else if (acct && acct.stop_service) {
        stopService = { level: 'customer', effectiveDate: acct.stop_service_effective_date, issuedBy: acct.stop_service_issued_by, note: acct.notes };
      }
      return {
        ...inv,
        ptpActive: !!(ptpMap[inv.recordNo] && ptpMap[inv.recordNo].length > 0),
        ptpAmount: ptpMap[inv.recordNo]
          ? ptpMap[inv.recordNo].reduce((s, p) => s + p.amount, 0)
          : 0,
        noteCount: noteCounts[inv.recordNo] || 0,
        collectorEmail,
        collectorLevel,
        stopService,
      };
    });

    res.json({
      invoices,
      count: invoices.length,
      cacheInfo: sage.getCacheAge(),
    });
  } catch (e) {
    console.error('[api] invoices error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/invoices/:recordno', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const inv = invoices.find(i => i.recordNo === req.params.recordno);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const notes  = db.getNotes(req.params.recordno);
    const ptps   = db.getPtpForRecord(req.params.recordno);
    const audit  = db.getAuditLog(req.params.recordno);

    // Enrich notes with reactions
    const noteIds = notes.map(n => n.id);
    const reactionsMap = db.getReactionsForNotes(noteIds);
    const enrichedNotes = notes.map(n => ({ ...n, reactions: reactionsMap[n.id] || [] }));

    // Enrich with Payee Central status for Amazon invoices
    const payeeStatus = payee.lookupInvoice(inv.invoiceId);
    const watched = db.isWatched(req.session.user.email, req.params.recordno);

    // Collector ownership + stop-service (invoice override, else customer)
    const acct = db.getCustomerAccount(inv.customerId);
    const ic = db.getAllInvoiceCollectors()[req.params.recordno];
    const is = db.getAllInvoiceStopService()[req.params.recordno];
    const collector = {
      email: (ic && ic.collector_email) || (acct && acct.collector_email) || null,
      level: ic ? 'invoice' : (acct && acct.collector_email ? 'customer' : null),
      customerCollector: (acct && acct.collector_email) || null,
    };
    let stopService = null;
    if (is) stopService = { level: 'invoice', effectiveDate: is.effective_date, issuedBy: is.issued_by, note: is.note };
    else if (acct && acct.stop_service) stopService = { level: 'customer', effectiveDate: acct.stop_service_effective_date, issuedBy: acct.stop_service_issued_by, note: acct.notes };

    res.json({ invoice: inv, notes: enrichedNotes, promises: ptps, audit, payeeStatus, watched, collector, stopService });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: PDF Retrieval ──────────────────────────────────────────────────────
// Omnia's PDF-generation endpoint takes 17-26s per call (confirmed via server
// logs — it's Omnia's own render time, not something we control), so results
// are cached on disk. Invoices don't change once issued, so a long TTL is safe.
const PDF_CACHE_DIR = path.join(__dirname, 'cache', 'pdfs');
const PDF_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const _pdfFetchInFlight = new Map(); // invoiceId -> Promise, collapses duplicate concurrent clicks

function pdfCachePath(invoiceId) {
  return path.join(PDF_CACHE_DIR, invoiceId.replace(/[^A-Za-z0-9\-_.]/g, '_') + '.pdf');
}

function getCachedPdf(invoiceId) {
  try {
    const filePath = pdfCachePath(invoiceId);
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs < PDF_CACHE_TTL_MS) return fs.readFileSync(filePath);
  } catch (e) { /* not cached or expired */ }
  return null;
}

function setCachedPdf(invoiceId, buf) {
  try {
    fs.mkdirSync(PDF_CACHE_DIR, { recursive: true });
    fs.writeFileSync(pdfCachePath(invoiceId), buf);
  } catch (e) { console.warn('[pdf-cache] write failed:', e.message); }
}

async function fetchOmniaInvoicePdfDeduped(invoiceId) {
  if (_pdfFetchInFlight.has(invoiceId)) return _pdfFetchInFlight.get(invoiceId);
  const p = omnia.fetchInvoicePdf(invoiceId).finally(() => _pdfFetchInFlight.delete(invoiceId));
  _pdfFetchInFlight.set(invoiceId, p);
  return p;
}

// Shared PDF fetch for an invoice: Omnia cache/deduped fetch, or on-demand
// ECI generation. Returns a Buffer, or null when no source can produce one.
// Used by the /pdf route flow below and by /api/comms/send attachments.
async function fetchInvoicePdfBuffer(inv) {
  if (omnia.isOmniaInvoice(inv.invoiceId)) {
    const cached = getCachedPdf(inv.invoiceId);
    if (cached) return cached;
    const result = await fetchOmniaInvoicePdfDeduped(inv.invoiceId);
    if (result.found && result.buf) { setCachedPdf(inv.invoiceId, result.buf); return result.buf; }
    return null;
  }
  if (inv.source === 'oe' || inv.source === 'eci-ar' || inv.source === 'eci-oe' || (inv.invoiceId && /^ECI-/i.test(inv.invoiceId))) {
    const lines = await sage.getInvoiceLines(inv.invoiceId).catch(() => []);
    return generateEciPdf(inv, lines);
  }
  return null;
}

app.get('/api/invoice/:recordno/pdf', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const inv = invoices.find(i => i.recordNo === req.params.recordno);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    db.auditLog(user.email, 'pdf_view', req.params.recordno, inv.invoiceId);

    // Omnia-sourced invoices (S-, SPI-, AST-, ASTM-, SS-, STM-)
    if (omnia.isOmniaInvoice(inv.invoiceId)) {
      const cached = getCachedPdf(inv.invoiceId);
      if (cached) {
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `inline; filename="${inv.invoiceId}.pdf"`);
        res.set('Content-Length', cached.length);
        return res.send(cached);
      }
      // Multiple clicks on the same slow-loading PDF share one in-flight Omnia
      // request instead of each firing a fresh 17-26s call (this is exactly
      // what happened in production: 3 clicks -> 3 separate slow fetches).
      const result = await fetchOmniaInvoicePdfDeduped(inv.invoiceId);
      if (result.found && result.buf) {
        setCachedPdf(inv.invoiceId, result.buf);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `inline; filename="${inv.invoiceId}.pdf"`);
        res.set('Content-Length', result.buf.length);
        return res.send(result.buf);
      }
      return res.status(404).json({ found: false, error: result.error || 'PDF not found in Omnia', invoiceId: inv.invoiceId });
    }

    // ECI- / OE-sourced invoices — generate PDF on demand from Intacct data
    if (inv.source === 'oe' || inv.source === 'eci-ar' || inv.source === 'eci-oe' || (inv.invoiceId && /^ECI-/i.test(inv.invoiceId))) {
      try {
        const lines = await sage.getInvoiceLines(inv.invoiceId).catch(() => []);
        const pdfBuf = await generateEciPdf(inv, lines);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `inline; filename="${inv.invoiceId}.pdf"`);
        res.set('Content-Length', pdfBuf.length);
        return res.send(pdfBuf);
      } catch (pdfErr) {
        console.error('[api] ECI PDF generation failed:', pdfErr.message);
        return res.status(500).json({ error: 'PDF generation failed: ' + pdfErr.message, invoiceId: inv.invoiceId });
      }
    }

    // Legacy: RECORDURL redirect
    if (inv.recordUrl) {
      return res.redirect(inv.recordUrl);
    }

    // No source available
    res.status(404).json({ found: false, error: 'No PDF source available for this invoice type', invoiceId: inv.invoiceId });
  } catch (e) {
    console.error('[api] pdf error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Locations & Customers ─────────────────────────────────────────────

app.get('/api/locations', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const seen = new Map();
    for (const inv of invoices) {
      if (!seen.has(inv.locationId)) {
        seen.set(inv.locationId, { id: inv.locationId, name: inv.locationName });
      }
    }
    res.json([...seen.values()].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/customers', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const seen = new Map();
    for (const inv of invoices) {
      if (!seen.has(inv.customerId)) {
        seen.set(inv.customerId, { id: inv.customerId, name: inv.customerName });
      }
    }
    res.json([...seen.values()].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Item lookup (for invoice creation) ────────────────────────────────
app.get('/api/items', requireAuth, async (req, res) => {
  try {
    const items = await sage.getItems();
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Full customer list from Sage (for invoice creation) ─────────────────
app.get('/api/customers/all', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const customers = await sage.getCustomers();
    res.json(customers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Full location list from Sage (for invoice creation) ─────────────────
app.get('/api/locations/all', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const locs = await sage.getLocations();
    res.json(locs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Create Invoice ──────────────────────────────────────────────────────
app.post('/api/invoice/create', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  const user = req.session.user;
  try {
    const { customerId, invoiceId, invoiceDate, dueDate, locationId, description, poNumber, lines } = req.body;

    // Basic validation
    if (!customerId || !invoiceId || !invoiceDate || !dueDate || !locationId) {
      return res.status(400).json({ error: 'Missing required fields: customerId, invoiceId, invoiceDate, dueDate, locationId' });
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'At least one line item is required' });
    }
    // Enforce ECI- prefix
    if (!invoiceId.startsWith('ECI-')) {
      return res.status(400).json({ error: 'Invoice ID must start with ECI-' });
    }
    // Validate line amounts
    for (const l of lines) {
      if (!l.itemId || !l.amount || isNaN(parseFloat(l.amount)) || parseFloat(l.amount) <= 0) {
        return res.status(400).json({ error: 'Each line item requires itemId and a positive amount' });
      }
    }

    const result = await sage.createInvoice({ customerId, invoiceId, invoiceDate, dueDate, locationId, description, poNumber, lines });

    db.auditLog(user.email, 'create_invoice', result.recordNo || invoiceId,
      `Created ${invoiceId} for customer ${customerId} — ${lines.length} line(s)`);

    // Bust cache so new invoice appears immediately
    await sage.getInvoices(true);

    res.json({ ok: true, invoiceId: result.invoiceId, recordNo: result.recordNo });
  } catch (e) {
    console.error('[api] create_invoice error:', e.message);
    db.auditLog(user.email, 'create_invoice_error', null, e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─── API: OE Invoice Lines (on-demand, per invoice) ─────────────────────────
app.get('/api/invoice/:invoiceId/lines', requireAuth, async (req, res) => {
  try {
    const { invoiceId } = req.params;
    if (!invoiceId || !invoiceId.startsWith('ECI-')) {
      return res.status(400).json({ error: 'invoiceId must start with ECI-' });
    }
    const lines = await sage.getInvoiceLines(invoiceId);
    res.json(lines);
  } catch (e) {
    console.error('[api] invoice lines error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─── API: Payee Central Status ────────────────────────────────────────────────
app.get('/api/invoice/:invoiceId/payee', requireAuth, (req, res) => {
  try {
    const { invoiceId } = req.params;
    const result = payee.lookupInvoice(invoiceId);
    if (!result) return res.status(404).json({ found: false, invoiceId });
    res.json({ found: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/payee/meta', requireAuth, (req, res) => {
  res.json(payee.feedMeta());
});

// Returns full payee status index (hold-status invoices only) for client-side table badges
app.get('/api/payee/index', requireAuth, (req, res) => {
  try {
    res.json(payee.getIndex());
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: KPIs ───────────────────────────────────────────────────────────────


// ─── API: Customer Summary ────────────────────────────────────────────────────
app.get('/api/customers/summary', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const customerMap = new Map();
    const now = Date.now();

    for (const inv of invoices) {
      const cid = inv.customerId;
      if (!customerMap.has(cid)) {
        customerMap.set(cid, {
          id: cid,
          name: inv.customerName,
          invoiceCount: 0,
          totalAR: 0,
          pastDueAR: 0,
          currentAR: 0,
          oldestDaysPastDue: 0,
          buckets: { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '91+': 0 },
        });
      }
      const c = customerMap.get(cid);
      c.invoiceCount++;
      c.totalAR += inv.totalDue;
      c.buckets[inv.bucket] = (c.buckets[inv.bucket] || 0) + inv.totalDue;

      if (inv.bucket === 'current') {
        c.currentAR += inv.totalDue;
      } else {
        c.pastDueAR += inv.totalDue;
        // Compute days past due from whenDue
        if (inv.whenDue) {
          const due = new Date(inv.whenDue).getTime();
          if (!isNaN(due)) {
            const dpd = Math.floor((now - due) / 86400000);
            if (dpd > c.oldestDaysPastDue) c.oldestDaysPastDue = dpd;
          }
        }
      }
    }

    const result = [...customerMap.values()].map(c => ({
      ...c,
      status: c.pastDueAR > 0 ? 'past_due' : (c.totalAR > 0 ? 'current' : 'clean'),
    })).sort((a, b) => b.pastDueAR - a.pastDueAR);

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Aging Snapshot Report ───────────────────────────────────────────────
app.get('/api/reports/aging-snapshot', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const scMap = new Map();
    for (const inv of invoices) {
      const sc = inv.locationId || 'Unknown';
      const scName = inv.locationName || inv.locationId || 'Unknown';
      if (!scMap.has(sc)) {
        scMap.set(sc, { serviceCenter: scName, current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b91plus: 0, total: 0, count: 0 });
      }
      const row = scMap.get(sc);
      row.count++;
      row.total += inv.totalDue;
      if (inv.bucket === 'current')   row.current  += inv.totalDue;
      if (inv.bucket === '1-30')      row.b1_30    += inv.totalDue;
      if (inv.bucket === '31-60')     row.b31_60   += inv.totalDue;
      if (inv.bucket === '61-90')     row.b61_90   += inv.totalDue;
      if (inv.bucket === '91+')       row.b91plus  += inv.totalDue;
    }

    const rows = [...scMap.values()].sort((a, b) => b.total - a.total);
    const totals = rows.reduce((acc, r) => {
      acc.current += r.current; acc.b1_30 += r.b1_30; acc.b31_60 += r.b31_60;
      acc.b61_90 += r.b61_90; acc.b91plus += r.b91plus; acc.total += r.total; acc.count += r.count;
      return acc;
    }, { current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b91plus: 0, total: 0, count: 0 });

    res.json({ rows, totals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Walk Forward Report ─────────────────────────────────────────────────
app.get('/api/reports/walk-forward', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let endingBalance = 0;
    let newInvoiceCount = 0;
    let newInvoiceAmount = 0;

    for (const inv of invoices) {
      endingBalance += inv.totalDue;
      if (inv.whenCreated) {
        const created = new Date(inv.whenCreated).getTime();
        if (!isNaN(created) && created >= thirtyDaysAgo) {
          newInvoiceCount++;
          newInvoiceAmount += inv.totalDue;
        }
      }
    }

    res.json({
      endingBalance,
      invoiceCount: invoices.length,
      newInvoiceCount,
      newInvoiceAmount,
      note: 'Walk forward computed from cached invoice data',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Top Customers by Past Due ──────────────────────────────────────────
app.get('/api/reports/top-customers', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const customerMap = new Map();
    for (const inv of invoices) {
      const cid = inv.customerId;
      if (!customerMap.has(cid)) {
        customerMap.set(cid, { id: cid, name: inv.customerName, totalAR: 0, pastDueAR: 0, invoiceCount: 0 });
      }
      const c = customerMap.get(cid);
      c.invoiceCount++;
      c.totalAR += inv.totalDue;
      if (inv.bucket !== 'current') c.pastDueAR += inv.totalDue;
    }

    const top10 = [...customerMap.values()]
      .sort((a, b) => b.pastDueAR - a.pastDueAR)
      .slice(0, 10);

    res.json(top10);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});




// ─── Customer-contact sync (comms platform) ──────────────────────────────────
async function runContactSync(triggeredBy) {
  const rows = await sage.getCustomerContacts();
  const summary = db.syncCustomerContactsFromSage(rows);
  db.auditLog(triggeredBy || 'system', 'comm_contact_sync', null, JSON.stringify(summary));
  console.log(`[contacts] sync: ${summary.inserted} inserted, ${summary.updated} updated, ${summary.skippedManual} manual-skipped across ${summary.customersWithContacts}/${summary.customers} customers`);
  return summary;
}

// ─── Graph sendMail helpers ────────────────────────────────────────────────────
function portalBaseUrl() {
  return process.env.REDIRECT_URI
    ? process.env.REDIRECT_URI.replace('/auth/callback', '')
    : 'https://ar.eastcoastfacilities.com';
}

// Raw send — no preference checks. Fire-and-forget; never throws to caller.
// Internal staff notifications only; customer-facing mail goes through the
// comms service (invoices@), never this arclerk path.
async function sendGraphMail(toEmail, subject, contentText) {
  try {
    const tokenResp = await msalApp.acquireTokenByClientCredential({
      scopes: ['https://graph.microsoft.com/.default']
    });
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/arclerk@eastcoastfacilities.com/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenResp.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'Text', content: contentText },
          toRecipients: [{ emailAddress: { address: toEmail } }]
        },
        saveToSentItems: false
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[notify] sendMail ${res.status} to ${toEmail}: ${errText.slice(0, 200)}`);
      try { db.auditLog('system', 'notify_email_fail', null, `${res.status} "${subject}" -> ${toEmail}`); } catch (e2) {}
      return;
    }
    console.log(`[notify] sent "${subject}" to ${toEmail}`);
    try { db.auditLog('system', 'notify_email', null, `"${subject}" -> ${toEmail}`); } catch (e2) {}
  } catch (e) {
    console.error('[notify] failed:', e.message);
    try { db.auditLog('system', 'notify_email_fail', null, `${e.message} "${subject}" -> ${toEmail}`); } catch (e2) {}
  }
}

// Preference-gated notification. event ∈ 'mentions' | 'collector' | 'stop' | 'replies'.
// 'replies' (a customer answered an assigned comms thread) bypasses the master
// opt-out — it is operational work, silenced only by its own notify_replies
// toggle. All other events still honor the master switch.
async function notifyUser(toEmail, event, subject, contentText) {
  if (!toEmail) return;
  try {
    const p = db.getNotifyPrefs(toEmail);
    if (event === 'replies') {
      if (!p.notify_replies) return;
    } else {
      const eventCol = { mentions: 'notify_mentions', collector: 'notify_collector', stop: 'notify_stop' }[event];
      if (!p.notify_email) return;                      // master opt-out
      if (eventCol && !p[eventCol]) return;             // per-event opt-out
    }
  } catch (e) { /* if prefs unreadable, default to sending */ }
  await sendGraphMail(toEmail, subject, contentText);
}

async function sendMentionEmail(toEmail, fromName, invoiceId, noteBody, recordNo) {
  const snippet = noteBody.length > 200 ? noteBody.slice(0, 200) + '…' : noteBody;
  const body = `You were mentioned in a note on invoice ${invoiceId} by ${fromName}.

Note: "${snippet}"

View it in the ECF AR Portal: ${portalBaseUrl()}

—ECF AR Portal`;
  await notifyUser(toEmail, 'mentions', `[ECF AR Portal] You were mentioned on invoice ${invoiceId}`, body);
}

// ─── API: Watchlist ───────────────────────────────────────────────────────────
app.get('/api/watchlist', requireAuth, (req, res) => {
  try {
    const items = db.getWatchlist(req.session.user.email);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/watchlist/:recordno', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const { invoiceId, customerName } = req.body || {};
    db.addToWatchlist(user.email, req.params.recordno, invoiceId, customerName);
    db.auditLog(user.email, 'watchlist_add', req.params.recordno, invoiceId || '');
    res.json({ ok: true, watched: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/watchlist/:recordno', requireAuth, (req, res) => {
  try {
    db.removeFromWatchlist(req.session.user.email, req.params.recordno);
    db.auditLog(req.session.user.email, 'watchlist_remove', req.params.recordno, '');
    res.json({ ok: true, watched: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Purchase Orders ──────────────────────────────────────────────────
app.get('/api/po', requireAuth, (req, res) => {
  try {
    res.json(db.getPurchaseOrders());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// NOTE: these literal routes must stay ABOVE '/api/po/:poNumber' or Express
// will match "ledger"/"needs-upload"/"overages" as a poNumber param instead.
app.get('/api/po/ledger', requireAuth, async (req, res) => {
  try {
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, req.session.user);
    res.json(poLedger.getPoLedger(invoices));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/po/needs-upload', requireAuth, async (req, res) => {
  try {
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, req.session.user);
    res.json(poLedger.getNeedsUpload(invoices));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// "Off radar": open Amazon invoices with no PO (native or assigned), never live
// in Amazon — they surface nowhere else. Assign a PO to pull one into Needs
// Upload, then it can be transmitted.
app.get('/api/po/orphans', requireAuth, async (req, res) => {
  try {
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, req.session.user);
    res.json(poLedger.getOrphanInvoices(invoices));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/po/overages', requireAuth, async (req, res) => {
  try {
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, req.session.user);
    res.json(poLedger.getOverages(invoices));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/po/mismatches', requireAuth, async (req, res) => {
  try {
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, req.session.user);
    res.json(poLedger.getPoMismatches(invoices));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/po/uploaded', requireAuth, async (req, res) => {
  try {
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, req.session.user);
    res.json(poLedger.getUploaded(invoices));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/po/resubmissions', requireAuth, async (req, res) => {
  try {
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, req.session.user);
    res.json(poLedger.getResubmissionMonitor(invoices));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Data freshness for the "last updated" display in the PO Funds view.
app.get('/api/po/meta', requireAuth, (req, res) => {
  try {
    const fresh = poLedger.getDataFreshness();
    const cacheInfo = sage.getCacheAge ? sage.getCacheAge() : null;
    res.json({ ...fresh, sageInvoices: cacheInfo ? cacheInfo.fetchedAt : null, refreshRunning: _payeeRefreshRunning, refreshStarted: _payeeRefreshStarted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual Payee Central refresh — kicks off the guarded scrape and returns
// immediately (it takes a few minutes). The client polls /api/po/meta.
app.post('/api/po/refresh-payee', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const r = doPayeeRefresh();
    db.auditLog(req.session.user.email, 'payee_refresh', null, r.alreadyRunning ? 'already running' : 'started');
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual per-PO detail scrape (Amazon "Available amount"). Long-running; returns
// immediately. The ledger picks up new balances on its next read.
app.post('/api/po/refresh-details', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const r = doPoDetailRefresh();
    db.auditLog(req.session.user.email, 'po_detail_refresh', null, r.alreadyRunning ? 'already running' : 'started');
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: EDI transmission (bridges to the iMac transmitter) ───────────────
// Resolves the invoice number to send: dash removed, plus an 'A'-style suffix
// for resubmissions (Payee Central rejects a reused invoice number). We detect
// resubmission via the Payee Central feed (latest attempt cancelled/rejected).
function ediInvoiceNumber(inv) {
  const base = (inv.invoiceId || '').replace('-', '');
  const resolved = payee.resolveInvoice(payee.toPayeeId(inv.invoiceId));
  if (resolved && ['Cancelled', 'Rejected'].includes(resolved.status) && resolved.suggestedResubmitId) {
    return { number: resolved.suggestedResubmitId, resubmission: true };
  }
  return { number: base, resubmission: false };
}

// Dry-run preview — SAFE, generates the 810 without transmitting.
app.post('/api/po/edi/dry-run', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), async (req, res) => {
  try {
    const { recordNo, po, as } = req.body || {};
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    const inv = invoices.find(i => i.recordNo === recordNo);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const meta = ediInvoiceNumber(inv);
    // Suffixed number: caller-specified (person picks at resubmit time) or, for a
    // detected resubmission, the computed next suffix. null = send number as-is.
    const asNumber = as || (meta.resubmission ? meta.number : null);
    const result = await ediBridge.dryRun(inv.invoiceId, { po: po || undefined, as: asNumber || undefined });
    db.auditLog(req.session.user.email, 'edi_dry_run', recordNo, `${inv.invoiceId}${po ? ' PO=' + po : ''}${asNumber ? ' AS=' + asNumber : ''}`);
    res.json({ ...result, invoiceId: inv.invoiceId, ediNumber: asNumber || inv.invoiceId.replace(/-/g, ''), resubmission: meta.resubmission, suggestedResubmitId: meta.number });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live transmit — gated behind EDI_TRANSMIT_ARMED. Refuses to fire otherwise.
// Only ONE transmit run may be active at a time. Concurrent streams trip
// Amazon's SFTP rate limit and cascade into handshake failures (observed
// 2026-07-15: parallel bulk runs took the whole endpoint down for minutes).
let _ediRunActive = null;

app.post('/api/po/edi/transmit', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  if (_ediRunActive) {
    const mins = Math.round((Date.now() - _ediRunActive.startedAt) / 60000);
    return res.status(409).json({
      error: `A transmission is already running (${_ediRunActive.count} invoice${_ediRunActive.count !== 1 ? 's' : ''}, started ${mins}m ago by ${_ediRunActive.by}). Wait for it to finish — concurrent runs trip Amazon's rate limit.`,
      busy: true,
    });
  }
  try {
    if (!EDI_TRANSMIT_ARMED) {
      return res.status(403).json({ error: 'Live EDI transmission is not armed. Set EDI_TRANSMIT_ARMED=true in .env to enable.', armed: false });
    }
    const { recordNos, po, as } = req.body || {};
    const list = Array.isArray(recordNos) ? recordNos : (recordNos ? [recordNos] : []);
    if (!list.length) return res.status(400).json({ error: 'recordNos required' });
    _ediRunActive = { startedAt: Date.now(), count: list.length, by: req.session.user.email };
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    const single = list.length === 1;
    const assignments = db.getAllPoAssignments();

    // Amazon's SFTP endpoint starts refusing handshakes after too many rapid
    // back-to-back sessions (observed 2026-07-15: 9 sends 4s apart succeeded,
    // then 3 straight handshake timeouts). Pace bulk sends and retry transient
    // connection failures with a cool-down before giving up.
    const TRANSIENT_RE = /handshake|timed out|timeout|ECONNRESET|ECONNREFUSED|EHOSTUNREACH/i;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    async function transmitWithRetry(invoiceId, opts) {
      let r = await ediBridge.transmit(invoiceId, opts);
      for (const delayMs of [30000, 60000]) {
        if (r.ok || !TRANSIENT_RE.test(r.error || '')) break;
        console.warn(`[edi] transient failure for ${invoiceId} (${r.error}) — retrying in ${delayMs / 1000}s`);
        await sleep(delayMs);
        r = await ediBridge.transmit(invoiceId, opts);
      }
      return r;
    }

    const results = [];
    let sent = 0;
    for (const rn of list) {
      const inv = invoices.find(i => i.recordNo === rn);
      if (!inv) { results.push({ recordNo: rn, ok: false, error: 'not found' }); continue; }
      if (sent > 0) await sleep(10000);   // pacing between SFTP sessions in a bulk run
      // Each invoice transmits under its OWN PO: an explicit `po` only when a
      // single invoice is sent from the preview (override); otherwise the
      // reassigned PO if one exists, else the PO on the Sage record.
      const effectivePo = (single && po) ? po : ((assignments[rn] && assignments[rn].assigned_po) || inv.poNumber || null);
      const meta = ediInvoiceNumber(inv);
      // Suffixed number: a caller-specified `as` only applies to a single send;
      // otherwise use the computed suffix for a detected resubmission.
      const asNumber = (single && as) ? as : (meta.resubmission ? meta.number : null);
      const r = await transmitWithRetry(inv.invoiceId, { po: effectivePo || undefined, as: asNumber || undefined });
      sent++;
      db.auditLog(req.session.user.email, 'edi_transmit', rn, `${inv.invoiceId}${effectivePo ? ' PO=' + effectivePo : ''}${asNumber ? ' AS=' + asNumber : ''} -> ${r.ok ? 'OK ' + (r.remotePath || '') : 'FAIL ' + (r.error || '')}`);
      results.push({ recordNo: rn, invoiceId: inv.invoiceId, po: effectivePo, ediNumber: asNumber || inv.invoiceId.replace(/-/g, ''), ...r });
    }
    const failed = results.filter(r => !r.ok);
    res.json({ armed: true, results, okCount: results.length - failed.length, failCount: failed.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { _ediRunActive = null; }
});

// Reassigns which PO an as-yet-unsubmitted invoice should actually be
// uploaded under. This never touches Sage or Payee Central — there's no API
// into Payee Central, upload is still a manual step — it just records intent
// so whoever does the upload knows which PO to use.
// A PO must never be an invoice number. Amazon POs look like "2D-19170701";
// Sage/Omnia invoice ids are S-/AST-/ASTM-/ECI-<digits>. Users have pasted an
// invoice's own number into the PO box (observed 2026-07-30, 2 phantom POs),
// which turns the invoice number into a placeholder PO. Reject it at the source.
const INVOICE_ID_RE = /^(ASTM|AST|ECI|S)-\d/i;
function poAssignError(assignedPo, invoiceId) {
  const po = String(assignedPo || '').trim();
  if (!po) return 'assignedPo is required';
  if (invoiceId && po.toUpperCase() === String(invoiceId).trim().toUpperCase())
    return "The PO cannot be the invoice's own number.";
  if (INVOICE_ID_RE.test(po)) return `"${po}" looks like an invoice number, not a PO. Amazon POs look like 2D-…`;
  return null;
}

app.post('/api/po/reassign/:recordNo', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    const { invoiceId, originalPo, assignedPo, note } = req.body || {};
    const vErr = poAssignError(assignedPo, invoiceId);
    if (vErr) return res.status(400).json({ error: vErr });
    db.setInvoicePoAssignment(req.params.recordNo, invoiceId || null, originalPo || null, assignedPo, note || null, user.email);
    db.auditLog(user.email, 'po_reassign', req.params.recordNo, `${originalPo || '?'} -> ${assignedPo}${note ? ' — ' + note : ''}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/po/reassign/:recordNo', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    db.clearInvoicePoAssignment(req.params.recordNo);
    db.auditLog(user.email, 'po_reassign_clear', req.params.recordNo, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk-reassign: point many invoices at the same PO in one action.
app.post('/api/po/reassign-bulk', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), async (req, res) => {
  try {
    const user = req.session.user;
    const { items, assignedPo, note } = req.body || {};
    const vErr = poAssignError(assignedPo, null);
    if (vErr) return res.status(400).json({ error: vErr });
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return res.status(400).json({ error: 'items required' });
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    let count = 0;
    for (const it of list) {
      const rn = typeof it === 'string' ? it : it.recordNo;
      if (!rn) continue;
      const inv = invoices.find(i => i.recordNo === rn);
      // Skip an item whose own invoice number equals the target PO (self-assign).
      if (inv && String(inv.invoiceId || '').toUpperCase() === String(assignedPo).trim().toUpperCase()) continue;
      db.setInvoicePoAssignment(rn, inv ? inv.invoiceId : null, inv ? inv.poNumber : null, assignedPo, note || null, user.email);
      count++;
    }
    db.auditLog(user.email, 'po_reassign_bulk', null, `${count} invoices -> ${assignedPo}${note ? ' — ' + note : ''}`);
    res.json({ ok: true, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Collector ownership ────────────────────────────────────────────────
// Effective collector for an invoice = invoice-level override, else the
// customer-level collector. These routes set/clear at each level.

app.post('/api/collector/customer/:customerId', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  try {
    const user = req.session.user;
    const { collectorEmail, customerName } = req.body || {};
    db.upsertCustomerAccount(req.params.customerId, customerName || null, { collector_email: collectorEmail || null }, user.email);
    db.auditLog(user.email, 'collector_assign_customer', req.params.customerId, collectorEmail || '(cleared)');
    if (collectorEmail && collectorEmail.toLowerCase() !== user.email.toLowerCase()) {
      notifyUser(collectorEmail, 'collector',
        `[ECF AR Portal] You're now the collector for ${customerName || req.params.customerId}`,
        `${user.name || user.email} set you as the default collector for ${customerName || req.params.customerId}. All of that customer's open invoices now appear in your My Work queue: ${portalBaseUrl()}\n\n—ECF AR Portal`)
        .catch(e => console.error('[notify] collector-cust:', e.message));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collector/invoice/:recordNo', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    const { invoiceId, collectorEmail } = req.body || {};
    if (!collectorEmail) {
      db.clearInvoiceCollector(req.params.recordNo);
      db.auditLog(user.email, 'collector_clear_invoice', req.params.recordNo, '');
    } else {
      db.setInvoiceCollector(req.params.recordNo, invoiceId || null, collectorEmail, user.email);
      db.auditLog(user.email, 'collector_assign_invoice', req.params.recordNo, collectorEmail);
      if (collectorEmail.toLowerCase() !== user.email.toLowerCase()) {
        notifyUser(collectorEmail, 'collector',
          `[ECF AR Portal] Invoice ${invoiceId || req.params.recordNo} assigned to you`,
          `${user.name || user.email} assigned invoice ${invoiceId || req.params.recordNo} to you.\n\nIt's now in your My Work queue: ${portalBaseUrl()}\n\n—ECF AR Portal`)
          .catch(e => console.error('[notify] collector:', e.message));
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collector/invoice-bulk', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), async (req, res) => {
  try {
    const user = req.session.user;
    const { items, collectorEmail } = req.body || {};
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return res.status(400).json({ error: 'items required' });
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    let count = 0;
    for (const it of list) {
      const rn = typeof it === 'string' ? it : it.recordNo;
      if (!rn) continue;
      const inv = invoices.find(i => i.recordNo === rn);
      if (!collectorEmail) db.clearInvoiceCollector(rn);
      else db.setInvoiceCollector(rn, inv ? inv.invoiceId : null, collectorEmail, user.email);
      count++;
    }
    db.auditLog(user.email, 'collector_assign_bulk', null, `${count} invoices -> ${collectorEmail || '(cleared)'}`);
    if (collectorEmail && collectorEmail.toLowerCase() !== user.email.toLowerCase() && count > 0) {
      notifyUser(collectorEmail, 'collector',
        `[ECF AR Portal] ${count} invoice${count !== 1 ? 's' : ''} assigned to you`,
        `${user.name || user.email} assigned ${count} invoice${count !== 1 ? 's' : ''} to you. They're now in your My Work queue: ${portalBaseUrl()}\n\n—ECF AR Portal`)
        .catch(e => console.error('[notify] collector-bulk:', e.message));
    }
    res.json({ ok: true, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Stop-service workflow ──────────────────────────────────────────────
// Customer-level flips the account flag with an effective date + issuer.
// Invoice-level records an override in invoice_stop_service.

app.post('/api/stop-service/customer/:customerId', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  try {
    const user = req.session.user;
    const { stop, effectiveDate, note, customerName } = req.body || {};
    db.upsertCustomerAccount(req.params.customerId, customerName || null, {
      stop_service: stop ? 1 : 0,
      stop_service_effective_date: stop ? (effectiveDate || null) : null,
      stop_service_issued_by: stop ? user.email : null,
      stop_service_at: stop ? new Date().toISOString() : null,
      notes: note !== undefined ? note : undefined,
    }, user.email);
    db.auditLog(user.email, stop ? 'stop_service_customer' : 'stop_service_clear_customer', req.params.customerId,
      stop ? `effective ${effectiveDate || '?'}${note ? ' — ' + note : ''}` : 'resumed');
    if (stop) {
      const acct = db.getCustomerAccount(req.params.customerId);
      const collector = acct && acct.collector_email;
      if (collector && collector.toLowerCase() !== user.email.toLowerCase()) {
        notifyUser(collector, 'stop',
          `[ECF AR Portal] Stop service issued — ${customerName || req.params.customerId}`,
          `${user.name || user.email} issued stop service for ${customerName || req.params.customerId}${effectiveDate ? ', effective ' + effectiveDate : ''}.${note ? '\n\nReason: ' + note : ''}\n\nReview in the ECF AR Portal: ${portalBaseUrl()}\n\n—ECF AR Portal`)
          .catch(e => console.error('[notify] stop-cust:', e.message));
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stop-service/invoice/:recordNo', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), async (req, res) => {
  try {
    const user = req.session.user;
    const { invoiceId, stop, effectiveDate, note } = req.body || {};
    if (!stop) {
      db.clearInvoiceStopService(req.params.recordNo);
      db.auditLog(user.email, 'stop_service_clear_invoice', req.params.recordNo, 'resumed');
    } else {
      db.setInvoiceStopService(req.params.recordNo, invoiceId || null, effectiveDate || null, note || null, user.email);
      db.auditLog(user.email, 'stop_service_invoice', req.params.recordNo, `effective ${effectiveDate || '?'}${note ? ' — ' + note : ''}`);
      // Notify the invoice's effective collector (invoice override, else customer default)
      try {
        const ic = db.getAllInvoiceCollectors()[req.params.recordNo];
        let collector = ic && ic.collector_email;
        if (!collector) {
          let invs = sage.getCachedInvoices();
          const inv = invs.find(i => i.recordNo === req.params.recordNo);
          if (inv) { const acct = db.getCustomerAccount(inv.customerId); collector = acct && acct.collector_email; }
        }
        if (collector && collector.toLowerCase() !== user.email.toLowerCase()) {
          notifyUser(collector, 'stop',
            `[ECF AR Portal] Stop service issued — invoice ${invoiceId || req.params.recordNo}`,
            `${user.name || user.email} issued stop service on invoice ${invoiceId || req.params.recordNo}${effectiveDate ? ', effective ' + effectiveDate : ''}.${note ? '\n\nReason: ' + note : ''}\n\nReview in the ECF AR Portal: ${portalBaseUrl()}\n\n—ECF AR Portal`)
            .catch(e => console.error('[notify] stop-inv:', e.message));
        }
      } catch (e) { console.error('[notify] stop-inv lookup:', e.message); }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── My Work ─────────────────────────────────────────────────────────────
// Invoices whose effective collector is the logged-in user.

app.get('/api/my-work', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const me = (user.email || '').toLowerCase();
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const acctByCust = {};
    for (const a of db.getAllCustomerAccounts()) acctByCust[a.customer_id] = a;
    const invColl = db.getAllInvoiceCollectors();
    const invStop = db.getAllInvoiceStopService();
    const noteCounts = db.getNoteCounts();
    const allPtp = db.getAllOpenPtp();
    const ptpMap = {};
    for (const p of allPtp) { (ptpMap[p.record_no] = ptpMap[p.record_no] || []).push(p); }

    const mine = [];
    for (const inv of invoices) {
      const acct = acctByCust[inv.customerId];
      const ic = invColl[inv.recordNo];
      const collectorEmail = (ic && ic.collector_email) || (acct && acct.collector_email) || null;
      if (!collectorEmail || collectorEmail.toLowerCase() !== me) continue;
      const is = invStop[inv.recordNo];
      let stopService = null;
      if (is) stopService = { level: 'invoice', effectiveDate: is.effective_date, issuedBy: is.issued_by, note: is.note };
      else if (acct && acct.stop_service) stopService = { level: 'customer', effectiveDate: acct.stop_service_effective_date, issuedBy: acct.stop_service_issued_by, note: acct.notes };
      mine.push({
        ...inv,
        collectorEmail,
        collectorLevel: ic ? 'invoice' : 'customer',
        stopService,
        noteCount: noteCounts[inv.recordNo] || 0,
        latestNote: (() => {
          const ns = db.getNotes(inv.recordNo);
          const n = ns[ns.length - 1];
          return n ? { body: String(n.body).slice(0, 140), by: n.user_name, at: n.created_at } : null;
        })(),
        ptpActive: !!(ptpMap[inv.recordNo] && ptpMap[inv.recordNo].length > 0),
        ptpAmount: ptpMap[inv.recordNo] ? ptpMap[inv.recordNo].reduce((s, p) => s + p.amount, 0) : 0,
      });
    }
    res.json({ invoices: mine, count: mine.length, totalDue: mine.reduce((s, i) => s + (i.totalDue || 0), 0) });
  } catch (e) {
    console.error('[api] my-work error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── AI (local, on-box via Ollama) ────────────────────────────────────────
// Every endpoint grounds the model in real data and returns drafts/summaries/
// suggestions only. AI never computes balances or writes to the ledger.

app.get('/api/ai/status', requireAuth, async (req, res) => {
  try {
    res.json({ available: await ai.available(), smart: ai.MODEL_SMART, fast: ai.MODEL_FAST });
  } catch (e) { res.json({ available: false }); }
});

// Build a grounded plain-text facts block for one invoice.
async function buildInvoiceContext(recordNo, user) {
  let invoices = sage.getCachedInvoices();
  if (invoices.length === 0) invoices = await sage.getInvoices();
  invoices = applyUserFilter(invoices, user);
  const inv = invoices.find(i => i.recordNo === recordNo);
  if (!inv) return null;
  const notes = db.getNotes(recordNo) || [];
  const ptps = db.getPtpForRecord(recordNo) || [];
  const payeeStatus = payee.lookupInvoice(inv.invoiceId);
  const acct = db.getCustomerAccount(inv.customerId);
  const ic = db.getAllInvoiceCollectors()[recordNo];
  const is = db.getAllInvoiceStopService()[recordNo];
  const today = new Date().toISOString().slice(0, 10);

  const lines = [];
  lines.push(`Invoice: ${inv.invoiceId || recordNo}`);
  lines.push(`Customer: ${inv.customerName || inv.customerId}`);
  lines.push(`Location: ${inv.locationName || inv.locationId}`);
  lines.push(`Invoice date: ${(inv.whenCreated || '').slice(0, 10)}`);
  lines.push(`Due date: ${(inv.whenDue || '').slice(0, 10)}`);
  lines.push(`Original amount: $${(inv.totalEntered || 0).toFixed(2)}`);
  lines.push(`Balance due: $${(inv.totalDue || 0).toFixed(2)}`);
  lines.push(`Days past due: ${inv.daysOverdue > 0 ? inv.daysOverdue : 0}`);
  if (inv.poNumber) lines.push(`PO number: ${inv.poNumber}`);
  if (payeeStatus) lines.push(`Amazon Payee Central status: ${payeeStatus.status || payeeStatus.statusMeta?.label || 'unknown'}`);
  const stop = is || (acct && acct.stop_service ? { effective_date: acct.stop_service_effective_date } : null);
  if (stop) lines.push(`STOP SERVICE flagged${stop.effective_date ? ', effective ' + stop.effective_date : ''}.`);
  if (ptps.length) {
    lines.push('Promises to pay:');
    for (const p of ptps) {
      const broken = p.promise_date && p.promise_date < today && !/kept|paid|fulfilled/i.test(p.status || '');
      lines.push(`  - $${(p.amount || 0).toFixed(2)} promised by ${p.promise_date} [${p.status || 'open'}]${broken ? ' (BROKEN — date passed, unpaid)' : ''}`);
    }
  } else {
    lines.push('Promises to pay: none on record.');
  }
  if (notes.length) {
    lines.push('Recent notes (newest first):');
    for (const n of notes.slice(0, 8)) {
      lines.push(`  - [${(n.created_at || '').slice(0, 10)}] ${(n.user_name || '').split(' ')[0]}: ${(n.body || '').replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  } else {
    lines.push('Notes: none yet.');
  }
  lines.push(`Today: ${today}.`);
  return { inv, text: lines.join('\n') };
}

app.post('/api/ai/parse-filter', requireAuth, async (req, res) => {
  try {
    const text = (req.body && req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const filter = await ai.parseFilterQuery(text);
    res.json({ filter });
  } catch (e) { res.status(502).json({ error: 'AI unavailable: ' + e.message }); }
});

app.post('/api/ai/summary/:recordno', requireAuth, async (req, res) => {
  try {
    const ctx = await buildInvoiceContext(req.params.recordno, req.session.user);
    if (!ctx) return res.status(404).json({ error: 'Invoice not found' });
    const summary = await ai.summarizeAccount(ctx.text);
    db.auditLog(req.session.user.email, 'ai_summary', req.params.recordno, '');
    res.json({ summary });
  } catch (e) { res.status(502).json({ error: 'AI unavailable: ' + e.message }); }
});

app.post('/api/ai/draft-email/:recordno', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), async (req, res) => {
  try {
    const ctx = await buildInvoiceContext(req.params.recordno, req.session.user);
    if (!ctx) return res.status(404).json({ error: 'Invoice not found' });
    const tone = (req.body && req.body.tone) || 'firm but professional';
    const draft = await ai.draftCollectionsEmail(ctx.text, tone);
    db.auditLog(req.session.user.email, 'ai_draft_email', req.params.recordno, tone);
    res.json({ draft });
  } catch (e) { res.status(502).json({ error: 'AI unavailable: ' + e.message }); }
});

app.post('/api/ai/prioritize', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const me = (user.email || '').toLowerCase();
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);
    const acctByCust = {};
    for (const a of db.getAllCustomerAccounts()) acctByCust[a.customer_id] = a;
    const invColl = db.getAllInvoiceCollectors();
    const invStop = db.getAllInvoiceStopService();
    const openPtp = {};
    for (const p of db.getAllOpenPtp()) openPtp[p.record_no] = true;

    const mine = invoices.filter(inv => {
      const ic = invColl[inv.recordNo];
      const c = (ic && ic.collector_email) || (acctByCust[inv.customerId] && acctByCust[inv.customerId].collector_email) || null;
      return c && c.toLowerCase() === me;
    });
    if (!mine.length) return res.json({ ranking: [], invoices: [] });

    const rows = mine.map(inv => {
      const stopped = !!invStop[inv.recordNo] || !!(acctByCust[inv.customerId] && acctByCust[inv.customerId].stop_service);
      return `${inv.recordNo} | ${inv.invoiceId || ''} | ${inv.customerName || inv.customerId} | balance $${(inv.totalDue || 0).toFixed(0)} | ${inv.daysOverdue > 0 ? inv.daysOverdue : 0} days overdue | ${openPtp[inv.recordNo] ? 'has open PTP' : 'no PTP'}${stopped ? ' | STOP SERVICE' : ''}`;
    }).join('\n');

    const result = await ai.prioritizeWork(`Invoices assigned to this collector (recordNo | invoice | customer | balance | overdue | ptp):\n${rows}`);
    const byId = {}; for (const inv of mine) byId[inv.recordNo] = inv;
    const ranked = (result.ranking || [])
      .filter(r => byId[r.recordNo])
      .map(r => ({ ...byId[r.recordNo], aiReason: r.reason }));
    // append any the model dropped, so nothing disappears
    const seen = new Set(ranked.map(r => r.recordNo));
    for (const inv of mine) if (!seen.has(inv.recordNo)) ranked.push({ ...inv, aiReason: '' });
    db.auditLog(user.email, 'ai_prioritize', null, `${ranked.length} invoices`);
    res.json({ invoices: ranked, count: ranked.length });
  } catch (e) { res.status(502).json({ error: 'AI unavailable: ' + e.message }); }
});

// ─── Reliability: reconciliation + health ─────────────────────────────────
app.get('/api/po/exceptions', requireAuth, (req, res) => {
  try {
    res.json(poLedger.getTransmissionExceptions());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health/data', requireAuth, (req, res) => {
  try {
    res.json({ checks: db.getHealth(), now: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Manual PO→site assignment ───────────────────────────────────────────
// For POs whose documents/invoices don't reveal a site: a human pins it here
// and the assignment wins over every automatic attribution source.
app.post('/api/po/:poNumber/site', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    const raw = (req.body && req.body.siteCode || '').trim().toUpperCase();
    if (raw && !/^[A-Z0-9 -]{2,10}$/.test(raw)) return res.status(400).json({ error: 'Site code must be 2-10 letters/digits (e.g. DTW1)' });
    db.setPoSite(req.params.poNumber, raw || null, user.email);
    db.auditLog(user.email, 'po_site_assign', req.params.poNumber, raw || '(cleared)');
    res.json({ ok: true, siteCode: raw || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pin an INVOICE's true service site. Needed for multi-site blanket POs whose
// header ship-to is a corporate code (BNA12 = Amazon Nashville HQ), where the
// PO-site fallback would mislabel the invoice. Empty siteCode clears.
app.post('/api/invoice/:recordNo/site', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    const raw = (req.body && req.body.siteCode || '').trim().toUpperCase();
    if (raw && !/^[A-Z]{2,4}\d{1,2}$/.test(raw)) return res.status(400).json({ error: 'Site code must look like DYY8 / DTW1' });
    db.setInvoiceSite(req.params.recordNo, (req.body && req.body.invoiceId) || null, raw || null, user.email);
    db.auditLog(user.email, 'invoice_site_assign', req.params.recordNo, raw || '(cleared)');
    res.json({ ok: true, siteCode: raw || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manually pin a PO's service type (resolves a "needs service review" flag).
const PO_SERVICE_TYPES = new Set(['snow', 'landscape', 'cleaning', 'maintenance', 'other']);
app.post('/api/po/:poNumber/service', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    const raw = (req.body && req.body.serviceType || '').trim().toLowerCase();
    if (raw && !PO_SERVICE_TYPES.has(raw)) return res.status(400).json({ error: 'service must be one of: ' + [...PO_SERVICE_TYPES].join(', ') });
    db.setPoService(req.params.poNumber, raw || null, user.email);
    db.auditLog(user.email, 'po_service_assign', req.params.poNumber, raw || '(cleared)');
    res.json({ ok: true, serviceType: raw || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Pending-by-Site Excel export ────────────────────────────────────────
// Styled .xlsx mirroring the on-screen report: per-PO rows, merged site cells
// for Site / Site Pending / Site Remaining, red/green/amber color coding.
app.get('/api/po/pending-by-site.xlsx', requireAuth, async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const mode = req.query.mode || 'all';            // all | pending | spare | unassigned
    const snowOnly = req.query.snow === '1';
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    // Same per-user scoping as the on-screen data routes — a filtered user's
    // export must match their screen, not the global picture.
    invoices = applyUserFilter(invoices, req.session.user);

    // ONE grouping shared with the on-screen report (invoice-site attribution,
    // serviceType snow filter, placeholder/no-real-PO rows, site overrides) —
    // the export drifted when this logic lived in two places.
    let list = poLedger.getPendingBySite(invoices, { snowOnly });
    if (mode === 'pending') list = list.filter(s => s.pending > 0);
    else if (mode === 'spare') list = list.filter(s => s.available != null && s.available > 0);
    else if (mode === 'unassigned') {
      list = list.filter(s => s.site === '(no site)');
      for (const s of list) {
        s.poRows = s.poRows.filter(r => r.poStatus === 'OPEN_FOR_INVOICING' || (r.available != null && r.available !== 0) || (r.pendingUpload || 0) > 0);
        s.count = s.poRows.reduce((a, r) => a + (r.pendingUploadInvoiceCount || 0), 0);
      }
      list = list.filter(s => s.poRows.length);
    }
    for (const s of list) s.poRows.sort((a, b) => (b.pendingUpload || 0) - (a.pendingUpload || 0) || (b.available || 0) - (a.available || 0));
    list.sort((a, b) => (b.pending - a.pending) || ((b.available ?? -Infinity) - (a.available ?? -Infinity)));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ECF AR Portal';
    const ws = wb.addWorksheet('PO Funds by Site', { views: [{ state: 'frozen', ySplit: 2 }] });

    const NAVY = 'FF1E3A5F', GRAY = 'FFF1F5F9', LIGHT = 'FFFAFCFF';
    const GREEN = 'FFDCFCE7', GREEN_T = 'FF166534', AMBER = 'FFFEF3C7', AMBER_T = 'FF92400E', RED = 'FFFEE2E2', RED_T = 'FF991B1B';
    const money = '$#,##0.00';
    const pctFill = (frac) => frac == null ? null : frac < 0 ? [RED, RED_T] : frac < 0.15 ? [AMBER, AMBER_T] : [GREEN, GREEN_T];

    // Title + generated stamp
    ws.mergeCells('A1:L1');
    const title = ws.getCell('A1');
    title.value = `ECF — Amazon PO Funds by Site (${mode}${snowOnly ? ' · snow only' : ''}) — generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
    title.font = { bold: true, size: 12, color: { argb: NAVY } };
    ws.getRow(1).height = 20;

    const HEAD = ['Site', 'PO #', 'PO Date', 'Doc/Rev Date', '# Inv', 'PO Value', 'Charges', 'Pending', 'Value Remaining', 'Remaining %', 'Site Pending', 'Site Remaining'];
    const hrow = ws.addRow(HEAD);
    hrow.eachCell(c => {
      c.font = { bold: true, size: 10, color: { argb: 'FF334155' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } };
      c.border = { bottom: { style: 'medium', color: { argb: 'FFCBD5E1' } } };
      c.alignment = { horizontal: 'center' };
    });

    const widths = [14, 18, 11, 12, 7, 14, 14, 14, 15, 12, 14, 15];
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    // PO doc filename date "YYYY-MM-DD" -> "12/3/25"; v1 = receipt, v2+ = revision.
    const shortDate = (s) => { if (!s) return null; const [y, m, d] = String(s).split('-'); return `${+m}/${+d}/${String(y).slice(2)}`; };

    let rowIdx = 3;
    for (const s of list) {
      const start = rowIdx;
      for (const r of s.poRows) {
        const remFrac = (r.available != null && r.ceilingAmount > 0) ? r.available / r.ceilingAmount : null;
        const row = ws.addRow([
          '', r.poNumber + (r.serviceType === 'snow' ? ' ❄' : '') + (r.noRealPo ? ' (no PO)' : ''),
          r.orderDate || null,
          r.docDate ? shortDate(r.docDate) + (r.docDateIsRevision ? ` (rev v${r.docVersion})` : '') : null,
          r.pendingUploadInvoiceCount || null,
          r.ceilingAmount, r.consumed || 0, r.pendingUpload || null,
          r.available, remFrac, '', '',
        ]);
        [6, 7, 8, 9].forEach(ci => { row.getCell(ci).numFmt = money; });
        row.getCell(2).font = { bold: true, color: { argb: NAVY }, size: 10 };
        [3, 4].forEach(ci => { const c = row.getCell(ci); c.font = { size: 9, color: { argb: 'FF64748B' } }; c.alignment = { horizontal: 'center' }; });
        if (r.docDateIsRevision) row.getCell(4).font = { size: 9, bold: true, color: { argb: 'FF5B21B6' } };
        row.getCell(9).font = { bold: true, size: 10, color: { argb: r.available != null && r.available < 0 ? 'FFDC2626' : 'FF1F2937' } };
        const pf = pctFill(remFrac);
        const pc = row.getCell(10);
        pc.numFmt = '0.0%';
        if (pf) { pc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pf[0] } }; pc.font = { bold: true, size: 10, color: { argb: pf[1] } }; }
        pc.alignment = { horizontal: 'center' };
        row.eachCell(c => { c.border = { ...(c.border || {}), bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } }; });
        rowIdx++;
      }
      const end = rowIdx - 1;
      // Merged site cells spanning the site's PO rows — same as on screen.
      // (Single-PO sites skip the merge — a one-cell range throws in ExcelJS.)
      if (end > start) ws.mergeCells(`A${start}:A${end}`);
      const sc = ws.getCell(`A${start}`);
      sc.value = `${s.site}\n${s.count} inv pending`;
      sc.font = { bold: true, color: { argb: NAVY }, size: 10 };
      sc.alignment = { vertical: 'middle', wrapText: true };
      sc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
      if (end > start) ws.mergeCells(`K${start}:K${end}`);
      const sp = ws.getCell(`K${start}`);
      sp.value = s.pending; sp.numFmt = money;
      sp.font = { bold: true, size: 10 };
      sp.alignment = { vertical: 'middle', horizontal: 'right' };
      sp.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
      if (end > start) ws.mergeCells(`L${start}:L${end}`);
      const sa = ws.getCell(`L${start}`);
      sa.value = s.available; sa.numFmt = money;
      sa.font = { bold: true, size: 10, color: { argb: s.available != null && s.available < 0 ? 'FFDC2626' : 'FF16A34A' } };
      sa.alignment = { vertical: 'middle', horizontal: 'right' };
      sa.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.available != null && s.available < 0 ? RED : GREEN } };
      // group separator
      for (let ci = 1; ci <= 12; ci++) ws.getCell(end, ci).border = { ...(ws.getCell(end, ci).border || {}), bottom: { style: 'thin', color: { argb: 'FF94A3B8' } } };
    }

    // Totals
    const tot = list.reduce((a, s) => ({ count: a.count + s.count, pending: a.pending + s.pending, ceiling: a.ceiling + s.ceiling, consumed: a.consumed + s.consumed, available: a.available + (s.available || 0) }), { count: 0, pending: 0, ceiling: 0, consumed: 0, available: 0 });
    const trow = ws.addRow(['Total', '', '', '', tot.count, tot.ceiling, tot.consumed, tot.pending, tot.available, null, tot.pending, tot.available]);
    trow.eachCell(c => { c.font = { bold: true, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRAY } }; c.border = { top: { style: 'medium', color: { argb: 'FF94A3B8' } } }; });
    [6, 7, 8, 9, 11, 12].forEach(ci => { trow.getCell(ci).numFmt = money; });
    trow.getCell(12).font = { bold: true, size: 10, color: { argb: tot.available < 0 ? 'FFDC2626' : 'FF16A34A' } };

    db.auditLog(req.session.user.email, 'export_pending_by_site_xlsx', null, `${mode}${snowOnly ? ' snow' : ''} — ${list.length} sites`);
    // Cloudflare caches .xlsx URLs at the edge BY DEFAULT — without no-store,
    // every download re-serves the first generated file (observed 2026-08-05:
    // stale exports with no origin hit / no audit row). Belt: no-store here;
    // suspenders: the client also appends a &t= cache-buster.
    res.setHeader('Cache-Control', 'no-store, no-cache, private, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ecf-po-funds-by-site-${mode}${snowOnly ? '-snow' : ''}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[api] pending-by-site.xlsx error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/po/:poNumber/notify-reroute', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  try {
    const user = req.session.user;
    const { toPoNumber, note } = req.body || {};
    if (!db.getPurchaseOrder(req.params.poNumber)) return res.status(404).json({ error: 'PO not found' });
    const detail = `Requested Amazon divert funds: ${req.params.poNumber} -> ${toPoNumber || '(new PO)'}${note ? ' — ' + note : ''}`;
    db.auditLog(user.email, 'po_notify_reroute', req.params.poNumber, detail);
    res.json({ ok: true, detail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/po/:poNumber', requireAuth, (req, res) => {
  try {
    const po = db.getPurchaseOrder(req.params.poNumber);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    res.json({ po, documents: db.getPoSourceDocuments(req.params.poNumber) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/po', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  try {
    const user = req.session.user;
    const { poNumber, locationId, customerId, ceilingAmount, notes } = req.body || {};
    if (!poNumber) return res.status(400).json({ error: 'poNumber is required' });
    if (db.getPurchaseOrder(poNumber)) return res.status(409).json({ error: 'PO already exists' });
    const po = db.upsertPo(poNumber, {
      location_id: locationId || null,
      customer_id: customerId || undefined,
      ceiling_amount: ceilingAmount != null ? parseFloat(ceilingAmount) : null,
      notes: notes || null,
    }, user.email);
    db.auditLog(user.email, 'po_create', poNumber, ceilingAmount ? `ceiling $${ceilingAmount}` : '');
    res.json(po);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/po/:poNumber', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  try {
    const user = req.session.user;
    const { locationId, customerId, ceilingAmount, status, notes } = req.body || {};
    if (!db.getPurchaseOrder(req.params.poNumber)) return res.status(404).json({ error: 'PO not found' });
    const fields = {};
    if (locationId !== undefined) fields.location_id = locationId;
    if (customerId !== undefined) fields.customer_id = customerId;
    if (ceilingAmount !== undefined) { fields.ceiling_amount = ceilingAmount != null ? parseFloat(ceilingAmount) : null; fields.ceiling_source = 'manual'; }
    if (status !== undefined) fields.status = status;
    if (notes !== undefined) fields.notes = notes;
    const po = db.upsertPo(req.params.poNumber, fields, user.email);
    db.auditLog(user.email, 'po_update', req.params.poNumber, JSON.stringify(fields));
    res.json(po);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/po/:poNumber', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  try {
    const user = req.session.user;
    db.deletePo(req.params.poNumber);
    db.auditLog(user.email, 'po_delete', req.params.poNumber, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Collection Forecast ─────────────────────────────────────────────────
app.get('/api/reports/collection-forecast', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const totalAR = invoices.reduce((s, i) => s + i.totalDue, 0);
    const openPtps = db.getAllOpenPtp();

    // PTP committed
    const ptpTotal  = openPtps.reduce((s, p) => s + p.amount, 0);
    const ptpCount  = openPtps.length;

    // Group PTPs by week
    const now = new Date();
    const weekBuckets = {};
    for (const p of openPtps) {
      if (!p.promise_date) continue;
      const d = new Date(p.promise_date);
      const diffDays = Math.round((d - now) / 86400000);
      const week = diffDays <= 7 ? 'week1' : diffDays <= 14 ? 'week2' : diffDays <= 21 ? 'week3' : diffDays <= 30 ? 'week4' : 'beyond';
      if (!weekBuckets[week]) weekBuckets[week] = { count: 0, amount: 0 };
      weekBuckets[week].count++;
      weekBuckets[week].amount += p.amount;
    }

    // Pace: invoices created last 90 days to estimate avg monthly AR
    const ninetyDaysAgo = Date.now() - 90 * 86400000;
    let last90Amount = 0;
    for (const inv of invoices) {
      if (inv.whenCreated && new Date(inv.whenCreated).getTime() >= ninetyDaysAgo) {
        last90Amount += inv.totalDue;
      }
    }
    const avgMonthlyNew = last90Amount / 3;

    // Projected AR 30d = today + new - PTP committed
    const projectedAR30 = Math.max(0, totalAR + avgMonthlyNew - ptpTotal);

    res.json({
      totalAR,
      ptpTotal,
      ptpCount,
      weekBuckets,
      avgMonthlyNew,
      projectedAR30,
      invoiceCount: invoices.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ─── API: Activity Log ───────────────────────────────────────────────────────
app.get('/api/activity-log', requireAuth, (req, res) => {
  try {
    const { user_email, action, record_no, limit = 200, offset = 0, date_from, date_to } = req.query;
    const user = req.session.user;

    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];

    // Non-admins: only see their own actions
    if (!['admin', 'manager'].includes(user.role)) {
      sql += ' AND user_email=?';
      params.push(user.email);
    } else if (user_email) {
      sql += ' AND user_email=?';
      params.push(user_email);
    }

    if (action) { sql += ' AND action LIKE ?'; params.push('%' + action + '%'); }
    if (record_no) { sql += ' AND record_no LIKE ?'; params.push('%' + record_no + '%'); }
    if (date_from) { sql += ' AND created_at >= ?'; params.push(date_from); }
    if (date_to)   { sql += ' AND created_at <= ?'; params.push(date_to + ' 23:59:59'); }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const rows = db.all(sql, params);
    const total = db.get('SELECT COUNT(*) as n FROM audit_log WHERE 1=1', []).n;
    res.json({ rows, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Amazon (C-00403) overview ──────────────────────────────────────────
app.get('/api/amazon/overview', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    // Filter to Amazon customer
    const amazon = invoices.filter(i => i.customerId === 'C-00403');
    const payeeIdx = payee.getIndex();

    // Enrich with payee status
    const enriched = amazon.map(inv => {
      const payeeId = (inv.invoiceId || '').replace(/^([A-Z]+)-/, '$1');
      const ps = payeeIdx[payeeId] || null;
      return { ...inv, payeeStatus: ps };
    });

    // Summary by payee status
    const byStatus = {};
    let totalAR = 0;
    let payeeCoverage = 0;
    for (const inv of enriched) {
      totalAR += inv.totalDue;
      const sl = inv.payeeStatus ? inv.payeeStatus.status : 'Unknown';
      if (!byStatus[sl]) byStatus[sl] = { count: 0, amount: 0, statusMeta: inv.payeeStatus?.statusMeta || null };
      byStatus[sl].count++;
      byStatus[sl].amount += inv.totalDue;
      if (inv.payeeStatus) payeeCoverage++;
    }

    // Aging buckets
    const buckets = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '91+': 0 };
    for (const inv of enriched) {
      const b = inv.bucket || 'current';
      buckets[b] = (buckets[b] || 0) + inv.totalDue;
    }

    res.json({
      invoices: enriched,
      totalAR,
      invoiceCount: amazon.length,
      payeeCoverage,
      byStatus,
      buckets,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Customer Statement (HTML for print/PDF) ────────────────────────────
app.get('/api/customer-statement/:customerId', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const custInvoices = invoices
      .filter(i => i.customerId === req.params.customerId)
      .sort((a, b) => (a.whenCreated || '').localeCompare(b.whenCreated || ''));

    if (custInvoices.length === 0) {
      return res.status(404).json({ error: 'No open invoices found for this customer' });
    }

    const custName = custInvoices[0].customerName || req.params.customerId;

    // Rendering shared with the comms email-attachment path (comms-service
    // buildStatementHtml); the route keeps its legacy print-on-open behavior.
    const html = require('./comms-service').buildStatementHtml(req.params.customerId, custInvoices, { autoPrint: true });

    db.auditLog(user.email, 'generate_statement', req.params.customerId, custName);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── API: Customer Account (stop_service + owner) ────────────────────────────
app.get('/api/customer-account/:id', requireAuth, (req, res) => {
  try {
    const acct = db.getCustomerAccount(req.params.id);
    res.json(acct || { customer_id: req.params.id, stop_service: 0, owner_name: null, owner_email: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/customer-account/:id', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    const { stop_service, owner_name, owner_email, customer_name, notes } = req.body;
    const fields = {};
    if (stop_service !== undefined) fields.stop_service = stop_service;
    if (owner_name !== undefined)   fields.owner_name   = owner_name;
    if (owner_email !== undefined)  fields.owner_email  = owner_email;
    if (customer_name !== undefined) fields.customer_name = customer_name;
    if (notes !== undefined)        fields.notes        = notes;
    const acct = db.upsertCustomerAccount(req.params.id, customer_name || req.params.id, fields, user.email);
    const action = stop_service !== undefined ? (stop_service ? 'stop_service' : 'resume_service') : 'update_customer';
    db.auditLog(user.email, action, req.params.id, JSON.stringify(fields));
    res.json(acct);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: All open PTPs ───────────────────────────────────────────────────────
app.get('/api/ptp/all', requireAuth, (req, res) => {
  try {
    const ptps = db.getAllOpenPtp();
    res.json(ptps);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: PTP status update ───────────────────────────────────────────────────
app.patch('/api/ptp/:id/status', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const { status } = req.body;
    if (!['open', 'kept', 'broken', 'partial'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    db.updatePtpStatus(req.params.id, status);
    db.auditLog(req.session.user.email, 'update_ptp_status', req.params.id, status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Customer accounts bulk ─────────────────────────────────────────────
app.get('/api/customer-accounts', requireAuth, (req, res) => {
  try {
    const accounts = db.getAllCustomerAccounts();
    // Index by customer_id
    const map = {};
    for (const a of accounts) map[a.customer_id] = a;
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Customer contacts (comms platform) ─────────────────────────────────
// Sync-seed from Intacct, manual-authoritative — see db.js customer_contacts.
app.get('/api/customers/:customerId/contacts', requireAuth, (req, res) => {
  try {
    res.json(db.listCustomerContacts(req.params.customerId, req.query.all === '1'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/customers/:customerId/contacts', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    const { name, email, phone, title, is_primary, consent_email, dunning_enabled, notes } = req.body;
    const contact = db.addCustomerContact(req.params.customerId,
      { name, email, phone, title, is_primary, consent_email, dunning_enabled, notes }, user.email);
    db.auditLog(user.email, 'comm_contact_add', req.params.customerId, `${contact.email}${name ? ' (' + name + ')' : ''}`);
    res.json(contact);
  } catch (e) {
    const code = /invalid email|UNIQUE constraint/.test(e.message) ? 400 : 500;
    res.status(code).json({ error: /UNIQUE constraint/.test(e.message) ? 'That email already exists for this customer' : e.message });
  }
});

app.put('/api/contacts/:id', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    const contact = db.updateCustomerContact(parseInt(req.params.id, 10), req.body, user.email);
    db.auditLog(user.email, 'comm_contact_update', contact.customer_id, `${contact.email}: ${JSON.stringify(req.body).slice(0, 200)}`);
    res.json(contact);
  } catch (e) {
    const code = /invalid email|not found/.test(e.message) ? 400 : 500;
    res.status(code).json({ error: e.message });
  }
});

app.delete('/api/contacts/:id', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    const contact = db.updateCustomerContact(parseInt(req.params.id, 10), { is_active: 0, is_primary: 0 }, user.email);
    db.auditLog(user.email, 'comm_contact_deactivate', contact.customer_id, contact.email);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contacts/sync', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const summary = await runContactSync(req.session.user.email);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Comms — outbound customer email (comms-service.js) ─────────────────
// The actor is ALWAYS the real logged-in user (req.session.realUser when an
// admin is impersonating) — sends must never be attributed to the mask.
const comms = require('./comms-service');

function commsRealActor(req) {
  return ((req.session.realUser || req.session.user) || {}).email || '';
}

// Whitelist the compose fields a client may supply; actor/actorType are set
// server-side so a request body can never spoof automation identity.
function commsPickBody(body) {
  const { customerId, contactId, toEmails, ccEmails, recordNos,
          templateKey, rawSubject, rawBody, attachStatement, attachInvoicePdfs, conversationId, correspondingEmail } = body || {};
  return { customerId, contactId, toEmails, ccEmails, recordNos,
           templateKey, rawSubject, rawBody, attachStatement, attachInvoicePdfs, conversationId, correspondingEmail };
}

app.get('/api/comms/config', requireAuth, (req, res) => {
  let mailbox = null;
  try { mailbox = require('./graph').mailbox(); } catch (e) { /* unset */ }
  res.json({
    mailbox,
    testMode: comms.allowlist().length > 0,
    allowlistSize: comms.allowlist().length,
    dunningArmed: process.env.DUNNING_ARMED === '1',
    statementsArmed: process.env.STATEMENTS_ARMED === '1',
    sageCacheAgeMin: Math.round((sage.getCacheAge() || 0) / 60000),
  });
});

app.post('/api/comms/preview', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const actor = commsRealActor(req);
    const p = commsPickBody(req.body);
    res.json(comms.previewMessage({ ...p, correspondingEmail: p.correspondingEmail || actor }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/comms/send', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), async (req, res) => {
  try {
    const actor = commsRealActor(req);
    const p = commsPickBody(req.body);

    // Resolve invoice PDF attachments HERE (route layer) so comms-service
    // stays generic. Fails loudly: the user asked for the PDF, so a send
    // without it would be worse than no send.
    let extraAttachments;
    if (p.attachInvoicePdfs && Array.isArray(p.recordNos) && p.recordNos.length) {
      const invoices = applyUserFilter(sage.getCachedInvoices(), req.session.user);
      extraAttachments = [];
      for (const rn of p.recordNos.slice(0, 5)) {
        const inv = invoices.find(i => i.recordNo === rn);
        if (!inv) return res.status(400).json({ error: `Invoice ${rn} not found (or outside your scope)` });
        const buf = await fetchInvoicePdfBuffer(inv);
        if (!buf) return res.status(400).json({ error: `No PDF available for ${inv.invoiceId}` });
        extraAttachments.push({ name: `${inv.invoiceId}.pdf`, contentType: 'application/pdf', contentBytes: buf.toString('base64'), size: buf.length });
      }
      if (p.recordNos.length > 5) {
        return res.status(400).json({ error: 'At most 5 invoice PDFs per email — attach the statement instead' });
      }
    }

    const result = await comms.sendMessage({
      ...p,
      extraAttachments,
      actorEmail: actor,
      actorType: 'human',
      correspondingEmail: p.correspondingEmail || actor,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/comms/templates', requireAuth, (req, res) => {
  try { res.json(db.listTemplates()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comms/templates', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { key, name, kind, subject, body_html } = req.body;
    if (!key || !subject || !body_html) return res.status(400).json({ error: 'key, subject, body_html required' });
    if (!/^[a-z0-9_]+$/.test(key)) return res.status(400).json({ error: 'key must be lowercase [a-z0-9_]' });
    const tokens = comms.extractTokens(subject, body_html);   // throws on unknown tokens
    const t = db.saveTemplateVersion(key, name, kind === 'internal' ? 'internal' : 'external',
      subject, body_html, JSON.stringify(tokens), req.session.user.email);
    db.auditLog(req.session.user.email, 'comm_template_save', null, `${key} v${t.current_version}`);
    res.json(t);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/comms/templates/:key/versions', requireAuth, (req, res) => {
  try { res.json(db.listTemplateVersions(req.params.key)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/comms/conversations', requireAuth, (req, res) => {
  try {
    // needsReply=1: customer spoke last and the thread is open — the core
    // "action item" state for a collector.
    if (req.query.needsReply === '1') {
      const rows = db.all(`
        SELECT * FROM conversations
        WHERE status='open' AND last_direction='in'
        ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 200
      `);
      return res.json(rows);
    }
    res.json(db.listConversations({
      customerId: req.query.customerId || undefined,
      status: req.query.status || undefined,
      assigned: req.query.assigned || undefined,
      limit: Math.min(parseInt(req.query.limit || '200', 10) || 200, 500),
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One call the UI polls for the logged-in user's comms action items:
// threads awaiting a reply (mine / unassigned / everyone's) + triage count.
app.get('/api/comms/action-items', requireAuth, (req, res) => {
  try {
    const me = String(req.session.user.email || '').toLowerCase();
    const needs = db.all(`
      SELECT id, customer_id, subject, assigned_email, last_message_at
      FROM conversations WHERE status='open' AND last_direction='in'
      ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 100
    `);
    const triage = db.get(`SELECT COUNT(*) AS c FROM conversations WHERE status='triage'`).c;
    res.json({
      needsReplyMine: needs.filter(c => (c.assigned_email || '') === me).length,
      needsReplyUnassigned: needs.filter(c => !c.assigned_email).length,
      needsReplyTotal: needs.length,
      triage,
      items: needs.slice(0, 20),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/comms/conversations/:id', requireAuth, (req, res) => {
  try {
    const conversation = db.getConversation(parseInt(req.params.id, 10));
    if (!conversation) return res.status(404).json({ error: 'Not found' });
    const messages = db.getMessagesForConversation(conversation.id).map(m => ({
      ...m,
      recordNos: db.all('SELECT record_no FROM message_invoices WHERE message_id=?', [m.id]).map(r => r.record_no),
    }));
    res.json({ conversation, messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/:recordNo/messages', requireAuth, (req, res) => {
  try { res.json(db.getMessagesForInvoice(req.params.recordNo)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Comms triage (unmatched inbound mail) ──────────────────────────────
app.get('/api/comms/triage', requireAuth, (req, res) => {
  try {
    const convs = db.listConversations({ status: 'triage', limit: 200 });
    res.json(convs.map(c => {
      const msgs = db.getMessagesForConversation(c.id);
      const last = msgs[msgs.length - 1] || {};
      return {
        ...c,
        lastFrom: last.from_email || '',
        lastSubject: last.subject || c.subject || '',
        lastSnippet: String(last.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160),
        lastAt: last.received_at || last.created_at || c.created_at,
        messageCount: msgs.length,
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comms/triage/:id/file', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    const conv = db.getConversation(parseInt(req.params.id, 10));
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const { customerId, assignEmail, createContact } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    let contactId = null;
    if (createContact) {
      // One-click "create contact from sender" while filing.
      const msgs = db.getMessagesForConversation(conv.id);
      const senderEmail = (msgs.find(m => m.direction === 'in') || {}).from_email;
      if (senderEmail) {
        try {
          const c = db.addCustomerContact(customerId, { email: senderEmail, name: req.body.contactName || null }, user.email);
          contactId = c.id;
          db.auditLog(user.email, 'comm_contact_add', customerId, `${senderEmail} (from triage)`);
        } catch (e) { /* already a contact — fine */ }
      }
    }
    const d = db.getDb();
    d.prepare("UPDATE conversations SET customer_id=?, contact_id=COALESCE(?, contact_id), assigned_email=?, status='open', updated_at=datetime('now') WHERE id=?")
      .run(customerId, contactId, assignEmail ? String(assignEmail).trim().toLowerCase() : (conv.assigned_email || user.email.toLowerCase()), conv.id);
    db.auditLog(user.email, 'comm_triage_file', null, `conv=${conv.id} -> ${customerId}${assignEmail ? ' assigned ' + assignEmail : ''}`);
    res.json(db.getConversation(conv.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/comms/triage/:id/dismiss', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const user = req.session.user;
    const conv = db.getConversation(parseInt(req.params.id, 10));
    if (!conv) return res.status(404).json({ error: 'Not found' });
    db.getDb().prepare("UPDATE conversations SET status='archived', updated_at=datetime('now') WHERE id=?").run(conv.id);
    db.auditLog(user.email, 'comm_triage_dismiss', null, `conv=${conv.id} "${(conv.subject || '').slice(0, 80)}"`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Dunning engine (dunning.js) ────────────────────────────────────────
// Preview-first, armed-gated. Executing a run live requires DUNNING_ARMED=1 in
// .env (Edwin's step) AND still passes every send through the comms allowlist.
const dunning = require('./dunning');

app.get('/api/dunning/rules', requireAuth, (req, res) => {
  try { res.json(db.listDunningRules()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dunning/rules', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  try {
    const f = { ...req.body };
    if (!f.id && (!f.name || !f.template_key || f.trigger_days_past_due == null || f.sequence == null)) {
      return res.status(400).json({ error: 'name, sequence, trigger_days_past_due, template_key required' });
    }
    if (f.template_key && !db.getTemplateByKey(f.template_key)) {
      return res.status(400).json({ error: `Unknown template: ${f.template_key}` });
    }
    if (f.billing_stream && !['all', 'sage', 'omnia'].includes(f.billing_stream)) {
      return res.status(400).json({ error: 'billing_stream must be all|sage|omnia' });
    }
    if (f.target_mode && !['all', 'only', 'except'].includes(f.target_mode)) {
      return res.status(400).json({ error: 'target_mode must be all|only|except' });
    }
    if (Array.isArray(f.target_customers)) f.target_customers = JSON.stringify(f.target_customers);
    if (f.target_mode === 'only' && (!f.target_customers || f.target_customers === '[]')) {
      return res.status(400).json({ error: 'Targeting "only specific customers" needs at least one customer' });
    }
    const rule = db.upsertDunningRule(f.id || null, f);
    db.auditLog(req.session.user.email, 'dunning_rule_save', null,
      `${rule.id} ${rule.name} active=${rule.active} target=${rule.target_mode}${rule.target_customers && rule.target_customers !== '[]' ? ':' + JSON.parse(rule.target_customers).length : ''}`);
    res.json(rule);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/dunning/rules/:id', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const rule = db.listDunningRules().find(r => r.id === parseInt(req.params.id, 10));
    if (!rule) return res.status(404).json({ error: 'Not found' });
    db.deleteDunningRule(rule.id);
    db.auditLog(req.session.user.email, 'dunning_rule_delete', null, `${rule.id} ${rule.name}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live impact preview for the rule editor: what would these parameters match
// against TODAY's cached invoices. Read-only.
app.post('/api/dunning/rules/impact', requireAuth, (req, res) => {
  try { res.json(dunning.ruleImpact(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── API: Overview dashboard (emulates the reconciliation platform's home) ───
// Service-center code from a location name by initials: "Baltimore Service
// Center" -> BSC, "South Chicago Service Center" -> SCSC. Matches the temp
// platform's chip codes for the common cases; unknowns render neutral.
const SC_BY_LOCATION = {
  'L-ECF-ALN': 'ASC',   // Allentown
  'L-ECF-BLT': 'BTSC',  // Baltimore (confirmed by Edwin)
  'L-ECF-BRW': 'BSC',   // Broward (confirmed by Edwin)
  'L-ECF-CIN': 'CTSC',  // Cincinnati
  'L-ECF-FCR': 'FC',    // FacilityCare
  'L-ECF-HBG': 'HSC',   // Harrisburg
  'L-ECF-HCT': 'HTSC',  // Hartford
  'L-ECF-SCSC': 'SCSC', // South Chicago
  'L-ECF-SRN': 'SSC',   // Scranton
  'L-ECF-TRN': 'TSC',   // Trenton
  'L-ECF-WPB': 'WPB',   // Palm Beach — no code observed on their platform yet
  'E-ECF': 'ECF',       // corporate
};
function scCodeFromLocation(locationIdOrName, name) {
  if (SC_BY_LOCATION[locationIdOrName]) return SC_BY_LOCATION[locationIdOrName];
  const words = String(name || locationIdOrName || '').replace(/[^a-zA-Z ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const code = words.map(w => w[0].toUpperCase()).join('');
  return code.length >= 2 && code.length <= 4 ? code : null;
}

app.get('/api/overview', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const csMap = db.getAllCollectionStatuses();
    const buckets = { '1-30': 0, '31-60': 0, '61-90': 0, '91-180': 0, '181+': 0 };
    let totalAR = 0, pastDueAR = 0, pastDueCount = 0, oldest = 0, sentToLegal = 0;
    const custs = new Map();
    const locs = new Set();
    const userScs = new Set();

    for (const inv of invoices) {
      totalAR += inv.totalDue;
      if (inv.locationId) locs.add(inv.locationId);
      const sc = scCodeFromLocation(inv.locationId, inv.locationName);
      if (sc) userScs.add(sc);
      const d = inv.daysOverdue || 0;
      if (d > oldest) oldest = d;
      const cs = csMap[inv.recordNo];
      if (cs && cs.status === 'Sent to Legal') sentToLegal += inv.totalDue;
      if (d >= 1) {
        pastDueAR += inv.totalDue;
        pastDueCount++;
        if (d <= 30) buckets['1-30'] += inv.totalDue;
        else if (d <= 60) buckets['31-60'] += inv.totalDue;
        else if (d <= 90) buckets['61-90'] += inv.totalDue;
        else if (d <= 180) buckets['91-180'] += inv.totalDue;
        else buckets['181+'] += inv.totalDue;
      }
      let c = custs.get(inv.customerId);
      if (!c) { c = { id: inv.customerId, name: inv.customerName, invoices: 0, pastDue: 0, oldest: 0, scs: new Set() }; custs.set(inv.customerId, c); }
      c.invoices++;
      if (d >= 1) c.pastDue += inv.totalDue;
      if (d > c.oldest) c.oldest = d;
      if (sc) c.scs.add(sc);
    }

    const top10 = [...custs.values()]
      .filter(c => c.pastDue > 0)
      .sort((a, b) => b.pastDue - a.pastDue)
      .slice(0, 10)
      .map(c => ({ ...c, scs: [...c.scs].sort().slice(0, 10) }));

    res.json({
      role: user.role,
      serviceCenters: [...userScs].sort(),
      totalAR, openInvoices: invoices.length,
      pastDueAR, pastDueCount,
      currentAR: totalAR - pastDueAR,
      customers: custs.size, locations: locs.size,
      oldestDays: oldest,
      buckets,
      sentToLegal,
      pctPastDue: totalAR > 0 ? Math.round((pastDueAR / totalAR) * 100) : 0,
      top10,
      sageCacheAgeMin: Math.round((sage.getCacheAge() || 0) / 60000),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Invite a user (pre-provision + invitation email) ───────────────────
app.post('/api/admin/invite', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { email, name, role, job_title } = req.body || {};
    const norm = String(email || '').trim().toLowerCase();
    if (!norm.endsWith('@eastcoastfacilities.com')) return res.status(400).json({ error: 'Must be an @eastcoastfacilities.com address' });
    if (!['admin', 'manager', 'ar_specialist', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    db.preProvisionUser(norm, name || '', role, job_title || null);
    const inviter = req.session.user;
    await sendGraphMail(norm, 'You have been invited to the ECF AR Portal',
`Hello${name ? ' ' + name.split(' ')[0] : ''},

${inviter.name} has invited you to the ECF AR Portal, the live accounts receivable workspace.

Sign in here with your ECF Microsoft account (this email address, your normal password):
${portalBaseUrl()}

Your access level: ${role.replace('_', ' ')}

Where to start:
- Dashboard: live AR totals and aging, updated straight from Sage
- Invoices (Client Data menu): the full invoice grid with filters
- My Work (Operations menu): invoices assigned to you

No separate password is needed. Questions? Reply to ${inviter.email}.

—ECF AR Portal`);
    db.auditLog(inviter.email, 'user_invite', null, `${norm} as ${role}`);
    res.json({ ok: true, email: norm, role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Stop-service list (their Operations screen) ────────────────────────
app.get('/api/stop-service-view', requireAuth, async (req, res) => {
  try {
    let invoices = sage.getCachedInvoices();
    if (!invoices.length) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, req.session.user);
    const byCust = new Map();
    for (const i of invoices) {
      let c = byCust.get(i.customerId);
      if (!c) { c = { pastDue: 0, oldest: 0, scs: new Set(), name: i.customerName }; byCust.set(i.customerId, c); }
      if ((i.daysOverdue || 0) >= 1) { c.pastDue += i.totalDue; if (i.daysOverdue > c.oldest) c.oldest = i.daysOverdue; }
      const sc = scCodeFromLocation(i.locationId, i.locationName);
      if (sc) c.scs.add(sc);
    }
    const rows = [];
    for (const acct of db.getAllCustomerAccounts()) {
      if (!acct.stop_service) continue;
      const c = byCust.get(acct.customer_id) || { pastDue: 0, oldest: 0, scs: new Set(), name: acct.customer_name };
      rows.push({
        customerId: acct.customer_id, name: c.name || acct.customer_name,
        scs: [...c.scs].sort(), pastDue: c.pastDue, oldest: c.oldest,
        effectiveDate: acct.stop_service_effective_date, issuedBy: acct.stop_service_issued_by,
        since: acct.stop_service_at,
      });
    }
    rows.sort((a, b) => String(a.effectiveDate || '').localeCompare(String(b.effectiveDate || '')));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Grid metadata (one call powering the emulated Invoices/My Work) ────
app.get('/api/grid-meta', requireAuth, (req, res) => {
  try {
    const collectors = {};
    for (const [rn, r] of Object.entries(db.getAllInvoiceCollectors())) collectors[rn] = r.collector_email;
    const customerCollectors = {};
    for (const a of db.getAllCustomerAccounts()) if (a.collector_email) customerCollectors[a.customer_id] = a.collector_email;
    res.json({
      statuses: COLLECTION_STATUSES,
      csByRecord: db.getAllCollectionStatuses(),
      collectors,
      customerCollectors,
      users: db.listUsers().map(u => ({ email: u.email, name: u.name })),
      scMap: SC_BY_LOCATION,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Customer page / Locations / Global search (emulation Phase 4) ──────
app.get('/api/customer-page/:customerId', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (!invoices.length) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user).filter(i => i.customerId === req.params.customerId);
    const name = invoices.length ? invoices[0].customerName : req.params.customerId;
    let pastDue = 0, totalAR = 0, oldest = 0;
    const bySc = {};
    for (const i of invoices) {
      totalAR += i.totalDue;
      const d = i.daysOverdue || 0;
      if (d > oldest) oldest = d;
      if (d >= 1) pastDue += i.totalDue;
      const sc = scCodeFromLocation(i.locationId, i.locationName) || '—';
      if (!bySc[sc]) bySc[sc] = { sc, pastDue: 0, open: 0, count: 0 };
      bySc[sc].count++;
      bySc[sc].open += i.totalDue;
      if (d >= 1) bySc[sc].pastDue += i.totalDue;
    }
    res.json({
      id: req.params.customerId, name,
      kpis: { pastDue, totalAR, oldest, invoices: invoices.length, locations: new Set(invoices.map(i => i.locationId)).size },
      scBreakdown: Object.values(bySc).sort((a, b) => b.pastDue - a.pastDue),
      invoices: invoices.sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0)),
      account: db.getCustomerAccount(req.params.customerId),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/locations-view', requireAuth, async (req, res) => {
  try {
    let invoices = sage.getCachedInvoices();
    if (!invoices.length) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, req.session.user);
    const by = new Map();
    for (const i of invoices) {
      const key = i.locationId || '—';
      let r = by.get(key);
      if (!r) { r = { locationId: key, locationName: i.locationName || key, sc: scCodeFromLocation(i.locationId, i.locationName), pastDue: 0, current: 0, invoices: 0, totalAR: 0, customers: new Set() }; by.set(key, r); }
      r.invoices++; r.totalAR += i.totalDue; r.customers.add(i.customerId);
      if ((i.daysOverdue || 0) >= 1) r.pastDue += i.totalDue; else r.current += i.totalDue;
    }
    res.json([...by.values()].map(r => ({ ...r, customers: r.customers.size })).sort((a, b) => b.totalAR - a.totalAR));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ customers: [], invoices: [], locations: [] });
    let invoices = sage.getCachedInvoices();
    if (!invoices.length) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, req.session.user);
    const custs = new Map(), locs = new Map(), invs = [];
    for (const i of invoices) {
      if ((i.customerName || '').toLowerCase().includes(q) || (i.customerId || '').toLowerCase().includes(q)) {
        const c = custs.get(i.customerId) || { id: i.customerId, name: i.customerName, invoices: 0, totalAR: 0 };
        c.invoices++; c.totalAR += i.totalDue; custs.set(i.customerId, c);
      }
      if ((i.locationName || '').toLowerCase().includes(q) && !locs.has(i.locationId)) locs.set(i.locationId, { id: i.locationId, name: i.locationName });
      if (invs.length < 25 && ((i.invoiceId || '').toLowerCase().includes(q) || (i.poNumber || '').toLowerCase().includes(q))) invs.push(i);
    }
    res.json({ customers: [...custs.values()].slice(0, 20), invoices: invs, locations: [...locs.values()].slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: InterNex Capital (Velocity) — range/single transmit, LOC rules ─────
// Edwin's rules (2026-08-12): everything transmits under LOC1; LOC2 is only
// for Amazon invoices NOT in the Payee feed (flagged in preview, held from
// transmit until the uploader's account switcher is mapped). Live sends gated
// by VELOCITY_TRANSMIT_ARMED. Tracks the last invoice number transmitted.
const velocityBridge = require('./velocity-bridge');
const AMAZON_CUSTS = new Set(['C-00403', 'C-00566']);

let _vNameMap = null;
let _vFeed = { mtime: 0, map: {} };
function velocityFeedRow(invoiceId) {
  try {
    const p = path.join(__dirname, 'velocity-feed.spark.json');
    const mt = fs.statSync(p).mtimeMs;
    if (mt !== _vFeed.mtime) {
      const f = JSON.parse(fs.readFileSync(p, 'utf8'));
      const map = {};
      for (const i of (f.invoices || [])) map[i.invoiceNumber] = i;
      _vFeed = { mtime: mt, map, generatedAt: f.generatedAt };
    }
    return _vFeed.map[invoiceId] || null;
  } catch (e) { return null; }
}
function velocityName(customerName) {
  try {
    if (_vNameMap === null) {
      _vNameMap = {};
      const p = path.join(__dirname, 'velocity-name-map.spark.json');
      if (fs.existsSync(p)) _vNameMap = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) { _vNameMap = {}; }
  return _vNameMap[customerName] || customerName;
}

// Feed-driven confirmation + advance-only high-water mark (Edwin 2026-08-13):
// an invoice counts once Velocity's scrape shows it; retransmits and sends
// below the mark never move it (Math.max only).
function reconcileVelocity() {
  try {
    velocityFeedRow('__warm__');   // ensure feed cache is loaded/refreshed
    const feedIds = Object.keys(_vFeed.map);
    const confirmed = db.confirmVelocityTransmits(feedIds);
    const maxima = {};
    for (const id of feedIds) {
      const p = parseInv(id);
      if (p && (!maxima[p.prefix] || p.num > maxima[p.prefix])) maxima[p.prefix] = p.num;
    }
    const advanced = {};
    for (const [pfx, mx] of Object.entries(maxima)) {
      const key = 'velocity_last_' + pfx;
      const prev = parseInt(db.getCommState(key) || '0', 10) || 0;
      if (mx > prev) { db.setCommState(key, String(mx)); advanced[pfx] = mx; }
    }
    return { confirmed, advanced, maxima };
  } catch (e) { return { confirmed: 0, error: e.message }; }
}

function parseInv(invoiceId) {
  const m = /^([A-Z]+)-(\d+)$/i.exec(String(invoiceId || '').trim());
  return m ? { prefix: m[1].toUpperCase(), num: parseInt(m[2], 10) } : null;
}
function eciNum(invoiceId) {
  const p = parseInv(invoiceId);
  return p && p.prefix === 'ECI' ? p.num : null;
}
// Per-prefix confirmed high-water marks (velocity_last_<PREFIX> in comm_state;
// legacy velocity_last_number migrates to ECI on first read).
const VELOCITY_PREFIXES = ['ECI', 'AST', 'ASTM', 'S', 'SPI', 'SS'];
function velocityMarks() {
  const marks = {};
  for (const p of VELOCITY_PREFIXES) {
    const v = parseInt(db.getCommState('velocity_last_' + p) || '0', 10) || 0;
    if (v) marks[p] = v;
  }
  if (!marks.ECI) {
    const legacy = parseInt(db.getCommState('velocity_last_number') || '0', 10) || 0;
    if (legacy) { db.setCommState('velocity_last_ECI', String(legacy)); marks.ECI = legacy; }
  }
  return marks;
}

function velocityRows(prefix, from, to, user) {
  let invoices = applyUserFilter(sage.getCachedInvoices(), user);
  const payeeMod = require('./payee');
  const vtMap = db.getVelocityTransmitMap();
  const rows = [];
  for (const inv of invoices) {
    const p = parseInv(inv.invoiceId);
    if (!p || p.prefix !== prefix || p.num < from || p.num > to) continue;
    const num = p.num;
    let line = 'LOC1';
    if (AMAZON_CUSTS.has(inv.customerId)) {
      let inPayee = false;
      try { inPayee = !!(payeeMod.lookupInvoice && payeeMod.lookupInvoice(inv.invoiceId)); } catch (e) {}
      line = inPayee ? 'LOC1' : 'LOC2';
    }
    rows.push({
      recordNo: inv.recordNo, invoiceId: inv.invoiceId, num,
      customer: inv.customerName, velocityCustomer: velocityName(inv.customerName),
      amount: inv.totalEntered || inv.totalDue, balance: inv.totalDue,
      whenCreated: inv.whenCreated, whenDue: inv.whenDue, daysOverdue: inv.daysOverdue || 0,
      line, transmitted: vtMap[inv.recordNo] || null,
      feed: (() => { const f = velocityFeedRow(inv.invoiceId); return f ? { account: f.account, status: f.status, balance: f.balance } : null; })(),
    });
  }
  rows.sort((a, b) => a.num - b.num);
  return rows;
}

function buildVelocityCsv(rows) {
  const d2 = (s) => {
    const dt = new Date(s);
    if (isNaN(dt)) return '';
    return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${String(dt.getFullYear()).slice(2)}`;
  };
  const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const lines = ['INVOICE #,CUSTOMER,INVOICE DATE,DUE,AMOUNT,AMOUNT PAID,BALANCE,TERM,AGE,Days Past Due,TX_TYPE,CM_REASON,INELIGIBLE'];
  for (const r of rows) {
    const paid = Math.max(0, (r.amount || 0) - (r.balance || 0));
    const term = r.whenCreated && r.whenDue ? days(r.whenCreated, r.whenDue) : '';
    const age = r.whenCreated ? days(r.whenCreated, new Date()) : '';
    const cust = String(r.velocityCustomer).replace(/,/g, ' ');
    lines.push(`${r.invoiceId},${cust},${d2(r.whenCreated)},${d2(r.whenDue)},$${(r.amount || 0).toFixed(2)},$${paid.toFixed(2)},$${(r.balance || 0).toFixed(2)},${term},${age},${r.daysOverdue},Invoice,,N`);
  }
  return lines.join('\n') + '\n';
}

app.get('/api/velocity/pending', requireAuth, (req, res) => {
  try {
    const prefix = String(req.query.prefix || 'ECI').toUpperCase();
    const from = parseInt(req.query.from, 10), to = parseInt(req.query.to, 10);
    if (!from || !to || to < from || to - from > 2000) return res.status(400).json({ error: 'Give a sane from/to invoice number range' });
    res.json({
      rows: velocityRows(prefix, from, to, req.session.user),
      marks: velocityMarks(),
      armed: process.env.VELOCITY_TRANSMIT_ARMED === '1',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/velocity/transmit', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    if (process.env.VELOCITY_TRANSMIT_ARMED !== '1') {
      return res.status(400).json({ error: 'VELOCITY_TRANSMIT_ARMED is not set — InterNex transmission is disabled.' });
    }
    const busy = await velocityBridge.lockState();
    if (busy.locked) return res.status(409).json({ error: `Velocity browser is busy (${busy.tool} since ${busy.since}) — transmit blocked to protect the session.` });
    const { from, to, includeRetransmit, line, confirmLoc2, prefix: rawPrefix, invoiceIds } = req.body || {};
    const prefix = String(rawPrefix || 'ECI').toUpperCase();
    const byList = Array.isArray(invoiceIds) && invoiceIds.length > 0;
    const f = parseInt(from, 10), t = parseInt(to, 10);
    if (!byList && (!f || !t || t < f)) return res.status(400).json({ error: 'from/to or invoiceIds required' });
    const targetLine = line === 'LOC2' ? 'LOC2' : 'LOC1';
    // LOC2 is EXPRESS-ONLY (Edwin 2026-08-12): a dedicated request with an
    // explicit confirmation flag; never part of a default transmit.
    if (targetLine === 'LOC2' && confirmLoc2 !== true) {
      return res.status(400).json({ error: 'LOC2 transmission requires the express confirmation' });
    }
    let rows;
    if (byList) {
      // Explicit list (reconcile popup): resolve each id via its own series.
      const wanted = new Set(invoiceIds.map(String));
      rows = [];
      for (const id of wanted) {
        const p = parseInv(id);
        if (!p) continue;
        rows.push(...velocityRows(p.prefix, p.num, p.num, req.session.user));
      }
      rows = rows.filter(r => wanted.has(r.invoiceId) && r.line === targetLine);
    } else {
      rows = velocityRows(prefix, f, t, req.session.user).filter(r => r.line === targetLine);
    }
    const skippedRetrans = rows.filter(r => r.transmitted && !includeRetransmit).length;
    if (!includeRetransmit) rows = rows.filter(r => !r.transmitted);
    if (!rows.length) return res.status(400).json({ error: `Nothing to transmit${skippedRetrans ? ` (${skippedRetrans} already transmitted — enable retransmit to resend)` : ''}` });
    const csv = buildVelocityCsv(rows);
    const padW = prefix === 'S' ? 4 : 6;
    const tmp = byList
      ? path.join('/tmp', `velocity-list-${Date.now()}-${rows.length}.csv`)
      : path.join('/tmp', `velocity-batch-${prefix}-${String(f).padStart(padW, '0')}-${String(t).padStart(padW, '0')}.csv`);
    fs.writeFileSync(tmp, csv);
    const user = commsRealActor(req);
    const result = await velocityBridge.transmitFile(tmp, { dryRun: false, account: targetLine });
    const batch = byList ? `list:${rows.length}` : `${prefix} ${f}-${t}`;
    for (const r of rows) db.insertVelocityTransmit(r.recordNo, r.invoiceId, r.line, batch, result.ok ? 'OK' : 'FAIL', user);
    // High-water mark advances only on CONFIRMED acceptance (feed reconcile),
    // never at transmit time — and never moves for retransmits/backfills.
    db.auditLog(user, 'velocity_transmit', rows[0].recordNo,
      `[${targetLine}] batch ${batch}: ${rows.length} invoice(s) -> ${result.ok ? 'OK' : 'FAIL'}${skippedRetrans ? `, ${skippedRetrans} retransmit-skipped` : ''}`);
    res.json({ ok: result.ok, count: rows.length, batch, skippedRetrans, output: result.output });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── One-button reconciliation: our open AR vs Velocity's open invoices ──────
// ─── On-demand Velocity refresh (scrape now → sync → reconcile) ──────────────
app.post('/api/velocity/refresh', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const lock = await velocityBridge.lockState();
    if (lock.locked) return res.status(409).json({ error: `Velocity browser is busy (${lock.tool} since ${lock.since}). Try again shortly.` });
    const before = await velocityBridge.remoteFeedMtime();
    const ok = await velocityBridge.startScrape();
    if (!ok) return res.status(500).json({ error: 'Could not start the scrape on the iMac' });
    db.setCommState('velocity_refresh_before', String(before));
    db.setCommState('velocity_refresh_started', new Date().toISOString());
    db.auditLog(req.session.user.email, 'velocity_refresh', null, 'on-demand scrape started');
    res.json({ started: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/velocity/refresh-status', requireAuth, async (req, res) => {
  try {
    const before = parseInt(db.getCommState('velocity_refresh_before') || '0', 10);
    const startedAt = db.getCommState('velocity_refresh_started');
    const now = await velocityBridge.remoteFeedMtime();
    if (now > before) {
      await velocityBridge.syncFeed(__dirname);
      _vFeed = { mtime: 0, map: {} };
      const rec = reconcileVelocity();
      return res.json({ done: true, syncedAt: new Date().toISOString(), reconcile: rec });
    }
    const lock = await velocityBridge.lockState();
    const mins = startedAt ? Math.round((Date.now() - Date.parse(startedAt)) / 60000) : null;
    if (!lock.locked && mins != null && mins > 2) {
      return res.json({ done: false, stalled: true, note: 'Scrape not running and feed not updated — check /tmp/velocity-scrape-portal.log on the iMac' });
    }
    res.json({ done: false, runningFor: mins, lock });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/velocity/reconcile', requireAuth, async (req, res) => {
  try {
    let invoices = sage.getCachedInvoices();
    if (!invoices.length) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, req.session.user);
    velocityFeedRow('__warm__');
    const feedMap = _vFeed.map;

    const ours = new Map();
    for (const i of invoices) if (i.totalDue > 0.01) ours.set(i.invoiceId, i);

    const matched = [], velocityOnly = [], oursOnly = [], balanceMismatch = [];
    let ourTotal = 0, velTotal = 0;

    for (const [id, inv] of ours) {
      ourTotal += inv.totalDue;
      const f = feedMap[id];
      if (f && f.status === 'open') {
        matched.push(id);
        if (Math.abs((f.balance || 0) - inv.totalDue) > 1) {
          balanceMismatch.push({ invoiceId: id, customer: inv.customerName, ourBalance: inv.totalDue, velocityBalance: f.balance, account: f.account });
        }
      } else {
        oursOnly.push({ invoiceId: id, customer: inv.customerName, balance: inv.totalDue, daysOverdue: inv.daysOverdue || 0, velocityStatus: f ? f.status : 'never submitted' });
      }
    }
    for (const [id, f] of Object.entries(feedMap)) {
      if (f.status !== 'open') continue;
      velTotal += f.balance || 0;
      if (!ours.has(id)) {
        // Open on Velocity but closed/absent in Sage — likely paid; needs closing there.
        velocityOnly.push({ invoiceId: id, customer: f.customer, velocityBalance: f.balance, account: f.account, submittedDate: f.submittedDate });
      }
    }
    oursOnly.sort((a, b) => b.balance - a.balance);
    velocityOnly.sort((a, b) => (b.velocityBalance || 0) - (a.velocityBalance || 0));
    balanceMismatch.sort((a, b) => Math.abs(b.ourBalance - b.velocityBalance) - Math.abs(a.ourBalance - a.velocityBalance));

    db.auditLog(req.session.user.email, 'velocity_reconcile', null,
      `matched=${matched.length} oursOnly=${oursOnly.length} velocityOnly=${velocityOnly.length} mismatch=${balanceMismatch.length}`);
    res.json({
      feedGeneratedAt: _vFeed.generatedAt || null,
      summary: {
        ourOpenCount: ours.size, ourOpenTotal: ourTotal,
        velocityOpenCount: Object.values(feedMap).filter(f => f.status === 'open').length, velocityOpenTotal: velTotal,
        matched: matched.length,
        oursOnly: oursOnly.length, oursOnlyTotal: oursOnly.reduce((s, x) => s + x.balance, 0),
        velocityOnly: velocityOnly.length, velocityOnlyTotal: velocityOnly.reduce((s, x) => s + (x.velocityBalance || 0), 0),
        balanceMismatch: balanceMismatch.length,
      },
      oursOnly: oursOnly.slice(0, 100),
      velocityOnly: velocityOnly.slice(0, 100),
      balanceMismatch: balanceMismatch.slice(0, 100),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Payment application worklist ────────────────────────────────────────────
// Receivables paid into OUR lockbox close in Sage but stay open on Velocity;
// this derives what needs applying on the lender side. Balance-delta based
// for now (open-vs-closed measuring per Edwin 2026-08-13); credits/discounts
// classified by the team until Sage payment detail is wired. Export matches
// the reconcile-CSV vocabulary (INVOICE_NUMBER, PAID_AMOUNT, PAID_DATE,
// NOTE, CLASSIFICATION) so the team can work it in Velocity directly.
async function velocityPaymentWorklist(user) {
  let invoices = applyUserFilter(sage.getCachedInvoices(), user);
  velocityFeedRow('__warm__');
  const ourByid = new Map(invoices.map(i => [i.invoiceId, i]));
  const rows = [];
  for (const [id, f] of Object.entries(_vFeed.map)) {
    if (f.status !== 'open') continue;
    const ours = ourByid.get(id);
    const ourBalance = ours ? ours.totalDue : 0;
    const delta = (f.balance || 0) - ourBalance;
    if (delta > 0.01) {
      rows.push({
        invoiceId: id, recordNo: ours ? ours.recordNo : null,
        customer: f.customer, account: f.account,
        velocityBalance: f.balance, ourBalance,
        amountToApply: Math.round(delta * 100) / 100,
        kind: ourBalance < 0.01 ? 'fully paid here' : 'partially paid here',
      });
    }
  }
  // Real payment dates/amounts + credit detection from Sage ARPYMTDETAIL.
  // Invoices absent from the open cache (fully paid) have no recordNo here;
  // those keep delta-only data until a record lookup path exists.
  try {
    // Fully-paid invoices are absent from the open cache — resolve their
    // RECORDNOs directly from Sage so they enrich too.
    const missing = rows.filter(r => !r.recordNo).map(r => r.invoiceId);
    if (missing.length) {
      const found = await sage.getRecordNosForInvoiceIds(missing);
      for (const r of rows) if (!r.recordNo && found[r.invoiceId]) r.recordNo = found[r.invoiceId];
    }
    const withRec = rows.filter(r => r.recordNo);
    const pays = await sage.getPaymentsForRecordNos(withRec.map(r => r.recordNo));
    for (const r of withRec) {
      const ps = pays[r.recordNo] || [];
      if (!ps.length) continue;
      r.payments = ps;
      r.paidDate = ps.map(p => p.date).filter(Boolean).sort().slice(-1)[0] || null;
      r.paidAmount = Math.round(ps.reduce((s2, p) => s2 + (p.amount || 0), 0) * 100) / 100;
      const adj = ps.reduce((s2, p) => s2 + (p.adjustment || 0) + (p.negativeInvoice || 0), 0);
      if (adj > 0.01) { r.kind += ' (credit/adjustment)'; r.classification = 'Credit/Adjustment'; r.adjustmentAmount = Math.round(adj * 100) / 100; }
    }
  } catch (e) { /* enrichment only */ }
  rows.sort((a, b) => b.amountToApply - a.amountToApply);
  return rows;
}

app.get('/api/velocity/payment-worklist', requireAuth, async (req, res) => {
  try {
    const rows = await velocityPaymentWorklist(req.session.user);
    res.json({
      feedGeneratedAt: _vFeed.generatedAt || null,
      count: rows.length,
      total: Math.round(rows.reduce((s, r) => s + r.amountToApply, 0) * 100) / 100,
      rows: rows.slice(0, 300),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/velocity/payment-worklist.csv', requireAuth, async (req, res) => {
  try {
    const rows = await velocityPaymentWorklist(req.session.user);
    const today = new Date();
    const d = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
    const dmy2 = (x) => { const dt = new Date(x); return isNaN(dt) ? d : `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${dt.getFullYear()}`; };
    const lines = ['INVOICE_NUMBER,PAID_AMOUNT,PAID_DATE,NOTE,CLASSIFICATION'];
    for (const r of rows) {
      lines.push(`${r.invoiceId},${r.amountToApply.toFixed(2)},${r.paidDate ? dmy2(r.paidDate) : d},${(r.kind + ' per Sage').replace(/,/g, ' ')},${r.classification || 'Payment'}`);
    }
    db.auditLog(req.session.user.email, 'velocity_payment_export', null, `${rows.length} rows`);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="velocity-payments-to-apply-${today.toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.send(lines.join('\n') + '\n');
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/velocity/status', requireAuth, async (req, res) => {
  try {
    let uploader = null;
    try { uploader = await velocityBridge.status(); } catch (e) { uploader = 'iMac unreachable: ' + e.message; }
    let feedAge = null;
    try { feedAge = Math.round((Date.now() - fs.statSync(path.join(__dirname, 'velocity-feed.spark.json')).mtimeMs) / 3600000); } catch (e) {}
    res.json({
      armed: process.env.VELOCITY_TRANSMIT_ARMED === '1',
      marks: velocityMarks(),
      prefixes: VELOCITY_PREFIXES,
      facilities: (() => {
        // Decode the generic dashboard harvest into named metrics. The portal
        // renders a Borrowing Base / Principal Balance / Available header trio
        // whose values chain through consecutive pairs; Total Unpaid Invoices
        // is labeled directly. Raw pairs kept as fallback.
        try {
          const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'velocity-feed.spark.json'), 'utf8'));
          if (!f.facilities) return null;
          const out = {};
          for (const [loc, fac] of Object.entries(f.facilities)) {
            const m = { account: fac.account, capturedAt: fac.capturedAt, error: fac.error || null };
            const pairs = fac.pairs || [];
            const bbIdx = pairs.findIndex(p => /borrowing base/i.test(p.label || ''));
            if (bbIdx >= 0) {
              m.borrowingBase = pairs[bbIdx].value;
              m.principalBalance = (pairs[bbIdx + 1] || {}).value || null;
              m.available = (pairs[bbIdx + 2] || {}).value || null;
            }
            const tu = pairs.find(p => /total unpaid/i.test(p.label || ''));
            if (tu) m.totalUnpaid = tu.value;
            if (!m.borrowingBase && !m.error) m.rawPairs = pairs.slice(0, 6);
            out[loc] = m;
          }
          return out;
        } catch (e) { return null; }
      })(),
      recent: db.listVelocityTransmits(60),
      pendingConfirmation: db.countUnconfirmedVelocity(),
      lock: await velocityBridge.lockState(),
      uploader, feedAgeHours: feedAge,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/velocity/sync-feed', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const r = await velocityBridge.syncFeed(__dirname);
    _vNameMap = null;   // re-read the freshly synced map next use
    _vFeed = { mtime: 0, map: {} };
    r.reconcile = reconcileVelocity();
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Collection status (emulation of the reconciliation platform) ───────
// Assigned collector sets the status; AR staff can change/update after.
const COLLECTION_STATUSES = ['Open', 'In Progress', 'HOF Support Required', 'Resubmit Requested',
  'Resubmitted', 'Promised', 'Sent to Legal', 'Disputed', 'Written Off'];

app.get('/api/collection-status', requireAuth, (req, res) => {
  try { res.json({ statuses: COLLECTION_STATUSES, byRecord: db.getAllCollectionStatuses() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/invoice/:recordNo/collection-status', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const { status, note } = req.body || {};
    if (!COLLECTION_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const inv = sage.getCachedInvoices().find(i => i.recordNo === req.params.recordNo);
    const row = db.setCollectionStatus(req.params.recordNo, inv ? inv.invoiceId : null, status, note, req.session.user.email);
    db.auditLog(req.session.user.email, 'collection_status', req.params.recordNo, `${status}${note ? ' — ' + note.slice(0, 120) : ''}`);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Customer attachments (files under uploads/customers/, soft delete) ─
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'customers');

app.get('/api/customers/:customerId/attachments', requireAuth, (req, res) => {
  try { res.json(db.listCustomerAttachments(req.params.customerId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// JSON body {filename, contentType, dataBase64} — avoids a multipart dependency.
app.post('/api/customers/:customerId/attachments', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const { filename, contentType, dataBase64 } = req.body || {};
    if (!filename || !dataBase64) return res.status(400).json({ error: 'filename and dataBase64 required' });
    const buf = Buffer.from(dataBase64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'Empty file' });
    if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'File too large (15MB max)' });
    const safeName = String(filename).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120);
    const custDir = path.join(UPLOADS_DIR, String(req.params.customerId).replace(/[^A-Za-z0-9_-]/g, '_'));
    fs.mkdirSync(custDir, { recursive: true });
    const storedPath = path.join(custDir, `${Date.now()}-${safeName}`);
    fs.writeFileSync(storedPath, buf);
    const row = db.addCustomerAttachment(req.params.customerId, safeName, storedPath, buf.length, contentType || null, req.session.user.email);
    db.auditLog(req.session.user.email, 'attachment_upload', req.params.customerId, `${safeName} (${buf.length}b)`);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/attachments/:id/download', requireAuth, (req, res) => {
  try {
    const a = db.getCustomerAttachment(parseInt(req.params.id, 10));
    if (!a || a.deleted || !fs.existsSync(a.stored_path)) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', a.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${a.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('CDN-Cache-Control', 'no-store');
    fs.createReadStream(a.stored_path).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/attachments/:id', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const a = db.getCustomerAttachment(parseInt(req.params.id, 10));
    if (!a) return res.status(404).json({ error: 'Not found' });
    db.softDeleteCustomerAttachment(a.id);   // file stays on disk — archive, never destroy
    db.auditLog(req.session.user.email, 'attachment_remove', a.customer_id, a.filename);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: Scheduled statement delivery (statements.js) ───────────────────────
const statements = require('./statements');

app.get('/api/statements/schedules', requireAuth, (req, res) => {
  try {
    res.json({
      armed: statements.armed(),
      schedules: db.listStatementSchedules(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/statements/schedules/:customerId', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const { enabled, day_of_month, contact_ids, min_balance } = req.body || {};
    const f = { enabled: enabled === undefined ? 1 : (enabled ? 1 : 0), day_of_month, min_balance };
    if (contact_ids !== undefined) f.contact_ids = Array.isArray(contact_ids) && contact_ids.length ? JSON.stringify(contact_ids) : null;
    const s = db.upsertStatementSchedule(req.params.customerId, f, req.session.user.email);
    db.auditLog(req.session.user.email, 'comm_stmt_schedule', null,
      `${req.params.customerId} enabled=${s.enabled} day=${s.day_of_month}`);
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/statements/run', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    res.json(await statements.runStatementSchedules({ triggeredBy: commsRealActor(req), force: !!req.body.force }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/dunning/generate', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  try { res.json(dunning.generate({ triggeredBy: req.session.user.email })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/dunning/runs', requireAuth, (req, res) => {
  try { res.json(db.listDunningRuns()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dunning/runs/:id/actions', requireAuth, (req, res) => {
  try { res.json(db.listDunningActions(parseInt(req.params.id, 10))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dunning/actions/:id/skip', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  try {
    db.updateDunningAction(parseInt(req.params.id, 10), { status: 'skipped', skip_reason: 'manual' });
    db.auditLog(req.session.user.email, 'dunning_skip', null, `action=${req.params.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dunning/runs/:id/execute', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await dunning.execute(parseInt(req.params.id, 10), { actorEmail: commsRealActor(req) });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/comms/conversations/:id/status', requireAuth, requireRole('admin', 'manager', 'ar_specialist'), (req, res) => {
  try {
    const { status, assignEmail } = req.body;
    const conv = db.getConversation(parseInt(req.params.id, 10));
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const sets = [], vals = [];
    if (status) {
      if (!['open', 'waiting', 'due', 'completed', 'archived'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
      sets.push('status=?'); vals.push(status);
    }
    if (assignEmail !== undefined) { sets.push('assigned_email=?'); vals.push(assignEmail ? String(assignEmail).trim().toLowerCase() : null); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push("updated_at=datetime('now')");
    vals.push(conv.id);
    db.getDb().prepare(`UPDATE conversations SET ${sets.join(',')} WHERE id=?`).run(...vals);
    db.auditLog(req.session.user.email, status ? 'comm_status' : 'comm_assign', null, `conv=${conv.id} ${status || ''} ${assignEmail || ''}`.trim());
    res.json(db.getConversation(conv.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: DSO + CEI ──────────────────────────────────────────────────────────
app.get('/api/reports/dso-cei', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const now = Date.now();
    let totalAR = 0, totalPastDue = 0, totalDays = 0, count = 0;
    for (const inv of invoices) {
      totalAR += inv.totalDue;
      if (inv.bucket !== 'current') totalPastDue += inv.totalDue;
      if (inv.whenDue) {
        const due = new Date(inv.whenDue).getTime();
        if (!isNaN(due)) {
          const days = Math.round((now - due) / 86400000);
          totalDays += days;
          count++;
        }
      }
    }
    // DSO = (Total AR / Annualized Revenue estimate) * 365
    // Without revenue data, estimate from open AR / 365 * assumed net terms 45
    // Use average days outstanding as a proxy
    const avgDaysOutstanding = count > 0 ? Math.round(totalDays / count) : 0;
    const pastDuePct = totalAR > 0 ? ((totalPastDue / totalAR) * 100).toFixed(1) : '0.0';
    // CEI = (Beginning AR + Credit Sales - Ending AR) / (Beginning AR + Credit Sales - Current AR) * 100
    // Simplified without credit sales: (totalPastDue collected proxy) — show what we have
    res.json({
      totalAR,
      totalPastDue,
      pastDuePct: parseFloat(pastDuePct),
      avgDaysOutstanding,
      invoiceCount: invoices.length,
      note: 'DSO proxy: average days past due date across all open invoices',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: SC Head-to-Head ────────────────────────────────────────────────────
app.get('/api/reports/sc-head-to-head', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const scMap = new Map();
    for (const inv of invoices) {
      const sc = inv.locationId || inv.locationName || 'UNKNOWN';
      if (!scMap.has(sc)) {
        scMap.set(sc, {
          sc,
          totalAR: 0, pastDueAR: 0, currentAR: 0,
          invoiceCount: 0, customerCount: new Set(),
          totalDaysPastDue: 0, pastDueCount: 0,
        });
      }
      const r = scMap.get(sc);
      r.invoiceCount++;
      r.totalAR += inv.totalDue;
      r.customerCount.add(inv.customerId);
      if (inv.bucket !== 'current') {
        r.pastDueAR += inv.totalDue;
        r.pastDueCount++;
        if (inv.whenDue) {
          const days = Math.round((Date.now() - new Date(inv.whenDue).getTime()) / 86400000);
          if (days > 0) r.totalDaysPastDue += days;
        }
      } else {
        r.currentAR += inv.totalDue;
      }
    }

    const rows = [...scMap.values()].map(r => ({
      sc: r.sc,
      totalAR: r.totalAR,
      pastDueAR: r.pastDueAR,
      currentAR: r.currentAR,
      invoiceCount: r.invoiceCount,
      customerCount: r.customerCount.size,
      pastDuePct: r.totalAR > 0 ? parseFloat((r.pastDueAR / r.totalAR * 100).toFixed(1)) : 0,
      avgDaysPastDue: r.pastDueCount > 0 ? Math.round(r.totalDaysPastDue / r.pastDueCount) : 0,
    })).sort((a, b) => b.pastDueAR - a.pastDueAR);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Customer Risk Score ────────────────────────────────────────────────
app.get('/api/reports/customer-risk', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const custMap = new Map();
    for (const inv of invoices) {
      const cid = inv.customerId;
      if (!custMap.has(cid)) {
        custMap.set(cid, {
          id: cid, name: inv.customerName,
          totalAR: 0, pastDueAR: 0, invoiceCount: 0,
          b91plus: 0, b61_90: 0, b31_60: 0,
          oldestDays: 0,
        });
      }
      const c = custMap.get(cid);
      c.invoiceCount++;
      c.totalAR += inv.totalDue;
      if (inv.bucket !== 'current') c.pastDueAR += inv.totalDue;
      if (inv.bucket === '91+') c.b91plus += inv.totalDue;
      if (inv.bucket === '61-90') c.b61_90 += inv.totalDue;
      if (inv.bucket === '31-60') c.b31_60 += inv.totalDue;
      if (inv.whenDue) {
        const days = Math.round((Date.now() - new Date(inv.whenDue).getTime()) / 86400000);
        if (days > c.oldestDays) c.oldestDays = days;
      }
    }

    const scored = [...custMap.values()].map(c => {
      // Risk score: weighted combination
      // pastDuePct (0-40 pts), severity/91+ weight (0-30 pts), oldest days (0-20 pts), concentration (0-10 pts)
      const pastDuePct = c.totalAR > 0 ? c.pastDueAR / c.totalAR : 0;
      const severityPct = c.pastDueAR > 0 ? (c.b91plus + c.b61_90 * 0.7) / c.pastDueAR : 0;
      const agePts = Math.min(c.oldestDays / 5, 20);  // cap at 100 days = 20 pts
      const concPts = Math.min(c.pastDueAR / 500000, 10);  // cap at $5M = 10 pts
      const score = Math.round(pastDuePct * 40 + severityPct * 30 + agePts + concPts);
      const tier = score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';
      return {
        id: c.id, name: c.name,
        score: Math.min(score, 100),
        tier,
        totalAR: c.totalAR,
        pastDueAR: c.pastDueAR,
        pastDuePct: parseFloat((pastDuePct * 100).toFixed(1)),
        oldestDays: c.oldestDays,
        invoiceCount: c.invoiceCount,
      };
    }).filter(c => c.pastDueAR > 0).sort((a, b) => b.score - a.score).slice(0, 20);

    res.json(scored);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Cleanup Progress ───────────────────────────────────────────────────
app.get('/api/reports/cleanup-progress', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    // We don't have payment history, so show newly-issued invoices by bucket as a proxy
    // What we CAN show: bucket distribution + new invoices added per week as "pipeline"
    const now = Date.now();
    const windows = [7, 14, 30];
    const result = {};

    for (const w of windows) {
      const cutoff = now - w * 24 * 60 * 60 * 1000;
      let newCount = 0, newAmount = 0;
      for (const inv of invoices) {
        if (inv.whenCreated) {
          const t = new Date(inv.whenCreated).getTime();
          if (!isNaN(t) && t >= cutoff) { newCount++; newAmount += inv.totalDue; }
        }
      }
      result[`days${w}`] = { count: newCount, amount: newAmount };
    }

    // Bucket breakdown
    const buckets = {};
    for (const inv of invoices) {
      const b = inv.bucket || 'unknown';
      if (!buckets[b]) buckets[b] = { count: 0, amount: 0 };
      buckets[b].count++;
      buckets[b].amount += inv.totalDue;
    }

    res.json({ windows: result, buckets, totalInvoices: invoices.length, note: 'New invoices added in each window (payment clearance data not yet available)' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/kpis', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    let invoices = sage.getCachedInvoices();
    if (invoices.length === 0) invoices = await sage.getInvoices();
    invoices = applyUserFilter(invoices, user);

    const buckets = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '91+': 0 };
    const counts  = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '91+': 0 };
    let totalAR = 0;

    for (const inv of invoices) {
      totalAR += inv.totalDue;
      buckets[inv.bucket] = (buckets[inv.bucket] || 0) + inv.totalDue;
      counts[inv.bucket]  = (counts[inv.bucket]  || 0) + 1;
    }

    const openPtp = db.getAllOpenPtp();
    const ptpTotal = openPtp.reduce((s, p) => s + p.amount, 0);

    res.json({
      totalAR,
      totalCount: invoices.length,
      buckets,
      counts,
      ptpTotal,
      ptpCount: openPtp.length,
      cacheInfo: sage.getCacheAge(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Notes ──────────────────────────────────────────────────────────────

app.get('/api/notes/:recordno', requireAuth, (req, res) => {
  try {
    const notes = db.getNotes(req.params.recordno);
    res.json(notes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/notes/:recordno', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const { body, type, mentions, parent_id } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Body required' });
    if (!['admin', 'manager', 'ar_specialist'].includes(user.role)) {
      return res.status(403).json({ error: 'Viewers cannot add notes' });
    }
    const mentionList = Array.isArray(mentions) ? mentions.filter(e => typeof e === 'string' && e.includes('@')) : [];
    const note = db.addNote(req.params.recordno, user.email, user.name, body.trim(), type || 'note', mentionList, parent_id ? parseInt(parent_id, 10) : null);
    db.auditLog(user.email, 'add_note', req.params.recordno, body.slice(0, 100));
    // Fire-and-forget mention emails
    if (mentionList.length > 0) {
      const cachedInv = sage.getCachedInvoices().find(i => i.recordNo === req.params.recordno);
      const invoiceId = cachedInv ? (cachedInv.invoiceId || req.params.recordno) : req.params.recordno;
      for (const mentionedEmail of mentionList) {
        if (mentionedEmail !== user.email) {
          sendMentionEmail(mentionedEmail, user.name || user.email, invoiceId, body.trim(), req.params.recordno)
            .catch(e => console.error('[mention-email] error:', e.message));
        }
      }
    }
    res.json(note);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Promise to Pay ─────────────────────────────────────────────────────

app.post('/api/ptp/:recordno', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    if (!['admin', 'manager', 'ar_specialist'].includes(user.role)) {
      return res.status(403).json({ error: 'Viewers cannot create PTPs' });
    }
    const { amount, date, note } = req.body;
    if (!amount || !date) return res.status(400).json({ error: 'amount and date required' });
    const ptp = db.addPtp(req.params.recordno, user.email, user.name, parseFloat(amount), date, note);
    db.addNote(req.params.recordno, user.email, user.name, `PTP set: $${amount} by ${date}${note ? ' — ' + note : ''}`, 'status_change');
    db.auditLog(user.email, 'add_ptp', req.params.recordno, `$${amount} by ${date}`);
    res.json(ptp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ptp/calendar', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const openPtps = db.getAllOpenPtp();
    const events = openPtps.map(p => ({
      id: p.id,
      recordNo: p.record_no,
      title: `PTP $${p.amount.toFixed(2)} — ${p.record_no}`,
      date: p.promise_date,
      amount: p.amount,
      status: p.status,
      userName: p.user_name,
      note: p.note,
    }));
    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Escalate ───────────────────────────────────────────────────────────

app.post('/api/escalate/:recordno', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const { note } = req.body;
    db.addNote(req.params.recordno, user.email, user.name, `⚠️ Escalated for manager attention${note ? ': ' + note : ''}`, 'escalation');
    db.auditLog(user.email, 'escalate', req.params.recordno, note || null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Mentions ───────────────────────────────────────────────────────────

app.get('/api/mentions', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const mentions = db.getMentionsForUser(user.email);
    const unseenCount = db.getUnseenMentionCount(user.email);
    res.json({ mentions, unconfirmedCount: db.getUnconfirmedMentionCount(req.session.user.email), unseenCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mentions/:noteId/confirm', requireAuth, (req, res) => {
  try {
    db.markMentionConfirmed(parseInt(req.params.noteId, 10), req.session.user.email);
    db.auditLog(req.session.user.email, 'mention_confirm', null, `note=${req.params.noteId}`);
    res.json({ ok: true, unconfirmed: db.getUnconfirmedMentionCount(req.session.user.email) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mentions/:noteId/seen', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    db.markMentionSeen(parseInt(req.params.noteId), user.email);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Reactions ──────────────────────────────────────────────────────────

app.post('/api/notes/:noteId/react', requireAuth, (req, res) => {
  try {
    const user = req.session.user;
    const noteId = parseInt(req.params.noteId);
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'emoji required' });

    // Toggle: check if exists
    const existing = db.getReactionsForNote(noteId).find(r => r.emoji === emoji && r.users.includes(user.email));
    if (existing) {
      db.removeReaction(noteId, user.email, emoji);
      db.auditLog(user.email, 'note_react_remove', null, `note ${noteId}: ${emoji}`);
    } else {
      db.addReaction(noteId, user.email, emoji);
      db.auditLog(user.email, 'note_react_add', null, `note ${noteId}: ${emoji}`);
    }
    res.json({ ok: true, reactions: db.getReactionsForNote(noteId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Users (for @mention autocomplete) ──────────────────────────────────

app.get('/api/users', requireAuth, (req, res) => {
  try {
    const users = db.listUsers().map(u => ({ email: u.email, name: u.name || u.email }));
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: User Management ──────────────────────────────────────────────────

app.get('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const users = db.listUsers(); // includes photo_data_url, job_title from schema
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { email, name, role, job_title } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
    if (!email.toLowerCase().endsWith('@eastcoastfacilities.com')) {
      return res.status(400).json({ error: 'Only @eastcoastfacilities.com accounts allowed' });
    }
    const validRoles = ['admin', 'manager', 'ar_specialist', 'viewer'];
    const assignedRole = validRoles.includes(role) ? role : 'viewer';
    const user = db.preProvisionUser(email.toLowerCase(), name || '', assignedRole, job_title || null);
    db.auditLog(req.session.user.email, 'provision_user', null, `Pre-provisioned ${email} as ${assignedRole}`);
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/users/:email', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const admin = req.session.user;
    const { role, location_filter, customer_filter, name } = req.body;
    const validRoles = ['admin', 'manager', 'ar_specialist', 'viewer'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role: ' + role });
    }
    const updates = {};
    if (role !== undefined) updates.role = role;
    if (name !== undefined) updates.name = name;
    if (location_filter !== undefined) updates.location_filter = location_filter;
    if (customer_filter !== undefined) updates.customer_filter = customer_filter;
    db.updateUserRole(req.params.email, updates);
    db.auditLog(admin.email, 'update_user', null, `Updated ${req.params.email}: ${JSON.stringify(updates)}`);
    res.json({ ok: true, user: db.getUserRole(req.params.email) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: Regions ───────────────────────────────────────────────────────
app.get('/api/regions', requireAuth, (req, res) => {
  try {
    res.json(db.getRegions());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/regions', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const user = req.session.user;
    const { regionCode, regionName, locationIds } = req.body || {};
    if (!regionCode || !regionName) return res.status(400).json({ error: 'regionCode and regionName are required' });
    if (db.getRegion(regionCode)) return res.status(409).json({ error: 'Region already exists' });
    const region = db.upsertRegion(regionCode, regionName, Array.isArray(locationIds) ? locationIds : [], user.email);
    db.auditLog(user.email, 'region_create', null, `${regionCode}: ${regionName}`);
    res.json(region);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/regions/:regionCode', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const user = req.session.user;
    const existing = db.getRegion(req.params.regionCode);
    if (!existing) return res.status(404).json({ error: 'Region not found' });
    const { regionName, locationIds } = req.body || {};
    const region = db.upsertRegion(
      req.params.regionCode,
      regionName ?? existing.region_name,
      Array.isArray(locationIds) ? locationIds : existing.location_ids,
      user.email
    );
    db.auditLog(user.email, 'region_update', null, `${req.params.regionCode}: ${JSON.stringify(req.body)}`);
    res.json(region);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/regions/:regionCode', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const user = req.session.user;
    db.deleteRegion(req.params.regionCode);
    db.auditLog(user.email, 'region_delete', null, req.params.regionCode);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Admin UI redirect ───────────────────────────────────────────────────────
app.get('/admin', requireAuth, requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), port: PORT });
});


// ─── Serve SPA for all other GET requests ────────────────────────────────────
app.get('*', (req, res) => {
  // Don't serve SPA for /auth routes
  if (req.path.startsWith('/auth/')) return res.status(404).send('Not found');
  if (req.path.startsWith('/api/'))  return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Startup ─────────────────────────────────────────────────────────────────
const httpsServer = require('https');
const tlsOpts = (() => {
  try {
    return { key: fs.readFileSync('/home/ecf-admin/ar-portal/tailscale.key'), cert: fs.readFileSync('/home/ecf-admin/ar-portal/tailscale.crt') };
  } catch(e) { return null; }
})();
const server = tlsOpts ? httpsServer.createServer(tlsOpts, app) : app;
(tlsOpts ? server : app).listen(PORT, () => {
  console.log(`[ar-portal] ECF AR Aging Portal running on port ${PORT}`);
  console.log(`[ar-portal] Started at ${new Date().toISOString()}`);

  // Pre-warm Sage cache on startup — this also warms Omnia token via fetchOmniaInvoices
  sage.getInvoices().then(invoices => {
    console.log(`[ar-portal] Pre-warmed cache: ${invoices.length} invoices`);
  }).catch(e => {
    console.warn(`[ar-portal] Cache pre-warm failed (normal if .env not set yet): ${e.message}`);
  });

  // Auto-refresh every 15 minutes
  setInterval(() => {
    sage.getInvoices(true).then(invoices => {
      console.log(`[ar-portal] Auto-refresh: ${invoices.length} invoices at ${new Date().toISOString()}`);
    }).catch(e => {
      console.warn(`[ar-portal] Auto-refresh error: ${e.message}`);
    });
  }, 15 * 60 * 1000);

  // Payee Central refresh — via the shared guarded controller (also used by the
  // manual Refresh button). Startup pass + every 30 minutes.
  doPayeeRefresh();
  setInterval(doPayeeRefresh, 30 * 60 * 1000);

  // Per-PO Amazon "Available amount" scrape — the authoritative Value Remaining.
  // ~1,100 detail pages, so it runs every 4 hours (not on the 30-min payee loop).
  // Delay the first pass 3 min so the open-PO list is refreshed first; each pass
  // scrapes against that fresh open set.
  setTimeout(doPoDetailRefresh, 3 * 60 * 1000);
  setInterval(doPoDetailRefresh, 4 * 60 * 60 * 1000);

  // Keep the local AI models hot so interactive calls stay ~fast (no ~20s cold
  // load). Warm on boot, then re-ping every 100 min (inside the 2h keep_alive).
  ai.available().then(ok => {
    if (!ok) { console.log('[ar-portal] Local AI (Ollama) not detected — AI features disabled'); return; }
    ai.warmup().then(() => console.log(`[ar-portal] AI warm: ${ai.MODEL_SMART} / ${ai.MODEL_FAST}`));
    setInterval(() => ai.warmup(), 100 * 60 * 1000);
  }).catch(() => {});

  // Seed the default comms templates (idempotent — only creates missing keys).
  try { comms.seedTemplates(); } catch (e) { console.warn(`[comms] template seed failed: ${e.message}`); }

  // Inbound mailbox poller — delta on invoices@ inbox + sent items every 2 min.
  // Never moves or marks-read; categories only (humans share the mailbox in
  // Outlook). Reply notifications go to the thread's assigned user.
  const { runInboundPoll } = require('./comms-inbound');
  const doInboundPoll = () => runInboundPoll({ notify: notifyUser })
    .catch(e => console.warn(`[comms-inbound] poll error: ${e.message}`));
  setTimeout(doInboundPoll, 60 * 1000);
  setInterval(doInboundPoll, 2 * 60 * 1000);

  // Statement scheduler: daily ~08:15 ET pass over the per-customer opt-in
  // schedules. Unarmed (STATEMENTS_ARMED unset) it only logs would-sends.
  setInterval(() => {
    try {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      if (now.getHours() !== 8 || now.getMinutes() > 45) return;
      const today = now.toISOString().slice(0, 10);
      if (db.getCommState('statements_last_auto') === today) return;
      db.setCommState('statements_last_auto', today);
      statements.runStatementSchedules({ triggeredBy: 'scheduler' })
        .then(s => { if (s.sent || s.wouldSend || s.failed) console.log(`[statements] run: ${s.sent} sent, ${s.wouldSend} would-send, ${s.failed} failed`); })
        .catch(e => console.warn(`[statements] scheduled run failed: ${e.message}`));
    } catch (e) { console.warn(`[statements] scheduler error: ${e.message}`); }
  }, 15 * 60 * 1000);

  // Velocity feed sync — pull InterNex status + name map from the iMac at
  // startup (+5 min) and every 6 hours.
  const doVelocitySync = () => velocityBridge.syncFeed(__dirname)
    .then(r => {
      if (r.feed) console.log('[velocity] feed synced');
      const rec = reconcileVelocity();
      if (rec.confirmed || Object.keys(rec.advanced || {}).length) console.log(`[velocity] reconcile: ${rec.confirmed} confirmed`, rec.advanced || {});
    })
    .catch(e => console.warn(`[velocity] feed sync failed: ${e.message}`));
  setTimeout(doVelocitySync, 5 * 60 * 1000);
  setInterval(doVelocitySync, 6 * 60 * 60 * 1000);

  // Dunning scheduler: weekdays 09:05 ET it GENERATES A PREVIEW run (never
  // sends). Humans review and execute from the console; live sends are gated
  // by DUNNING_ARMED and the comms allowlist. Seed rules ship inactive.
  try { dunning.seedRules(); } catch (e) { console.warn(`[dunning] rule seed failed: ${e.message}`); }
  setInterval(() => {
    try {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      if (now.getDay() === 0 || now.getDay() === 6) return;
      if (now.getHours() !== 9 || now.getMinutes() > 30) return;
      const today = now.toISOString().slice(0, 10);
      if (db.getCommState('dunning_last_auto') === today) return;
      db.setCommState('dunning_last_auto', today);
      const r = dunning.generate({ triggeredBy: 'scheduler' });
      console.log(`[dunning] scheduled preview run ${r.runId}: ${r.digests || 0} digests`);
      // Auto-execute only when BOTH armed and explicitly opted in — the final
      // automation gate after Edwin has approved manual runs for a while.
      if (process.env.DUNNING_AUTO === '1' && dunning.armed() && r.digests > 0) {
        dunning.execute(r.runId, { actorEmail: 'scheduler' })
          .then(x => console.log(`[dunning] auto-executed run ${r.runId}: ${x.sent} sent, ${x.failed} failed`))
          .catch(e => console.warn(`[dunning] auto-execute failed: ${e.message}`));
      }
    } catch (e) { console.warn(`[dunning] scheduled preview failed: ${e.message}`); }
  }, 15 * 60 * 1000);

  // Customer-contact sync from Intacct DISPLAYCONTACT — contacts change slowly;
  // startup pass (delayed 2 min so it never competes with the invoice
  // pre-warm) then every 24 hours. Manual rows are never touched (see db.js).
  setTimeout(() => runContactSync('scheduler').catch(() => {}), 2 * 60 * 1000);
  setInterval(() => runContactSync('scheduler').catch(() => {}), 24 * 60 * 60 * 1000);

  // SharePoint PO-document scan — read-only Graph list; docs change slowly, so
  // run at startup then every 6 hours.
  const { runBackfill: runPoEmailBackfill } = require('./po-email-backfill');
  const runPoDocScan = () => {
    scanPoDocs().then(out => {
      console.log(`[ar-portal] PO-doc scan: ${out.distinctPos} POs with docs at ${out.generatedAt}`);
      // Any PO still without a site after the SharePoint scan: pull its site
      // straight from Amazon's PO email (arclerk) and pin it. Closes the
      // "PDF not filed yet" gap automatically — targets shrink toward zero.
      return runPoEmailBackfill(null, false);
    }).then(s => {
      if (s && s.assigned) console.log(`[ar-portal] PO email-backfill: assigned ${s.assigned} site(s) from PO emails (${s.noEmail} had no email)`);
    }).catch(e => {
      console.warn(`[ar-portal] PO-doc scan / email-backfill error: ${e.message}`);
    });
  };
  runPoDocScan();
  setInterval(runPoDocScan, 6 * 60 * 60 * 1000);
});

module.exports = app;
