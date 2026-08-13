'use strict';
// ─── comms-service.js — the single message-creation service ──────────────────
// EVERY customer-facing email leaves through sendMessage(): human composes
// (Deploy 4 UI) and the dunning engine (Deploy 7) alike. Core rules, from the
// 2026-08-11 communications plan:
//   - From/Reply-To is ALWAYS graph.mailbox() (invoices@). Not a parameter;
//     there is no code path that accepts a caller-supplied From.
//   - Send-time snapshot: the resolved subject/body/recipients/signature/
//     template version are persisted on the messages row and never re-rendered.
//   - Signed reply token [ECF#<base36 id>-<hmac10>] goes in the subject of
//     every new thread; HMAC key COMMS_REPLY_SECRET. Verifiable without a DB
//     hit; forgeries fail closed.
//   - COMMS_ALLOWLIST (env, comma-separated) is the go-live gate: while set,
//     every recipient must be on it or the send is rejected. Edwin clears it
//     to go live. DO NOT bypass.
//   - Draft-then-send (POST /messages then /send) because plain sendMail
//     returns an empty 202 and loses internetMessageId/conversationId, which
//     inbound reply threading needs.

const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const db = require('./db');
const sage = require('./sage');
const graph = require('./graph');

const KNOWN_TOKENS = new Set([
  'customer_name', 'contact_name', 'invoice_id', 'invoice_date', 'due_date',
  'balance', 'days_past_due', 'total_due', 'invoice_count', 'invoice_table',
  'signature', 'sender_name', 'portal_link',
]);

// ─── Reply tokens ────────────────────────────────────────────────────────────
function replySecret() {
  const s = process.env.COMMS_REPLY_SECRET;
  if (!s) throw new Error('COMMS_REPLY_SECRET not set in .env');
  return s;
}

function signToken(convId) {
  const base = Number(convId).toString(36);
  const mac = crypto.createHmac('sha256', replySecret()).update(base).digest('hex').slice(0, 10);
  return `${base}-${mac}`;
}

