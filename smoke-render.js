// Headless SPA boot check with stubbed APIs (no auth, no real data touched).
const { chromium } = require('./node_modules/playwright-core');
const stub = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const R = {
  '/auth/me': { email: 'smoke@test', name: 'Smoke Test', role: 'admin' },
  '/api/invoices': { invoices: [], count: 0, cacheInfo: {} },
  '/api/mentions': { mentions: [], unseenCount: 0 },
};
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true })).newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.route('**/*', r => {
    const u = new URL(r.request().url());
    if (R[u.pathname] !== undefined) return r.fulfill(stub(R[u.pathname]));
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/auth/')) return r.fulfill(stub({}));
    r.continue();
  });
  await p.goto('https://localhost:3600/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await p.waitForTimeout(1500);
  const navOk = await p.$eval('.nav-tabs', el => el.children.length >= 4).catch(() => false);
  const viewOk = await p.$('#view-dashboard').then(Boolean).catch(() => false);
  console.log(navOk && viewOk ? 'RENDER OK' : 'RENDER INCOMPLETE nav=' + navOk + ' view=' + viewOk);
  console.log('JS ERRORS:', errors.length ? JSON.stringify(errors.slice(0, 3)) : 'none');
  await b.close();
  process.exit(navOk && viewOk && !errors.length ? 0 : 1);
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
