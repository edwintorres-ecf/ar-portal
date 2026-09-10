// Probe: does Payee Central show a rejection REASON anywhere we can capture?
// Opens the invoice list, searches one known rejected invoice, opens it, and
// dumps the URL + page text so we can see what is actually available.
const { launchBrowser, ensureLoggedInContext } = require('/home/ecf-admin/ar-portal/payee-scraper');

const TARGET = process.argv[2] || 'AST003664';

(async () => {
  const browser = await launchBrowser();
  const ctx = await ensureLoggedInContext(browser);
  const page = await ctx.newPage();

  // 1. Try the obvious detail URLs first — cheapest if one of them works.
  const candidates = [
    `https://payeecentral.amazon.com/Invoices/Details?invoiceNumber=${TARGET}`,
    `https://payeecentral.amazon.com/Invoice/Details?invoiceNumber=${TARGET}`,
    `https://payeecentral.amazon.com/Invoices/InvoiceDetails?invoiceNumber=${TARGET}`,
  ];
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1200);
      const txt = await page.locator('body').innerText().catch(() => '');
      console.log('--- TRY', url, '=>', page.url(), 'len', txt.length);
      if (txt.length > 400 && !/not found|error/i.test(txt.slice(0, 200))) {
        console.log(txt.slice(0, 3000));
        break;
      }
    } catch (e) { console.log('--- TRY', url, 'ERR', e.message); }
  }

  // 2. Otherwise drive the list UI: search the invoice, then open its row.
  console.log('\n=== via the invoice list ===');
  await page.goto('https://payeecentral.amazon.com/Invoices', { waitUntil: 'networkidle', timeout: 40000 });
  await page.waitForTimeout(1500);
  const box = page.locator('input[type="text"], input[type="search"]').first();
  try {
    await box.fill(TARGET, { timeout: 8000 });
    await box.press('Enter');
    await page.waitForTimeout(3500);
  } catch (e) { console.log('search box:', e.message); }

  const listTxt = await page.locator('body').innerText().catch(() => '');
  console.log('LIST TEXT (first 1500):\n' + listTxt.slice(0, 1500));

  // Any link that looks like it leads to the invoice.
  const links = await page.evaluate((t) => Array.from(document.querySelectorAll('a'))
    .map(a => ({ text: (a.textContent || '').trim().slice(0, 60), href: a.href }))
    .filter(l => l.text.includes(t) || /invoice/i.test(l.href))
    .slice(0, 20), TARGET);
  console.log('LINKS:', JSON.stringify(links, null, 1));

  const target = page.getByText(TARGET, { exact: false }).first();
  try {
    await target.click({ timeout: 6000 });
    await page.waitForTimeout(3000);
    console.log('AFTER CLICK URL:', page.url());
    const dtxt = await page.locator('body').innerText().catch(() => '');
    console.log('DETAIL TEXT (first 4000):\n' + dtxt.slice(0, 4000));
  } catch (e) { console.log('click:', e.message); }

  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
