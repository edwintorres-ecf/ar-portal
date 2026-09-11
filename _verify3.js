// 1. Does the BU picker populate BEFORE the ledger finishes?
// 2. Do the AR tiles move when the BU filter and the snow toggle move?
const { chromium } = require('/home/ecf-admin/ar-portal/node_modules/playwright-core');
const COOKIE = process.argv[2];
const [name, ...rest] = COOKIE.split('=');
const value = rest.join('=');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1100 }, ignoreHTTPSErrors: true });
  await ctx.addCookies([{ name, value, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'None' }]);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('https://localhost:3600/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(1500);

  const t0 = Date.now();
  await p.evaluate(() => navGo('po-funds'));
  // Poll for the picker every 250ms and record how soon it is usable.
  let readyAt = null;
  for (let i = 0; i < 200; i++) {
    const n = await p.evaluate(() => (typeof _poBuOptions !== 'undefined' ? _poBuOptions.length : 0));
    if (n > 1) { readyAt = Date.now() - t0; break; }
    await p.waitForTimeout(250);
  }
  const ledgerAt = await (async () => {
    for (let i = 0; i < 240; i++) {
      const n = await p.evaluate(() => (typeof _poRaw !== 'undefined' && _poRaw.ledger ? _poRaw.ledger.length : 0));
      if (n > 0) return Date.now() - t0;
      await p.waitForTimeout(250);
    }
    return null;
  })();
  console.log(`BU picker usable after : ${readyAt} ms`);
  console.log(`ledger loaded after    : ${ledgerAt} ms   ${readyAt !== null && ledgerAt !== null && readyAt < ledgerAt ? '← picker is ready FIRST' : '← STILL GATED'}`);

  await p.evaluate(() => setPoFundsSubtab('pending-site'));
  await p.waitForTimeout(22000);
  const read = () => p.evaluate(() => {
    const d = _poArStatus || {};
    return { openAr: d.openAr, n: d.openArCount, filter: d.filter,
      caption: (document.querySelector('#po-pending-site-content span + span') || {}).textContent };
  });
  const base = await read();
  console.log(`\nno filter        : ${M(base.openAr)}  ${base.n} invoices   filter=${JSON.stringify(base.filter)}`);

  await p.evaluate(() => togglePbsSnow());
  await p.waitForTimeout(22000);
  const snow = await read();
  console.log(`snow only        : ${M(snow.openAr)}  ${snow.n} invoices   filter=${JSON.stringify(snow.filter)}`);

  await p.evaluate(() => poSetBuList(['NACF']));
  await p.waitForTimeout(22000);
  const nacf = await read();
  console.log(`snow + NACF      : ${M(nacf.openAr)}  ${nacf.n} invoices   filter=${JSON.stringify(nacf.filter)}`);
  console.log(`caption          : ${JSON.stringify(nacf.caption)}`);

  await p.evaluate(() => poSetBuList(['Logistics']));
  await p.waitForTimeout(22000);
  const log = await read();
  console.log(`snow + Logistics : ${M(log.openAr)}  ${log.n} invoices   filter=${JSON.stringify(log.filter)}`);

  const ok = base.openAr > snow.openAr && snow.openAr > nacf.openAr && nacf.openAr !== log.openAr;
  console.log(`\ntiles respond to the filter: ${ok ? 'YES' : 'NO'}`);
  console.log('JS errors        :', errors.length ? JSON.stringify(errors.slice(0, 5)) : 'none');
  await p.screenshot({ path: '/tmp/tiles.png', fullPage: false });
  await b.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
