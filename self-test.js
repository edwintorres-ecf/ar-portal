// ─── Nightly reliability self-test ───────────────────────────────────────────
// Run by systemd timer (ar-selftest.timer). Checks every layer the portal
// depends on; emails the operator ONLY on failure (silence = healthy).
// Everything it verifies has bitten us at least once — see memory notes.
const { execSync } = require('child_process');
const db = require('./db');
const ops = require('./ops-alerts');

const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message.slice(0, 200) });
  }
};
const sh = (cmd) => execSync(cmd, { timeout: 30000 }).toString().trim();

(async () => {
  // 1. Services on spark
  check('ar-portal.service', () => {
    if (sh('systemctl is-active ar-portal.service') !== 'active') throw new Error('not active');
  });
  check('recruit.service', () => {
    if (sh('systemctl is-active recruit.service') !== 'active') throw new Error('not active');
  });
  // 2. OpenClaw node connected (was silently dead for a month once)
  check('openclaw-node', () => {
    if (sh('systemctl --user is-active openclaw-node.service') !== 'active') throw new Error('service not active');
    const recent = sh('journalctl --user -u openclaw-node.service --since "-26 hours" --no-pager | grep -c "gateway connected" || true');
    const errs = sh('journalctl --user -u openclaw-node.service --since "-2 hours" --no-pager | grep -ciE "reconnect paused|AUTH_TOKEN" || true');
    if (parseInt(errs, 10) > 0) throw new Error('auth/reconnect errors in last 2h');
    return `connected events last 26h: ${recent}`;
  });
  // 3. Payee feed freshness (independent re-check of the scraper's invariant)
  check('payee-feed-freshness', () => {
    const fs = require('fs');
    const feed = JSON.parse(fs.readFileSync(__dirname + '/payee-feed.spark.json', 'utf8'));
    const genAge = (Date.now() - Date.parse(feed.generatedAt)) / 3600000;
    if (genAge > 3) throw new Error(`feed generated ${genAge.toFixed(1)}h ago (refresh loop stalled?)`);
    const newest = Math.max(0, ...feed.items.map(i => Date.parse(i['Entry Date']) || 0));
    const entryAge = (Date.now() - newest) / 3600000;
    if (entryAge > 48) throw new Error(`newest entry ${entryAge.toFixed(1)}h old (truncation?)`);
    return `${feed.items.length} items, generated ${genAge.toFixed(1)}h ago, newest entry ${entryAge.toFixed(1)}h`;
  });
  // 4. Invariant health rows: anything red?
  check('ops-health-board', () => {
    const bad = db.getHealth().filter(h => h.status === 'fail');
    if (bad.length) throw new Error(bad.map(b => `${b.check_key}: ${b.detail || ''}`).join(' | ').slice(0, 200));
    return `${db.getHealth().length} checks green/amber`;
  });
  // 5. Transmission reconciliation
  check('edi-reconciliation', () => {
    const poLedger = require('./po-ledger');
    const { exceptions, duplicates } = poLedger.getTransmissionExceptions();
    if (exceptions.length) throw new Error(`${exceptions.length} transmitted invoice(s) missing from Payee past grace: ${exceptions.slice(0, 5).map(x => x.invoiceId).join(', ')}`);
    return duplicates.length ? `no vanished submissions (${duplicates.length} duplicate-send records on watch)` : 'clean';
  });
  // 6. Smoke test (routes + modules + headless render)
  check('smoke-test', () => {
    execSync('node ' + __dirname + '/smoke-test.js', { timeout: 180000 });
  });
  // 7. Disk space
  check('disk-space', () => {
    const pct = parseInt(sh("df --output=pcent / | tail -1").replace('%', ''), 10);
    if (pct > 90) throw new Error(`root filesystem at ${pct}%`);
    return `root ${pct}%`;
  });

  const failed = results.filter(r => !r.ok);
  const lines = results.map(r => `${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(lines.join('\n'));
  db.setHealth('self-test', failed.length ? 'fail' : 'ok', `${results.length - failed.length}/${results.length} passed`, failed.length);

  if (failed.length) {
    await ops.raise('self-test', `Nightly self-test: ${failed.length} check(s) failing`,
      lines.join('\n'), { minIntervalHours: 20 });
    process.exit(1);
  }
  process.exit(0);
})();
