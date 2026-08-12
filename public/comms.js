'use strict';
// ─── comms.js — customer communications UI (AR Portal) ───────────────────────
// Deploy 2 scope: customer contacts management + drawer primary-contact line.
// Loaded by index.html as /comms.js; later deploys add the composer, mailbox,
// triage, and dunning console here so index.html stays lean. Relies on globals
// from index.html: apiFetch, escHtml, currentUser.

const COMMS_AMAZON = ['C-00403', 'C-00566'];

// index.html declares `let currentUser` at top level, which lives in the
// shared global lexical scope but is NOT a window property, so reading it via
// the window object always yields undefined. Read the bare global instead.
function commsUser() {
  try { return (typeof currentUser !== 'undefined' && currentUser) || null; } catch (e) { return null; }
}

function commsCanEdit() {
  return commsUser() && ['admin', 'manager', 'ar_specialist'].includes(commsUser().role);
}
function commsIsManager() {
  return commsUser() && ['admin', 'manager'].includes(commsUser().role);
}

// ─── Modal shell (injected once) ─────────────────────────────────────────────
(function commsInjectModal() {
  const html = `
<div id="contacts-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)commsCloseContacts()">
  <div class="modal-box" style="width:760px;max-width:95vw;max-height:88vh;overflow-y:auto">
    <h3 id="contacts-modal-title" style="margin-bottom:2px">Contacts</h3>
    <div id="contacts-modal-sub" style="font-size:12px;color:var(--gray-500);margin-bottom:10px"></div>
    <div id="contacts-modal-banner"></div>
    <div id="contacts-modal-list" style="margin-bottom:12px"></div>
    <div id="contacts-modal-form"></div>
    <div class="modal-footer" style="display:flex;gap:8px;justify-content:space-between;align-items:center">
      <span id="contacts-sync-wrap"></span>
      <span style="display:flex;gap:8px">
        <button class="btn-sm" id="contacts-email-btn" style="background:var(--navy);color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-weight:600;display:none" onclick="commsComposeFromContacts()">✉️ Email customer</button>
        <button class="btn-sm" style="background:#f1f5f9;border:none;padding:6px 14px;border-radius:6px;cursor:pointer" onclick="commsCloseContacts()">Close</button>
      </span>
    </div>
  </div>
</div>`;
  if (document.body) document.body.insertAdjacentHTML('beforeend', html);
  else document.addEventListener('DOMContentLoaded', () => document.body.insertAdjacentHTML('beforeend', html));
})();

// ─── Contacts modal ──────────────────────────────────────────────────────────
let _contactsCustomerId = null;
let _contactsCustomerName = '';
let _contactsEditing = null; // contact id being edited, or null = add mode

async function commsOpenContacts(customerId, customerName) {
  _contactsCustomerId = customerId;
  _contactsCustomerName = customerName || customerId;
  _contactsEditing = null;
  document.getElementById('contacts-modal').style.display = 'flex';
  document.getElementById('contacts-modal-title').textContent = '👤 Contacts — ' + _contactsCustomerName;
  document.getElementById('contacts-modal-sub').textContent = customerId;
  document.getElementById('contacts-modal-banner').innerHTML = COMMS_AMAZON.includes(customerId)
    ? `<div style="background:#fef9c3;color:#854d0e;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:600;margin-bottom:10px">EDI collections — this customer is excluded from dunning automation. Contacts here are reference-only.</div>`
    : '';
  const emailBtnEl = document.getElementById('contacts-email-btn');
  if (emailBtnEl) emailBtnEl.style.display = commsCanEdit() ? '' : 'none';
  document.getElementById('contacts-sync-wrap').innerHTML = commsIsManager()
    ? `<button class="btn-sm" style="background:#eff6ff;color:#1d4ed8;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600" onclick="commsSyncContacts(this)">⟳ Sync from Sage</button>
       <span style="font-size:11px;color:var(--gray-500);margin-left:6px">seeds from Intacct; never touches manual edits</span>`
    : '';
  await commsReloadContacts();
}

function commsCloseContacts() {
  document.getElementById('contacts-modal').style.display = 'none';
  _contactsCustomerId = null;
}

async function commsReloadContacts() {
  const list = document.getElementById('contacts-modal-list');
  list.innerHTML = '<div style="padding:16px;color:var(--gray-500);font-size:13px">Loading…</div>';
  try {
    const contacts = await apiFetch(`/api/customers/${encodeURIComponent(_contactsCustomerId)}/contacts`);
    commsRenderContactList(contacts);
    commsRenderContactForm();
  } catch (e) {
    list.innerHTML = `<div style="padding:16px;color:var(--red);font-size:13px">${escHtml(e.message)}</div>`;
  }
}

