'use strict';
// ─── ar-recon-walkthrough.js — READ-ONLY UI inspection of the temporary
// AR reconciliation platform (Laravel app on DO droplet), for the emulation
// map. Discipline: the ONLY form ever submitted is the login form. Navigation
// is GET-only via link hrefs. Links whose text/href smells mutating (logout,
// delete, import, run, send, approve, generate, export) are RECORDED, never
// visited. Screenshots + DOM inventory land in /tmp/ar-recon/.

const fs = require('fs');
const { chromium } = require('playwright-core');

const BASE = 'https://ar-reconciliation.eastcoastfacilities.com';
const EMAIL = process.argv[2];
const PASSWORD = process.argv[3];
const OUT = '/tmp/ar-recon';
const SKIP_RE = /logout|log-out|delete|destroy|remove|import|upload|run|execute|send|approve|generate|export|download|create|new|edit|\.csv|\.xlsx|\.pdf/i;
const MAX_PAGES = 25;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  // ── Login (the one permitted POST) ──
  await page.goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
    page.click('button[type=submit]'),
  ]);
  await page.waitForTimeout(1500);
  if (page.url().includes('/login')) {
    const err = await page.evaluate(() => document.body.innerText.slice(0, 400));
    console.error('LOGIN FAILED — still on /login. Page says:', err.replace(/\s+/g, ' ').slice(0, 250));
    await browser.close();
    process.exit(2);
  }
  console.log('logged in, landed on:', page.url());

  const inventory = [];
  const visited = new Set();
  const queue = [page.url()];
  const skipped = new Set();

  const harvest = async (url, idx) => {
    const info = await page.evaluate(() => {
      const txt = (el) => (el.innerText || '').trim().replace(/\s+/g, ' ');
      const tables = [...document.querySelectorAll('table')].map(t => ({
        headers: [...t.querySelectorAll('thead th, tr:first-child th')].map(th => txt(th)).filter(Boolean),
        rows: t.querySelectorAll('tbody tr').length,
      })).filter(t => t.headers.length);
      return {
        title: document.title,
        h1: [...document.querySelectorAll('h1,h2')].slice(0, 4).map(txt).filter(Boolean),
        navLinks: [...document.querySelectorAll('nav a, aside a, header a, .sidebar a, [class*=nav] a, [class*=menu] a')]
          .map(a => ({ text: txt(a), href: a.getAttribute('href') })).filter(l => l.text && l.href),
        allLinks: [...document.querySelectorAll('a[href]')].map(a => ({ text: txt(a).slice(0, 60), href: a.getAttribute('href') })),
        buttons: [...new Set([...document.querySelectorAll('button, input[type=submit], [role=button], a.btn, [class*=button]')]
          .map(txt).filter(t => t && t.length < 50))],
        selects: [...document.querySelectorAll('select')].map(s => ({
          name: s.name || s.id,
          options: [...s.options].slice(0, 15).map(o => o.text.trim()),
        })),
        inputs: [...document.querySelectorAll('input:not([type=hidden])')].map(i => ({ name: i.name || i.id, type: i.type, placeholder: i.placeholder || '' })),
        badges: [...new Set([...document.querySelectorAll('[class*=badge], [class*=chip], [class*=status], [class*=tag], [class*=pill]')]
          .map(txt).filter(t => t && t.length < 30))].slice(0, 30),
        tables,
        bodyPreviewText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
      };
    });
    const slug = url.replace(BASE, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';
    await page.screenshot({ path: `${OUT}/${String(idx).padStart(2, '0')}-${slug.slice(0, 50)}.png`, fullPage: true });
    inventory.push({ url: url.replace(BASE, '') || '/', ...info });
    // Enqueue new same-origin GET links
    for (const l of info.allLinks) {
      if (!l.href) continue;
      let abs;
      try { abs = new URL(l.href, BASE).href; } catch (e) { continue; }
      if (!abs.startsWith(BASE)) continue;
      abs = abs.split('#')[0];
      if (visited.has(abs) || queue.includes(abs)) continue;
      if (SKIP_RE.test(abs) || SKIP_RE.test(l.text)) { skipped.add(`${l.text} -> ${abs.replace(BASE, '')}`); continue; }
      queue.push(abs);
    }
  };

  let idx = 0;
  while (queue.length && visited.size < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
      await page.waitForTimeout(800);
      await harvest(page.url(), idx++);
      console.log('captured:', url.replace(BASE, '') || '/');
    } catch (e) {
      console.log('failed:', url.replace(BASE, ''), '-', e.message.slice(0, 80));
    }
  }

  fs.writeFileSync(`${OUT}/inventory.json`, JSON.stringify({ base: BASE, capturedAt: new Date().toISOString(), pages: inventory, skippedLinks: [...skipped] }, null, 2));
  console.log(`\nDONE: ${inventory.length} pages captured, ${skipped.size} mutating links recorded-not-clicked`);
  console.log('skipped:', [...skipped].join(' | ').slice(0, 800));
  await browser.close();
})().catch(e => { console.error('WALKTHROUGH FAILED:', e.message); process.exit(1); });
