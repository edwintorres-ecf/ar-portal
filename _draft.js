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
  await p.waitForTimeout(2200);
  await p.evaluate(() => { _mailboxFilter = ''; return commsLoadMailbox(); });
  await p.waitForTimeout(2500);

  // type into thread 8
  await p.evaluate(() => commsSelectThread(8));
  await p.waitForTimeout(3000);
  await p.click('#cmp-body');
  await p.keyboard.type('Half written reply about the past due balance');
  await p.waitForTimeout(2000);
  console.log('status after typing :', await p.evaluate(() => (document.getElementById('cmp-draft-state')||{}).textContent));

  // switch away and back — the real test
  await p.evaluate(() => commsSelectThread(6));
  await p.waitForTimeout(3000);
  console.log('body on other thread:', JSON.stringify(await p.evaluate(() => commsBodyText())));
  await p.evaluate(() => commsSelectThread(8));
  await p.waitForTimeout(3000);
  console.log('body on return      :', JSON.stringify(await p.evaluate(() => commsBodyText())));
  console.log('status on return    :', await p.evaluate(() => (document.getElementById('cmp-draft-state')||{}).textContent));

  // drafts list + badge
  await p.evaluate(() => { _mailboxFilter = 'drafts'; return commsLoadMailbox(); });
  await p.waitForTimeout(2500);
  console.log('drafts view         :', await p.evaluate(() => _mailboxConvs.map(c => c.id + ':' + String(c.subject).slice(0, 26))));
  await p.evaluate(() => { _mailboxFilter = ''; return commsLoadMailbox(); });
  await p.waitForTimeout(2500);
  console.log('DRAFT badge in list :', await p.evaluate(() => /DRAFT/.test(document.getElementById('mailbox-list').innerText)));

  // discard
  await p.evaluate(() => commsSelectThread(8));
  await p.waitForTimeout(2500);
  p.on('dialog', d => d.accept());
  await p.evaluate(() => commsDraftDiscard());
  await p.waitForTimeout(2000);
  console.log('body after discard  :', JSON.stringify(await p.evaluate(() => commsBodyText())));
  const left = await p.evaluate(async () => (await apiFetch('/api/comms/drafts')).drafts.length);
  console.log('drafts remaining    :', left);
  console.log('JS errors           :', errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none');
  await b.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
