// Navigate the real PO Details page and extract Amazon's actual available
// balance (line items: ordered vs invoiced/available qty × unit price).
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const { chromium } = require('/home/ecf-admin/ar-portal/node_modules/playwright-core');
const SESSION_PATH = '/home/ecf-admin/ar-portal/cache/payee-session.json';
const TEST_PO = process.argv[2] || '2D-19170701';

(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const p = await (await b.newContext({ storageState: SESSION_PATH })).newPage();
  const apis = [];
  p.on('response', async (r) => {
    const u = r.url(); if (!/amazon/i.test(u) || /\.(js|css|png|gif|woff|svg|ico)/i.test(u)) return;
    let t = ''; try { t = await r.text(); } catch (e) { return; }
    if (/quantity|unitPrice|available|remaining|invoiced|lineItem|openAmount|amountRemaining/i.test(t) && t.length < 500000) apis.push({ u: u.slice(-55), t });
  });

  const url = `https://payeecentral.amazon.com/PurchaseOrder/Details?poNumber=${encodeURIComponent(TEST_PO)}`;
  await p.goto(url, { waitUntil: 'networkidle', timeout: 40000 }).catch(() => {});
  await p.waitForTimeout(3500);
  console.log('landed:', p.url().slice(0, 70), '| loggedIn:', !/signin/i.test(p.url()));

  const txt = (await p.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  console.log('=== PAGE TEXT (first 900) ===');
  console.log(txt.slice(0, 900));

  // Column headers of any table (to find "Available"/"Remaining"/"Invoiced")
  const heads = await p.$$eval('table th, [role="columnheader"]', th => th.map(x => x.innerText.trim()).filter(Boolean)).catch(() => []);
  console.log('=== TABLE HEADERS:', JSON.stringify(heads.slice(0, 25)));

  console.log('=== data XHR (', apis.length, ') ===');
  for (const a of apis.slice(0, 3)) {
    console.log('URL…', a.u);
    try { const j = JSON.parse(a.t); console.log('  keys:', Object.keys(j).slice(0, 20).join(',')); console.log('  ', JSON.stringify(j).replace(/\s+/g, ' ').slice(0, 900)); }
    catch (e) { console.log('  (html/text)', a.t.replace(/\s+/g, ' ').slice(0, 500)); }
  }
  await b.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
