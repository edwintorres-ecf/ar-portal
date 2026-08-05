// ─── Ops alerts ──────────────────────────────────────────────────────────────
// Reliability alerting for the AR Portal's data pipelines. Sends throttled
// email to the operator when an invariant breaks, and records every check's
// state in ops_health for the UI health strip and the nightly self-test.
//
// Design rules (learned from 2026-07 incidents):
//  - Alerts NEVER throw into the caller — a broken mailer must not break a scrape.
//  - Every alert key is throttled (default 6h) so a flapping check can't spam.
//  - Every alert also lands in ops_health, so the UI shows red even if email fails.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const OPS_ALERT_TO = process.env.OPS_ALERT_TO || 'edwin.torres@eastcoastfacilities.com';
const OPS_ALERT_FROM = process.env.OPS_ALERT_FROM || 'arclerk@eastcoastfacilities.com';

let _token = null, _tokenExp = 0;
async function getToken() {
  if (_token && Date.now() < _tokenExp - 60000) return _token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Graph token error');
  _token = data.access_token; _tokenExp = Date.now() + data.expires_in * 1000;
  return _token;
}

async function sendMail(subject, text) {
  const token = await getToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${OPS_ALERT_FROM}/sendMail`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'Text', content: text },
        toRecipients: [{ emailAddress: { address: OPS_ALERT_TO } }],
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) throw new Error('sendMail ' + res.status);
}

/**
 * Record a failing check and (throttled) email the operator.
 * key       — stable identifier, e.g. 'payee-feed-stale'
 * subject   — email subject (prefixed automatically)
 * detail    — human-readable body / health detail
 * opts.minIntervalHours — throttle window (default 6)
 * opts.status — health status to record (default 'fail')
 */
async function raise(key, subject, detail, opts = {}) {
  try { db.setHealth(key, opts.status || 'fail', String(detail).slice(0, 500), opts.metric); } catch (e) {}
  try {
    if (!db.shouldAlert(key, opts.minIntervalHours ?? 6)) {
      console.warn(`[ops-alert] ${key}: ${subject} (throttled, no email)`);
      return;
    }
    await sendMail(`[AR Portal ALERT] ${subject}`,
      `${detail}\n\nCheck key: ${key}\nTime: ${new Date().toISOString()}\n\n—AR Portal reliability monitor`);
    console.warn(`[ops-alert] ${key}: emailed ${OPS_ALERT_TO}`);
  } catch (e) {
    console.error(`[ops-alert] ${key}: email failed (${e.message}) — health row still recorded`);
  }
}

/** Record a passing check (clears the red in the UI; no email). */
function ok(key, detail, metric) {
  try { db.setHealth(key, 'ok', detail ? String(detail).slice(0, 500) : null, metric); } catch (e) {}
}

module.exports = { raise, ok, sendMail };
