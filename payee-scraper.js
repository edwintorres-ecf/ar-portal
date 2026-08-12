'use strict';
/**
 * payee-scraper.js — Live Amazon Payee Central scraper for ECF AR Portal
 *
 * Replaces the broken off-box iMac feed (which only ever extracted 8 of ~1900
 * invoices). Runs entirely on spark using playwright-core against the box's
 * system Chromium, the same pattern as omnia.js.
 *
 * Flow: log in (or reuse a saved session) -> open Invoices -> click through
 * the "Yes, keep going" continuation banner so the server computes the FULL
 * result set -> click "Export to Excel" -> the export is a blob: URL, so we
 * fetch it from inside the page context and parse it with the xlsx library
 * -> verify the parsed row count against the page's own "Showing X of Y
 * entries" total before trusting it -> write payee-central-feed.json in the
 * exact shape payee.js already reads.
 */

const { chromium } = require('playwright-core');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const CHROMIUM_PATH = '/usr/bin/chromium-browser';
const LOGIN_URL = 'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=3600&openid.return_to=https%3A%2F%2Fpayeecentral.amazon.com%2FInvoices&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=amzn_hz_payee_central_us&openid.mode=checkid_setup&language=en_US&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0';
const INVOICES_URL = 'https://payeecentral.amazon.com/Invoices';
const CREATE_INVOICE_URL = 'https://payeecentral.amazon.com/Invoices/CreateInvoice';
const SESSION_PATH = path.join(__dirname, 'cache', 'payee-session.json');
// Renamed 2026-07-17 — see the note in payee.js: the old filename is still
// scp-targeted by the retired iMac scraper's 6am cron and must not be read.
const FEED_PATH = path.join(__dirname, 'payee-feed.spark.json');
const OPEN_POS_PATH = path.join(__dirname, 'payee-open-pos.json');
const KEEP_GOING_SEL = '#pc-invoice-search-results-table-fetch-next-batch';

function launchBrowser() {
  return chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

async function login(context) {
  if (!process.env.PAYEE_EMAIL || !process.env.PAYEE_PASSWORD) {
    throw new Error('PAYEE_EMAIL/PAYEE_PASSWORD not set in .env');
  }
  const page = await context.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

    const emailSel = '#ap_email, input[name="email"]';
    if (await page.locator(emailSel).count() > 0) {
      await page.locator(emailSel).first().fill(process.env.PAYEE_EMAIL);
      const contBtn = '#continue, input#continue';
      if (await page.locator(contBtn).count() > 0) {
        await page.locator(contBtn).first().click();
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      }
    }

    const pwSel = '#ap_password, input[name="password"]';
    if (await page.locator(pwSel).count() === 0) {
      throw new Error('Password field not found after email step — Payee Central login page may have changed');
    }
    await page.locator(pwSel).first().fill(process.env.PAYEE_PASSWORD);
    await page.locator('#signInSubmit, input#signInSubmit').first().click();
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    if (!page.url().startsWith('https://payeecentral.amazon.com')) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const reason = /incorrect/i.test(bodyText) ? 'incorrect credentials'
        : /verification|otp|code/i.test(bodyText) ? 'additional verification (OTP/2FA) required — cannot proceed headlessly'
        : 'unknown (landed on ' + page.url() + ')';
      throw new Error('Payee Central login failed: ' + reason);
    }

    fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
    await context.storageState({ path: SESSION_PATH });
  } finally {
    await page.close();
  }
}

