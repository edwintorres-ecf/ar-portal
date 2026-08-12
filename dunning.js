'use strict';
// ─── dunning.js — automated collections reminder engine ──────────────────────
// Two-step, preview-first, idempotent. Encodes the EDI lessons:
//   - ARMED GATE: live sends require DUNNING_ARMED=1 in .env; anything else
//     forces mode='preview'. Arming is Edwin's explicit go-live step.
//   - CONCURRENCY LOCK: one run at a time, in-process flag.
//   - Selection reads the CACHED invoice set only — never a fresh Sage pull
//     mid-run (feed-lag double-send lesson).
//   - Idempotency ledger dunning_sent: an invoice never re-triggers a one-shot
//     rule; repeating rules re-fire only in a new cycle bucket.
//   - HARD EXCLUSIONS, checked at selection AND re-checked before each send:
//     Amazon (EDI collections), stop-service customers, invoices with an open
//     promise to pay, customers with no dunning-approved contact.
//   - Per-customer DIGEST: one email per customer per run, highest-sequence
//     matching rule wins; all surviving invoices ride in {{invoice_table}}.
//   - Cadence: no customer gets two dunning emails within
//     DUNNING_MIN_GAP_DAYS (default 3) regardless of rules.
//   - Every send goes through comms-service sendMessage (actorType
//     'automation') — same From enforcement, allowlist gate, snapshot, audit
//     as human sends. While COMMS_ALLOWLIST is set, even an armed live run
//     can only reach internal inboxes.
//   - Billing streams are SEPARATE (non-negotiable): ECI- = Sage, AST/ASTM/S-
//     = Omnia. A rule scoped to one stream never touches the other.
//   - Skips are RECORDED as actions with skip_reason so "why didn't customer
//     X get an email" is answerable from the console.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');
const sage = require('./sage');
const comms = require('./comms-service');

const AMAZON_CUSTOMERS = new Set(['C-00403', 'C-00566']);
const MIN_GAP_DAYS = parseInt(process.env.DUNNING_MIN_GAP_DAYS || '3', 10);

let _runActive = false;

function armed() { return process.env.DUNNING_ARMED === '1'; }

function streamOf(invoiceId) {
  const id = String(invoiceId || '').toUpperCase();
  if (/^(AST|ASTM|S)-/.test(id)) return 'omnia';
  if (/^ECI-/.test(id)) return 'sage';
  return 'other';
}

function cycleBucket(rule, daysOverdue) {
  if (!rule.repeat_every_days) return null;
  return Math.floor(Math.max(0, daysOverdue - rule.trigger_days_past_due) / rule.repeat_every_days);
}

function idemKey(recordNo, rule, daysOverdue) {
  const cyc = cycleBucket(rule, daysOverdue);
  return cyc == null ? `${recordNo}:${rule.id}` : `${recordNo}:${rule.id}:${cyc}`;
}

function dunningContacts(customerId) {
  return db.listCustomerContacts(customerId)
    .filter(c => c.dunning_enabled && c.consent_email);
}

function lastDunningSentAt(customerId) {
  const row = db.get(`
    SELECT MAX(ds.sent_at) AS last FROM dunning_sent ds
    JOIN dunning_actions da ON da.message_id = ds.message_id
    WHERE da.customer_id = ?
  `, [customerId]);
  return row && row.last ? row.last : null;
}

function withinGap(customerId) {
  const last = lastDunningSentAt(customerId);
  if (!last) return false;
  // sqlite datetime('now') is UTC "YYYY-MM-DD HH:MM:SS"
  const ms = Date.parse(last.replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) && (Date.now() - ms) < MIN_GAP_DAYS * 86400000;
}

