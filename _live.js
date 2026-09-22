// Every view, as a real admin, against real production data.
'use strict';
require('dotenv').config();
const path = require('path'); const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright-core');
const bp = require('./browser-path');
const VIEWS = ['overview', 'invoices2', 'dashboard', 'customers', 'locations', 'sitepos', 'search',
  'service-centers', 'po-funds', 'reports', 'comms-mailbox', 'comms-triage', 'comms-dunning',
  'comms-statements', 'amazon', 'activity', 'ptp-board', 'admin'];
(async () => {
  const d = require('./db').getDb();
  const admin = d.prepare("SELECT * FROM user_roles WHERE role='admin' LIMIT 1").get();
  const sdb = new DatabaseSync(path.join(__dirname, 'sessions.db'));
  const sid = crypto.randomBytes(24).toString('hex');
  sdb.prepare('INSERT OR REPLACE INTO sessions (sid, expired, sess) VALUES (?,?,?)').run(sid, Date.now() + 3600000,
    JSON.stringify({ cookie: { originalMaxAge: 3600000, httpOnly: true, secure: true, sameSite: 'none', path: '/' },
      user: { email: admin.email, name: admin.name, role: 'admin' } }));
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(sid).digest('base64').replace(/=+$/, '');
  const b = await chromium.launch(bp.launchOptions());
  try {
    const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
    await ctx.addCookies([{ name: 'connect.sid', value: `s:${sid}.${sig}`, domain: 'localhost', path: '/', httpOnly: true, secure: true }]);
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await p.goto('https://localhost:3600/', { waitUntil: 'networkidle', timeout: 60000 });
    await p.waitForTimeout(3000);
    console.log('boot errors:', errs.length ? errs.join(' | ') : 'none');
    for (const v of VIEWS) {
      const before = errs.length;
      await p.evaluate(n => navGo(n), v);
      await p.waitForTimeout(1800);
      const shown = await p.evaluate(n => {
        const el = document.getElementById('view-' + n);
        return el ? { vis: getComputedStyle(el).display !== 'none', chars: el.innerText.trim().length } : null;
      }, v);
      const newErrs = errs.slice(before);
      const bad = !shown || !shown.vis || shown.chars < 40 || newErrs.length;
      console.log(`  ${bad ? '✗' : '✓'} ${v.padEnd(18)} ${shown ? String(shown.chars).padStart(6) + ' chars' : 'NO VIEW ELEMENT'}${newErrs.length ? '  ERR: ' + newErrs.join('; ') : ''}`);
    }
    console.log('\ntotal JS errors:', errs.length);
    await p.evaluate(() => navGo('overview'));
    await p.waitForTimeout(2500);
    await p.screenshot({ path: '/tmp/prod-dashboard.png' });
    await ctx.close();
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
  finally { await b.close(); sdb.prepare('DELETE FROM sessions WHERE sid=?').run(sid); }
})();
