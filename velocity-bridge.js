'use strict';
// ─── velocity-bridge.js — spark → iMac bridge for InterNex Capital (Velocity) ─
// Mirrors edi-bridge.js: the transmitter (velocity-uploader.js, Atlas finance
// workspace) stays on the iMac; the portal ships a range/single CSV over scp
// and invokes `upload --file=<csv>` there. Live sends are gated by
// VELOCITY_TRANSMIT_ARMED in .env (checked in the route, like EDI).

const { execFile } = require('child_process');
const path = require('path');

const SSH_KEY = '/home/ecf-admin/.ssh/id_ed25519_dispatch';
const HOST = 'openclaw@easts-imac-pro.local';
const NODE = '/usr/local/bin/node';
const FIN = '/Users/openclaw/.openclaw/workspace/finance';

function ssh(remoteCmd, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-i', SSH_KEY, '-o', 'ConnectTimeout=10', HOST, remoteCmd],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error((stderr || err.message).slice(0, 400)));
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? err.code : 0 });
      });
  });
}

function scpTo(localPath, remotePath, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile('scp', ['-i', SSH_KEY, '-o', 'ConnectTimeout=10', localPath, `${HOST}:${remotePath}`],
      { timeout: timeoutMs },
      (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).slice(0, 300))) : resolve(true));
  });
}

function scpFrom(remotePath, localPath, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile('scp', ['-i', SSH_KEY, '-o', 'ConnectTimeout=10', `${HOST}:${remotePath}`, localPath],
      { timeout: timeoutMs },
      (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).slice(0, 300))) : resolve(true));
  });
}

async function status() {
  const r = await ssh(`cd ${FIN} && ${NODE} velocity-uploader.js status`);
  return r.stdout.trim();
}

// Ship a portal-built CSV and run the uploader against it. dryRun validates
// transport + CSV without opening the browser flow.
async function transmitFile(localCsvPath, { dryRun = false, account = 'LOC1' } = {}) {
  const remote = `/tmp/velocity-portal-${Date.now()}-${path.basename(localCsvPath)}`;
  await scpTo(localCsvPath, remote);
  const flags = `--file=${remote}${account === 'LOC2' ? ' --account=LOC2' : ''}${dryRun ? ' --dry-run' : ''}`;
  const r = await ssh(`cd ${FIN} && ${NODE} velocity-uploader.js upload ${flags}`, 420000);
  const out = (r.stdout + '\n' + r.stderr).trim();
  const ok = dryRun ? /DRY RUN complete/i.test(out) : /success|uploaded/i.test(out) && !/error|fail/i.test(out.split('\n').slice(-8).join('\n'));
  return { ok, remote, output: out.slice(-2200) };
}

// Pull the Velocity status feed + customer-name map onto spark.
async function syncFeed(destDir) {
  const out = {};
  try { await scpFrom(`${FIN}/velocity-feed.json`, path.join(destDir, 'velocity-feed.spark.json')); out.feed = true; } catch (e) { out.feedError = e.message; }
  try { await scpFrom(`${FIN}/velocity-customer-name-map.json`, path.join(destDir, 'velocity-name-map.spark.json')); out.nameMap = true; } catch (e) { out.nameMapError = e.message; }
  return out;
}

// Browser-mutex state on the iMac (see .velocity-browser.lock in the
// finance workspace) — the portal refuses to start work while it's held.
async function lockState() {
  try {
    const r = await ssh(`cat ${FIN}/.velocity-browser.lock 2>/dev/null || echo none`, 15000);
    const t = r.stdout.trim();
    if (t === 'none' || !t) return { locked: false };
    const j = JSON.parse(t);
    return { locked: true, tool: j.tool, since: new Date(j.startedAt).toISOString() };
  } catch (e) { return { locked: false, error: e.message }; }
}

// Kick a full Velocity scrape on the iMac in the background (respects the
// mutex itself). Returns immediately; completion detected via feed mtime.
async function startScrape() {
  const r = await ssh(`cd ${FIN} && (nohup /usr/local/bin/node velocity-scraper.js scrape > /tmp/velocity-scrape-portal.log 2>&1 & echo started)`, 20000);
  return /started/.test(r.stdout);
}

async function remoteFeedMtime() {
  const r = await ssh(`stat -f %m ${FIN}/velocity-feed.json 2>/dev/null || echo 0`, 15000);
  return parseInt(r.stdout.trim(), 10) || 0;
}

module.exports = { status, transmitFile, syncFeed, lockState, startScrape, remoteFeedMtime };
