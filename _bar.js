'use strict';
require('dotenv').config();
const path = require('path'); const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright-core');
const bp = require('./browser-path');
const ok = (l, c, x) => console.log(`${c ? '  ✓' : '  ✗'} ${l}${x !== undefined ? ' : ' + x : ''}`);
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
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('https://localhost:3600/', { waitUntil: 'networkidle', timeout: 60000 });
    await p.evaluate(() => navGo('po-funds'));
    await p.waitForSelector('#po-funds-freshness .pofresh-health', { timeout: 40000 });
    await p.waitForTimeout(600);

    const m = await p.evaluate(() => {
      const el = document.getElementById('po-funds-freshness');
      const r = el.getBoundingClientRect();
      const pill = el.querySelector('.pofresh-health');
      const stamps = [...el.querySelectorAll('.pofresh-stamp')];
      return {
        height: Math.round(r.height),
        lines: Math.round(r.height / parseFloat(getComputedStyle(el).lineHeight || 18)),
        dots: el.querySelectorAll('span[style*="border-radius:50%"]').length,
        stamps: stamps.length,
        stampTops: [...new Set(stamps.map(s => Math.round(s.getBoundingClientRect().top)))].length,
        pill: pill.textContent.trim(),
        pillClass: pill.className,
        detailOpen: !document.getElementById('po-health-detail').hidden,
      };
    });
    ok('no loose dots left in the strip', m.dots === 0, String(m.dots));
    ok('all four stamps on ONE line', m.stampTops === 1, `${m.stamps} stamps across ${m.stampTops} line(s)`);
    ok('strip is a single row when collapsed', m.height <= 46, m.height + 'px tall');
    ok('health pill NAMES what is broken', /failing:/.test(m.pill) || /all \d+ checks OK/.test(m.pill), m.pill);
    ok('pill is coloured by severity', /is-(fail|warn|ok)/.test(m.pillClass), m.pillClass);
    ok('detail starts collapsed', m.detailOpen === false);

    await p.evaluate(() => poHealthToggle());
    await p.waitForTimeout(400);
    const o = await p.evaluate(() => {
      const el = document.getElementById('po-health-detail');
      const rows = [...el.querySelectorAll('.pohealth-row')];
      return {
        open: !el.hidden, rows: rows.length,
        failFirst: rows.slice(0, 2).every(r => r.classList.contains('is-fail')),
        named: rows.slice(0, 2).map(r => r.querySelector('.pohealth-key').textContent.trim()),
        hasDetail: rows.filter(r => r.querySelector('.pohealth-detail').textContent.trim()).length,
        expanded: document.querySelector('.pofresh-health').getAttribute('aria-expanded'),
      };
    });
    ok('detail expands', o.open === true, `${o.rows} checks listed`);
    ok('FAILING CHECKS SORT FIRST', o.failFirst, o.named.join(', '));
    ok('each row carries its detail', o.hasDetail >= o.rows - 2, `${o.hasDetail}/${o.rows}`);
    ok('aria-expanded tracks the state', o.expanded === 'true', o.expanded);

    await p.screenshot({ path: '/tmp/bar-open.png', clip: { x: 0, y: 60, width: 1600, height: 330 } });
    await p.evaluate(() => poHealthToggle());
    await p.waitForTimeout(300);
    ok('collapses again', await p.evaluate(() => document.getElementById('po-health-detail').hidden));
    await p.screenshot({ path: '/tmp/bar-closed.png', clip: { x: 0, y: 60, width: 1600, height: 200 } });
    ok('no JS errors', errs.length === 0, errs.join('; '));
    await ctx.close();
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
  finally { await b.close(); sdb.prepare('DELETE FROM sessions WHERE sid=?').run(sid); }
})();
