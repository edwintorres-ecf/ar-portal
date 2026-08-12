'use strict';
// ─── statements.js — scheduled statement delivery ────────────────────────────
// Per-customer OPT-IN schedules (statement_schedules): on/after day N each
// month, email the customer's statement (PDF attached, statement template,
// all open invoices tagged) through the same comms-service every other send
// uses. Safety model mirrors dunning:
//   - STATEMENTS_ARMED=1 required for live sends; unarmed runs log would-sends.
//   - COMMS_ALLOWLIST still gates every recipient while set.
//   - One send per customer per month (last_sent_period), Amazon hard-excluded,
//     zero/low balances skipped, consent respected by the service.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');
const sage = require('./sage');
const comms = require('./comms-service');
const { AMAZON_CUSTOMERS } = require('./dunning');

let _runActive = false;

function armed() { return process.env.STATEMENTS_ARMED === '1'; }

function etNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

// One pass over all schedules. Returns per-customer outcomes. `force` ignores
// the day-of-month check (manual "run now"), never the per-month idempotency.
async function runStatementSchedules({ triggeredBy, force } = {}) {
  if (_runActive) return { skipped: 'active' };
  _runActive = true;
  try {
    const now = etNow();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const invoices = sage.getCachedInvoices();
    if (!invoices.length) throw new Error('Invoice cache is empty — refusing to run');
    const custAccounts = {};
    for (const a of db.getAllCustomerAccounts()) custAccounts[a.customer_id] = a;

    const results = [];
    for (const s of db.listStatementSchedules()) {
      const out = { customerId: s.customer_id, status: 'skipped', reason: null };
      results.push(out);
      if (!s.enabled) { out.reason = 'disabled'; continue; }
      if (s.last_sent_period === period) { out.reason = 'already_sent_this_month'; continue; }
      if (!force && now.getDate() < s.day_of_month) { out.reason = 'not_due_yet'; continue; }
      if (AMAZON_CUSTOMERS.has(s.customer_id)) { out.reason = 'amazon'; continue; }

      const custInvoices = invoices.filter(i => i.customerId === s.customer_id && i.totalDue > 0);
      const totalDue = custInvoices.reduce((t, i) => t + i.totalDue, 0);
      if (totalDue < (s.min_balance ?? 0.01)) { out.reason = 'below_min_balance'; continue; }

      const contacts = db.listCustomerContacts(s.customer_id).filter(c => c.consent_email);
      let recipients;
      if (s.contact_ids) {
        const ids = new Set(JSON.parse(s.contact_ids));
        recipients = contacts.filter(c => ids.has(c.id));
      } else {
        const primary = contacts.find(c => c.is_primary) || contacts[0];
        recipients = primary ? [primary] : [];
      }
      if (!recipients.length) { out.reason = 'no_contact'; continue; }

      if (!armed()) {
        out.status = 'would_send';
        out.reason = `${recipients.length} recipient(s), $${Math.round(totalDue).toLocaleString()} due — STATEMENTS_ARMED not set`;
        continue;
      }

      const acct = custAccounts[s.customer_id];
      try {
        const sent = await comms.sendMessage({
          actorEmail: 'statement-engine',
          actorType: 'automation',
          correspondingEmail: (acct && (acct.collector_email || acct.owner_email)) || null,
          customerId: s.customer_id,
          contactId: recipients[0].id,
          toEmails: recipients.map(c => c.email),
          recordNos: custInvoices.map(i => i.recordNo),
          templateKey: 'statement',
          attachStatement: true,
        });
        db.setStatementSent(s.customer_id, period);
        db.auditLog(triggeredBy || 'statement-engine', 'statement_sent', custInvoices[0]?.recordNo || null,
          `${s.customer_id} period=${period} msg=${sent.messageId} to=${recipients.map(c => c.email).join(',')}`);
        out.status = 'sent';
        out.reason = `msg ${sent.messageId}`;
      } catch (e) {
        db.auditLog(triggeredBy || 'statement-engine', 'statement_send_fail', null,
          `${s.customer_id}: ${String(e.message).slice(0, 200)}`);
        out.status = 'failed';
        out.reason = String(e.message).slice(0, 160);
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    const summary = {
      period,
      sent: results.filter(r => r.status === 'sent').length,
      wouldSend: results.filter(r => r.status === 'would_send').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      results,
    };
    if (summary.sent || summary.wouldSend || summary.failed) {
      db.auditLog(triggeredBy || 'statement-engine', 'statement_run', null,
        JSON.stringify({ period, sent: summary.sent, wouldSend: summary.wouldSend, failed: summary.failed, skipped: summary.skipped }));
    }
    return summary;
  } finally {
    _runActive = false;
  }
}

module.exports = { runStatementSchedules, armed };
