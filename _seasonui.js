'use strict';
require('dotenv').config();
const path = require('path'); const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright-core');
const bp = require('./browser-path');
const ok = (l, c, x) => console.log(`${c ? '  ✓' : '  ✗'} ${l}${x !== undefined ? ' : ' + x : ''}`);
(async () => {
  const db = require('./db').getDb();
  const admin = db.prepare("SELECT * FROM user_roles WHERE role='admin' LIMIT 1").get();
  const sdb = new DatabaseSync(path.join(__dirname, 'sessions.db'));
  const sid = crypto.randomBytes(24).toString('hex');
  sdb.prepare('INSERT OR REPLACE INTO sessions (sid, expired, sess) VALUES (?,?,?)').run(sid, Date.now() + 3600000,
    JSON.stringify({ cookie: { originalMaxAge: 3600000, httpOnly: true, secure: true, sameSite: 'none', path: '/' },
      user: { email: admin.email, name: admin.name, role: 'admin' } }));
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(sid).digest('base64').replace(/=+$/, '');
  const b = await chromium.launch(bp.launchOptions());
  try {
    const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1700, height: 1100 } });
    await ctx.addCookies([{ name: 'connect.sid', value: `s:${sid}.${sig}`, domain: 'localhost', path: '/', httpOnly: true, secure: true }]);
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('https://localhost:3600/', { waitUntil: 'networkidle', timeout: 60000 });
    await p.evaluate(() => navGo('po-funds'));
    await p.waitForFunction(() => typeof _poLedger !== 'undefined' && _poLedger.length > 0, null, { timeout: 90000 });
    await p.evaluate(() => setPoFundsSubtab('season'));
    await p.waitForFunction(() => {
      const el = document.getElementById('po-season-content');
      return el && !/Checking the award/.test(el.innerText);
    }, null, { timeout: 120000 });
    await p.waitForTimeout(600);

    const m = await p.evaluate(() => {
      const el = document.getElementById('po-season-content');
      return {
        tiles: el.querySelectorAll('div[style*="border-radius:9px"]').length,
        rows: el.querySelectorAll('table tbody tr').length,
        sortable: el.querySelectorAll('th[onclick]').length,
        rollups: [...el.querySelectorAll('div')].filter(d => /^By (service center|region|pricing model)$/.test((d.firstChild||{}).textContent||'')).length,
        badge: document.getElementById('po-season-badge').textContent,
        text: el.innerText.slice(0, 220).replace(/\n+/g, ' | '),
      };
    });
    ok('screen renders', m.rows > 0, `${m.rows} site rows`);
    ok('four summary tiles', m.tiles >= 4, String(m.tiles));
    ok('columns sortable', m.sortable >= 9, `${m.sortable} sortable headers`);
    ok('tab badge shows sites awaiting a PO', /283/.test(m.badge), m.badge);
    console.log('   headline:', m.text.slice(0, 150));

    // sorting
    const first = () => p.evaluate(() => document.querySelector('#po-season-content tbody tr td').innerText.trim());
    const before = await first();
    await p.evaluate(() => {
      const th = [...document.querySelectorAll('#po-season-content th[onclick]')].find(t => t.textContent.includes('Site'));
      th.click();
    });
    await p.waitForTimeout(700);
    const after = await first();
    ok('sorting reorders', before !== after, `${before} -> ${after}`);

    ok('no JS errors', errs.length === 0, errs.join('; '));
    await p.screenshot({ path: '/tmp/season.png', clip: { x: 0, y: 190, width: 1700, height: 900 } });
    await ctx.close();
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
  finally { await b.close(); sdb.prepare('DELETE FROM sessions WHERE sid=?').run(sid); }
})();