// ─── Generate: evaluate rules → preview actions ─────────────────────────────
function generate({ triggeredBy } = {}) {
  if (_runActive) throw new Error('A dunning run is already active');
  _runActive = true;
  try {
    const rules = db.all('SELECT * FROM dunning_rules WHERE active=1 ORDER BY sequence DESC');
    const run = db.createDunningRun('preview', triggeredBy || 'scheduler');
    const stats = { rules: rules.length, eligible: 0, digests: 0, skipped: {} };
    if (!rules.length) {
      db.finishDunningRun(run.id, 'done', JSON.stringify({ ...stats, note: 'no active rules' }));
      return { runId: run.id, ...stats, note: 'no active rules' };
    }

    const invoices = sage.getCachedInvoices();
    if (!invoices.length) throw new Error('Invoice cache is empty — refusing to generate');
    const custAccounts = {};
    for (const a of db.getAllCustomerAccounts()) custAccounts[a.customer_id] = a;
    const invoiceStops = db.getAllInvoiceStopService();
    const openPtp = new Set(db.getAllOpenPtp().map(p => p.record_no));
    const collectors = db.getAllInvoiceCollectors();

    const skip = (customerId, rule, recordNos, reason) => {
      db.insertDunningAction({ run_id: run.id, rule_id: rule ? rule.id : 0, customer_id: customerId, record_nos: JSON.stringify(recordNos), status: 'skipped', skip_reason: reason });
      stats.skipped[reason] = (stats.skipped[reason] || 0) + recordNos.length;
    };

    // Per customer: pick the highest-sequence rule with any matching invoice,
    // then digest every invoice that survives the per-invoice checks.
    const byCustomer = new Map();
    for (const inv of invoices) {
      if (!inv.customerId || inv.totalDue <= 0) continue;
      if (!byCustomer.has(inv.customerId)) byCustomer.set(inv.customerId, []);
      byCustomer.get(inv.customerId).push(inv);
    }

    for (const [customerId, custInvoices] of byCustomer) {
      if (AMAZON_CUSTOMERS.has(customerId)) {
        const anyMatch = custInvoices.some(i => rules.some(r => i.daysOverdue >= r.trigger_days_past_due));
        if (anyMatch) skip(customerId, null, custInvoices.map(i => i.recordNo), 'amazon');
        continue;
      }

      // Highest-sequence rule (rules sorted DESC) with at least one raw match.
      let rule = null, matched = [];
      for (const r of rules) {
        const excl = new Set(JSON.parse(r.exclude_customers || '[]'));
        if (excl.has(customerId)) continue;
        matched = custInvoices.filter(i =>
          i.daysOverdue >= r.trigger_days_past_due &&
          i.totalDue >= (r.min_invoice_balance || 0) &&
          (r.billing_stream === 'all' || streamOf(i.invoiceId) === r.billing_stream));
        if (matched.length) { rule = r; break; }
      }
      if (!rule) continue;

      const acct = custAccounts[customerId];
      if (acct && acct.stop_service) { skip(customerId, rule, matched.map(i => i.recordNo), 'stop_service'); continue; }
      if (withinGap(customerId)) { skip(customerId, rule, matched.map(i => i.recordNo), 'recent_send'); continue; }
      const contacts = dunningContacts(customerId);
      if (!contacts.length) { skip(customerId, rule, matched.map(i => i.recordNo), 'no_contact'); continue; }

      const surviving = [], perInvoiceSkips = { open_ptp: [], idempotent: [], stop_service: [] };
      for (const inv of matched) {
        if (invoiceStops[inv.recordNo]) { perInvoiceSkips.stop_service.push(inv.recordNo); continue; }
        if (openPtp.has(inv.recordNo)) { perInvoiceSkips.open_ptp.push(inv.recordNo); continue; }
        if (db.dunningSentExists(idemKey(inv.recordNo, rule, inv.daysOverdue))) { perInvoiceSkips.idempotent.push(inv.recordNo); continue; }
        surviving.push(inv);
      }
      for (const [reason, rns] of Object.entries(perInvoiceSkips)) {
        if (rns.length) skip(customerId, rule, rns, reason);
      }
      if (!surviving.length) continue;

      // corresponding user: uniform invoice collector, else account owner.
      const colEmails = [...new Set(surviving.map(i => (collectors[i.recordNo] || {}).collector_email).filter(Boolean))];
      const corresponding = colEmails.length === 1 ? colEmails[0]
        : (acct && acct.collector_email) || (acct && acct.owner_email) || null;

      db.insertDunningAction({
        run_id: run.id, rule_id: rule.id, customer_id: customerId,
        record_nos: JSON.stringify(surviving.map(i => i.recordNo)),
        status: 'preview',
      });
      stats.eligible += surviving.length;
      stats.digests++;
      // Stash the corresponding email on comm_state? No — recompute at execute.
      void corresponding;
    }

    db.finishDunningRun(run.id, 'done', JSON.stringify(stats));
    db.auditLog(triggeredBy || 'scheduler', 'dunning_run', null, `run=${run.id} preview: ${stats.digests} digests / ${stats.eligible} invoices, skips=${JSON.stringify(stats.skipped)}`);
    return { runId: run.id, ...stats };
  } finally {
    _runActive = false;
  }
}

