// ─── Post-deploy smoke test ──────────────────────────────────────────────────
// Run after every deploy (deploy.sh) and nightly (self-test). Exit 0 = pass.
// Three layers:
//   1. Service + route contract: portal answers, protected APIs are gated.
//   2. Module load: every backend module requires cleanly under this Node.
//   3. Headless render: the SPA boots with stubbed APIs and zero JS errors.
const { execSync } = require('child_process');

const BASE = process.env.SMOKE_BASE || 'https://localhost:3600';
let failures = [];
const ok = (name) => console.log('  ✓', name);
const fail = (name, why) => { failures.push(name + ': ' + why); console.log('  ✗', name, '—', why); };

async function code(method, path) {
  try {
    const res = await fetch(BASE + path, { method, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    return res.status;
  } catch (e) { return 'ERR:' + e.message.slice(0, 40); }
}

(async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed local cert

  console.log('[1/3] route contract');
  const routes = [
    ['GET', '/', [200, 302]],                          // page serves (or SSO redirect)
    ['GET', '/api/invoices', [401]],                   // gated
    ['GET', '/api/po/exceptions', [401]],
    ['GET', '/api/health/data', [401]],
    ['GET', '/api/po/pending-by-site.xlsx', [401]],
    ['POST', '/api/po/edi/transmit', [401]],
    ['POST', '/api/admin/impersonate/x', [401]],
  ];
  for (const [m, p, want] of routes) {
    const c = await code(m, p);
    if (want.includes(c)) ok(`${m} ${p} -> ${c}`);
    else fail(`${m} ${p}`, `got ${c}, want ${want.join('/')}`);
  }

  console.log('[2/3] module load');
  for (const mod of ['./db', './payee', './payee-scraper', './po-ledger', './po-doc-watcher', './ai', './ops-alerts', './edi-bridge', './sage']) {
    try { require(mod); ok(mod); } catch (e) { fail(mod, e.message.slice(0, 80)); }
  }

  console.log('[3/3] headless render');
  try {
    const out = execSync('node ' + __dirname + '/smoke-render.js', { timeout: 90000 }).toString();
    if (/RENDER OK/.test(out) && /JS ERRORS: none/.test(out)) ok('SPA renders, zero JS errors');
    else fail('headless render', out.slice(-200));
  } catch (e) {
    fail('headless render', (e.stdout ? e.stdout.toString() : e.message).slice(-200));
  }

  console.log(failures.length ? `\nSMOKE FAIL (${failures.length})` : '\nSMOKE PASS');
  process.exit(failures.length ? 1 : 0);
})();