function commsRenderContactList(contacts) {
  const list = document.getElementById('contacts-modal-list');
  const canEdit = commsCanEdit();
  const isAmazon = COMMS_AMAZON.includes(_contactsCustomerId);
  if (!contacts.length) {
    list.innerHTML = '<div style="padding:14px;color:var(--gray-500);font-size:13px">No contacts on file for this customer yet.</div>';
    return;
  }
  list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="text-align:left;color:var(--gray-500);font-size:11px;text-transform:uppercase">
      <th style="padding:6px 8px"></th><th style="padding:6px 8px">Name</th><th style="padding:6px 8px">Email</th>
      <th style="padding:6px 8px">Phone</th><th style="padding:6px 8px">Source</th>
      <th style="padding:6px 8px" title="May be emailed at all">Email OK</th>
      <th style="padding:6px 8px" title="Approved for automated dunning">Dunning</th>
      <th style="padding:6px 8px"></th>
    </tr></thead>
    <tbody>${contacts.map(c => `
      <tr style="border-top:1px solid var(--gray-100)">
        <td style="padding:6px 8px;cursor:${canEdit ? 'pointer' : 'default'}" title="Primary contact"
            ${canEdit ? `onclick="commsSetPrimary(${c.id})"` : ''}>${c.is_primary ? '⭐' : '☆'}</td>
        <td style="padding:6px 8px">${escHtml(c.name || '—')}${c.title ? `<div style="font-size:11px;color:var(--gray-500)">${escHtml(c.title)}</div>` : ''}</td>
        <td style="padding:6px 8px;font-family:monospace;font-size:12px">${escHtml(c.email)}</td>
        <td style="padding:6px 8px">${escHtml(c.phone || '—')}</td>
        <td style="padding:6px 8px"><span style="background:${c.source === 'intacct' ? '#e0f2fe' : '#f3e8ff'};color:${c.source === 'intacct' ? '#0c4a6e' : '#6b21a8'};padding:1px 7px;border-radius:8px;font-size:10px;font-weight:600">${c.source === 'intacct' ? 'Intacct' : 'Manual'}</span></td>
        <td style="padding:6px 8px">${commsToggle(c.id, 'consent_email', c.consent_email, canEdit)}</td>
        <td style="padding:6px 8px">${isAmazon ? '<span style="font-size:11px;color:var(--gray-400)">n/a</span>' : commsToggle(c.id, 'dunning_enabled', c.dunning_enabled, canEdit)}</td>
        <td style="padding:6px 8px;white-space:nowrap">${canEdit ? `
          <button class="btn-sm" style="background:#f1f5f9;border:none;padding:3px 8px;border-radius:5px;cursor:pointer" title="Edit" onclick='commsEditContact(${JSON.stringify(c).replace(/'/g, "&#39;")})'>✎</button>
          <button class="btn-sm" style="background:#fee2e2;color:#b91c1c;border:none;padding:3px 8px;border-radius:5px;cursor:pointer" title="Deactivate" onclick="commsDeactivateContact(${c.id}, '${escHtml(c.email)}')">✕</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>`;
}

function commsToggle(id, field, val, canEdit) {
  const on = !!val;
  return `<span style="cursor:${canEdit ? 'pointer' : 'default'};font-size:16px" title="${field === 'consent_email' ? 'May be emailed' : 'Approved for automated dunning'}"
    ${canEdit ? `onclick="commsToggleFlag(${id}, '${field}', ${on ? 0 : 1})"` : ''}>${on ? '🟢' : '⚪'}</span>`;
}

async function commsToggleFlag(id, field, newVal) {
  try {
    if (field === 'dunning_enabled' && newVal) {
      if (!confirm('Approve this contact to receive AUTOMATED dunning emails once the engine goes live?')) return;
    }
    await apiFetch(`/api/contacts/${id}`, { method: 'PUT', body: JSON.stringify({ [field]: newVal }) });
    await commsReloadContacts();
  } catch (e) { alert('Update failed: ' + e.message); }
}

async function commsSetPrimary(id) {
  try {
    await apiFetch(`/api/contacts/${id}`, { method: 'PUT', body: JSON.stringify({ is_primary: 1 }) });
    await commsReloadContacts();
  } catch (e) { alert('Update failed: ' + e.message); }
}

function commsRenderContactForm(edit) {
  const wrap = document.getElementById('contacts-modal-form');
  if (!commsCanEdit()) { wrap.innerHTML = ''; return; }
  _contactsEditing = edit ? edit.id : null;
  const v = edit || {};
  wrap.innerHTML = `
    <div style="border-top:1px solid var(--gray-100);padding-top:10px">
      <div style="font-size:12px;font-weight:600;color:var(--gray-600);margin-bottom:6px">${edit ? 'Edit contact' : 'Add contact'}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <input id="cc-name" placeholder="Name" value="${escHtml(v.name || '')}" style="flex:1;min-width:130px;padding:6px 8px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px">
        <input id="cc-email" placeholder="email@company.com" value="${escHtml(v.email || '')}" style="flex:1.4;min-width:180px;padding:6px 8px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px">
        <input id="cc-phone" placeholder="Phone" value="${escHtml(v.phone || '')}" style="flex:0.8;min-width:110px;padding:6px 8px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px">
        <input id="cc-title" placeholder="Title" value="${escHtml(v.title || '')}" style="flex:0.8;min-width:110px;padding:6px 8px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px">
        <button class="btn-sm" style="background:var(--navy);color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-weight:600" onclick="commsSaveContact()">${edit ? 'Save' : '+ Add'}</button>
        ${edit ? `<button class="btn-sm" style="background:#f1f5f9;border:none;padding:6px 10px;border-radius:6px;cursor:pointer" onclick="commsRenderContactForm()">Cancel</button>` : ''}
      </div>
    </div>`;
}

function commsEditContact(c) { commsRenderContactForm(c); }

async function commsSaveContact() {
  const body = {
    name: document.getElementById('cc-name').value.trim(),
    email: document.getElementById('cc-email').value.trim(),
    phone: document.getElementById('cc-phone').value.trim(),
    title: document.getElementById('cc-title').value.trim(),
  };
  if (!body.email) { alert('Email is required'); return; }
  try {
    if (_contactsEditing) {
      await apiFetch(`/api/contacts/${_contactsEditing}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await apiFetch(`/api/customers/${encodeURIComponent(_contactsCustomerId)}/contacts`, { method: 'POST', body: JSON.stringify(body) });
    }
    _contactsEditing = null;
    await commsReloadContacts();
  } catch (e) { alert('Save failed: ' + e.message); }
}

async function commsDeactivateContact(id, email) {
  if (!confirm(`Deactivate ${email}? The row is kept (inactive), not deleted.`)) return;
  try {
    await apiFetch(`/api/contacts/${id}`, { method: 'DELETE' });
    await commsReloadContacts();
  } catch (e) { alert('Failed: ' + e.message); }
}

function commsComposeFromContacts() {
  const customerId = _contactsCustomerId, customerName = _contactsCustomerName;
  commsCloseContacts();
  // Customer-level compose: no invoice tags; statement attached by default so
  // the balance detail rides along.
  commsOpenComposer({ customerId, customerName, recordNos: [], defaultAttach: true });
}

async function commsSyncContacts(btn) {
  btn.disabled = true; btn.textContent = '⟳ Syncing…';
  try {
    const s = await apiFetch('/api/contacts/sync', { method: 'POST' });
    alert(`Sync complete.\n\nInserted: ${s.inserted}\nUpdated: ${s.updated}\nManual rows preserved: ${s.skippedManual}\nCustomers with contacts in Intacct: ${s.customersWithContacts}/${s.customers}`);
    await commsReloadContacts();
  } catch (e) { alert('Sync failed: ' + e.message); }
  btn.disabled = false; btn.textContent = '⟳ Sync from Sage';
}

// ─── Composer (Deploy 4) ─────────────────────────────────────────────────────
// Human compose path. Template picker fills the editable subject/body with the
// TEMPLATE SOURCE (tokens visible); if the user leaves it untouched the send
// carries templateKey so the version is recorded on the snapshot; any edit
// switches to raw mode. Preview always resolves server-side; Send goes through
// the same /api/comms/send the dunning engine will use.

let _composerCtx = null;   // { customerId, customerName, recordNos, contacts, templates, dirty, templateKey }

