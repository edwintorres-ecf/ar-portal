'use strict';
/**
 * payee-rejection-scraper.js — why Amazon rejected an invoice.
 *
 * The Excel export the main scraper drives gives seven columns and no reason;
 * the reason only exists on the invoice's own detail page, which is keyed by
 * Amazon's INTERNAL numeric invoiceId, not by our invoice number. So each
 * rejection has to be looked up in the invoice list first to find its detail
 * link, then read.
 *
 * The list view also carries two columns the Excel export drops: "Action" and
 * "Amazon Contact". The latter is the person at Amazon who owns the invoice,
 * which is exactly who a rejection has to be taken up with, so it is captured
 * here too (Edwin 2026-09-10).
 *
 * Cheap by design: only OPEN rejections are looked up, and there are usually a
 * dozen. Failure to read one leaves the previous reason in place rather than
 * blanking it — same degrade-to-stale posture as the other scrapers.
 */

const db = require('./db');
const { launchBrowser, ensureLoggedInContext } = require('./payee-scraper');

const INVOICES_URL = 'https://payeecentral.amazon.com/Invoices';
const PER_INVOICE_TIMEOUT = 30000;
const SETTLE_MS = 1200;

// The detail page renders label/value pairs as text; pull a labelled value out
// of the flattened body text.
function labelled(text, label) {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\n\\s*([^\\n]+)', 'i');
  const m = text.match(re);
  if (!m) return null;
  const v = m[1].replace(/\s+/g, ' ').trim();
  return v && v !== '-' ? v : null;
}

async function scrapeOne(page, invoiceNumber) {
  await page.goto(INVOICES_URL, { waitUntil: 'networkidle', timeout: PER_INVOICE_TIMEOUT });
  await page.waitForTimeout(500);
  const box = page.locator('input[type="text"], input[type="search"]').first();
  await box.fill(invoiceNumber, { timeout: 8000 });
  await box.press('Enter');
  await page.waitForTimeout(2500);

  // Read the row straight out of the DOM. Clicking is unreliable — Amazon's
  // help overlay (chardinjs) intercepts pointer events on a fresh session.
  const row = await page.evaluate(() => {
    for (const t of document.querySelectorAll('table')) {
      const heads = Array.from(t.querySelectorAll('th')).map(h => (h.textContent || '').trim());
      if (!heads.some(h => h.startsWith('Invoice #'))) continue;
      const tr = t.querySelector('tbody tr');
      if (!tr) continue;
      const tds = Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim());
      const idx = (p) => heads.findIndex(h => h.startsWith(p));
      const link = tr.querySelector('a[href*="InvoiceDetails"]');
      const iContact = idx('Amazon Contact');
      return {
        href: link ? link.href : null,
        amazonContact: iContact >= 0 ? tds[iContact] : null,
        status: (() => { const i = idx('Invoice Status'); return i >= 0 ? tds[i] : null; })(),
        po: (() => { const i = idx('Purchase Order #'); return i >= 0 ? tds[i] : null; })(),
      };
    }
    return null;
  });
  if (!row) throw new Error('invoice not found in the list');

  const out = {
    amazonContact: row.amazonContact && row.amazonContact.includes('@') ? row.amazonContact.toLowerCase() : null,
    status: row.status || null,
    po: row.po || null,
    reason: null, rejectedBy: null, description: null, servicePeriod: null,
  };
  if (!row.href) return out;   // list gave us the contact; detail link missing

  await page.goto(row.href, { waitUntil: 'domcontentloaded', timeout: PER_INVOICE_TIMEOUT });
  await page.waitForTimeout(SETTLE_MS);
  if (/signin|\/ap\//i.test(page.url())) throw new Error('bounced to signin');
  const text = await page.locator('body').innerText().catch(() => '');

  out.reason = labelled(text, 'Rejection Reason');
  out.rejectedBy = (labelled(text, 'Invoice Rejected by') || '').toLowerCase() || null;
  out.description = labelled(text, 'Invoice Description');
  out.servicePeriod = labelled(text, 'Service Period');
  if (!out.amazonContact) {
    const c = labelled(text, 'Amazon Contact');
    if (c && c.includes('@')) out.amazonContact = c.toLowerCase();
  }
  return out;
}

/**
 * Reads reasons for open rejections that do not have one yet (or all of them
 * with {refresh:true}).
 */
async function scrapeRejectionReasons({ limit = 0, refresh = false } = {}) {
  const targets = db.listRejections()
    .filter(r => refresh || !r.reason)
    .slice(0, limit > 0 ? limit : undefined);
  if (!targets.length) return { attempted: 0, updated: 0, failed: 0, note: 'nothing to look up' };

  const browser = await launchBrowser();
  const stats = { attempted: 0, updated: 0, failed: 0, contacts: 0, errors: [] };
  try {
    const ctx = await ensureLoggedInContext(browser);
    const page = await ctx.newPage();
    for (const r of targets) {
      stats.attempted++;
      try {
        const info = await scrapeOne(page, r.payee_id);
        db.updateRejectionDetail(r.payee_id, {
          reason: info.reason, rejected_by: info.rejectedBy,
          amazon_contact: info.amazonContact, description: info.description,
        });
        if (info.reason) stats.updated++;
        // The invoice's Amazon contact is a better site contact than the PO
        // document's purchaser: it is per invoice and it is current.
        if (info.amazonContact && r.site_code) {
          db.learnSiteAmazonContact({
            siteCode: r.site_code, name: null, email: info.amazonContact,
            source: 'payee-invoice:' + r.payee_id, seenAt: new Date().toISOString().slice(0, 10),
          });
          stats.contacts++;
        }
      } catch (e) {
        stats.failed++;
        stats.errors.push(`${r.payee_id}: ${String(e.message).slice(0, 80)}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return stats;
}

module.exports = { scrapeRejectionReasons, labelled };
