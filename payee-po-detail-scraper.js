'use strict';
/**
 * payee-po-detail-scraper.js — per-PO authoritative balance from Payee Central.
 *
 * The SearchOpenPOs endpoint (payee-scraper.js openpos mode) gives only the
 * ORIGINAL po amount, never the live remaining. Amazon exposes the true,
 * quantity-enforced remaining only on each PO's detail page:
 *   https://payeecentral.amazon.com/PurchaseOrder/Details?poNumber=<po>
 * which server-renders "Available amount $X USD" plus the Ship To site and the
 * line-item service description. This walks every open PO's detail page and
 * captures that authoritative available balance so the ledger's "Value
 * Remaining" is Amazon's real number, not our computed one.
 *
 * Reliability posture (matches payee-scraper.js): degrade to STALE, never to
 * WRONG. A PO whose page fails to load / lacks an "Available amount" keeps its
 * previously-cached value flagged {stale:true} — we never zero a balance on a
 * transient failure. If too many POs fail in one pass we alert and refuse to
 * treat the pass as authoritative.
 */

const path = require('path');
const fs = require('fs');
const { launchBrowser, ensureLoggedInContext } = require('./payee-scraper');

const OPEN_POS_PATH = path.join(__dirname, 'payee-open-pos.json');
const DETAILS_PATH = path.join(__dirname, 'payee-po-details.spark.json');
const DETAILS_URL = (po) => `https://payeecentral.amazon.com/PurchaseOrder/Details?poNumber=${encodeURIComponent(po)}`;

const CONCURRENCY = 3;          // parallel detail pages within one context
const PER_PO_TIMEOUT = 25000;   // nav budget per PO
const SETTLE_MS = 900;          // let the server-rendered figures paint
const FAIL_ALERT_RATIO = 0.40;  // >40% failures in a pass = don't trust it