async function ensureLoggedInContext(browser) {
  if (fs.existsSync(SESSION_PATH)) {
    const context = await browser.newContext({ storageState: SESSION_PATH, acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(INVOICES_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    const stillLoggedIn = page.url().startsWith('https://payeecentral.amazon.com/Invoices');
    await page.close();
    if (stillLoggedIn) return context;
    await context.close();
  }
  const context = await browser.newContext({ acceptDownloads: true });
  await login(context);
  return context;
}

async function clickThroughKeepGoing(page) {
  const keepGoing = page.locator(KEEP_GOING_SEL);
  let clicks = 0;
  while (clicks < 40) {
    let visible = await keepGoing.first().isVisible().catch(() => false);
    if (!visible) {
      // The button disappears while the next batch renders. A single 4s wait
      // ended pagination early under load (observed: current-year list stopped
      // at exactly 6,000 rows / 5 clicks, silently dropping the newest 3 days
      // of submissions). Poll up to ~16s for it to reappear before concluding
      // the list is actually complete.
      for (let i = 0; i < 8 && !visible; i++) {
        await page.waitForTimeout(2000);
        visible = await keepGoing.first().isVisible().catch(() => false);
      }
      if (!visible) break;
    }
    await keepGoing.first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(4000);
    clicks++;
  }
  return clicks;
}

async function exportInvoices(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('text=Export to Excel').first().click(),
  ]);
  const blobUrl = download.url();
  const base64 = await page.evaluate(async (url) => {
    const response = await fetch(url);
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }, blobUrl);
  return Buffer.from(base64, 'base64');
}

function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function formatAmount(row) {
  const amt = Number(row['Invoice Amount']);
  const currency = row['Currency'] || 'USD';
  if (Number.isNaN(amt)) return row['Invoice Amount'];
  return '$' + amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + currency;
}

const INVOICE_DATE_SELECTOR = '#pc-invoice-search-form-recent-date-selector';
// Scrape a wider history than the default "last 3 months" so an invoice's
// original submission doesn't age out of view (which made cancelled
// resubmissions look like they still needed uploading). Newest range first.
const SCRAPE_RANGES = (process.env.PAYEE_SCRAPE_RANGES || 'CURRENT_YEAR,LAST_YEAR').split(',').map(s => s.trim());

// Selects a date range in the Invoices "entered in" dropdown and waits for the
// list to reload, then pages through "keep going", exports, and returns parsed
// rows. Verifies the export count against the page's own reported total.
async function scrapeRange(page, rangeValue) {
  const hasSelector = await page.locator(INVOICE_DATE_SELECTOR).count() > 0;
  if (hasSelector) {
    await page.selectOption(INVOICE_DATE_SELECTOR, rangeValue).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  const clicks = await clickThroughKeepGoing(page);

  const bodyText = await page.locator('body').innerText();
  const showingMatch = bodyText.match(/Showing \d+ to \d+ of ([\d,]+) entries/);
  const reportedTotal = showingMatch ? parseInt(showingMatch[1].replace(/,/g, ''), 10) : null;
  if (reportedTotal === null) {
    throw new Error(`[${rangeValue}] Could not find "Showing X of Y entries" — layout may have changed`);
  }

  const buf = await exportInvoices(page);
  const rawRows = parseWorkbook(buf);
  // The page's "Showing X of Y" counter caps at 5,000, so a complete export can
  // legitimately EXCEED the reported total (observed: export 5970 vs page 5000).
  // Only an export with FEWER rows than the page claims means we lost data.
  if (rawRows.length < reportedTotal) {
    throw new Error(`[${rangeValue}] Export incomplete: ${rawRows.length} rows vs ${reportedTotal} reported on page — refusing to overwrite feed`);
  }
  if (rawRows.length > reportedTotal) {
    console.log(`[payee-scraper] Range ${rangeValue}: export ${rawRows.length} > page counter ${reportedTotal} (counter caps at 5,000) — accepting export`);
  }
  console.log(`[payee-scraper] Range ${rangeValue}: ${rawRows.length} rows (${clicks} keep-going)`);
  return rawRows;
}

async function scrapePayeeCentral() {
  const browser = await launchBrowser();
  try {
    const context = await ensureLoggedInContext(browser);
    const page = await context.newPage();
    await page.goto(INVOICES_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Merge rows across ranges, keeping the most current entry per invoice #
    // (later Entry Date wins) so cross-year duplicates collapse cleanly.
    const byInvoice = {};
    for (const range of SCRAPE_RANGES) {
      const rows = await scrapeRange(page, range);
      for (const row of rows) {
        const key = (row['Invoice #'] || '').trim().toUpperCase();
        if (!key) continue;
        const prev = byInvoice[key];
        if (!prev) { byInvoice[key] = row; continue; }
        const prevDate = Date.parse(prev['Entry Date']) || 0;
        const curDate = Date.parse(row['Entry Date']) || 0;
        if (curDate >= prevDate) byInvoice[key] = row;
      }
    }
    await page.close();

    const rawRows = Object.values(byInvoice);
    if (rawRows.length === 0) {
      throw new Error('No rows across any range — refusing to overwrite existing feed');
    }

    const items = rawRows.map(row => ({
      'Invoice #': row['Invoice #'],
      'Purchase Order #': row['Purchase Order #'],
      'Entry Date': row['Entry Date'],
      'Invoice Date': row['Invoice Date'],
      'Estimated Due Date': row['Estimated Due Date'],
      'Invoice Amount': formatAmount(row),
      'Invoice Status': row['Invoice Status'],
    }));

    const feed = {
      generatedAt: new Date().toISOString(),
      source: 'payee-scraper-spark',
      ranges: SCRAPE_RANGES,
      totalRows: items.length,
      items,
    };

    // ── Data-contract invariants ─────────────────────────────────────────
    // Every scrape must prove itself before it may replace the cache. Each
    // check below exists because its absence let a real incident through.
    const ops = require('./ops-alerts');

    // Invariant 1 — floor guard (2026-07-17: retired iMac scraper overwrote
    // 12,386 good rows with a self-flagged 1,113-row partial).
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(FEED_PATH, 'utf8')); } catch (e) { /* first run */ }
    const prevCount = prev ? (prev.items || []).length : 0;
    if (prevCount > 0 && items.length < prevCount * 0.6) {
      const msg = `New feed has ${items.length} items vs ${prevCount} cached (<60%) — refusing to overwrite`;
      ops.raise('payee-feed-floor', 'Payee feed floor-guard tripped', msg).catch(() => {});
      throw new Error(msg);
    }

    // Invariant 2 — freshness (2026-07-20: pagination quit early and the feed
    // silently carried nothing newer than 3 days old; users re-transmitted
    // live submissions). A healthy pull must contain recent entries.
    // 2026-08-02: extended default to 168h (7d) — 36h was too tight for weekends.
    // Additional bypass: if the cached feed is ALSO stale, this is a genuine
    // business lull (no new submissions), not scraper truncation — allow write.
    const FRESHNESS_HOURS = parseInt(process.env.PAYEE_FEED_MAX_AGE_HOURS || '168', 10);
    const newestMs = Math.max(0, ...items.map(i => Date.parse(i['Entry Date']) || 0));
    const ageHours = (Date.now() - newestMs) / 3600000;
    if (!newestMs || ageHours > FRESHNESS_HOURS) {
      // Check if the existing cached feed is equally stale (genuine business lull)
      const prevNewestMs = prev ? Math.max(0, ...(prev.items||[]).map(i => Date.parse(i['Entry Date']) || 0)) : 0;
      const prevAgeHours = prevNewestMs ? (Date.now() - prevNewestMs) / 3600000 : Infinity;
      const prevAlsoStale = !prevNewestMs || prevAgeHours > FRESHNESS_HOURS;
      if (prevAlsoStale) {
        // Both current and previous feed are similarly old — business lull, not truncation
        ops.raise('payee-feed-stale', 'Payee feed entry dates are old (business lull)',
          `Newest entry is ${newestMs ? ageHours.toFixed(1) + 'h old' : 'unparseable'} but prev feed equally stale (${prevAgeHours.toFixed(1)}h) — allowing write`,
          { status: 'warn' }).catch(() => {});
      } else {
        const msg = `Newest feed entry is ${newestMs ? ageHours.toFixed(1) + 'h old' : 'unparseable'} (limit ${FRESHNESS_HOURS}h) — scrape likely truncated; refusing to overwrite`;
        ops.raise('payee-feed-stale', 'Payee feed failed freshness invariant', msg).catch(() => {});
        throw new Error(msg);
      }
    }

    // Invariant 3 — distribution sanity: a status bucket swinging massively in
    // one pull means the upstream list changed shape, not reality. Warn-only
    // (alert but still write) — blocking here would fight legitimate bulk events.
    if (prevCount > 0) {
      const dist = (list) => {
        const m = {};
        for (const it of list) { const s = (it['Invoice Status'] || '?').trim(); m[s] = (m[s] || 0) + 1; }
        return m;
      };
      const now = dist(items), before = dist(prev.items);
      const shifts = [];
      for (const s of new Set([...Object.keys(now), ...Object.keys(before)])) {
        const a = before[s] || 0, b = now[s] || 0;
        if (Math.abs(b - a) > 300 && (a === 0 || Math.abs(b - a) / a > 0.3)) shifts.push(`${s}: ${a}→${b}`);
      }
      if (shifts.length) {
        ops.raise('payee-feed-distribution', 'Payee feed status distribution shifted sharply',
          `Status buckets moved >30% and >300 rows in one pull: ${shifts.join('; ')} — verify upstream before trusting derived reports.`,
          { status: 'warn' }).catch(() => {});
      }
    }

    ops.ok('payee-feed', `${items.length} items, newest entry ${ageHours.toFixed(1)}h old`, items.length);
    // Clear guard keys raised on earlier failed runs — without this a tripped
    // guard stays red in ops_health forever and the nightly self-test cries
    // wolf on long-recovered incidents (seen: openpos-floor 07-26, stale 08-02).
    // payee-feed-stale is cleared only when this pull genuinely passed the
    // freshness invariant, so a business-lull warn raised above survives.
    if (newestMs && ageHours <= FRESHNESS_HOURS) {
      ops.ok('payee-feed-stale', `newest entry ${ageHours.toFixed(1)}h old (limit ${FRESHNESS_HOURS}h)`);
    }
    ops.ok('payee-feed-floor', `${items.length} items vs ${prevCount} cached`);

    const tmpPath = FEED_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(feed, null, 2));
    fs.renameSync(tmpPath, FEED_PATH);
    console.log(`[payee-scraper] Wrote ${items.length} invoices (ranges: ${SCRAPE_RANGES.join('+')}) to ${FEED_PATH}`);
    return feed;
  } finally {
    await browser.close();
  }
}

