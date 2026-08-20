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
    if (entryAge > 48) {
      // Old newest-entry only signals truncation if something was actually
      // transmitted recently and should have appeared. Quiet business days
      // (no transmits) are normal, not a scrape failure (false alarm 2026-08-19).
      const recentTx = db.get("SELECT COUNT(*) AS c FROM audit_log WHERE action='edi_transmit' AND detail LIKE '%-> OK%' AND created_at > datetime('now','-48 hours')").c;
      if (recentTx > 0) throw new Error(`newest entry ${entryAge.toFixed(1)}h old with ${recentTx} OK transmit(s) in 48h (truncation?)`);
      return `${feed.items.length} items, generated ${genAge.toFixed(1)}h ago, newest entry ${entryAge.toFixed(1)}h (quiet — no transmits in 48h)`;
    }
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
  // 5a. Tailnet + iMac health: spark vouches for the standby/transmitter box.
  // The 2026-08-19 tailscale logout broke replication, bridges, and the
  // watchdog's spark-direct check for days with zero alerts — never again.
  check('tailnet-imac', () => {
    const IMAC = 'openclaw@easts-imac-pro.taildac2b4.ts.net';
    const KEY = '/home/ecf-admin/.ssh/id_ed25519_dispatch';
    let out;
    try {
      out = execSync(`ssh -i ${KEY} -o BatchMode=yes -o ConnectTimeout=10 ${IMAC} 'echo ok; date +%s; cat /Users/openclaw/ar-failover/last-sync 2>/dev/null || echo 0; cat /Users/openclaw/recruit-failover/last-sync 2>/dev/null || echo 0; curl -s -o /dev/null -m 3 -w %{http_code} http://127.0.0.1:7788/ 2>/dev/null || echo 000'`,
        { timeout: 30000, encoding: 'utf8' }).trim().split('\n');
    } catch (e) {
      throw new Error('iMac unreachable over tailnet (logout/expiry/offline?) — replication, EDI + Velocity bridges, and failover safety checks are all degraded');
    }
    const nowS = parseInt(out[1], 10);
    const arSync = parseInt(out[2], 10) || 0;
    const recSync = parseInt(out[3], 10) || 0;
    const daemon = (out[4] || '').trim();
    const arAgeMin = arSync ? Math.round((nowS - arSync) / 60) : -1;
    const recAgeMin = recSync ? Math.round((nowS - recSync) / 60) : -1;
    const probs = [];
    if (arAgeMin < 0 || arAgeMin > 30) probs.push(`AR replica sync ${arAgeMin < 0 ? 'never ran' : arAgeMin + 'm stale'}`);
    if (recAgeMin < 0 || recAgeMin > 30) probs.push(`recruit replica sync ${recAgeMin < 0 ? 'never ran' : recAgeMin + 'm stale'}`);
    if (probs.length) throw new Error(probs.join('; '));
    return `tailnet ok, AR sync ${arAgeMin}m, recruit sync ${recAgeMin}m, browser daemon ${daemon === '000' ? 'DOWN (velocity uploads blocked)' : 'up'}`;
  });
  // 5b. PO consumption reconciliation: ledger vs Amazon implied consumed
  check('po-consumption-recon', () => {
    const poLedger = require('./po-ledger');
    const r = poLedger.getConsumptionRecon();
    const drift = r.autoFixable.filter(x => Math.abs(x.gap || 0) > 500);
    const openReviews = db.get("SELECT COUNT(*) AS c FROM po_consumption_review WHERE resolved_at IS NULL").c;
    if (drift.length > 5) throw new Error(`${drift.length} POs drifted >$500 below Amazon implied consumed — run consumption-backfill`);
    return `${r.ok.length} reconciled, ${r.overdrawn.length} over-drawn, ${r.overLedger.length} over-ledger, ${openReviews} open reviews`;
  });
  // 6. Comms platform: inbound poller alive, no failed sends, dunning clean
  check('comms-platform', () => {
    if (!process.env.AR_MAILBOX) return 'AR_MAILBOX unset — comms checks skipped';
    const last = db.getCommState('inbound_last_poll');
    if (!last) throw new Error('inbound poller has never run');
    const ageMin = (Date.now() - Date.parse(last)) / 60000;
    if (ageMin > 30) throw new Error(`inbound poll ${ageMin.toFixed(0)}m ago (poller wedged?)`);
    const failed = db.get("SELECT COUNT(*) AS c FROM messages WHERE status='failed' AND created_at > datetime('now','-24 hours')").c;
    if (failed) throw new Error(`${failed} failed outbound message(s) in 24h`);
    const badRuns = db.get("SELECT COUNT(*) AS c FROM dunning_runs WHERE (status='running' AND started_at < datetime('now','-2 hours')) OR (error IS NOT NULL AND started_at > datetime('now','-24 hours'))").c;
    if (badRuns) throw new Error(`${badRuns} stuck/errored dunning run(s)`);
    const triage = db.get("SELECT COUNT(*) AS c FROM conversations WHERE status='triage'").c;
    return `poll ${ageMin.toFixed(0)}m ago, 0 failed sends, dunning clean${triage ? `, ${triage} in triage` : ''}`;
  });
  // 7. Smoke test (routes + modules + headless render)
  check('smoke-test', () => {
    execSync('node ' + __dirname + '/smoke-test.js', { timeout: 180000 });
  });
  // 8. Disk space
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