// ─── Execute: send approved/preview actions of a run ────────────────────────
async function execute(runId, { actorEmail } = {}) {
  if (_runActive) throw new Error('A dunning run is already active');
  _runActive = true;
  try {
    if (!armed()) throw new Error('DUNNING_ARMED is not set — live dunning sends are disabled. Preview only.');
    const run = db.getDunningRun(runId);
    if (!run) throw new Error('Run not found');
    const actions = db.listDunningActions(runId).filter(a => ['preview', 'approved'].includes(a.status));
    const rules = {};
    for (const r of db.all('SELECT * FROM dunning_rules')) rules[r.id] = r;
    const custAccounts = {};
    for (const a of db.getAllCustomerAccounts()) custAccounts[a.customer_id] = a;
    const collectors = db.getAllInvoiceCollectors();
    const invoices = sage.getCachedInvoices();
    const invByRn = new Map(invoices.map(i => [i.recordNo, i]));

    const result = { sent: 0, failed: 0, reskipped: 0 };
    for (const action of actions) {
      const rule = rules[action.rule_id];
      const recordNos = JSON.parse(action.record_nos || '[]');
      // RE-CHECK every hard exclusion right before the send path.
      if (!rule || AMAZON_CUSTOMERS.has(action.customer_id)) {
        db.updateDunningAction(action.id, { status: 'skipped', skip_reason: 'amazon' }); result.reskipped++; continue;
      }
      const acct = custAccounts[action.customer_id];
      if (acct && acct.stop_service) {
        db.updateDunningAction(action.id, { status: 'skipped', skip_reason: 'stop_service' }); result.reskipped++; continue;
      }
      const contacts = dunningContacts(action.customer_id);
      if (!contacts.length) {
        db.updateDunningAction(action.id, { status: 'skipped', skip_reason: 'no_contact' }); result.reskipped++; continue;
      }
      const openPtp = new Set(db.getAllOpenPtp().map(p => p.record_no));
      const live = recordNos.filter(rn => {
        const inv = invByRn.get(rn);
        return inv && inv.totalDue > 0 && !openPtp.has(rn) && !db.dunningSentExists(idemKey(rn, rule, inv.daysOverdue));
      });
      if (!live.length) {
        db.updateDunningAction(action.id, { status: 'skipped', skip_reason: 'idempotent' }); result.reskipped++; continue;
      }

      const colEmails = [...new Set(live.map(rn => (collectors[rn] || {}).collector_email).filter(Boolean))];
      const corresponding = colEmails.length === 1 ? colEmails[0]
        : (acct && acct.collector_email) || (acct && acct.owner_email) || null;

      try {
        const sent = await comms.sendMessage({
          actorEmail: 'dunning-engine',
          actorType: 'automation',
          correspondingEmail: corresponding,
          customerId: action.customer_id,
          contactId: (contacts.find(c => c.is_primary) || contacts[0]).id,
          toEmails: contacts.map(c => c.email),
          recordNos: live,
          templateKey: rule.template_key,
          dunningActionId: action.id,
        });
        for (const rn of live) {
          const inv = invByRn.get(rn);
          db.recordDunningSent(idemKey(rn, rule, inv.daysOverdue), rn, rule.id, sent.messageId);
        }
        db.updateDunningAction(action.id, { status: 'sent', message_id: sent.messageId });
        db.auditLog(actorEmail || 'dunning-engine', 'dunning_send', live[0],
          `run=${runId} action=${action.id} ${action.customer_id} rule=${rule.name} ${live.length} inv -> msg ${sent.messageId}`);
        result.sent++;
      } catch (e) {
        db.updateDunningAction(action.id, { status: 'failed', skip_reason: String(e.message).slice(0, 120) });
        db.auditLog(actorEmail || 'dunning-engine', 'dunning_send_fail', live[0],
          `run=${runId} action=${action.id} ${action.customer_id}: ${String(e.message).slice(0, 200)}`);
        result.failed++;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    db.auditLog(actorEmail || 'dunning-engine', 'dunning_execute', null, `run=${runId} ${JSON.stringify(result)}`);
    return result;
  } finally {
    _runActive = false;
  }
}

// ─── Seed default rules (INACTIVE — Edwin reviews and activates) ────────────
function seedRules() {
  const existing = db.get('SELECT COUNT(*) AS c FROM dunning_rules');
  if (existing.c > 0) return 0;
  const defaults = [
    { name: 'Reminder 1 (5 days past due)', sequence: 1, trigger: 5, repeat: null, template: 'reminder1' },
    { name: 'Reminder 2 (15 days past due)', sequence: 2, trigger: 15, repeat: null, template: 'reminder2' },
    { name: 'Reminder 3 (30 days past due)', sequence: 3, trigger: 30, repeat: null, template: 'reminder3' },
    { name: 'Continuous (45+ days, every 14)', sequence: 4, trigger: 45, repeat: 14, template: 'continuous' },
  ];
  for (const r of defaults) {
    db.upsertDunningRule(null, { name: r.name, active: 0, sequence: r.sequence, trigger_days_past_due: r.trigger, repeat_every_days: r.repeat, template_key: r.template, billing_stream: 'all', min_invoice_balance: 50 });
  }
  console.log('[dunning] seeded 4 default rules (inactive)');
  return defaults.length;
}

module.exports = { generate, execute, seedRules, armed, AMAZON_CUSTOMERS, streamOf, idemKey, cycleBucket };