(function commsInjectComposer() {
  const html = `
<div id="composer-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)commsCloseComposer()">
  <div class="modal-box" style="width:860px;max-width:96vw;max-height:92vh;overflow-y:auto">
    <h3 id="composer-title" style="margin-bottom:2px">✉️ Email customer</h3>
    <div id="composer-sub" style="font-size:12px;color:var(--gray-500);margin-bottom:8px"></div>
    <div id="composer-testmode"></div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <div id="composer-to-wrap" style="font-size:13px"></div>
      <input id="composer-cc" placeholder="CC (comma-separated, optional)" style="padding:7px 9px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="composer-template" onchange="commsApplyTemplate()" style="padding:7px 9px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px"></select>
        <label style="font-size:12.5px;display:flex;align-items:center;gap:5px"><input type="checkbox" id="composer-attach-stmt"> Attach statement</label>
        <label id="composer-attach-inv-wrap" style="font-size:12.5px;display:none;align-items:center;gap:5px"><input type="checkbox" id="composer-attach-inv"> <span id="composer-attach-inv-label">Attach invoice PDF</span></label>
        <button class="btn-sm" id="composer-ai-btn" style="background:#f5f3ff;color:#6d28d9;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600;display:none" onclick="commsAiPrefill(this)">✨ Draft with AI</button>
      </div>
      <input id="composer-subject" placeholder="Subject" oninput="_composerCtx&&(_composerCtx.dirty=true)" style="padding:7px 9px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px;font-weight:600">
      <textarea id="composer-body" rows="10" oninput="_composerCtx&&(_composerCtx.dirty=true)" style="padding:9px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px;font-family:inherit;line-height:1.45"></textarea>
      <div style="font-size:11px;color:var(--gray-500)">Tokens like {{invoice_id}}, {{balance}}, {{invoice_table}}, {{signature}} resolve at send. The signature and the shared From address (invoices@) are added automatically.</div>
      <div id="composer-preview" style="display:none;border:1px solid var(--gray-200);border-radius:8px;padding:14px;background:#fafafa;font-size:13px"></div>
      <div id="composer-status" style="font-size:12.5px"></div>
    </div>
    <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
      <button class="btn-sm" style="background:#f1f5f9;border:none;padding:7px 14px;border-radius:6px;cursor:pointer" onclick="commsCloseComposer()">Cancel</button>
      <button class="btn-sm" style="background:#eff6ff;color:#1d4ed8;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;font-weight:600" onclick="commsPreview()">👁 Preview</button>
      <button class="btn-sm" id="composer-send-btn" style="background:var(--navy);color:#fff;border:none;padding:7px 16px;border-radius:6px;cursor:pointer;font-weight:600" onclick="commsSend(this)">Send</button>
    </div>
  </div>
</div>`;
  if (document.body) document.body.insertAdjacentHTML('beforeend', html);
  else document.addEventListener('DOMContentLoaded', () => document.body.insertAdjacentHTML('beforeend', html));
})();

async function commsOpenComposer({ customerId, customerName, recordNos, invoiceId, defaultAttach, conversationId, replyToEmail, replySubject }) {
  if (!commsCanEdit()) { alert('Your role cannot send customer email.'); return; }
  const [contacts, templates, config] = await Promise.all([
    apiFetch(`/api/customers/${encodeURIComponent(customerId)}/contacts`),
    apiFetch('/api/comms/templates'),
    apiFetch('/api/comms/config'),
  ]);
  _composerCtx = { customerId, customerName, recordNos: recordNos || [], contacts, templates, dirty: false, templateKey: null, conversationId: conversationId || null };
  // In a reply, target the actual counterparty rather than the default
  // primary-contact selection.
  const replyNorm = (replyToEmail || '').trim().toLowerCase();
  if (replyNorm) contacts.forEach(c => { c.is_primary = (c.email === replyNorm) ? 1 : 0; });
  document.getElementById('composer-modal').style.display = 'flex';
  document.getElementById('composer-title').textContent = '✉️ Email ' + (customerName || customerId);
  document.getElementById('composer-sub').textContent = invoiceId
    ? `Invoice ${invoiceId} · sends from ${config.mailbox || 'invoices@'}`
    : `Sends from ${config.mailbox || 'invoices@'}`;
  document.getElementById('composer-testmode').innerHTML = config.testMode
    ? `<div style="background:#fef3c7;color:#92400e;padding:8px 12px;border-radius:8px;font-size:12px;font-weight:600;margin-bottom:8px">TEST MODE: sends are restricted to the internal allowlist. Customers cannot receive email until Edwin clears COMMS_ALLOWLIST.</div>`
    : '';
  document.getElementById('composer-to-wrap').innerHTML = contacts.length
    ? 'To: ' + contacts.map(c => `<label style="margin-right:12px;display:inline-flex;align-items:center;gap:4px">
        <input type="checkbox" class="composer-to" value="${escHtml(c.email)}" ${c.is_primary ? 'checked' : ''}>
        ${escHtml(c.name || c.email)}${c.is_primary ? ' ⭐' : ''}${c.consent_email ? '' : ' <span style="color:#b91c1c;font-size:10px">(consent off)</span>'}</label>`).join('')
      + ` <input id="composer-to-extra" placeholder="add address…" style="padding:4px 8px;border:1px solid var(--gray-200);border-radius:6px;font-size:12px;width:180px">`
    : `To: <input id="composer-to-extra" placeholder="recipient@company.com" style="padding:5px 8px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px;width:260px">
       <span style="color:var(--gray-500);font-size:11.5px">(no contacts on file — <a href="#" onclick="commsCloseComposer();commsOpenContacts('${escHtml(customerId)}','${escHtml(customerName || '')}');return false">add one</a>)</span>`;
  const tsel = document.getElementById('composer-template');
  tsel.innerHTML = '<option value="">Custom (blank)</option>' +
    templates.filter(t => t.kind === 'external' && t.active).map(t => `<option value="${escHtml(t.key)}">${escHtml(t.name || t.key)}</option>`).join('');
  tsel.value = '';
  // Counterparty not in contacts (e.g. filed thread with an unsaved sender):
  // pre-fill the free-entry recipient field so the reply still targets them.
  if (replyNorm && !contacts.some(c => c.email === replyNorm)) {
    const extra = document.getElementById('composer-to-extra');
    if (extra) extra.value = replyNorm;
  }
  const subjEl = document.getElementById('composer-subject');
  if (conversationId) {
    subjEl.value = replySubject || 'RE: (thread subject)';
    subjEl.disabled = true;
    subjEl.title = 'Replies keep the thread subject so routing tokens survive';
  } else {
    subjEl.value = '';
    subjEl.disabled = false;
    subjEl.title = '';
  }
  document.getElementById('composer-body').value = '';
  document.getElementById('composer-cc').value = '';
  document.getElementById('composer-attach-stmt').checked = !!defaultAttach;
  const invWrap = document.getElementById('composer-attach-inv-wrap');
  const invCount = (_composerCtx.recordNos || []).length;
  invWrap.style.display = invCount ? 'flex' : 'none';
  document.getElementById('composer-attach-inv').checked = false;
  document.getElementById('composer-attach-inv-label').textContent =
    invCount > 1 ? `Attach invoice PDFs (${invCount})` : 'Attach invoice PDF';
  document.getElementById('composer-preview').style.display = 'none';
  document.getElementById('composer-status').innerHTML = '';
  document.getElementById('composer-ai-btn').style.display =
    (window._aiAvailable && _composerCtx.recordNos.length === 1) ? '' : 'none';
}

