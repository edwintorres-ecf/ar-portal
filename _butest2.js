// Same check, but against the REAL server with a real session — no stubs.
const { chromium } = require('/home/ecf-admin/ar-portal/node_modules/playwright-core');
const COOKIE = process.argv[2];           // "connect.sid=s%3A..."
const [name, ...rest] = COOKIE.split('=');
const value = rest.join('=');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
  await ctx.addCookies([{ name, value, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'None' }]);
  const p = await ctx.newPage();
  const errors = []; const failed = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) failed.push(r.status() + ' ' + new URL(r.url()).pathname); });

  await p.goto('https://localhost:3600/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(2000);
  await p.evaluate(() => navGo('po-funds'));
  await p.waitForTimeout(45000);
  const before = await p.evaluate(() => ({
    bu: typeof _poBuOptions !== 'undefined' ? _poBuOptions : '(undef)',
    reg: typeof _msReg !== 'undefined' && _msReg['po-bu'] ? _msReg['po-bu'].options : '(no reg)',
    fresh: (document.getElementById('po-funds-freshness') || {}).textContent,
  }));
  console.log('[ledger tab] _poBuOptions :', JSON.stringify(before.bu));
  console.log('[ledger tab] reg options  :', JSON.stringify(before.reg));
  console.log('[ledger tab] freshness    :', JSON.stringify((before.fresh || '').slice(0, 70)));

  // Now do what Edwin did: switch to Pending by Site, then open the picker.
  await p.evaluate(() => setPoFundsSubtab('pending-site'));
  await p.waitForTimeout(8000);
  const after = await p.evaluate(() => ({
    bu: typeof _poBuOptions !== 'undefined' ? _poBuOptions : '(undef)',
    reg: typeof _msReg !== 'undefined' && _msReg['po-bu'] ? _msReg['po-bu'].options : '(no reg)',
    fresh: (document.getElementById('po-funds-freshness') || {}).textContent,
  }));
  console.log('[pending-site] _poBuOptions:', JSON.stringify(after.bu));
  console.log('[pending-site] reg options :', JSON.stringify(after.reg));
  console.log('[pending-site] freshness   :', JSON.stringify((after.fresh || '').slice(0, 70)));

  await p.evaluate(() => msToggle('po-bu'));
  await p.waitForTimeout(600);
  const panel = await p.evaluate(() => {
    const el = document.querySelector('.ms-panel');
    return el ? { boxes: el.querySelectorAll('input[type=checkbox]').length, text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 140) } : null;
  });
  console.log('panel                     :', JSON.stringify(panel));
  console.log('failed API calls          :', failed.length ? JSON.stringify(failed) : 'none');
  console.log('JS errors                 :', errors.length ? JSON.stringify(errors.slice(0, 5)) : 'none');
  await p.screenshot({ path: '/tmp/bu-real.png' });
  await b.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