// Captures the full open-PO list (with authoritative PO amounts) from Payee
// Central's internal SearchOpenPOs endpoint — the same data the Create Invoice
// "Show all open POs" list is built from. Read-only: opens the picker, pages
// through "keep going", collects the JSON responses, and closes without
// touching the invoice form.
async function scrapeOpenPOs() {
  const browser = await launchBrowser();
  try {
    const context = await ensureLoggedInContext(browser);
    const page = await context.newPage();

    const byPo = {};
    page.on('response', async (res) => {
      if (!/SearchOpenPOs/i.test(res.url())) return;
      try {
        const json = await res.json();
        for (const po of (json.openPOList || [])) {
          if (po.poNumber) byPo[po.poNumber] = po;
        }
      } catch (e) { /* non-JSON or already consumed */ }
    });

    await page.goto(CREATE_INVOICE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    const showAll = page.locator('text=Show all open POs').first();
    if (await showAll.count() > 0) {
      await showAll.click().catch(() => {});
      await page.waitForTimeout(3000);
    }

    // "Yes, keep going" loads the next batch of POs; repeat until it's gone.
    // Same early-exit hazard as the invoice list (2026-07-20): the button
    // vanishes while a batch renders, so poll for its reappearance before
    // concluding the list is complete — a truncated open-PO list makes real
    // POs look closed and misflags hundreds of pre-flight checks.
    const keepGoing = page.locator('text=Yes, keep going');
    let rounds = 0;
    while (rounds < 60) {
      let visible = await keepGoing.first().isVisible().catch(() => false);
      if (!visible) {
        for (let i = 0; i < 8 && !visible; i++) {
          await page.waitForTimeout(2000);
          visible = await keepGoing.first().isVisible().catch(() => false);
        }
        if (!visible) break;
      }
      await keepGoing.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(3500);
      rounds++;
    }
    await page.close();

    const pos = Object.values(byPo);
    if (pos.length === 0) {
      throw new Error('SearchOpenPOs returned no POs — layout/endpoint may have changed; refusing to overwrite existing open-PO cache');
    }
    // Floor guard: a pull far smaller than the cache is a truncated scrape.
    try {
      const prevPos = JSON.parse(fs.readFileSync(OPEN_POS_PATH, 'utf8'));
      const prevN = (prevPos.pos || []).length;
      if (prevN > 0 && pos.length < prevN * 0.7) {
        const ops = require('./ops-alerts');
        const msg = `Open-PO pull has ${pos.length} POs vs ${prevN} cached (<70%) — refusing to overwrite`;
        ops.raise('openpos-floor', 'Open-PO scrape floor-guard tripped', msg).catch(() => {});
        throw new Error(msg);
      }
    } catch (e) {
      if (/refusing to overwrite/.test(e.message)) throw e;
    }

    const out = {
      generatedAt: new Date().toISOString(),
      source: 'payee-scraper-openpos',
      keepGoingRounds: rounds,
      total: pos.length,
      // Keep ALL raw endpoint fields (ship-to/site/description vary by PO type)
      // with our normalized names layered on top.
      pos: pos.map(p => ({
        ...p,
        poNumber: p.poNumber,
        amount: p.poAmount,
        currency: p.poCurrency || 'USD',
        status: p.poStatus,
        matchingType: p.matchingType,
        orderDate: p.orderDate,
      })),
    };
    const tmp = OPEN_POS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, OPEN_POS_PATH);
    console.log(`[payee-scraper] Wrote ${pos.length} open POs (${rounds} keep-going rounds) to ${OPEN_POS_PATH}`);
    // Clear the floor guard raised on earlier truncated pulls (see note in
    // scrapePayeeCentral — a tripped guard otherwise stays red forever).
    require('./ops-alerts').ok('openpos-floor', `${pos.length} POs written (floor guard passed)`);
    return out;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapePayeeCentral, scrapeOpenPOs, launchBrowser, ensureLoggedInContext };

if (require.main === module) {
  const mode = process.argv[2] || 'invoices';
  const run = mode === 'openpos' ? scrapeOpenPOs : scrapePayeeCentral;
  run()
    .then(() => process.exit(0))
    .catch(e => { console.error('[payee-scraper] FAILED:', e.message); process.exit(1); });
}