function commsCloseComposer() {
  document.getElementById('composer-modal').style.display = 'none';
  _composerCtx = null;
}

function commsApplyTemplate() {
  if (!_composerCtx) return;
  const key = document.getElementById('composer-template').value;
  _composerCtx.templateKey = key || null;
  _composerCtx.dirty = false;
  if (!key) { return; }
  const t = _composerCtx.templates.find(x => x.key === key);
  if (t && t.version_row) {
    document.getElementById('composer-subject').value = t.version_row.subject;
    // Show the body source with tags stripped to editable text; tokens stay.
    document.getElementById('composer-body').value = t.version_row.body_html
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*/gi, '\n\n').replace(/<[^>]+>/g, '').trim();
  }
}

function commsComposerPayload() {
  const c = _composerCtx;
  const to = [...document.querySelectorAll('.composer-to:checked')].map(x => x.value);
  const extra = (document.getElementById('composer-to-extra') || {}).value || '';
  for (const e of extra.split(/[;,]+/)) if (e.trim()) to.push(e.trim());
  const cc = (document.getElementById('composer-cc').value || '').split(/[;,]+/).map(s => s.trim()).filter(Boolean);
  const useTemplate = c.templateKey && !c.dirty;
  const bodyText = document.getElementById('composer-body').value;
  return {
    customerId: c.customerId,
    toEmails: to, ccEmails: cc,
    recordNos: c.recordNos,
    conversationId: c.conversationId || undefined,
    attachStatement: document.getElementById('composer-attach-stmt').checked,
    attachInvoicePdfs: document.getElementById('composer-attach-inv').checked,
    ...(useTemplate
      ? { templateKey: c.templateKey }
      : {
          rawSubject: document.getElementById('composer-subject').value,
          // Paragraphs on blank lines; tokens like {{balance}} pass through
          // escHtml untouched and resolve server-side.
          rawBody: bodyText.split(/\n{2,}/).map(p => '<p>' + escHtml(p).replace(/\n/g, '<br>') + '</p>').join('\n'),
        }),
  };
}

async function commsPreview() {
  if (!_composerCtx) return;
  const box = document.getElementById('composer-preview');
  box.style.display = 'block';
  box.innerHTML = '<span style="color:var(--gray-500)">Rendering…</span>';
  try {
    const p = await apiFetch('/api/comms/preview', { method: 'POST', body: JSON.stringify(commsComposerPayload()) });
    box.innerHTML = `
      <div style="font-size:11px;color:var(--gray-500);margin-bottom:6px">From: ${escHtml(p.from)} · To: ${p.to.map(escHtml).join(', ')}${p.cc.length ? ' · CC: ' + p.cc.map(escHtml).join(', ') : ''}</div>
      <div style="font-weight:700;margin-bottom:8px">${escHtml(p.subject)}</div>
      <div style="border-top:1px solid var(--gray-200);padding-top:10px">${p.bodyHtml}</div>`;
  } catch (e) {
    box.innerHTML = `<span style="color:var(--red)">${escHtml(e.message)}</span>`;
  }
}

async function commsSend(btn) {
  if (!_composerCtx) return;
  const payload = commsComposerPayload();
  if (!payload.toEmails.length) { alert('Pick at least one recipient.'); return; }
  if (!confirm(`Send to ${payload.toEmails.join(', ')}?`)) return;
  btn.disabled = true; btn.textContent = 'Sending…';
  const status = document.getElementById('composer-status');
  try {
    const r = await apiFetch('/api/comms/send', { method: 'POST', body: JSON.stringify(payload) });
    status.innerHTML = `<span style="color:#15803d;font-weight:600">✓ Sent: ${escHtml(r.subject)}</span>`;
    setTimeout(commsCloseComposer, 1600);
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">✗ ${escHtml(e.message)}</span>`;
  }
  btn.disabled = false; btn.textContent = 'Send';
}

async function commsAiPrefill(btn) {
  const c = _composerCtx;
  if (!c || c.recordNos.length !== 1) return;
  btn.disabled = true; btn.textContent = '✨ Drafting…';
  try {
    const r = await apiFetch(`/api/ai/draft-email/${encodeURIComponent(c.recordNos[0])}`, { method: 'POST', body: JSON.stringify({}) });
    const draft = r.draft || '';
    const m = draft.match(/^\s*Subject:\s*(.+)\n+([\s\S]*)$/i);
    document.getElementById('composer-template').value = '';
    c.templateKey = null; c.dirty = true;
    if (m) {
      document.getElementById('composer-subject').value = m[1].trim();
      document.getElementById('composer-body').value = m[2].trim() + '\n\n{{signature}}';
    } else {
      document.getElementById('composer-body').value = draft.trim() + '\n\n{{signature}}';
    }
  } catch (e) { alert('AI draft failed: ' + e.message); }
  btn.disabled = false; btn.textContent = '✨ Draft with AI';
}

// ─── Triage view (Deploy 5) ──────────────────────────────────────────────────

