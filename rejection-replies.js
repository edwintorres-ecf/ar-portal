'use strict';
// ─── rejection-replies.js — "reply to this email to request resubmission" ────
//
// The rejection notice tells the site owner they can just reply. That promise
// has to be true, so this reads the notice mailbox and turns a reply into a
// recorded resubmission request against the exact invoices the notice covered
// (Edwin 2026-09-10).
//
// Notices are sent from arclerk@, NOT the customer comms mailbox (invoices@),
// because they are internal. comms-inbound.js only watches invoices@, so this
// polls arclerk@ separately rather than widening that poller's remit and
// risking internal mail being filed as customer correspondence.
//
// Matching is by a signed token in the subject, which survives Reply and
// Reply-All in every mail client. An unsigned or forged token is ignored.

const db = require('./db');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const NOTICE_MAILBOX = process.env.REJECTION_MAILBOX || 'arclerk@eastcoastfacilities.com';

let _getToken = null;
let _verifyToken = null;
let _onRequest = null;
// app.js owns the Graph credentials and the token signer; both are injected so
// this module has no second copy of either.
function configure({ getToken, verifyRejToken, onRequest }) {
  _getToken = getToken;
  _verifyToken = verifyRejToken;
  _onRequest = onRequest || null;
}

async function gGet(path) {
  const token = await _getToken();
  const res = await fetch(GRAPH + path, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error(`graph ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return res.json();
}

// Strip quoted history so a reply that only says "yes please" is not read as
// the whole original notice, and so the note we store is what THEY wrote.
function topOfReply(text) {
  const t = String(text || '').replace(/\r/g, '');
  const cut = t.search(/\n\s*(?:On .{0,80}wrote:|-{3,}\s*Original Message|From:\s)/);
  return (cut > 0 ? t.slice(0, cut) : t).trim().slice(0, 400);
}

// A reply IS the request — the notice asks them to reply asking for
// resubmission, so anything other than an explicit "not yet" counts. Being
// generous here is safe: a request only puts it on the AR queue, it does not
// resubmit anything by itself.
function readsAsDecline(text) {
  return /\b(not yet|do not resubmit|don'?t resubmit|hold off|on hold|no,?\s*not)\b/i.test(String(text || ''));
}

async function pollRejectionReplies() {
  const stats = { seen: 0, matched: 0, requested: 0, declined: 0, alreadyDone: 0, skipped: 0 };
  if (!_getToken || !_verifyToken) return { ...stats, error: 'not configured' };

  const since = db.getSetting('rejection_reply_since', null)
    || new Date(Date.now() - 7 * 86400000).toISOString();
  const url = `/users/${encodeURIComponent(NOTICE_MAILBOX)}/mailFolders/inbox/messages`
    + `?$select=id,subject,from,receivedDateTime,bodyPreview,body,internetMessageId`
    + `&$filter=receivedDateTime ge ${since}&$orderby=receivedDateTime desc&$top=50`;

  let data;
  try { data = await gGet(url); }
  catch (e) { return { ...stats, error: e.message }; }

  let newest = since;
  for (const m of (data.value || [])) {
    stats.seen++;
    if (m.receivedDateTime > newest) newest = m.receivedDateTime;
    const hay = `${m.subject || ''}\n${(m.body && m.body.content) || m.bodyPreview || ''}`;
    const noticeId = _verifyToken(hay);
    if (!noticeId) { stats.skipped++; continue; }

    const notice = db.getRejectionNotice(noticeId);
    if (!notice) { stats.skipped++; continue; }
    stats.matched++;

    const from = ((m.from || {}).emailAddress || {}).address || '';
    const bodyText = (m.body && m.body.contentType === 'text'
      ? m.body.content
      : String((m.body && m.body.content) || m.bodyPreview || '').replace(/<[^>]+>/g, ' '));
    const note = topOfReply(bodyText);

    if (readsAsDecline(note)) { stats.declined++; continue; }

    let any = false;
    for (const pid of notice.payeeIds) {
      const before = db.listRejections({ includeResolved: true }).find(r => r.payee_id === pid);
      if (!before) continue;
      if (before.resubmit_requested_at) { stats.alreadyDone++; continue; }
      db.requestResubmission(pid, from || 'reply', note);
      stats.requested++; any = true;
    }
    if (any) {
      db.markNoticeReplied(noticeId, from);
      db.auditLog(from || 'rejection-reply', 'resubmission_requested', String(noticeId),
        `${notice.siteCode || 'no site'}: ${notice.payeeIds.join(', ')} — "${note.slice(0, 120)}"`);
      if (_onRequest) { try { await _onRequest(notice, from, note); } catch (e) { console.error('[rejection-replies] notify:', e.message); } }
    }
  }

  // Only advance the watermark on a clean pass, so a Graph failure mid-way
  // cannot skip replies we never actually read.
  db.setSetting('rejection_reply_since', newest, 'rejection-replies');
  return stats;
}

module.exports = { pollRejectionReplies, configure, topOfReply, readsAsDecline, NOTICE_MAILBOX };
