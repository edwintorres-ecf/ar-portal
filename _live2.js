'use strict';
require('dotenv').config();
const path = require('path'); const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright-core');
const bp = require('./browser-path');
const CHECK = {
  search: '#view-search', reports: '#view-reports', amazon: '#view-amazon',
  activity: '#view-activity', 'comms-triage': '#view-comms-triage',
  'comms-dunning': '#view-comms-dunning', 'comms-statements': '#view-comms-statements',
  'po-funds': '#view-po-funds',
};
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
    await p.waitForTimeout(2500);
    for (const [v, sel] of Object.entries(CHECK)) {
      const before = errs.length;
      await p.evaluate(n => navGo(n), v);
      await p.waitForTimeout(7000);          // let the async renderers finish
      const r = await p.evaluate(s => {
        const el = document.querySelector(s);
        if (!el) return null;
        return { chars: el.innerText.trim().length,
                 tables: el.querySelectorAll('table').length,
                 inputs: el.querySelectorAll('input,select,button').length,
                 loading: /Loading|…/.test(el.innerText) };
      }, sel);
      const e2 = errs.slice(before);
      console.log(`  ${v.padEnd(18)} ${String(r.chars).padStart(7)} chars · ${r.tables} tables · ${r.inputs} controls${r.loading ? ' · STILL LOADING' : ''}${e2.length ? '  ERR ' + e2.join('; ') : ''}`);
    }
    console.log('\ntotal JS errors:', errs.length ? errs.join(' | ') : 0);
    await ctx.close();
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
  finally { await b.close(); sdb.prepare('DELETE FROM sessions WHERE sid=?').run(sid); }
})();