async function commsLoadTriage() {
  const root = document.getElementById('comms-triage-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:30px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const [rows, customers] = await Promise.all([
      apiFetch('/api/comms/triage'),
      apiFetch('/api/customers'),
    ]);
    window._commsCustomers = customers;
    commsUpdateTriageBadge(rows.length);
    if (!rows.length) {
      root.innerHTML = '<div style="padding:36px;text-align:center;color:var(--gray-500)">🎉 Triage is empty. Unmatched inbound mail to the AR mailbox lands here.</div>';
      return;
    }
    root.innerHTML = `
      <div style="font-size:13px;color:var(--gray-600);margin:4px 0 12px">Inbound mail the router could not safely match to a customer. File each thread or dismiss it; the router never guesses.</div>
      ${rows.map(r => `
      <div style="border:1px solid var(--gray-200);border-radius:10px;padding:12px 14px;margin-bottom:10px;background:#fff">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div style="min-width:250px;flex:1">
            <div style="font-weight:600;font-size:13.5px">${escHtml(r.lastSubject || '(no subject)')}</div>
            <div style="font-size:12px;color:var(--gray-500);margin:2px 0">From <span style="font-family:monospace">${escHtml(r.lastFrom)}</span> · ${escHtml((r.lastAt || '').slice(0, 16).replace('T', ' '))} · ${r.messageCount} msg</div>
            <div style="font-size:12.5px;color:var(--gray-600)">${escHtml(r.lastSnippet)}</div>
          </div>
          ${commsCanEdit() ? `
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <select id="triage-cust-${r.id}" style="padding:5px 8px;border:1px solid var(--gray-200);border-radius:6px;font-size:12px;max-width:220px">
              <option value="">File to customer…</option>
              ${customers.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)} (${escHtml(c.id)})</option>`).join('')}
            </select>
            <label style="font-size:11.5px;display:flex;align-items:center;gap:3px"><input type="checkbox" id="triage-cc-${r.id}" checked> save sender as contact</label>
            <button class="btn-sm" style="background:var(--navy);color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-weight:600" onclick="commsFileTriage(${r.id})">File</button>
            <button class="btn-sm" style="background:#f1f5f9;border:none;padding:5px 10px;border-radius:6px;cursor:pointer" onclick="commsDismissTriage(${r.id})">Dismiss</button>
          </div>` : ''}
        </div>
      </div>`).join('')}`;
  } catch (e) {
    root.innerHTML = `<div style="padding:30px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

async function commsFileTriage(id) {
  const customerId = document.getElementById(`triage-cust-${id}`).value;
  if (!customerId) { alert('Pick a customer to file this thread to.'); return; }
  try {
    await apiFetch(`/api/comms/triage/${id}/file`, {
      method: 'POST',
      body: JSON.stringify({ customerId, createContact: document.getElementById(`triage-cc-${id}`).checked }),
    });
    commsLoadTriage();
  } catch (e) { alert('File failed: ' + e.message); }
}

async function commsDismissTriage(id) {
  if (!confirm('Dismiss this thread? It is archived, not deleted.')) return;
  try {
    await apiFetch(`/api/comms/triage/${id}/dismiss`, { method: 'POST' });
    commsLoadTriage();
  } catch (e) { alert('Dismiss failed: ' + e.message); }
}

function commsUpdateTriageBadge(count) {
  const b = document.getElementById('triage-badge');
  if (!b) return;
  if (count > 0) { b.textContent = count; b.style.display = ''; }
  else b.style.display = 'none';
}

// Badge refresher: the Comms nav badge is the "you have action items" signal
// on every screen — replies awaiting response + triage, with a breakdown in
// the tooltip. Polls once authenticated, then every 2 minutes.
(function commsBadgeLoop() {
  const tick = async () => {
    if (!commsUser()) return;
    try {
      const a = await apiFetch('/api/comms/action-items');
      const total = (a.needsReplyTotal || 0) + (a.triage || 0);
      const b = document.getElementById('triage-badge');
      if (b) {
        if (total > 0) {
          b.textContent = total;
          b.style.display = '';
          b.title = `${a.needsReplyTotal} awaiting reply (${a.needsReplyMine} yours, ${a.needsReplyUnassigned} unassigned) · ${a.triage} in triage`;
        } else b.style.display = 'none';
      }
    } catch (e) { /* quiet */ }
  };
  setTimeout(tick, 5000);
  setInterval(tick, 2 * 60 * 1000);
})();

// ─── Mailbox view (Deploy 6) ─────────────────────────────────────────────────
// Filter chips over ONE canonical conversation store — chips are filters and
// assignments, never copies.

let _mailboxFilter = 'needs-reply';

