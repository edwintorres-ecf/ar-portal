const { chromium } = require('/home/ecf-admin/ar-portal/node_modules/playwright-core');
const bp = require('/home/ecf-admin/ar-portal/browser-path');
const [name, ...rest] = process.argv[2].split('='); const value = rest.join('=');
(async () => {
  const b = await chromium.launch(bp.launchOptions({ headless: true }));
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1250 }, ignoreHTTPSErrors: true });
  await ctx.addCookies([{ name, value, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'None' }]);
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('https://localhost:3600/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(1800);
  await p.evaluate(() => navGo('comms-mailbox'));
  await p.waitForTimeout(2500);
  await p.evaluate(() => { _mailboxFilter = ''; return commsLoadMailbox(); });
  await p.waitForTimeout(2500);
  await p.evaluate(() => commsSelectThread(8));
  await p.waitForTimeout(4000);
  const a = await p.evaluate(() => ({
    contacts: document.querySelectorAll('[data-cmp-contact]').length,
    pickerText: (document.getElementById('cmp-contacts') || {}).innerText.replace(/\n+/g, ' | ').slice(0, 150),
    family: typeof _cmpFamily !== 'undefined' && _cmpFamily ? { self: _cmpFamily.self && _cmpFamily.self.customer_id, parent: _cmpFamily.parent && _cmpFamily.parent.customer_id, sib: (_cmpFamily.siblings || []).length } : null,
    ctx: (document.getElementById('mailbox-context') || {}).innerText.replace(/\n+/g, ' | ').slice(0, 170),
  }));
  console.log('contacts in picker :', a.contacts);
  console.log('picker             :', a.pickerText);
  console.log('family             :', JSON.stringify(a.family));
  console.log('context pane       :', a.ctx);
  // tick a contact
  if (a.contacts) {
    await p.evaluate(() => { const b = document.querySelector('[data-cmp-contact]'); b.checked = true; commsContactPicked(); });
    console.log('To after ticking   :', await p.evaluate(() => document.getElementById('cmp-to').value));
  }
  // FYI
  await p.evaluate(() => commsToggleFyi());
  await p.waitForTimeout(5000);
  const f = await p.evaluate(() => ({
    rows: document.querySelectorAll('[data-fyi]').length,
    text: (document.getElementById('cmp-fyi') || {}).innerText.replace(/\n+/g, ' | ').slice(0, 190),
  }));
  console.log('FYI rows           :', f.rows);
  console.log('FYI panel          :', f.text);
  if (f.rows) {
    await p.evaluate(() => commsInsertFyi());
    await p.waitForTimeout(500);
    console.log('body after insert  :', JSON.stringify((await p.evaluate(() => document.getElementById('cmp-body').value)).slice(0, 190)));
  }
  console.log('JS errors          :', errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none');
  await p.screenshot({ path: '/tmp/mb3.png' });
  await b.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