function money(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[,$]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Parses a Payee Central money label. Two formats:
//   "Available amount $404,101.00 USD"    -> 404101.00
//   "Available amount ($760.28 USD)"      -> -760.28   (accountant-parens = over)
//   "Available amount --"                 -> null       (Amazon masks the amount)
function labeledMoney(t, label) {
  const m = t.match(new RegExp(label + '\\s*(\\(?)\\$([\\d,]+\\.\\d{2})'));
  if (!m) return null;
  const v = money(m[2]);
  return v == null ? null : (m[1] === '(' ? -v : v);
}

function extractFromText(po, txt) {
  const t = (txt || '').replace(/\s+/g, ' ');
  const esc = po.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const available = labeledMoney(t, 'Available amount');
  const poAmount = labeledMoney(t, 'PO amount');
  const status = (t.match(new RegExp(esc + '\\s+([A-Za-z]+)\\s+Order date')) || [])[1] || null;
  const site = (t.match(/Ship To[\s\S]{0,140}?\(([A-Z0-9]{2,5})\)/) || [])[1] || null;
  // Amazon masks the amount on some POs ("Available amount --" + a "Why am I not
  // able to see the amount?" link). That's a permanent, expected state — the
  // page rendered fine, Amazon just won't disclose the figure — not a scrape
  // failure to retry endlessly.
  const masked = /Available amount\s*--/.test(t) || /Why am I not able to see the amount/.test(t);
  // First line-item description: "...Showing N items ... 1 <DESC> ..." — best
  // effort; the ledger's own doc-derived serviceType stays the primary source.
  let desc = null;
  const dm = t.match(/Net Amount\s+(?:PO Line #[\s\S]*?Net Amount\s+)?1\s+(.+?)\s+(?:[A-Z]{2,4}\d{1,2}\b|Dec |Jan |Nov |Oct )/);
  if (dm) desc = dm[1].slice(0, 120).trim();
  return { available, poAmount, status, site, desc, masked };
}

async function scrapeOne(page, po) {
  await page.goto(DETAILS_URL(po), { waitUntil: 'domcontentloaded', timeout: PER_PO_TIMEOUT });
  // Wait for the balance line (server-rendered) or bail after a short settle.
  await page.locator('text=Available amount').first().waitFor({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
  if (/signin|\/ap\//i.test(page.url())) throw new Error('bounced to signin');
  const txt = await page.locator('body').innerText().catch(() => '');
  const rec = extractFromText(po, txt);
  // masked => Amazon rendered the page but hides the figure (permanent, fine).
  // available present => got the real number. Neither => genuine load failure.
  if (rec.available == null && !rec.masked) throw new Error('no Available amount on page');
  return rec;
}

function loadPrev() {
  try { return JSON.parse(fs.readFileSync(DETAILS_PATH, 'utf8')); }
  catch (e) { return { details: {} }; }
}

function writeOut(out) {
  const tmp = DETAILS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, DETAILS_PATH);
}

// staleOnly: only (re)scrape POs missing from cache or older than maxAgeH — lets
// a crashed run resume cheaply. Default (full) refreshes every open PO.
async function scrapePoDetails({ staleOnly = false, maxAgeH = 20, limit = 0 } = {}) {
  const openDoc = JSON.parse(fs.readFileSync(OPEN_POS_PATH, 'utf8'));
  let openPos = (openDoc.pos || []).map(p => p.poNumber).filter(Boolean);
  if (limit > 0) openPos = openPos.slice(0, limit);

  const prev = loadPrev();
  const details = { ...(prev.details || {}) };
  const cutoff = Date.now() - maxAgeH * 3600 * 1000;

  const queue = openPos.filter(po => {
    if (!staleOnly) return true;
    const d = details[po];
    // Re-scrape if never seen, still failing (stale), or truly missing a figure.
    // A masked PO (available null but masked:true) is settled — don't retry it.
    if (!d || d.stale || (d.available == null && !d.masked)) return true;
    return !d.scrapedAt || Date.parse(d.scrapedAt) < cutoff;
  });

  // Drop cache entries for POs no longer open (they closed) so the ledger
  // doesn't keep showing a remaining balance for a closed PO.
  const openSet = new Set(openPos);
  for (const po of Object.keys(details)) if (!openSet.has(po)) delete details[po];

  console.log(`[po-detail] ${openPos.length} open POs, scraping ${queue.length} (staleOnly=${staleOnly})`);
  if (queue.length === 0) {
    writeOut({ ...prev, generatedAt: new Date().toISOString(), openTotal: openPos.length, details });
    return { ok: 0, failed: 0, total: 0 };
  }

  const browser = await launchBrowser();
  let ok = 0, failed = 0, done = 0;
  const stampIso = new Date().toISOString();
  try {
    const context = await ensureLoggedInContext(browser);
    const pages = [];
    for (let i = 0; i < CONCURRENCY; i++) pages.push(await context.newPage());

    let idx = 0;
    async function worker(page) {
      while (idx < queue.length) {
        const po = queue[idx++];
        let rec = null;
        for (let attempt = 0; attempt < 2 && !rec; attempt++) {
          try { rec = await scrapeOne(page, po); }
          catch (e) { if (attempt === 1) rec = { _err: e.message }; else await page.waitForTimeout(1200); }
        }
        if (rec && !rec._err) {
          details[po] = { ...rec, scrapedAt: stampIso, stale: false };
          ok++;
        } else {
          const prevD = details[po];
          if (prevD && prevD.available != null) details[po] = { ...prevD, stale: true, lastError: rec && rec._err };
          else details[po] = { available: null, poAmount: null, status: null, site: null, desc: null, scrapedAt: stampIso, stale: true, lastError: rec && rec._err };
          failed++;
        }
        done++;
        if (done % 25 === 0) {
          writeOut({ generatedAt: stampIso, source: 'payee-po-detail-scraper', openTotal: openPos.length, ok, failed, partial: true, details });
          console.log(`[po-detail] ${done}/${queue.length} (ok ${ok}, fail ${failed})`);
        }
      }
    }
    await Promise.all(pages.map(pg => worker(pg)));
  } finally {
    await browser.close();
  }

  const failRatio = queue.length ? failed / queue.length : 0;
  const out = {
    generatedAt: stampIso,
    source: 'payee-po-detail-scraper',
    openTotal: openPos.length,
    scraped: queue.length, ok, failed,
    failRatio: Number(failRatio.toFixed(3)),
    trustworthy: failRatio <= FAIL_ALERT_RATIO,
    details,
  };
  writeOut(out);
  console.log(`[po-detail] DONE ok=${ok} failed=${failed} failRatio=${(failRatio * 100).toFixed(1)}%`);

  if (failRatio > FAIL_ALERT_RATIO) {
    try {
      require('./ops-alerts').raise('po-detail-failratio',
        'PO detail scrape unreliable',
        `${failed}/${queue.length} PO detail pages failed (${(failRatio * 100).toFixed(0)}%) — availability figures may be stale`).catch(() => {});
    } catch (e) { /* alerts must never throw */ }
  }
  return { ok, failed, total: queue.length, failRatio };
}

function getPoDetails() {
  try { return JSON.parse(fs.readFileSync(DETAILS_PATH, 'utf8')); }
  catch (e) { return { details: {} }; }
}

module.exports = { scrapePoDetails, getPoDetails };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {
    staleOnly: args.includes('--stale'),
    limit: Number((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0,
  };
  scrapePoDetails(opts)
    .then(r => { console.log('[po-detail] result', JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('[po-detail] FAILED:', e.message); process.exit(1); });
}