async function commsLoadMailbox() {
  const root = document.getElementById('comms-mailbox-root');
  if (!root) return;
  const chips = [
    ['needs-reply', '📩 Needs reply'], ['open', 'Open'], ['waiting', 'Waiting'], ['due', 'Due'], ['triage', 'Triage'],
    ['completed', 'Completed'], ['archived', 'Archived'], ['mine', 'Mine'], ['', 'All'],
  ];
  root.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 12px">
      ${chips.map(([k, label]) => `<button class="btn-sm" style="border:none;padding:5px 12px;border-radius:14px;cursor:pointer;font-size:12px;font-weight:600;background:${_mailboxFilter === k ? 'var(--navy)' : '#f1f5f9'};color:${_mailboxFilter === k ? '#fff' : 'var(--gray-700)'}" onclick="_mailboxFilter='${k}';commsLoadMailbox()">${label}</button>`).join('')}
    </div>
    <div id="mailbox-list"><div style="padding:24px;text-align:center;color:var(--gray-500)">Loading…</div></div>
    <div id="mailbox-thread" style="display:none"></div>`;
  try {
    let q = '';
    if (_mailboxFilter === 'mine') q = '?assigned=' + encodeURIComponent((commsUser()?.email || '').toLowerCase());
    else if (_mailboxFilter === 'needs-reply') q = '?needsReply=1';
    else if (_mailboxFilter) q = '?status=' + _mailboxFilter;
    const convs = await apiFetch('/api/comms/conversations' + q);
    const list = document.getElementById('mailbox-list');
    if (!convs.length) {
      list.innerHTML = _mailboxFilter === 'needs-reply'
        ? '<div style="padding:30px;text-align:center;color:var(--gray-500)">✅ Nothing awaiting a reply. Customer responses land here the moment they arrive.</div>'
        : '<div style="padding:30px;text-align:center;color:var(--gray-500)">No conversations here.</div>';
      return;
    }
    const dirIcon = (c) => c.last_direction === 'in' ? '📩' : c.last_direction === 'out' ? '📤' : '·';
    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="text-align:left;color:var(--gray-500);font-size:11px;text-transform:uppercase">
        <th style="padding:6px 10px"></th><th style="padding:6px 10px">Customer</th><th style="padding:6px 10px">Subject</th>
        <th style="padding:6px 10px">Status</th><th style="padding:6px 10px">Assigned</th><th style="padding:6px 10px">Last activity</th><th style="padding:6px 10px"></th>
      </tr></thead>
      <tbody>${convs.map(c => `
        <tr style="border-top:1px solid var(--gray-100);cursor:pointer" onclick="commsOpenThread(${c.id})">
          <td style="padding:8px 10px">${dirIcon(c)}</td>
          <td style="padding:8px 10px">${escHtml(c.customer_id || '(unfiled)')}</td>
          <td style="padding:8px 10px;font-weight:600">${escHtml((c.subject || '(no subject)').replace(/\s*\[ECF#[^\]]+\]/, ''))}
            ${c.status === 'open' && c.last_direction === 'in' ? '<span style="background:#fee2e2;color:#b91c1c;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:700;margin-left:5px">NEEDS REPLY</span>' : ''}</td>
          <td style="padding:8px 10px"><span style="background:#f1f5f9;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">${escHtml(c.status)}</span></td>
          <td style="padding:8px 10px;font-size:12px;color:var(--gray-600)">${escHtml((c.assigned_email || '').split('@')[0] || '—')}</td>
          <td style="padding:8px 10px;font-size:12px;color:var(--gray-500)">${escHtml((c.last_message_at || c.created_at || '').slice(0, 16).replace('T', ' '))}</td>
          <td style="padding:8px 10px" onclick="event.stopPropagation()">
            ${commsCanEdit() && c.customer_id ? `<button class="btn-sm" style="background:var(--navy);color:#fff;border:none;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600" onclick="commsReplyToConversation(${c.id})">↩ Reply</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>`;
  } catch (e) {
    document.getElementById('mailbox-list').innerHTML = `<div style="padding:24px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

async function commsOpenThread(id) {
  const listEl = document.getElementById('mailbox-list');
  const threadEl = document.getElementById('mailbox-thread');
  listEl.style.display = 'none';
  threadEl.style.display = '';
  threadEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const { conversation: c, messages } = await apiFetch(`/api/comms/conversations/${id}`);
    const statuses = ['open', 'waiting', 'due', 'completed', 'archived'];
    threadEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <div>
          <button class="btn-sm" style="background:#f1f5f9;border:none;padding:5px 12px;border-radius:6px;cursor:pointer" onclick="commsLoadMailbox()">← Back</button>
          <strong style="margin-left:8px">${escHtml((c.subject || '(no subject)').replace(/\s*\[ECF#[^\]]+\]/, ''))}</strong>
          <span style="font-size:12px;color:var(--gray-500);margin-left:6px">${escHtml(c.customer_id || 'unfiled')}</span>
        </div>
        ${commsCanEdit() ? `
        <div style="display:flex;gap:6px;align-items:center">
          <select onchange="commsSetThreadStatus(${c.id}, this.value)" style="padding:5px 8px;border:1px solid var(--gray-200);border-radius:6px;font-size:12px">
            ${statuses.map(s => `<option value="${s}" ${c.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          ${c.customer_id ? `<button class="btn-sm" style="background:var(--navy);color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-weight:600" onclick="commsReplyToConversation(${c.id})">↩ Reply</button>` : ''}
        </div>` : ''}
      </div>
      ${messages.map(m => `
      <div style="border:1px solid var(--gray-200);border-radius:10px;margin-bottom:8px;background:${m.direction === 'in' ? '#fff' : '#f8fafc'}">
        <div style="padding:8px 12px;font-size:12px;color:var(--gray-600);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;cursor:pointer" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? '' : 'none'">
          <span>${m.direction === 'in' ? '📩' : '📤'} <strong>${escHtml(m.direction === 'in' ? m.from_email : (m.corresponding_email || m.actor_email || m.from_email))}</strong>
            ${m.actor_type === 'automation' ? '<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700;margin-left:4px">AUTO</span>' : ''}
            ${m.status === 'failed' ? '<span style="background:#fee2e2;color:#b91c1c;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700;margin-left:4px">FAILED</span>' : ''}</span>
          <span>${escHtml(((m.sent_at || m.received_at || m.created_at) || '').slice(0, 16).replace('T', ' '))}</span>
        </div>
        <div style="padding:4px 14px 12px;font-size:13px;border-top:1px solid var(--gray-100)">${m.body_html || escHtml(m.body_text || '')}</div>
      </div>`).join('')}`;
  } catch (e) {
    threadEl.innerHTML = `<div style="padding:24px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

// Reply to a conversation from anywhere: works out who the counterparty is
// (last inbound sender, else last outbound recipient) and opens the composer
// into the same thread with them preselected.
async function commsReplyToConversation(id) {
  try {
    const { conversation: c, messages } = await apiFetch(`/api/comms/conversations/${id}`);
    if (!c.customer_id) { alert('File this thread to a customer first (Triage).'); return; }
    let replyTo = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].direction === 'in' && messages[i].from_email) { replyTo = messages[i].from_email; break; }
    }
    if (!replyTo) {
      for (let i = messages.length - 1; i >= 0; i--) {
        try { const t = JSON.parse(messages[i].to_emails || '[]'); if (t.length) { replyTo = t[0]; break; } } catch (e) {}
      }
    }
    // A reply inherits the thread's tagged invoices so tokens resolve and the
    // invoice-PDF attach checkbox is available (the "resend a copy" case).
    const recordNos = [...new Set(messages.flatMap(m => m.recordNos || []))];
    await commsOpenComposer({
      customerId: c.customer_id, customerName: c.customer_id, recordNos,
      conversationId: c.id, replyToEmail: replyTo,
      replySubject: /^re:/i.test(c.subject || '') ? c.subject : 'RE: ' + (c.subject || ''),
    });
  } catch (e) { alert('Could not open reply: ' + e.message); }
}

async function commsSetThreadStatus(id, status) {
  try {
    await apiFetch(`/api/comms/conversations/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
  } catch (e) { alert('Update failed: ' + e.message); }
}

// ─── Dunning console (Deploy 7) ──────────────────────────────────────────────
// Rules → Generate preview → review actions (skips show WHY) → Execute.
// Execute is disabled until DUNNING_ARMED=1, and even then the comms allowlist
// still gates every recipient while set.

async function commsLoadDunning() {
  const root = document.getElementById('comms-dunning-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:30px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const [rules, runs, config, templates] = await Promise.all([
      apiFetch('/api/dunning/rules'),
      apiFetch('/api/dunning/runs'),
      apiFetch('/api/comms/config'),
      apiFetch('/api/comms/templates'),
    ]);
    const isAdmin = commsUser() && commsUser().role === 'admin';
    const isMgr = commsIsManager();
    root.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <span style="background:${config.dunningArmed ? '#dcfce7;color:#15803d' : '#fee2e2;color:#b91c1c'};padding:4px 12px;border-radius:12px;font-size:12px;font-weight:700">${config.dunningArmed ? 'ARMED — live sends enabled' : 'UNARMED — preview only'}</span>
        ${config.testMode ? '<span style="background:#fef3c7;color:#92400e;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:700">TEST MODE — allowlist active</span>' : ''}
        ${isMgr ? '<button class="btn-sm" style="background:var(--navy);color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-weight:600" onclick="commsDunningGenerate(this)">▶ Generate preview run</button>' : ''}
      </div>

      <div style="font-size:13px;font-weight:700;color:var(--gray-600);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 8px">Rules</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px">
        <thead><tr style="text-align:left;color:var(--gray-500);font-size:11px;text-transform:uppercase">
          <th style="padding:6px 10px">Active</th><th style="padding:6px 10px">Seq</th><th style="padding:6px 10px">Name</th>
          <th style="padding:6px 10px">Trigger</th><th style="padding:6px 10px">Repeat</th><th style="padding:6px 10px">Template</th>
          <th style="padding:6px 10px">Stream</th><th style="padding:6px 10px">Min $</th>
        </tr></thead>
        <tbody>${rules.map(r => `
          <tr style="border-top:1px solid var(--gray-100)">
            <td style="padding:7px 10px">${isAdmin
              ? `<span style="cursor:pointer;font-size:16px" onclick="commsDunningToggleRule(${r.id}, ${r.active ? 0 : 1})">${r.active ? '🟢' : '⚪'}</span>`
              : (r.active ? '🟢' : '⚪')}</td>
            <td style="padding:7px 10px">${r.sequence}</td>
            <td style="padding:7px 10px;font-weight:600">${escHtml(r.name)}</td>
            <td style="padding:7px 10px">${r.trigger_days_past_due}d past due</td>
            <td style="padding:7px 10px">${r.repeat_every_days ? 'every ' + r.repeat_every_days + 'd' : 'once'}</td>
            <td style="padding:7px 10px"><code style="font-size:11.5px">${escHtml(r.template_key)}</code></td>
            <td style="padding:7px 10px">${escHtml(r.billing_stream)}</td>
            <td style="padding:7px 10px">$${r.min_invoice_balance || 0}</td>
          </tr>`).join('')}</tbody>
      </table>
      <div style="font-size:11.5px;color:var(--gray-500);margin:-12px 0 16px">Amazon (C-00403, C-00566), stop-service customers, invoices with an open PTP, and contacts not approved for dunning are excluded automatically. Templates: ${templates.filter(t => t.kind === 'external').map(t => t.key).join(', ')}.</div>

      <div style="font-size:13px;font-weight:700;color:var(--gray-600);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 8px">Runs</div>
      <div id="dunning-runs">${runs.length ? runs.map(r => `
        <div style="border:1px solid var(--gray-200);border-radius:8px;padding:9px 12px;margin-bottom:6px;cursor:pointer" onclick="commsDunningOpenRun(${r.id})">
          <strong>Run ${r.id}</strong> · ${escHtml(r.mode)} · ${escHtml(r.status)} · ${escHtml((r.started_at || '').slice(0, 16).replace('T', ' '))}
          <span style="font-size:12px;color:var(--gray-500)">by ${escHtml(r.triggered_by || '')}</span>
          <span id="dunning-run-summary-${r.id}" style="font-size:12px;color:var(--gray-600)">${r.stats_json ? ' · ' + escHtml(commsDunningStatsLine(r.stats_json)) : ''}</span>
        </div>`).join('') : '<div style="padding:14px;color:var(--gray-500);font-size:13px">No runs yet. Generate a preview to see exactly who would be emailed and why others are skipped.</div>'}</div>
      <div id="dunning-run-detail"></div>`;
  } catch (e) {
    root.innerHTML = `<div style="padding:30px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

function commsDunningStatsLine(statsJson) {
  try {
    const s = JSON.parse(statsJson);
    const skips = Object.entries(s.skipped || {}).map(([k, v]) => `${k}:${v}`).join(' ');
    return `${s.digests || 0} digests / ${s.eligible || 0} invoices${skips ? ' · skipped ' + skips : ''}`;
  } catch (e) { return ''; }
}

async function commsDunningToggleRule(id, active) {
  if (active && !confirm('Activate this dunning rule? It will start matching invoices in preview runs (and live runs once armed).')) return;
  try {
    await apiFetch('/api/dunning/rules', { method: 'POST', body: JSON.stringify({ id, active }) });
    commsLoadDunning();
  } catch (e) { alert('Update failed: ' + e.message); }
}

async function commsDunningGenerate(btn) {
  btn.disabled = true; btn.textContent = '▶ Generating…';
  try {
    const r = await apiFetch('/api/dunning/generate', { method: 'POST' });
    await commsLoadDunning();
    if (r.runId) commsDunningOpenRun(r.runId);
  } catch (e) { alert('Generate failed: ' + e.message); }
}

async function commsDunningOpenRun(runId) {
  const el = document.getElementById('dunning-run-detail');
  el.innerHTML = '<div style="padding:14px;color:var(--gray-500)">Loading…</div>';
  try {
    const [actions, config] = await Promise.all([
      apiFetch(`/api/dunning/runs/${runId}/actions`),
      apiFetch('/api/comms/config'),
    ]);
    const sendable = actions.filter(a => ['preview', 'approved'].includes(a.status));
    const reasonLabel = {
      amazon: 'Amazon — EDI collections', stop_service: 'Stop service', open_ptp: 'Open promise to pay',
      no_contact: 'No dunning-approved contact', recent_send: `Emailed within gap window`, idempotent: 'Already sent this step', manual: 'Manually skipped',
    };
    el.innerHTML = `
      <div style="border-top:2px solid var(--gray-200);margin-top:14px;padding-top:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
          <strong>Run ${runId} — ${sendable.length} digest(s) ready, ${actions.length - sendable.length} skipped</strong>
          ${commsIsManager() && sendable.length ? `
            <button class="btn-sm" style="background:${config.dunningArmed ? 'var(--navy)' : '#e2e8f0'};color:${config.dunningArmed ? '#fff' : '#94a3b8'};border:none;padding:6px 14px;border-radius:6px;cursor:${config.dunningArmed ? 'pointer' : 'not-allowed'};font-weight:600"
              ${config.dunningArmed ? `onclick="commsDunningExecute(${runId}, this)"` : 'title="Requires DUNNING_ARMED=1 in .env (the go-live step)"'}>
              🚀 Execute run${config.dunningArmed ? '' : ' (unarmed)'}</button>` : ''}
        </div>
        ${actions.map(a => {
          const rns = JSON.parse(a.record_nos || '[]');
          const badge = a.status === 'preview' ? '#dbeafe;color:#1d4ed8' : a.status === 'sent' ? '#dcfce7;color:#15803d'
            : a.status === 'failed' ? '#fee2e2;color:#b91c1c' : '#f1f5f9;color:#64748b';
          return `<div style="border:1px solid var(--gray-200);border-radius:8px;padding:8px 12px;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <span><strong>${escHtml(a.customer_id)}</strong> · ${rns.length} invoice(s) <span style="font-size:11.5px;color:var(--gray-500)">${escHtml(rns.slice(0, 6).join(', '))}${rns.length > 6 ? '…' : ''}</span></span>
            <span style="display:flex;gap:6px;align-items:center">
              <span style="background:${badge};padding:2px 9px;border-radius:10px;font-size:11px;font-weight:700">${escHtml(a.status)}</span>
              ${a.skip_reason ? `<span style="font-size:11.5px;color:var(--gray-500)">${escHtml(reasonLabel[a.skip_reason] || a.skip_reason)}</span>` : ''}
              ${a.status === 'preview' && commsIsManager() ? `<button class="btn-sm" style="background:#f1f5f9;border:none;padding:3px 9px;border-radius:5px;cursor:pointer;font-size:11px" onclick="commsDunningSkipAction(${a.id}, ${runId})">Skip</button>` : ''}
            </span>
          </div>`;
        }).join('')}
      </div>`;
  } catch (e) {
    el.innerHTML = `<div style="padding:14px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

async function commsDunningSkipAction(id, runId) {
  try {
    await apiFetch(`/api/dunning/actions/${id}/skip`, { method: 'POST' });
    commsDunningOpenRun(runId);
  } catch (e) { alert('Skip failed: ' + e.message); }
}

async function commsDunningExecute(runId, btn) {
  if (!confirm('Execute this dunning run? Every digest listed as ready will be emailed through the comms service (allowlist still applies while set).')) return;
  btn.disabled = true; btn.textContent = '🚀 Executing…';
  try {
    const r = await apiFetch(`/api/dunning/runs/${runId}/execute`, { method: 'POST' });
    alert(`Run complete.\nSent: ${r.sent}\nFailed: ${r.failed}\nRe-skipped: ${r.reskipped}`);
    commsDunningOpenRun(runId);
  } catch (e) { alert('Execute failed: ' + e.message); }
  btn.disabled = false; btn.textContent = '🚀 Execute run';
}

// ─── Invoice drawer: primary-contact line ────────────────────────────────────
// Called by openDrawer after renderDrawer; inserts a compact line showing who
// an email about this invoice would go to (Deploy 3 hangs the composer here).
async function commsDecorateDrawer(data) {
  try {
    const inv = data && data.invoice;
    if (!inv || !inv.customerId) return;
    const body = document.getElementById('drawer-body');
    if (!body) return;
    const contacts = await apiFetch(`/api/customers/${encodeURIComponent(inv.customerId)}/contacts`);
    const primary = contacts.find(c => c.is_primary) || contacts[0];
    const line = document.createElement('div');
    line.id = 'drawer-contact-line';
    line.style.cssText = 'padding:8px 12px;background:#f8fafc;border:1px solid var(--gray-100);border-radius:8px;margin-bottom:10px;font-size:12.5px;display:flex;justify-content:space-between;align-items:center;gap:8px';
    const emailBtn = commsCanEdit()
      ? `<button class="btn-sm" style="background:var(--navy);color:#fff;border:none;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600" onclick='commsOpenComposer({customerId:"${escHtml(inv.customerId)}",customerName:"${escHtml(inv.customerName || '')}",recordNos:["${escHtml(inv.recordNo)}"],invoiceId:"${escHtml(inv.invoiceId || inv.recordNo)}"})'>✉️ Email</button>`
      : '';
    line.innerHTML = primary
      ? `<span>👤 <strong>${escHtml(primary.name || primary.email)}</strong>${primary.name ? ` · <span style="font-family:monospace;font-size:11.5px">${escHtml(primary.email)}</span>` : ''}${primary.phone ? ' · ' + escHtml(primary.phone) : ''}</span>
         <span style="display:flex;gap:6px">${emailBtn}<button class="btn-sm" style="background:#f1f5f9;border:none;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:11px" onclick="commsOpenContacts('${escHtml(inv.customerId)}','${escHtml(inv.customerName || '')}')">Manage</button></span>`
      : `<span style="color:var(--gray-500)">No customer contacts on file</span>
         <span style="display:flex;gap:6px">${emailBtn}<button class="btn-sm" style="background:#f1f5f9;border:none;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:11px" onclick="commsOpenContacts('${escHtml(inv.customerId)}','${escHtml(inv.customerName || '')}')">${commsCanEdit() ? '+ Add' : 'View'}</button></span>`;
    const old = document.getElementById('drawer-contact-line');
    if (old) old.remove();
    body.insertBefore(line, body.firstChild);

    // Email history for this invoice (canonical messages store, tagged rows)
    const msgs = await apiFetch(`/api/invoices/${encodeURIComponent(inv.recordNo)}/messages`);
    const oldHist = document.getElementById('drawer-email-history');
    if (oldHist) oldHist.remove();
    if (msgs.length) {
      const hist = document.createElement('div');
      hist.id = 'drawer-email-history';
      hist.style.cssText = 'border:1px solid var(--gray-100);border-radius:8px;margin-bottom:10px;font-size:12.5px;overflow:hidden';
      hist.innerHTML = `<div style="padding:7px 12px;background:#f8fafc;font-weight:600;font-size:12px">✉️ Emails (${msgs.length})</div>` +
        msgs.map(m => `
        <div style="padding:6px 12px;border-top:1px solid var(--gray-100);cursor:pointer" onclick="this.querySelector('.deh-body').style.display = this.querySelector('.deh-body').style.display === 'none' ? '' : 'none'">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <span>${m.direction === 'in' ? '📩' : '📤'} ${escHtml((m.subject || '').replace(/\s*\[ECF#[^\]]+\]/, '').slice(0, 60))}
              ${m.actor_type === 'automation' ? '<span style="background:#fef3c7;color:#92400e;padding:0 5px;border-radius:6px;font-size:9.5px;font-weight:700">AUTO</span>' : ''}
              ${m.status === 'failed' ? '<span style="background:#fee2e2;color:#b91c1c;padding:0 5px;border-radius:6px;font-size:9.5px;font-weight:700">FAILED</span>' : ''}</span>
            <span style="color:var(--gray-500);font-size:11px">${escHtml(((m.sent_at || m.received_at || m.created_at) || '').slice(0, 10))}</span>
          </div>
          <div class="deh-body" style="display:none;padding:8px 2px 2px;font-size:12.5px">${m.body_html || escHtml(m.body_text || '')}</div>
        </div>`).join('');
      line.insertAdjacentElement('afterend', hist);
    }
  } catch (e) { /* decoration only — never break the drawer */ }
}
