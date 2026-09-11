// Does the Business unit picker get its options? Drives the real SPA with the
// API stubbed, so the answer is about the client wiring, not the data.
const { chromium } = require('/home/ecf-admin/ar-portal/node_modules/playwright-core');
const stub = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const META = {
  payeeFeed: '2026-09-11T15:14:32.383Z', openPos: '2026-09-11T15:15:42.835Z',
  poDocs: '2026-09-11T15:12:53.760Z', sageInvoices: '2026-09-11T15:00:00.073Z',
  businessUnits: ['AMXL', 'AMZL', 'ATS', 'GSF', 'Logistics', 'MbA', 'NACF', 'R2L'],
  refreshRunning: false, refreshStarted: null,
};
const R = {
  '/auth/me': { email: 'smoke@test', name: 'Smoke Test', role: 'admin' },
  '/api/po/meta': META,
  '/api/invoices': { invoices: [], count: 0, cacheInfo: {} },
  '/api/mentions': { mentions: [], unseenCount: 0 },
};
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const p = await (await b.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true })).newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  const metaHits = [];
  await p.route('**/*', r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/po/meta') metaHits.push(1);
    if (R[u.pathname] !== undefined) return r.fulfill(stub(R[u.pathname]));
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/auth/')) return r.fulfill(stub({}));
    r.continue();
  });
  await p.goto('https://localhost:3600/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p.waitForTimeout(1200);
  await p.evaluate(() => navGo('po-funds'));
  await p.waitForTimeout(2500);

  // Top-level let/const are NOT window properties in a classic script — read the
  // bare identifiers.
  const out = await p.evaluate(() => ({
    poBuOptions: typeof _poBuOptions !== 'undefined' ? _poBuOptions : '(undefined)',
    regOptions: typeof _msReg !== 'undefined' && _msReg['po-bu'] ? _msReg['po-bu'].options : '(no reg)',
    wrapHtml: (document.getElementById('po-filter-bu-wrap') || {}).innerHTML ? 'present' : 'EMPTY',
    freshness: (document.getElementById('po-funds-freshness') || {}).textContent,
  }));
  console.log('meta fetches      :', metaHits.length);
  console.log('_poBuOptions      :', JSON.stringify(out.poBuOptions));
  console.log('_msReg[po-bu].opts:', JSON.stringify(out.regOptions));
  console.log('filter wrap       :', out.wrapHtml);
  console.log('freshness line    :', JSON.stringify((out.freshness || '').slice(0, 90)));

  // Now open the panel the way a click does, and count the checkboxes.
  await p.evaluate(() => msToggle('po-bu'));
  await p.waitForTimeout(400);
  const panel = await p.evaluate(() => {
    const el = document.querySelector('.ms-panel');
    return el ? { boxes: el.querySelectorAll('input[type=checkbox]').length, text: el.textContent.trim().slice(0, 120) } : null;
  });
  console.log('panel             :', JSON.stringify(panel));
  console.log('JS errors         :', errors.length ? JSON.stringify(errors.slice(0, 5)) : 'none');
  await b.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
