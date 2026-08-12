'use strict';
// ─── comms-inbound.js — shared-mailbox ingestion + reply routing ─────────────
// Polls invoices@ (inbox + sent items) every 2 minutes via Graph DELTA queries
// and routes each new message into the canonical conversations/messages store.
//
// Routing precedence (2026-08-11 plan, adapted from the design doc):
//   1. Mailbox ownership — only AR_MAILBOX is polled.
//   2. RFC threading — In-Reply-To/References matched to a known
//      internet_message_id, plus Exchange conversationId matched to
//      conversations.graph_conversation_id (survives header mangling).
//   3. Signed subject token [ECF#...] — HMAC-verified; forgeries fail closed
//      and are audited (comm_token_invalid).
//   4. Sender-compatibility validation on any match; incompatible → triage.
//   5. No match: sender uniquely identifies ONE customer's contact → new
//      auto-filed conversation; ambiguous or unknown → TRIAGE. Never guess.
//
// Mailbox hygiene: the poller NEVER moves messages and NEVER marks them read
// (humans may be working the same mailbox in Outlook). It only applies Outlook
// categories AR/Filed and AR/Triage so Outlook users can see portal state.
// Sent-items ingestion captures replies humans send from invoices@ in Outlook
// (actor_type 'mailbox_user') so the canonical timeline stays complete.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');
const graph = require('./graph');
const comms = require('./comms-service');

const POLL_LOOKBACK_HOURS = parseInt(process.env.COMMS_INBOUND_LOOKBACK_HOURS || '24', 10);
const SELECT = 'id,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,conversationId,internetMessageId,hasAttachments,body,categories';

let _pollActive = false;

function internalDomain(email) {
  return graph.normEmail(email).endsWith('@eastcoastfacilities.com');
}

// ─── Delta plumbing ──────────────────────────────────────────────────────────
async function deltaPage(folder, stateKey) {
  const mb = graph.mailbox();
  let url = db.getCommState(stateKey);
  if (!url) {
    const since = new Date(Date.now() - POLL_LOOKBACK_HOURS * 3600 * 1000).toISOString();
    url = `/users/${mb}/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=receivedDateTime ge ${since}`;
  }
  const out = [];
  // Walk nextLinks in one poll; persist the deltaLink for the next poll.
  for (let hop = 0; hop < 20; hop++) {
    const page = await graph.gGet(url, { Prefer: 'odata.maxpagesize=50' });
    out.push(...(page.value || []));
    if (page['@odata.nextLink']) { url = page['@odata.nextLink']; continue; }
    if (page['@odata.deltaLink']) { db.setCommState(stateKey, page['@odata.deltaLink']); }
    break;
  }
  return out;
}

// Fetch RFC In-Reply-To / References for one message (headers are not
// available through the delta $select; single-message GET only).
async function fetchRfcRefs(graphMessageId) {
  const mb = graph.mailbox();
  try {
    const m = await graph.gGet(`/users/${mb}/messages/${encodeURIComponent(graphMessageId)}?$select=internetMessageHeaders`);
    const h = {};
    for (const row of (m.internetMessageHeaders || [])) h[row.name.toLowerCase()] = row.value;
    return { inReplyTo: h['in-reply-to'] || null, references: h['references'] || null };
  } catch (e) {
    return { inReplyTo: null, references: null };
  }
}

async function applyCategory(graphMessageId, existing, label) {
  const mb = graph.mailbox();
  const cats = new Set(existing || []);
  if (cats.has(label)) return;
  cats.add(label);
  await graph.gPatch(`/users/${mb}/messages/${encodeURIComponent(graphMessageId)}`, { categories: [...cats] }).catch(() => {});
}

// ─── Conversation matching ───────────────────────────────────────────────────
function matchConversation(m, rfc) {
  // 2a. RFC In-Reply-To / References → a message we sent
  for (const ref of [rfc.inReplyTo, rfc.references]) {
    if (!ref) continue;
    for (const imid of ref.match(/<[^>]+>/g) || []) {
      const prior = db.getMessageByInternetMessageId(imid);
      if (prior) return { conv: db.getConversation(prior.conversation_id), via: 'rfc' };
    }
  }
  // 2b. Exchange conversationId
  if (m.conversationId) {
    const conv = db.getConversationByGraphId(m.conversationId);
    if (conv) return { conv, via: 'graph-conv' };
  }
  // 3. Signed subject token
  const tok = (m.subject || '').match(comms.TOKEN_RE);
  if (tok) {
    const convId = comms.verifyToken(tok[1]);
    if (convId) {
      const conv = db.getConversation(convId);
      if (conv) return { conv, via: 'token' };
    } else {
      db.auditLog('comms-inbound', 'comm_token_invalid', null,
        `"${(m.subject || '').slice(0, 80)}" from ${graph.normEmail(m.from?.emailAddress?.address)}`);
    }
  }
  return { conv: null, via: null };
}

