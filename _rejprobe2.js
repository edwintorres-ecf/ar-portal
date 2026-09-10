// Follow the real detail link (keyed by Amazon's internal numeric invoiceId,
// which is why the guessed invoiceNumber URLs 404'd) and dump the page.
const { launchBrowser, ensureLoggedInContext } = require('/home/ecf-admin/ar-portal/payee-scraper');
const TARGET = process.argv[2] || 'AST003664';
(async () => {
  const browser = await launchBrowser();
  const ctx = await ensureLoggedInContext(browser);
  const page = await ctx.newPage();
  await page.goto('https://payeecentral.amazon.com/Invoices', { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(1200);
  const box = page.locator('input[type="text"], input[type="search"]').first();
  await box.fill(TARGET, { timeout: 8000 });
  await box.press('Enter');
  await page.waitForTimeout(3500);

  const row = await page.evaluate(() => {
    for (const t of document.querySelectorAll('table')) {
      const heads = Array.from(t.querySelectorAll('th')).map(h => (h.textContent || '').trim());
      if (!heads.some(h => h.startsWith('Invoice #'))) continue;
      const tr = t.querySelector('tbody tr');
      if (!tr) continue;
      const tds = Array.from(tr.querySelectorAll('td')).map(td => (td.textContent || '').trim());
      const link = tr.querySelector('a[href*="InvoiceDetails"]');
      return { heads, tds, href: link ? link.href : null };
    }
    return null;
  });
  console.log('HEADERS:', JSON.stringify(row && row.heads));
  console.log('CELLS  :', JSON.stringify(row && row.tds));
  console.log('DETAIL :', row && row.href);
  if (row && row.href) {
    await page.goto(row.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const txt = await page.locator('body').innerText().catch(() => '');
    console.log('\n===== DETAIL PAGE =====\n' + txt.slice(0, 5000));
  }
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