// Returns the conversation id for a valid token, else null. Constant shape,
// fails closed on any malformed or forged input.
function verifyToken(token) {
  const m = /^([a-z0-9]{1,10})-([0-9a-f]{10})$/.exec(String(token || '').trim().toLowerCase());
  if (!m) return null;
  const id = parseInt(m[1], 36);
  if (!Number.isInteger(id) || id <= 0) return null;
  const expected = crypto.createHmac('sha256', replySecret()).update(m[1]).digest('hex').slice(0, 10);
  const a = Buffer.from(expected), b = Buffer.from(m[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

// Matches the reference token anywhere — legacy bracketed subjects and the
// current body-footer "Ref: ECF#..." form alike.
const TOKEN_RE = /ECF#([a-z0-9]{1,10}-[0-9a-f]{10})/i;

// ─── Allowlist (the go-live gate) ────────────────────────────────────────────
function allowlist() {
  return (process.env.COMMS_ALLOWLIST || '').split(',').map(graph.normEmail).filter(Boolean);
}

// ─── Money / date formatting ─────────────────────────────────────────────────
const fmtMoney = (n) => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'n/a';
const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─── Signature renderer ──────────────────────────────────────────────────────
// Attribution only. correspondingEmail names the human whose signature appears;
// routing never reads it. Automation with no corresponding user signs AR Team.
function renderSignature(correspondingEmail) {
  const u = correspondingEmail ? db.getUserRoleAnyCase(correspondingEmail) : null;
  const lines = [];
  if (u && u.name) {
    lines.push(`<strong>${escHtml(u.name)}</strong>`);
    if (u.job_title) lines.push(escHtml(u.job_title));
  } else {
    lines.push('<strong>AR Team</strong>');
  }
  lines.push('East Coast Facilities Inc.');
  if (u && u.phone) lines.push(escHtml(u.phone));
  lines.push(`<a href="mailto:${graph.mailbox()}">${graph.mailbox()}</a>`);
  return lines.join('<br>');
}

// ─── Facts for token substitution ────────────────────────────────────────────
function buildFacts({ customerId, recordNos, contactName, correspondingEmail }) {
  const invoices = sage.getCachedInvoices();
  const tagged = (recordNos || []).map(rn => invoices.find(i => i.recordNo === rn)).filter(Boolean);
  const first = tagged[0] || null;
  const customerName = first ? first.customerName
    : (invoices.find(i => i.customerId === customerId) || {}).customerName || customerId || '';
  const totalDue = tagged.reduce((s, i) => s + (i.totalDue || 0), 0);
  const u = correspondingEmail ? db.getUserRoleAnyCase(correspondingEmail) : null;

  const invoiceTable = tagged.length ? `
<table style="border-collapse:collapse;width:100%;max-width:640px;font-size:13px">
  <thead><tr>
    <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #1e3a5f">Invoice #</th>
    <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #1e3a5f">Invoice Date</th>
    <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #1e3a5f">Due Date</th>
    <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #1e3a5f">Days Past Due</th>
    <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #1e3a5f">Balance Due</th>
  </tr></thead>
  <tbody>${tagged.map(i => `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${escHtml(i.invoiceId || i.recordNo)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${fmtDate(i.whenCreated)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${fmtDate(i.whenDue || i.dueDate)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${i.daysOverdue > 0 ? i.daysOverdue : 'current'}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${fmtMoney(i.totalDue)}</td>
  </tr>`).join('')}</tbody>
  <tfoot><tr>
    <td colspan="4" style="padding:6px 10px;font-weight:700">Total</td>
    <td style="padding:6px 10px;text-align:right;font-weight:700">${fmtMoney(totalDue)}</td>
  </tr></tfoot>
</table>` : '(no invoices tagged)';

  return {
    customer_name: customerName,
    contact_name: contactName || 'there',
    invoice_id: first ? (first.invoiceId || first.recordNo) : '',
    invoice_date: first ? fmtDate(first.whenCreated) : '',
    due_date: first ? fmtDate(first.whenDue || first.dueDate) : '',
    balance: first ? fmtMoney(first.totalDue) : '',
    days_past_due: first ? String(first.daysOverdue || 0) : '',
    total_due: fmtMoney(totalDue),
    invoice_count: String(tagged.length),
    invoice_table: invoiceTable,
    sender_name: u && u.name ? u.name : 'AR Team',
    portal_link: 'https://ar.eastcoastfacilities.com',
    _tagged: tagged,
  };
}

// ─── Template rendering ──────────────────────────────────────────────────────
// {{token}} substitution. Unknown token = hard error (at preview time, so a
// bad template can never half-send). {{signature}} resolves last.
function renderTemplate(subjectTpl, bodyTpl, facts, signatureHtml) {
  const tokenValues = {};
  const sub = (tpl, allowSignature) => String(tpl || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, raw) => {
    const t = raw.toLowerCase();
    if (t === 'signature') {
      if (!allowSignature) throw new Error('{{signature}} is not valid in a subject line');
      tokenValues.signature = '(rendered)';
      return signatureHtml;
    }
    if (!KNOWN_TOKENS.has(t)) throw new Error(`Unknown template token: {{${t}}}`);
    const v = facts[t];
    if (v === undefined) throw new Error(`Token {{${t}}} could not be resolved`);
    tokenValues[t] = t === 'invoice_table' ? `(${facts.invoice_count} invoices)` : v;
    return v;
  });
  const subject = sub(subjectTpl, false);
  const body = sub(bodyTpl, true);
  return { subject, body, tokenValues };
}

let _logoUri = null;
function ecfLogoUri() {
  if (_logoUri === null) {
    try {
      const fsx = require('fs');
      _logoUri = 'data:image/png;base64,' + fsx.readFileSync(require('path').join(__dirname, 'public', 'ecf-logo.png')).toString('base64');
    } catch (e) { _logoUri = ''; }
  }
  return _logoUri;
}

// ─── Statement HTML (shared with /api/customer-statement) ────────────────────
// autoPrint=true keeps the legacy print-on-open behavior for the route;
// attachments must NOT auto-print.
function buildStatementHtml(customerId, custInvoices, { autoPrint = false } = {}) {
  // OFFICIAL ECF statement format (rebuilt verbatim from the CyrusOne sample
  // Edwin supplied 2026-08-13): logo + green serif STATEMENT, Total Due,
  // Bill To / Remit To (Philadelphia lockbox), five-column invoice table with
  // green header bars, contact footer. Chromium adds "Page X of Y" when
  // rendered via htmlToPdf(html, { pageNumbers: true }).
  const sorted = [...custInvoices].sort((a, b) => (a.whenCreated || '').localeCompare(b.whenCreated || ''));
  const custName = sorted.length ? (sorted[0].customerName || customerId) : customerId;
  const totalDue = sorted.reduce((s2, i) => s2 + i.totalDue, 0);
  const dmy = (d) => {
    const dt = new Date(d);
    return isNaN(dt) ? '' : `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${dt.getFullYear()}`;
  };
  const money = (n) => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Statement - ${escHtml(custName)}</title>
<style>
  body { font-family: Verdana, Geneva, sans-serif; font-size: 11px; color: #000; margin: 0; padding: 26px 30px; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; }
  .hdr img { height: 52px; }
  .doc-title { font-family: Georgia, 'Times New Roman', serif; font-size: 40px; color: #3FAE49; letter-spacing: 1px; }
  .addr { margin-top: 14px; font-size: 11.5px; line-height: 1.45; }
  .totaldue { text-align: right; font-size: 15px; font-weight: bold; margin-top: 10px; }
  .parties { display: flex; justify-content: space-between; margin: 34px 0 26px; font-size: 11.5px; }
  .parties b { font-size: 11.5px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { background: #3FAE49; color: #fff; font-size: 10.5px; font-weight: bold; padding: 6px 8px; border: 1px solid #2d8a37; }
  thead { display: table-header-group; }
  tbody td { padding: 14px 8px; font-size: 11.5px; text-align: center; }
  td.bal { text-align: right; }
  tr { page-break-inside: avoid; }
  .footnote { text-align: center; font-size: 10.5px; margin-top: 26px; }
</style>
</head>
<body>
<div class="hdr">
  <div>
    ${ecfLogoUri() ? `<img src="${ecfLogoUri()}" alt="East Coast Facilities">` : '<div style="font-size:20px;font-weight:bold">East Coast Facilities</div>'}
    <div class="addr">1324 North Sherman Street<br>Allentown, PA 18109</div>
  </div>
  <div style="text-align:right">
    <div class="doc-title">STATEMENT</div>
    <div class="totaldue">Total Due: ${money(totalDue)}</div>
  </div>
</div>

<div class="parties">
  <div><b>Bill To:</b>&nbsp;&nbsp; <b>${escHtml(custName)}</b></div>
  <div style="display:flex;gap:10px"><b>Remit To:</b>
    <span><b>EAST COAST FACILITIES, INC.</b><br>P.O. BOX 823967<br>PHILADELPHIA, PA 19182-3969</span>
  </div>
</div>

<table>
  <thead><tr>
    <th>INVOICE DATE</th><th>DUE DATE</th><th>INVOICE NUMBER</th><th>CUST. REFERENCE #</th><th>INVOICE BALANCE</th>
  </tr></thead>
  <tbody>
    ${sorted.map(inv => `<tr>
      <td>${dmy(inv.whenCreated)}</td>
      <td>${dmy(inv.whenDue)}</td>
      <td>${escHtml(inv.invoiceId || inv.recordNo)}</td>
      <td>${escHtml(inv.poNumber || '')}</td>
      <td class="bal">${money(inv.totalDue)}</td>
    </tr>`).join('')}
  </tbody>
</table>

<div class="footnote">Please contact 844-ECF-CORP if you have any questions regarding this statement.</div>
${autoPrint ? '<script>window.onload = function() { window.print(); }</script>' : ''}
</body>
</html>`;
}

// ─── Recipient guard ─────────────────────────────────────────────────────────
// Dedupe + normalize; block contacts with consent revoked; enforce allowlist.
function resolveRecipients(customerId, toEmails, ccEmails) {
  const to = [...new Set((toEmails || []).map(graph.normEmail).filter(Boolean))];
  const cc = [...new Set((ccEmails || []).map(graph.normEmail).filter(Boolean))].filter(e => !to.includes(e));
  if (!to.length) throw new Error('At least one recipient is required');
  const contacts = customerId ? db.listCustomerContacts(customerId, true) : [];
  for (const e of [...to, ...cc]) {
    const c = contacts.find(x => x.email === e);
    if (c && !c.consent_email) throw new Error(`${e} has email consent turned off for this customer`);
  }
  const allow = allowlist();
  if (allow.length) {
    const outside = [...to, ...cc].filter(e => !allow.includes(e));
    if (outside.length) {
      throw new Error(`TEST MODE: recipient(s) not in COMMS_ALLOWLIST: ${outside.join(', ')}. Clearing the allowlist is the go-live step.`);
    }
  }
  return { to, cc };
}

// ─── Preview ─────────────────────────────────────────────────────────────────
// Fully resolves a message without sending or writing anything.
function previewMessage(opts) {
  const {
    customerId, contactId, toEmails, ccEmails, recordNos,
    templateKey, rawSubject, rawBody, correspondingEmail, conversationId,
  } = opts;
  const { to, cc } = resolveRecipients(customerId, toEmails, ccEmails);
  const contact = contactId ? db.getCustomerContact(contactId) : null;
  const facts = buildFacts({
    customerId, recordNos,
    contactName: contact ? (contact.name || '').split(/\s+/)[0] : null,
    correspondingEmail,
  });
  const signatureHtml = renderSignature(correspondingEmail);
  let subjectTpl = rawSubject, bodyTpl = rawBody, template = null;
  if (templateKey) {
    template = db.getTemplateByKey(templateKey);
    if (!template || !template.version_row) throw new Error(`Template not found: ${templateKey}`);
    subjectTpl = template.version_row.subject;
    bodyTpl = template.version_row.body_html;
  }
  if (!subjectTpl || !bodyTpl) throw new Error('Subject and body are required');
  const rendered = renderTemplate(subjectTpl, bodyTpl, facts, signatureHtml);
  let subjectFinal = rendered.subject;
  if (conversationId) {
    const conv = db.getConversation(conversationId);
    if (!conv) throw new Error('Conversation not found');
    const cleanSubject = String(conv.subject || '').replace(/\s*\[ECF#[^\]]+\]/i, '');
    subjectFinal = /^re:/i.test(cleanSubject) ? cleanSubject : `RE: ${cleanSubject}`;
    // Old conversations may predate tokens (triage-born threads) — mint one
    // lazily so every outbound carries the reference footer.
    if (!conv.subject_token) {
      db.setConversationSubject(conv.id, conv.subject, signToken(conv.id));
      conv = db.getConversation(conv.id);
    }
  } else {
    subjectFinal = `${rendered.subject} [ECF#new]`;
  }
  return {
    from: graph.mailbox(),
    to, cc,
    subject: subjectFinal,
    bodyHtml: rendered.body,
    signatureHtml,
    tokenValues: rendered.tokenValues,
    template: template ? { id: template.id, key: template.key, version: template.current_version } : null,
    taggedInvoices: facts._tagged.map(i => ({ recordNo: i.recordNo, invoiceId: i.invoiceId, totalDue: i.totalDue })),
    testMode: allowlist().length > 0,
  };
}

// ─── Send ────────────────────────────────────────────────────────────────────
async function sendMessage(opts) {
  const {
    actorEmail, actorType, correspondingEmail,
    customerId, contactId, toEmails, ccEmails, recordNos,
    templateKey, rawSubject, rawBody, attachStatement, conversationId,
    dunningActionId, extraAttachments,
  } = opts;
  if (!actorEmail) throw new Error('actorEmail is required');
  if (!['human', 'automation'].includes(actorType)) throw new Error('actorType must be human or automation');

  const mb = graph.mailbox();
  const { to, cc } = resolveRecipients(customerId, toEmails, ccEmails);
  const contact = contactId ? db.getCustomerContact(contactId) : null;
  const facts = buildFacts({
    customerId, recordNos,
    contactName: contact ? (contact.name || '').split(/\s+/)[0] : null,
    correspondingEmail,
  });
  const signatureHtml = renderSignature(correspondingEmail);

  let subjectTpl = rawSubject, bodyTpl = rawBody, template = null;
  if (templateKey) {
    template = db.getTemplateByKey(templateKey);
    if (!template || !template.version_row) throw new Error(`Template not found: ${templateKey}`);
    subjectTpl = template.version_row.subject;
    bodyTpl = template.version_row.body_html;
  }
  if (!subjectTpl || !bodyTpl) throw new Error('Subject and body are required');
  const rendered = renderTemplate(subjectTpl, bodyTpl, facts, signatureHtml);

  // Conversation: reuse (reply) or create (new thread with signed token)
  let conv, subjectFinal;
  if (conversationId) {
    conv = db.getConversation(conversationId);
    if (!conv) throw new Error('Conversation not found');
    if (customerId && conv.customer_id && conv.customer_id !== customerId) {
      throw new Error('Conversation belongs to a different customer');
    }
    const cleanSubject = String(conv.subject || '').replace(/\s*\[ECF#[^\]]+\]/i, '');
    subjectFinal = /^re:/i.test(cleanSubject) ? cleanSubject : `RE: ${cleanSubject}`;
    // Old conversations may predate tokens (triage-born threads) — mint one
    // lazily so every outbound carries the reference footer.
    if (!conv.subject_token) {
      db.setConversationSubject(conv.id, conv.subject, signToken(conv.id));
      conv = db.getConversation(conv.id);
    }
  } else {
    conv = db.createConversation({
      customerId, contactId: contact ? contact.id : null,
      mailbox: mb, assignedEmail: graph.normEmail(actorType === 'human' ? actorEmail : correspondingEmail || ''),
    });
    const token = signToken(conv.id);
    // Subject stays CLEAN — the routing token rides in a small body footer
    // instead (repliers quote the body, so it survives; subjects full of
    // bracket codes read like spam to customers).
    subjectFinal = rendered.subject;
    db.setConversationSubject(conv.id, subjectFinal, token);
    conv = db.getConversation(conv.id);
  }

  // Build the Graph draft. The reference footer is part of the send-time
  // snapshot so the stored body matches what the customer received.
  const refToken = conv.subject_token;
  const bodyFinal = rendered.body + (refToken
    ? `<div style="color:#94a3b8;font-size:11px;margin-top:14px">Ref: ECF#${refToken}</div>`
    : '');
  const draftPayload = {
    subject: subjectFinal,
    body: { contentType: 'HTML', content: bodyFinal },
    toRecipients: to.map(a => ({ emailAddress: { address: a } })),
    ...(cc.length ? { ccRecipients: cc.map(a => ({ emailAddress: { address: a } })) } : {}),
    replyTo: [{ emailAddress: { address: mb } }],
  };
  const attachmentsMeta = [];
  if (attachStatement && customerId) {
    const invoices = sage.getCachedInvoices().filter(i => i.customerId === customerId);
    if (invoices.length) {
      const html = buildStatementHtml(customerId, invoices, { autoPrint: false });
      const pdf = await htmlToPdf(html, { pageNumbers: true });
      const name = `Statement-${customerId}-${new Date().toISOString().slice(0, 10)}.pdf`;
      draftPayload.attachments = [{
        '@odata.type': '#microsoft.graph.fileAttachment',
        name, contentType: 'application/pdf',
        contentBytes: pdf.toString('base64'),
      }];
      attachmentsMeta.push({ name, size: pdf.length, contentType: 'application/pdf' });
    }
  }
  // Caller-supplied binary attachments (e.g. invoice PDFs resolved at the
  // route layer). contentBytes is already base64.
  if (Array.isArray(extraAttachments) && extraAttachments.length) {
    draftPayload.attachments = draftPayload.attachments || [];
    for (const a of extraAttachments) {
      draftPayload.attachments.push({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.name, contentType: a.contentType || 'application/octet-stream',
        contentBytes: a.contentBytes,
      });
      attachmentsMeta.push({ name: a.name, size: a.size || null, contentType: a.contentType || null });
    }
  }

  // Draft-then-send; on failure record a failed message and clean the draft up.
  //
  // Replies use Graph createReply on the LAST message of the thread so
  // Exchange writes real In-Reply-To/References headers and keeps the quoted
  // history — a plain new draft with an "RE:" subject gets a fresh
  // conversationId and does NOT stack in the recipient's mail client
  // (found live 2026-08-12: portal replies arrived as separate emails).
  let draft = null;
  try {
    let anchorPool = [];
    if (conversationId) {
      const prior = db.getMessagesForConversation(conv.id).filter(m => m.graph_message_id);
      // Anchor to the newest message that is IN the thread's canonical
      // Exchange conversation — anchoring to a stray (a pre-fix reply that
      // spawned its own conversationId) would propagate the broken thread.
      const canonical = prior.filter(m => !conv.graph_conversation_id || m.graph_conversation_id === conv.graph_conversation_id);
      anchorPool = (canonical.length ? canonical : prior).slice(-5).reverse();
    }
    if (anchorPool.length) {
      // Graph ids are folder-scoped and die when a message moves (a just-sent
      // reply's draft id is dead until the poller refreshes it) — so walk the
      // pool newest-first, and when an id is stale, resolve the LIVE id via
      // the immutable RFC internetMessageId and retry before moving on. This
      // matters most for a brand-new thread whose only anchor was sent
      // seconds ago (found live 2026-08-12 in the cross-thread test).
      let replyDraft = null;
      for (const anchor of anchorPool) {
        try {
          replyDraft = await graph.gPost(`/users/${mb}/messages/${encodeURIComponent(anchor.graph_message_id)}/createReply`);
          break;
        } catch (e) { /* stale id — try to re-resolve below */ }
        if (anchor.internet_message_id) {
          try {
            // A message sent moments ago is briefly in transit — not yet
            // queryable in Sent Items — so poll for it for a few seconds
            // before falling to an older anchor.
            let liveId = null;
            for (let attempt = 0; attempt < 4 && !liveId; attempt++) {
              if (attempt) await new Promise(r => setTimeout(r, 1500));
              const q = encodeURIComponent(`internetMessageId eq '${anchor.internet_message_id}'`);
              const found = await graph.gGet(`/users/${mb}/messages?$filter=${q}&$select=id&$top=1`);
              liveId = (found.value && found.value[0] && found.value[0].id) || null;
              if (liveId === anchor.graph_message_id) liveId = null;   // same dead id — keep waiting
            }
            if (liveId) {
              try { db.getDb().prepare('UPDATE messages SET graph_message_id=? WHERE id=?').run(liveId, anchor.id); } catch (e2) { /* unique clash */ }
              replyDraft = await graph.gPost(`/users/${mb}/messages/${encodeURIComponent(liveId)}/createReply`);
              break;
            }
          } catch (e) { /* resolution failed — next-older anchor */ }
        }
      }
      if (replyDraft) {
        const full = await graph.gGet(`/users/${mb}/messages/${encodeURIComponent(replyDraft.id)}?$select=id,body,internetMessageId,conversationId`);
        await graph.gPatch(`/users/${mb}/messages/${encodeURIComponent(replyDraft.id)}`, {
          subject: subjectFinal,
          toRecipients: draftPayload.toRecipients,
          ...(draftPayload.ccRecipients ? { ccRecipients: draftPayload.ccRecipients } : {}),
          replyTo: draftPayload.replyTo,
          // Our content on top, Exchange's quoted history preserved below.
          body: { contentType: 'HTML', content: bodyFinal + '<br>' + ((full.body && full.body.content) || '') },
        });
        for (const att of (draftPayload.attachments || [])) {
          await graph.gPost(`/users/${mb}/messages/${encodeURIComponent(replyDraft.id)}/attachments`, att);
        }
        draft = { id: replyDraft.id, internetMessageId: full.internetMessageId, conversationId: full.conversationId };
        await graph.gPost(`/users/${mb}/messages/${encodeURIComponent(replyDraft.id)}/send`);
      }
    }
    if (!draft) {
      draft = await graph.gPost(`/users/${mb}/messages`, draftPayload);
      await graph.gPost(`/users/${mb}/messages/${encodeURIComponent(draft.id)}/send`);
    }
  } catch (e) {
    if (draft && draft.id) {
      await graph.gDelete(`/users/${mb}/messages/${encodeURIComponent(draft.id)}`).catch(() => {});
    }
    db.insertMessage({
      conversation_id: conv.id, direction: 'out', actor_type: actorType,
      actor_email: graph.normEmail(actorEmail), corresponding_email: graph.normEmail(correspondingEmail || ''),
      from_email: mb, to_emails: JSON.stringify(to), cc_emails: cc.length ? JSON.stringify(cc) : null,
      subject: subjectFinal, body_html: bodyFinal,
      template_id: template ? template.id : null, template_version: template ? template.current_version : null,
      token_values: JSON.stringify(rendered.tokenValues), signature_snapshot: signatureHtml,
      status: 'failed', error: String(e.message).slice(0, 500),
      dunning_action_id: dunningActionId || null,
    });
    db.auditLog(graph.normEmail(actorEmail), 'comm_send_fail', (recordNos || [])[0] || null,
      `conv=${conv.id} to=${to.join(',')} : ${String(e.message).slice(0, 200)}`);
    throw e;
  }

  const msg = db.insertMessage({
    conversation_id: conv.id, direction: 'out', actor_type: actorType,
    actor_email: graph.normEmail(actorEmail), corresponding_email: graph.normEmail(correspondingEmail || ''),
    from_email: mb, to_emails: JSON.stringify(to), cc_emails: cc.length ? JSON.stringify(cc) : null,
    subject: subjectFinal, body_html: bodyFinal,
    template_id: template ? template.id : null, template_version: template ? template.current_version : null,
    token_values: JSON.stringify(rendered.tokenValues), signature_snapshot: signatureHtml,
    graph_message_id: draft.id, internet_message_id: draft.internetMessageId || null,
    graph_conversation_id: draft.conversationId || null,
    sent_at: new Date().toISOString(), status: 'sent',
    has_attachments: attachmentsMeta.length ? 1 : 0,
    attachments_json: attachmentsMeta.length ? JSON.stringify(attachmentsMeta) : null,
    dunning_action_id: dunningActionId || null,
  });
  db.tagMessageInvoices(msg.id, recordNos || []);
  db.touchConversation(conv.id, {
    lastDirection: 'out', status: 'waiting',
    graphConversationId: draft.conversationId || null,
  });
  db.auditLog(graph.normEmail(actorEmail), 'comm_send', (recordNos || [])[0] || null,
    `conv=${conv.id} msg=${msg.id} "${subjectFinal.slice(0, 80)}" to=${to.join(',')}${cc.length ? ' cc=' + cc.join(',') : ''}${actorType === 'automation' ? ' [automation]' : ''}`);

  return { messageId: msg.id, conversationId: conv.id, internetMessageId: draft.internetMessageId, subject: subjectFinal };
}

// ─── Seed templates ──────────────────────────────────────────────────────────
// Idempotent: creates v1 only for keys that do not exist yet. All external.
// Copy rules: no em dashes, no filler. {{signature}} is appended by the
// template body, resolved by the service at send time.
const DEFAULT_TEMPLATES = [
  {
    key: 'manual_blank', name: 'Blank message',
    subject: '{{customer_name}}: message from East Coast Facilities',
    body: `<p>Hello {{contact_name}},</p>
<p></p>
<p>{{signature}}</p>`,
  },
  {
    key: 'reminder1', name: 'Reminder 1 (friendly)',
    subject: 'Payment reminder: invoice {{invoice_id}}',
    body: `<p>Hello {{contact_name}},</p>
<p>This is a friendly reminder that invoice <strong>{{invoice_id}}</strong> for <strong>{{balance}}</strong> was due on {{due_date}} and is now {{days_past_due}} days past due.</p>
<p>If payment is already on the way, thank you and please disregard this note. If anything is holding this up, reply to this email and we will get it resolved together.</p>
<p>{{signature}}</p>`,
  },
  {
    key: 'reminder2', name: 'Reminder 2 (firm)',
    subject: 'Second notice: invoice {{invoice_id}} remains unpaid',
    body: `<p>Hello {{contact_name}},</p>
<p>Our records show invoice <strong>{{invoice_id}}</strong> for <strong>{{balance}}</strong> remains unpaid {{days_past_due}} days past its {{due_date}} due date, and we have not received a response to our earlier reminder.</p>
<p>Please arrange payment or reply with an expected payment date. If there is a dispute or a missing document on our side, let us know and we will address it promptly.</p>
<p>{{signature}}</p>`,
  },
  {
    key: 'reminder3', name: 'Reminder 3 (final notice)',
    subject: 'Final notice: invoice {{invoice_id}} requires immediate attention',
    body: `<p>Hello {{contact_name}},</p>
<p>Despite prior notices, invoice <strong>{{invoice_id}}</strong> for <strong>{{balance}}</strong> is now {{days_past_due}} days past due.</p>
<p>Please remit payment within 5 business days or contact us immediately with a payment plan. Continued nonpayment may require us to review service continuation and refer the balance for further collection action.</p>
<p>We would much rather resolve this together. Reply to this email or call and we will work it out.</p>
<p>{{signature}}</p>`,
  },
  {
    key: 'continuous', name: 'Open balance summary',
    subject: 'Open balance summary for {{customer_name}}: {{total_due}}',
    body: `<p>Hello {{contact_name}},</p>
<p>Here is the current summary of open invoices for {{customer_name}}. The total outstanding balance is <strong>{{total_due}}</strong> across {{invoice_count}} invoice(s):</p>
{{invoice_table}}
<p>Please arrange payment for any past-due amounts. If any invoice needs a correction or supporting documentation, reply to this email and we will take care of it.</p>
<p>{{signature}}</p>`,
  },
  {
    key: 'statement', name: 'Statement cover note',
    subject: 'Statement of account: {{customer_name}}',
    body: `<p>Hello {{contact_name}},</p>
<p>Attached is your current statement of account with East Coast Facilities. The total outstanding balance is <strong>{{total_due}}</strong> across {{invoice_count}} open invoice(s):</p>
{{invoice_table}}
<p>If your records differ from ours, reply to this email and we will reconcile the difference.</p>
<p>{{signature}}</p>`,
  },
];

function extractTokens(subject, body) {
  const found = new Set();
  for (const m of `${subject}\n${body}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)) {
    const t = m[1].toLowerCase();
    if (t !== 'signature' && !KNOWN_TOKENS.has(t)) throw new Error(`Unknown template token: {{${t}}}`);
    found.add(t);
  }
  return [...found];
}

function seedTemplates() {
  let created = 0;
  for (const t of DEFAULT_TEMPLATES) {
    if (db.getTemplateByKey(t.key)) continue;
    db.saveTemplateVersion(t.key, t.name, 'external', t.subject, t.body, JSON.stringify(extractTokens(t.subject, t.body)), 'seed');
    created++;
  }
  if (created) console.log(`[comms] seeded ${created} default template(s)`);
  return created;
}

module.exports = {
  sendMessage, previewMessage, seedTemplates, buildStatementHtml, htmlToPdf, ecfLogoUri,
  signToken, verifyToken, TOKEN_RE, allowlist, extractTokens, renderSignature,
};