// 4. Compatibility: an inbound sender may join a matched conversation only if
// they are a contact of its customer, internal, or already on the thread.
function senderCompatible(conv, senderEmail) {
  if (internalDomain(senderEmail)) return true;
  if (conv.customer_id) {
    const contacts = db.listCustomerContacts(conv.customer_id, true);
    if (contacts.some(c => c.email === senderEmail)) return true;
  }
  for (const prior of db.getMessagesForConversation(conv.id)) {
    try {
      const all = [...JSON.parse(prior.to_emails || '[]'), ...JSON.parse(prior.cc_emails || '[]'), prior.from_email];
      if (all.map(graph.normEmail).includes(senderEmail)) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

// 5. Unmatched: unique-contact auto-file, else triage.
function customerForSender(senderEmail) {
  const rows = db.all('SELECT DISTINCT customer_id FROM customer_contacts WHERE email=? AND is_active=1', [senderEmail]);
  return rows.length === 1 ? rows[0].customer_id : null;
}

function insertInbound(conv, m, { direction, actorType, actorEmail }) {
  const to = (m.toRecipients || []).map(r => graph.normEmail(r.emailAddress?.address)).filter(Boolean);
  const cc = (m.ccRecipients || []).map(r => graph.normEmail(r.emailAddress?.address)).filter(Boolean);
  return db.insertMessage({
    conversation_id: conv.id,
    direction,
    actor_type: actorType,
    actor_email: actorEmail || null,
    from_email: graph.normEmail(m.from?.emailAddress?.address) || '',
    to_emails: JSON.stringify(to),
    cc_emails: cc.length ? JSON.stringify(cc) : null,
    subject: m.subject || '',
    body_html: (m.body && m.body.content) || '',
    graph_message_id: m.id,
    internet_message_id: m.internetMessageId || null,
    graph_conversation_id: m.conversationId || null,
    received_at: m.receivedDateTime || null,
    sent_at: m.sentDateTime || null,
    status: direction === 'in' ? 'received' : 'sent',
    has_attachments: m.hasAttachments ? 1 : 0,
  });
}

// ─── One poll pass ───────────────────────────────────────────────────────────
async function runInboundPoll({ notify } = {}) {
  if (_pollActive) return { skipped: 'active' };
  _pollActive = true;
  const stats = { inbox: 0, filed: 0, autoFiled: 0, triage: 0, sentIngested: 0, skipped: 0 };
  try {
    const mb = graph.normEmail(graph.mailbox());

    // ── Inbox ──
    for (const m of await deltaPage('inbox', 'inbound_delta_inbox')) {
      if (!m.id || m['@removed']) continue;
      if (db.getMessageByGraphId(m.id)) { stats.skipped++; continue; }
      // Graph message ids are FOLDER-SCOPED and change when an item moves; the
      // RFC internetMessageId is the immutable identity. Never ingest twice.
      if (m.internetMessageId && db.getMessageByInternetMessageId(m.internetMessageId)) { stats.skipped++; continue; }
      const sender = graph.normEmail(m.from?.emailAddress?.address);
      if (!sender) { stats.skipped++; continue; }
      stats.inbox++;

      const rfc = await fetchRfcRefs(m.id);
      let { conv } = matchConversation(m, rfc);

      if (conv && conv.status !== 'archived' && senderCompatible(conv, sender)) {
        const msg = insertInbound(conv, m, { direction: 'in', actorType: internalDomain(sender) ? 'mailbox_user' : 'external', actorEmail: internalDomain(sender) ? sender : null });
        db.getDb().prepare('UPDATE messages SET in_reply_to=?, references_hdr=? WHERE id=?')
          .run(rfc.inReplyTo, rfc.references ? rfc.references.slice(0, 2000) : null, msg.id);
        db.touchConversation(conv.id, { lastDirection: 'in', status: 'open' });
        db.auditLog('comms-inbound', 'comm_receive', null, `conv=${conv.id} from=${sender} "${(m.subject || '').slice(0, 80)}"`);
        await applyCategory(m.id, m.categories, 'AR/Filed');
        stats.filed++;
        if (notify && conv.assigned_email && conv.assigned_email !== sender) {
          notify(conv.assigned_email, 'replies',
            `[AR Portal] Reply from ${m.from?.emailAddress?.name || sender}`,
            `${m.from?.emailAddress?.name || sender} replied on "${(m.subject || '').slice(0, 100)}".\n\nOpen the AR Mailbox in the portal to view and respond.\n\n(This thread is assigned to you.)`);
        }
        continue;
      }

      // No safe match → auto-file on unique contact, else triage. Never guess.
      const custId = customerForSender(sender);
      const newConv = db.createConversation({
        customerId: custId,
        mailbox: mb,
        subject: m.subject || '(no subject)',
        status: custId ? 'open' : 'triage',
      });
      insertInbound(newConv, m, { direction: 'in', actorType: internalDomain(sender) ? 'mailbox_user' : 'external', actorEmail: internalDomain(sender) ? sender : null });
      db.touchConversation(newConv.id, { lastDirection: 'in', graphConversationId: m.conversationId || null });
      if (custId) {
        db.auditLog('comms-inbound', 'comm_auto_filed', null, `conv=${newConv.id} from=${sender} -> ${custId}`);
        await applyCategory(m.id, m.categories, 'AR/Filed');
        stats.autoFiled++;
      } else {
        db.auditLog('comms-inbound', 'comm_triage', null, `conv=${newConv.id} from=${sender} "${(m.subject || '').slice(0, 80)}"`);
        await applyCategory(m.id, m.categories, 'AR/Triage');
        stats.triage++;
      }
    }

    // ── Sent items: capture Outlook-human sends from the shared mailbox ──
    for (const m of await deltaPage('sentitems', 'inbound_delta_sent')) {
      if (!m.id || m['@removed']) continue;
      if (db.getMessageByGraphId(m.id)) { stats.skipped++; continue; }
      // A portal send is recorded under its DRAFT id, but Exchange moves the
      // item to Sent Items under a NEW id — match on the immutable RFC
      // internetMessageId and refresh our stored graph id to the live one.
      const prior = m.internetMessageId ? db.getMessageByInternetMessageId(m.internetMessageId) : null;
      if (prior) {
        if (prior.graph_message_id !== m.id) {
          try { db.getDb().prepare('UPDATE messages SET graph_message_id=? WHERE id=?').run(m.id, prior.id); } catch (e) { /* unique clash — leave as is */ }
        }
        stats.skipped++; continue;
      }
      // An unrecorded sent item = a human (or another tool) sending as invoices@.
      let conv = m.conversationId ? db.getConversationByGraphId(m.conversationId) : null;
      if (!conv) {
        const tok = (m.subject || '').match(comms.TOKEN_RE);
        if (tok) { const id = comms.verifyToken(tok[1]); conv = id ? db.getConversation(id) : null; }
      }
      if (!conv) {
        // New outbound thread started in Outlook: file it if a recipient
        // uniquely identifies a customer; otherwise leave it out of the store
        // (own sent mail is never triaged).
        const rcpt = (m.toRecipients || []).map(r => graph.normEmail(r.emailAddress?.address)).filter(Boolean);
        const custIds = [...new Set(rcpt.map(customerForSender).filter(Boolean))];
        if (custIds.length !== 1) { stats.skipped++; continue; }
        conv = db.createConversation({ customerId: custIds[0], mailbox: mb, subject: m.subject || '(no subject)', status: 'waiting' });
      }
      insertInbound(conv, m, { direction: 'out', actorType: 'mailbox_user', actorEmail: null });
      db.touchConversation(conv.id, { lastDirection: 'out', graphConversationId: m.conversationId || null });
      db.auditLog('comms-inbound', 'comm_sent_ingested', null, `conv=${conv.id} "${(m.subject || '').slice(0, 80)}"`);
      stats.sentIngested++;
    }

    db.setCommState('inbound_last_poll', new Date().toISOString());
    if (stats.inbox || stats.sentIngested) console.log('[comms-inbound]', JSON.stringify(stats));
    return stats;
  } finally {
    _pollActive = false;
  }
}

module.exports = { runInboundPoll };

if (require.main === module) {
  runInboundPoll().then(s => { console.log('poll:', JSON.stringify(s)); process.exit(0); })
    .catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}
