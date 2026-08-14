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

let _myCaps = null;
async function commsFetchCaps() {
  try { _myCaps = (await apiFetch('/api/comms/config')).caps || null; } catch (e) { /* keep role fallback */ }
}
function commsHasCap(cap) {
  if (_myCaps) return _myCaps.includes(cap);
  const u = commsUser();   // fallback to role tiers until caps load
  if (!u) return false;
  return u.role === 'admin' || (u.role === 'manager' && cap !== 'users.admin' && cap !== 'templates.admin') ||
         (u.role === 'ar_specialist' && ['notes.write', 'status.set', 'contacts.manage', 'attachments.manage', 'email.send', 'triage.manage', 'statements.manage', 'po.edit'].includes(cap));
}
function commsCanEdit() { return commsHasCap('email.send') || commsHasCap('notes.write'); }
function commsIsManager() { return commsHasCap('dunning.run') || commsHasCap('finance.transmit'); }

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
    <div id="contacts-attachments"></div>
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
  commsLoadAttachments(customerId);
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
      <th style="padding:6px 8px">Phone</th><th style="padding:6px 8px">Type</th><th style="padding:6px 8px">Source</th>
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
        <td style="padding:6px 8px">${canEdit
          ? `<span style="cursor:pointer;background:${c.contact_type === 'collections' ? '#ddefd9;color:#3f7238' : '#fdf4d5;color:#8a6d1a'};padding:1px 8px;border-radius:8px;font-size:10px;font-weight:700" title="Click to switch billing/collections" onclick="commsToggleContactType(${c.id}, '${c.contact_type === 'collections' ? 'billing' : 'collections'}')">${c.contact_type === 'collections' ? '📞 Collections' : '📨 Billing'}</span>`
          : `<span style="background:${c.contact_type === 'collections' ? '#ddefd9;color:#3f7238' : '#fdf4d5;color:#8a6d1a'};padding:1px 8px;border-radius:8px;font-size:10px;font-weight:700">${c.contact_type === 'collections' ? '📞 Collections' : '📨 Billing'}</span>`}</td>
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

async function commsToggleContactType(id, newType) {
  try {
    await apiFetch(`/api/contacts/${id}`, { method: 'PUT', body: JSON.stringify({ contact_type: newType }) });
    await commsReloadContacts();
  } catch (e) { alert('Failed: ' + e.message); }
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
        <select id="cc-type" style="padding:6px 8px;border:1px solid var(--gray-200);border-radius:6px;font-size:13px">
          <option value="collections" ${(v.contact_type || 'collections') === 'collections' ? 'selected' : ''}>📞 Collections</option>
          <option value="billing" ${v.contact_type === 'billing' ? 'selected' : ''}>📨 Billing</option>
        </select>
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
    contact_type: document.getElementById('cc-type').value,
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
        <input type="checkbox" class="composer-to" value="${escHtml(c.email)}" ${(contacts.some(x => x.contact_type === 'collections') ? c.contact_type === 'collections' : c.is_primary) ? 'checked' : ''}>
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

// ─── Customer page (Phase 4 — their customer detail layout + our comms) ──────

let _custPageId = null;

async function commsOpenCustomerPage(customerId) {
  _custPageId = customerId;
  try { history.replaceState(null, '', '#customer-page/' + encodeURIComponent(customerId)); } catch (e) {}
  if (typeof switchView === 'function') switchView('customer-page');
  commsLoadCustomerPage();
}

async function commsLoadCustomerPage() {
  const root = document.getElementById('customer-page-root');
  if (!root || !_custPageId) return;
  root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const [c] = await Promise.all([apiFetch(`/api/customer-page/${encodeURIComponent(_custPageId)}`), commsGridMeta()]);
    const fmt$ = (n) => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const scChips = commsScChips(c.scBreakdown.map(x => x.sc).filter(x => x !== '—'));
    const kpi = (label, value, sub, red) => `
      <div style="flex:1;min-width:170px;background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:14px 16px">
        <div style="font-size:10.5px;font-weight:600;letter-spacing:.06em;color:#6b6458;text-transform:uppercase">${label}</div>
        <div style="font-size:22px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums;${red ? 'color:#b32020' : ''}">${value}</div>
        <div style="font-size:11.5px;color:#6b6458">${sub}</div>
      </div>`;
    root.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin:6px 0 12px">
        <div>
          <div style="font-size:11.5px;color:#6b6458">Customers / ${escHtml(c.id)}</div>
          <h1 style="font-size:26px;font-weight:700;margin:2px 0 4px">${escHtml(c.name)}</h1>
          <div>${scChips}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${commsCanEdit() ? `<button class="btn-sm" style="background:#1a1814;color:#fff;border:none;padding:7px 14px;border-radius:9px;cursor:pointer;font-weight:600" onclick='commsOpenComposer({customerId:"${escHtml(c.id)}",customerName:"${escHtml(c.name)}",recordNos:[],defaultAttach:true})'>✉️ Email customer</button>` : ''}
          <button class="btn-sm" style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:7px 14px;border-radius:9px;cursor:pointer" onclick="commsOpenContacts('${escHtml(c.id)}','${escHtml(c.name)}')">👤 Contacts</button>
          <button class="btn-sm" style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:7px 14px;border-radius:9px;cursor:pointer" onclick="openStatement('${escHtml(c.id)}')">📄 Statement</button>
        </div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
        ${kpi('Past Due Remaining', fmt$(c.kpis.pastDue), c.kpis.invoices + ' invoices', true)}
        ${kpi('Total AR', fmt$(c.kpis.totalAR), c.kpis.invoices + ' open invoices')}
        ${kpi('Oldest Invoice', c.kpis.oldest + 'd', 'days past due')}
        ${kpi('Service Centers', c.kpis.locations, 'with open invoices')}
      </div>
      <div style="font-size:12px;font-weight:700;color:#6b6458;text-transform:uppercase;letter-spacing:.05em;margin:4px 0 8px">SC breakdown</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
        ${c.scBreakdown.map(b => `
          <div style="min-width:150px;background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:12px;padding:10px 14px">
            ${commsScChips([b.sc])}
            <div style="font-size:15px;font-weight:700;margin-top:5px;font-variant-numeric:tabular-nums;color:${b.pastDue > 0 ? '#b32020' : '#3f7238'}">${fmt$(b.pastDue)} past due</div>
            <div style="font-size:11px;color:#6b6458">${fmt$(b.open)} open · ${b.count} inv</div>
          </div>`).join('')}
      </div>
      <div id="custpage-attachments"></div>
      <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;overflow:hidden;margin-top:14px">
        <div style="padding:10px 16px;background:#faf8f3;font-size:12.5px;font-weight:600">Open Invoices (${c.invoices.length})</div>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="text-align:left;color:#6b6458;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em">
            ${['Invoice', 'SC', 'Invoice Date', 'Due', 'Days Past Due', 'Status', 'Collector', 'Amount'].map(h => `<th style="padding:8px 10px">${h}</th>`).join('')}
          </tr></thead>
          <tbody>${c.invoices.slice(0, 200).map(i => {
            const cs = (_gridMeta.csByRecord[i.recordNo] || {}).status || 'Open';
            const col = commsEffectiveCollector(i);
            return `<tr style="border-top:1px solid #f1ede3;cursor:pointer" onclick="openDrawer('${escHtml(i.recordNo)}')">
              <td style="padding:8px 10px;font-weight:600">${escHtml(i.invoiceId || i.recordNo)}</td>
              <td style="padding:8px 10px">${commsScChipFor(i)}</td>
              <td style="padding:8px 10px">${escHtml(i.whenCreated || '—')}</td>
              <td style="padding:8px 10px">${escHtml(i.whenDue || '—')}</td>
              <td style="padding:8px 10px">${i.daysOverdue > 0 ? `<span class="age-pill ${commsAgePillClass(i.daysOverdue)}">${i.daysOverdue}d</span>` : '<span style="color:#3f7238;font-size:11.5px;font-weight:600">Current</span>'}</td>
              <td style="padding:8px 10px"><span class="cs-chip ${commsCsClass(cs)}">${escHtml(cs)}</span></td>
              <td style="padding:8px 10px;font-size:11.5px">${col ? escHtml(col.split('@')[0]) : 'Unassigned'}</td>
              <td style="padding:8px 10px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">${fmt$(i.totalDue)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        ${c.invoices.length > 200 ? `<div style="padding:8px 16px;font-size:11.5px;color:#6b6458">Showing 200 of ${c.invoices.length} — use Invoices with a customer filter for the full set.</div>` : ''}
      </div>`;
    // Attachments block reuses the shared loader, retargeted at this container
    const att = document.getElementById('custpage-attachments');
    att.innerHTML = '<div id="custpage-attachments-inner" style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:4px 16px 12px"></div>'
      + '<div id="custpage-notes" style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:12px 16px;margin-top:14px"></div>';
    commsLoadAttachments(c.id, 'custpage-attachments-inner');
    commsLoadCustNotes(c.id);
  } catch (e) {
    root.innerHTML = `<div style="padding:40px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

// Customer-level notes (their platform keeps notes on the customer; ours
// were invoice-only). Keyed by customer id in the same notes table.
let _custNoteReplyTo = null;
async function commsLoadCustNotes(customerId) {
  const el = document.getElementById('custpage-notes');
  if (!el) return;
  try {
    const notes = await apiFetch(`/api/notes/${encodeURIComponent(customerId)}`);
    const kids = {}, tops = [];
    for (const n of notes) { if (n.parent_id) (kids[n.parent_id] = kids[n.parent_id] || []).push(n); else tops.push(n); }
    const one = (n, child) => `
      <div style="padding:8px 10px;border-top:1px solid #f1ede3;${child ? 'margin-left:24px;border-left:2px solid #e7e1d4;' : ''}">
        <div style="font-size:13px">${escHtml(n.body)}</div>
        <div style="font-size:11px;color:#6b6458;margin-top:2px">${child ? '↳ ' : ''}${escHtml(n.user_name)} · ${escHtml((n.created_at || '').slice(0, 10))}
          ${commsCanEdit() ? ` · <a href="#" style="color:#3763a0" onclick="_custNoteReplyTo=${n.id};document.getElementById('custnote-ind').textContent='↳ replying to ${escHtml(n.user_name)}';document.getElementById('custnote-body').focus();return false">reply</a>` : ''}</div>
      </div>`;
    el.innerHTML = `
      <div style="font-size:12px;font-weight:700;color:#6b6458;margin-bottom:4px">CUSTOMER NOTES (${notes.length})</div>
      ${tops.map(n => one(n, false) + (kids[n.id] || []).map(x => one(x, true)).join('')).join('') || '<div style="font-size:12px;color:#a8a093;padding:6px 0">No notes on this customer yet.</div>'}
      ${commsCanEdit() ? `
        <div id="custnote-ind" style="font-size:11px;color:#6b6458;margin-top:8px"></div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <input id="custnote-body" placeholder="Add a customer note…" style="flex:1;padding:8px 10px;border:1px solid #e7e1d4;border-radius:8px;font-size:13px"
            onkeydown="if(event.key==='Enter')commsSaveCustNote('${escHtml(customerId)}')">
          <button class="btn-sm" style="background:#1a1814;color:#fff;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsSaveCustNote('${escHtml(customerId)}')">Save</button>
        </div>` : ''}`;
  } catch (e) { el.innerHTML = `<div style="font-size:12px;color:var(--red)">${escHtml(e.message)}</div>`; }
}

async function commsSaveCustNote(customerId) {
  const box = document.getElementById('custnote-body');
  const body = box.value.trim();
  if (!body) return;
  try {
    await apiFetch(`/api/notes/${encodeURIComponent(customerId)}`, { method: 'POST', body: JSON.stringify({ body, parent_id: _custNoteReplyTo }) });
    _custNoteReplyTo = null;
    commsLoadCustNotes(customerId);
  } catch (e) { alert('Save failed: ' + e.message); }
}

// Their platform: clicking a customer opens the customer page. Take over the
// legacy filterByCustomer (which used to just filter the invoice table).
filterByCustomer = (customerId) => commsOpenCustomerPage(customerId);

// ─── Locations view (Phase 4) ────────────────────────────────────────────────
async function commsLoadLocations() {
  const root = document.getElementById('locations-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const rows = await apiFetch('/api/locations-view');
    const fmt$ = (n) => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    await commsGridMeta();
    root.innerHTML = `
      <h1 style="font-size:26px;font-weight:700;margin:6px 0 12px">Locations</h1>
      <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="text-align:left;color:#6b6458;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em">
            ${['Location', 'Service Center', 'Customers', 'Invoices', 'Past Due', 'Current', 'Total AR'].map(h => `<th style="padding:8px 12px">${h}</th>`).join('')}
          </tr></thead>
          <tbody>${rows.map(r => `
            <tr style="border-top:1px solid #f1ede3">
              <td style="padding:9px 12px;font-weight:600">${escHtml(r.locationName)}</td>
              <td style="padding:9px 12px">${r.sc ? commsScChips([r.sc]) : '—'}</td>
              <td style="padding:9px 12px;text-align:right;font-variant-numeric:tabular-nums">${r.customers}</td>
              <td style="padding:9px 12px;text-align:right;font-variant-numeric:tabular-nums">${r.invoices.toLocaleString()}</td>
              <td style="padding:9px 12px;text-align:right;font-variant-numeric:tabular-nums;color:${r.pastDue > 0 ? '#b32020' : 'inherit'};font-weight:600">${fmt$(r.pastDue)}</td>
              <td style="padding:9px 12px;text-align:right;font-variant-numeric:tabular-nums">${fmt$(r.current)}</td>
              <td style="padding:9px 12px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${fmt$(r.totalAR)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;
  } catch (e) {
    root.innerHTML = `<div style="padding:40px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

// ─── Global search (Phase 4) ─────────────────────────────────────────────────
async function commsLoadSearch() {
  const root = document.getElementById('search-root');
  if (!root) return;
  root.innerHTML = `
    <h1 style="font-size:26px;font-weight:700;margin:6px 0 12px">Global Search</h1>
    <div style="display:flex;gap:8px;max-width:560px">
      <input id="gsearch-q" placeholder="Customer, invoice #, PO #, or location…" style="flex:1;padding:10px 14px;border:1px solid var(--line,#e7e1d4);border-radius:10px;font-size:14px;background:#fff" onkeydown="if(event.key==='Enter')commsRunSearch()">
      <button class="btn-sm" style="background:#1a1814;color:#fff;border:none;padding:9px 18px;border-radius:10px;cursor:pointer;font-weight:600" onclick="commsRunSearch()">Search</button>
    </div>
    <div id="gsearch-results" style="margin-top:16px"></div>`;
  setTimeout(() => document.getElementById('gsearch-q').focus(), 100);
}

async function commsRunSearch() {
  const q = document.getElementById('gsearch-q').value.trim();
  const out = document.getElementById('gsearch-results');
  if (q.length < 2) { out.innerHTML = '<div style="color:#6b6458;font-size:13px">Type at least 2 characters.</div>'; return; }
  out.innerHTML = '<div style="color:#6b6458;font-size:13px">Searching…</div>';
  try {
    const r = await apiFetch('/api/search?q=' + encodeURIComponent(q));
    const fmt$ = (n) => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const card = (title, inner) => inner ? `<div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:12px 16px;margin-bottom:12px"><div style="font-weight:700;font-size:13.5px;margin-bottom:8px">${title}</div>${inner}</div>` : '';
    out.innerHTML =
      card(`Customers (${r.customers.length})`, r.customers.map(c => `<div style="padding:6px 0;border-top:1px solid #f1ede3;cursor:pointer;font-size:13px" onclick="commsOpenCustomerPage('${escHtml(c.id)}')"><strong>${escHtml(c.name)}</strong> <span style="color:#6b6458;font-size:11.5px">${escHtml(c.id)}</span> · ${c.invoices} inv · ${fmt$(c.totalAR)}</div>`).join('')) +
      card(`Invoices (${r.invoices.length})`, r.invoices.map(i => `<div style="padding:6px 0;border-top:1px solid #f1ede3;cursor:pointer;font-size:13px" onclick="openDrawer('${escHtml(i.recordNo)}')"><strong>${escHtml(i.invoiceId)}</strong> · ${escHtml(i.customerName)} · ${fmt$(i.totalDue)}${i.daysOverdue > 0 ? ` · <span class="age-pill ${commsAgePillClass(i.daysOverdue)}">${i.daysOverdue}d</span>` : ''}</div>`).join('')) +
      card(`Locations (${r.locations.length})`, r.locations.map(l => `<div style="padding:6px 0;border-top:1px solid #f1ede3;font-size:13px">${escHtml(l.name)}</div>`).join('')) ||
      '<div style="color:#6b6458;font-size:13px">No matches.</div>';
  } catch (e) {
    out.innerHTML = `<div style="color:var(--red);font-size:13px">${escHtml(e.message)}</div>`;
  }
}

// ─── Invoices grid v2 (Phase 3 — their Client Data > Invoices, verbatim) ─────

let _gridMeta = null;
let _inv2 = { all: [], quick: '', page: 1, f: {} };
const INV2_PAGE = 50;

async function commsGridMeta(force) {
  if (!_gridMeta || force) _gridMeta = await apiFetch('/api/grid-meta');
  return _gridMeta;
}

function commsScChipFor(inv) {
  const code = (_gridMeta && _gridMeta.scMap[inv.locationId]) || null;
  return code ? commsScChips([code]) : '<span class="sc-chip sc-unknown">—</span>';
}

function commsEffectiveCollector(inv) {
  if (!_gridMeta) return null;
  return _gridMeta.collectors[inv.recordNo] || _gridMeta.customerCollectors[inv.customerId] || null;
}

async function commsLoadInvoices2() {
  const root = document.getElementById('invoices2-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const [data, meta] = await Promise.all([apiFetch('/api/invoices'), commsGridMeta(true)]);
    _inv2.all = Array.isArray(data) ? data : (data.invoices || []);
    _inv2.page = 1;
    commsRenderInvoices2(true);
  } catch (e) {
    root.innerHTML = `<div style="padding:40px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

function commsInv2Filtered() {
  const m = _gridMeta;
  const f = _inv2.f;
  const AMZ = ['C-00403', 'C-00566'];
  let rows = _inv2.all;
  const csOf = (inv) => (m.csByRecord[inv.recordNo] || {}).status || 'Open';
  if (_inv2.quick === 'amazon') rows = rows.filter(i => AMZ.includes(i.customerId));
  else if (_inv2.quick) rows = rows.filter(i => csOf(i) === _inv2.quick);
  if (f.sc) rows = rows.filter(i => m.scMap[i.locationId] === f.sc);
  if (f.customer) { const q = f.customer.toLowerCase(); rows = rows.filter(i => (i.customerName || '').toLowerCase().includes(q) || (i.customerId || '').toLowerCase().includes(q)); }
  if (f.location) rows = rows.filter(i => i.locationId === f.location);
  if (f.invoice) { const q = f.invoice.toLowerCase(); rows = rows.filter(i => (i.invoiceId || '').toLowerCase().includes(q)); }
  if (f.status) rows = rows.filter(i => csOf(i) === f.status);
  if (f.payment === 'none') rows = rows.filter(i => (i.totalEntered || 0) - (i.totalDue || 0) < 0.01);
  if (f.payment === 'partial') rows = rows.filter(i => { const p = (i.totalEntered || 0) - (i.totalDue || 0); return p >= 0.01 && i.totalDue > 0.01; });
  if (f.collector) rows = rows.filter(i => (commsEffectiveCollector(i) || '') === f.collector);
  const dir = f.direction === 'asc' ? 1 : -1;
  const key = f.sort || 'aging';
  rows = [...rows].sort((a, b) => {
    if (key === 'amount') return dir * (a.totalDue - b.totalDue);
    if (key === 'invoice-date') return dir * String(a.whenCreated || '').localeCompare(String(b.whenCreated || ''));
    if (key === 'due-date') return dir * String(a.whenDue || '').localeCompare(String(b.whenDue || ''));
    return dir * ((a.daysOverdue || 0) - (b.daysOverdue || 0));
  });
  return rows;
}

function commsRenderInvoices2(full) {
  const root = document.getElementById('invoices2-root');
  const m = _gridMeta;
  const fmt$ = (n) => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const QUICK = [['', 'All'], ...m.statuses.map(s => [s, s]), ['amazon', 'Amazon View']];
  if (full) {
    const locs = [...new Map(_inv2.all.map(i => [i.locationId, i.locationName])).entries()].filter(([id]) => id).sort((a, b) => a[1].localeCompare(b[1]));
    const scs = [...new Set(_inv2.all.map(i => m.scMap[i.locationId]).filter(Boolean))].sort();
    root.innerHTML = `
      <h1 style="font-size:26px;font-weight:700;margin:6px 0 10px">Invoices</h1>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
        <span style="font-size:12px;color:#6b6458;margin-right:2px">Quick Filters:</span>
        ${QUICK.map(([v, label]) => `<button class="btn-sm inv2-quick" data-q="${escHtml(v)}" style="border:1px solid var(--line,#e7e1d4);background:#fff;padding:5px 12px;border-radius:12px;cursor:pointer;font-size:12px" onclick="_inv2.quick='${escHtml(v)}';_inv2.page=1;commsRenderInvoices2(true)">${escHtml(label)}</button>`).join('')}
      </div>
      <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:14px 16px;margin-bottom:14px">
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${[['Service Centers', `<select id="if-sc"><option value="">All</option>${scs.map(c => `<option ${_inv2.f.sc === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`],
             ['Customer', `<input id="if-customer" placeholder="Customer name or code" value="${escHtml(_inv2.f.customer || '')}">`],
             ['Location', `<select id="if-location"><option value="">All</option>${locs.map(([id, n]) => `<option value="${escHtml(id)}" ${_inv2.f.location === id ? 'selected' : ''}>${escHtml(n)}</option>`).join('')}</select>`],
             ['Invoice #', `<input id="if-invoice" placeholder="ECI-024110" value="${escHtml(_inv2.f.invoice || '')}">`],
             ['Status', `<select id="if-status"><option value="">All</option>${m.statuses.map(x => `<option ${_inv2.f.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`],
             ['Payment Status', `<select id="if-payment"><option value="">All</option><option value="none" ${_inv2.f.payment === 'none' ? 'selected' : ''}>No Payments</option><option value="partial" ${_inv2.f.payment === 'partial' ? 'selected' : ''}>Partially Paid</option></select>`],
             ['Collector', `<select id="if-collector"><option value="">All</option>${m.users.map(u => `<option value="${escHtml(u.email.toLowerCase())}" ${_inv2.f.collector === u.email.toLowerCase() ? 'selected' : ''}>${escHtml(u.name || u.email)}</option>`).join('')}</select>`],
             ['Sort By', `<select id="if-sort"><option value="aging">Aging</option><option value="amount" ${_inv2.f.sort === 'amount' ? 'selected' : ''}>Amount</option><option value="invoice-date" ${_inv2.f.sort === 'invoice-date' ? 'selected' : ''}>Invoice Date</option><option value="due-date" ${_inv2.f.sort === 'due-date' ? 'selected' : ''}>Due Date</option></select>`],
             ['Direction', `<select id="if-direction"><option value="desc">Descending</option><option value="asc" ${_inv2.f.direction === 'asc' ? 'selected' : ''}>Ascending</option></select>`]]
            .map(([label, ctl]) => `<label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#6b6458;min-width:140px;flex:1">${label}${ctl}</label>`).join('')}
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn-sm" style="background:#1a1814;color:#fff;border:none;padding:7px 16px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsInv2Apply()">Apply</button>
          <button class="btn-sm" style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:7px 14px;border-radius:8px;cursor:pointer" onclick="_inv2.f={};_inv2.quick='';_inv2.page=1;commsRenderInvoices2(true)">Reset</button>
        </div>
      </div>
      <div id="inv2-table"></div>`;
    root.querySelectorAll('#invoices2-root select, #invoices2-root input').forEach(el => { el.style.cssText += 'padding:7px 9px;border:1px solid var(--line,#e7e1d4);border-radius:8px;font-size:13px;background:#fff'; });
    root.querySelectorAll('.inv2-quick').forEach(b => {
      if (b.dataset.q === _inv2.quick) { b.style.background = '#1a1814'; b.style.color = '#fff'; b.style.borderColor = '#1a1814'; }
    });
  }
  const rows = commsInv2Filtered();
  const start = (_inv2.page - 1) * INV2_PAGE;
  const pageRows = rows.slice(start, start + INV2_PAGE);
  const paidOf = (i) => Math.max(0, (i.totalEntered || 0) - (i.totalDue || 0));
  document.getElementById('inv2-table').innerHTML = `
    <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;overflow:hidden">
      <div style="display:flex;justify-content:space-between;padding:10px 16px;background:#faf8f3;font-size:12.5px;font-weight:600;flex-wrap:wrap;gap:8px">
        <span>Invoices</span>
        <span id="inv2-bulkbar" style="display:none;gap:8px;align-items:center">
          <span id="inv2-bulkcount" style="font-size:12px;color:#6b6458"></span>
          <select id="inv2-bulk-collector" style="padding:4px 8px;border:1px solid var(--line,#e7e1d4);border-radius:6px;font-size:12px">
            <option value="">Assign collector…</option>
            ${(_gridMeta.users || []).map(u => `<option value="${escHtml(u.email.toLowerCase())}">${escHtml(u.name || u.email)}</option>`).join('')}
            <option value="__clear__">— Clear collector —</option>
          </select>
          <button class="btn-sm" style="background:#1a1814;color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-weight:600" onclick="commsInv2BulkAssign(this)">Apply</button>
        </span>
        <span style="color:#6b6458">${rows.length.toLocaleString()} total</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr style="text-align:left;color:#6b6458;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em">
          <th style="padding:8px 10px"><input type="checkbox" onclick="document.querySelectorAll('.inv2-pick').forEach(x => x.checked = this.checked);commsInv2BulkBar()"></th>
          ${['Invoice Number', 'Service Center', 'Location', 'Customer', 'Status', 'Amount', 'PO #', 'Payment', 'Aging', 'Collector', 'Manage'].map(h => `<th style="padding:8px 10px">${h}</th>`).join('')}
        </tr></thead>
        <tbody>${pageRows.map(i => {
          const cs = (_gridMeta.csByRecord[i.recordNo] || {}).status || 'Open';
          const paid = paidOf(i);
          const col = commsEffectiveCollector(i);
          const colName = col ? ((_gridMeta.users.find(u => u.email.toLowerCase() === col.toLowerCase()) || {}).name || col.split('@')[0]) : '—';
          return `<tr style="border-top:1px solid #f1ede3;cursor:pointer" onclick="openDrawer('${escHtml(i.recordNo)}')">
            <td style="padding:9px 10px" onclick="event.stopPropagation()"><input type="checkbox" class="inv2-pick" value="${escHtml(i.recordNo)}" onclick="commsInv2BulkBar()"></td>
            <td style="padding:9px 10px;font-weight:600">${escHtml(i.invoiceId || i.recordNo)}</td>
            <td style="padding:9px 10px">${commsScChipFor(i)}</td>
            <td style="padding:9px 10px">${escHtml(i.locationName || '—')}</td>
            <td style="padding:9px 10px">${escHtml(i.customerName || '—')}</td>
            <td style="padding:9px 10px"><span class="cs-chip ${commsCsClass(cs)}">${escHtml(cs)}</span></td>
            <td style="padding:9px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${fmt$(i.totalDue)}</td>
            <td style="padding:9px 10px;font-size:11.5px">${escHtml(i.poNumber || '—')}</td>
            <td style="padding:9px 10px;font-size:11px;color:#6b6458">${paid >= 0.01 ? 'Paid ' + fmt$(paid) + '<br>of ' + fmt$(i.totalEntered) : 'No Payments<br>Recorded'}</td>
            <td style="padding:9px 10px">${i.daysOverdue > 0 ? `<span class="age-pill ${commsAgePillClass(i.daysOverdue)}">${i.daysOverdue}d</span>` : '<span style="color:#3f7238;font-size:11.5px;font-weight:600">Current</span>'}</td>
            <td style="padding:9px 10px;font-size:12px">${escHtml(colName)}</td>
            <td style="padding:9px 10px" onclick="event.stopPropagation()"><button class="btn-sm" style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:4px 10px;border-radius:7px;cursor:pointer;font-size:11.5px" onclick="openDrawer('${escHtml(i.recordNo)}')">Open</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-top:1px solid #f1ede3;font-size:12.5px">
        <span style="color:#6b6458">Showing ${rows.length ? start + 1 : 0}–${Math.min(start + INV2_PAGE, rows.length)} of ${rows.length.toLocaleString()}</span>
        <span style="display:flex;gap:8px;align-items:center">
          <button class="btn-sm" style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:5px 12px;border-radius:8px;cursor:${_inv2.page > 1 ? 'pointer' : 'not-allowed'}" ${_inv2.page > 1 ? 'onclick="_inv2.page--;commsRenderInvoices2(false)"' : 'disabled'}>Previous</button>
          <span style="color:#6b6458">Page ${_inv2.page} of ${Math.max(1, Math.ceil(rows.length / INV2_PAGE))}</span>
          <button class="btn-sm" style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:5px 12px;border-radius:8px;cursor:${start + INV2_PAGE < rows.length ? 'pointer' : 'not-allowed'}" ${start + INV2_PAGE < rows.length ? 'onclick="_inv2.page++;commsRenderInvoices2(false)"' : 'disabled'}>Next</button>
        </span>
      </div>
    </div>`;
}

function commsInv2BulkBar() {
  const n = document.querySelectorAll('.inv2-pick:checked').length;
  const bar = document.getElementById('inv2-bulkbar');
  if (bar) { bar.style.display = n ? 'inline-flex' : 'none'; }
  const cnt = document.getElementById('inv2-bulkcount');
  if (cnt) cnt.textContent = n + ' selected';
}

async function commsInv2BulkAssign(btn) {
  const items = [...document.querySelectorAll('.inv2-pick:checked')].map(x => x.value);
  const sel = document.getElementById('inv2-bulk-collector').value;
  if (!items.length || !sel) { alert('Select invoices and a collector.'); return; }
  const clear = sel === '__clear__';
  if (!confirm(`${clear ? 'Clear collector on' : 'Assign'} ${items.length} invoice(s)${clear ? '' : ' to ' + sel}?`)) return;
  btn.disabled = true;
  try {
    await apiFetch('/api/collector/invoice-bulk', { method: 'POST', body: JSON.stringify({ items, collectorEmail: clear ? '' : sel }) });
    await commsGridMeta(true);
    commsRenderInvoices2(false);
  } catch (e) { alert('Failed: ' + e.message); }
  btn.disabled = false;
}

function commsInv2Apply() {
  _inv2.f = {
    sc: document.getElementById('if-sc').value,
    customer: document.getElementById('if-customer').value.trim(),
    location: document.getElementById('if-location').value,
    invoice: document.getElementById('if-invoice').value.trim(),
    status: document.getElementById('if-status').value,
    payment: document.getElementById('if-payment').value,
    collector: document.getElementById('if-collector').value,
    sort: document.getElementById('if-sort').value,
    direction: document.getElementById('if-direction').value,
  };
  _inv2.page = 1;
  commsRenderInvoices2(true);
}

// ─── My Work v2 (their columns incl. LATEST NOTE) — takes over loadMyWork ────
async function commsMyWorkV2() {
  const view = document.getElementById('view-my-work');
  if (!view) return;
  let host = document.getElementById('mywork2-root');
  if (!host) { view.innerHTML = '<div id="mywork2-root" style="padding:4px 8px"></div>'; host = document.getElementById('mywork2-root'); }
  host.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const [data] = await Promise.all([apiFetch('/api/my-work'), commsGridMeta()]);
    const fmt$ = (n) => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const rows = data.invoices || [];
    host.innerHTML = `
      <h1 style="font-size:26px;font-weight:700;margin:6px 0 2px">My Work</h1>
      <div style="font-size:12.5px;color:#6b6458;margin-bottom:14px">${rows.length} invoice(s) assigned to you · ${fmt$(data.totalDue || 0)} total</div>
      <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;overflow:hidden">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr style="text-align:left;color:#6b6458;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em">
          ${['Invoice', 'Status', 'Due Date', 'Days Past Due', 'Amount', 'Stop Service', 'Customer', 'Latest Note'].map(h => `<th style="padding:8px 10px">${h}</th>`).join('')}
        </tr></thead>
        <tbody>${rows.map(i => {
          const cs = (_gridMeta.csByRecord[i.recordNo] || {}).status || 'Open';
          return `<tr style="border-top:1px solid #f1ede3;cursor:pointer" onclick="openDrawer('${escHtml(i.recordNo)}')">
            <td style="padding:9px 10px;font-weight:600">${escHtml(i.invoiceId || i.recordNo)}</td>
            <td style="padding:9px 10px"><span class="cs-chip ${commsCsClass(cs)}">${escHtml(cs)}</span></td>
            <td style="padding:9px 10px">${escHtml(i.whenDue || '—')}</td>
            <td style="padding:9px 10px">${i.daysOverdue > 0 ? `<span class="age-pill ${commsAgePillClass(i.daysOverdue)}">${i.daysOverdue}d</span>` : '<span style="color:#3f7238;font-weight:600;font-size:11.5px">Current</span>'}</td>
            <td style="padding:9px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${fmt$(i.totalDue)}</td>
            <td style="padding:9px 10px">${i.stopService ? '<span class="cs-chip cs-sent-to-legal">STOP</span>' : '—'}</td>
            <td style="padding:9px 10px;font-size:12px">${escHtml(i.customerName || '')}</td>
            <td style="padding:9px 10px;font-size:11.5px;color:#6b6458;max-width:260px">${i.latestNote ? escHtml(i.latestNote.body) + `<div style="font-size:10.5px;color:#a8a093">${escHtml(i.latestNote.by || '')} · ${escHtml((i.latestNote.at || '').slice(0, 10))}</div>` : '—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      ${rows.length === 0 ? '<div style="padding:30px;text-align:center;color:#6b6458;font-size:13px">Nothing assigned to you right now.</div>' : ''}
      </div>`;
  } catch (e) {
    host.innerHTML = `<div style="padding:40px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}
// Take over the legacy loader so the existing nav dispatch just works.
loadMyWork = commsMyWorkV2;

// ─── Training (in-app, written for the team moving off ECF AR Recon) ─────────
function commsLoadTraining() {
  const root = document.getElementById('training-root');
  if (!root) return;
  const card = (title, body) => `<div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:16px 20px;margin-bottom:12px"><div style="font-weight:700;font-size:15px;margin-bottom:6px">${title}</div><div style="font-size:13px;line-height:1.55;color:#3d3830">${body}</div></div>`;
  root.innerHTML = `
    <h1 style="font-size:26px;font-weight:700;margin:6px 0 4px">Training</h1>
    <div style="font-size:12.5px;color:#6b6458;margin-bottom:16px">For the team moving from ECF AR (reconciliation) to this portal. Same screens, live data.</div>
    ${card('Signing in', 'Go to <strong>ar.eastcoastfacilities.com</strong> and sign in with your ECF Microsoft account, the same email and password you use for Outlook. There is no separate portal password to set or remember.')}
    ${card('What changed from the old platform', '<strong>No more daily reconcile.</strong> The footer used to say "Last Reconciled" because data was imported by hand. Here it says <strong>Live data</strong>: invoices, balances, and payments come straight from Sage Intacct all day. The Reconcile screen has no equivalent because it is no longer needed. Payments show automatically in the Payment column of Invoices.')}
    ${card('Your daily screens', '<strong>Dashboard</strong> is home: totals, aging, top past-due customers. <strong>Client Data → Invoices</strong> is the full grid, same columns and quick filters you know (Open, In Progress, Promised, Sent to Legal…). <strong>Operations → My Work</strong> is your assigned queue with the latest note on each invoice. Click any row to open the invoice drawer: notes, promises to pay, status, PDF, and email history in one place.')}
    ${card('Collection statuses', 'The assigned collector sets the status from the invoice drawer (the dropdown next to the status chip); AR staff can update it afterward. Every change is recorded with who and when. "Sent to Legal" totals appear on the Dashboard Quick Stats.')}
    ${card('Customers', 'Click any customer name anywhere to open their page: past-due summary, per-service-center breakdown, attachments, and all open invoices. From there you can email the customer, manage contacts, or print a statement.')}
    ${card('Email, the big one', 'This portal sends and receives <strong>real email</strong> from invoices@eastcoastfacilities.com. Instead of writing a note that says "emailed David about payment," you email David from the invoice or customer page, with the invoice PDF or statement attached, and his reply lands back on the same thread automatically. Find conversations under <strong>Comms → AR Mailbox</strong>; anything awaiting your reply is tagged <span style="background:#fee2e2;color:#b91c1c;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">NEEDS REPLY</span>. Unrecognized inbound mail goes to <strong>Comms → Triage</strong> for filing.')}
    ${card('Notes and @mentions', 'Notes work like before: open the invoice drawer and write. Type @ to mention a teammate; they get a bell notification and an email. Notes are internal only and never reach customers.')}
    ${card('Amazon', 'Amazon collections stay in the <strong>🟠 Amazon PO Manager</strong>: PO funds, EDI transmission, Payee Central status. Amazon is excluded from email dunning automatically. Use the "Amazon View" quick filter on Invoices to see only Amazon rows.')}
    ${card('Finance: InterNex (Velocity)', 'Invoices are financed through InterNex Capital. <strong>Finance → InterNex</strong> shows the line status (borrowing base, principal, availability), lets you transmit invoice ranges, and reconciles our open invoices against the lender with one button. <strong>If you see a "Safeguard active" notice</strong>, an upload or data refresh is using the shared connection; transmits pause for a few minutes to protect both systems, then everything works again on its own.')}
      ${card('Roles & permissions', '<strong>Viewer</strong>: sees dashboards, invoices, customers, and reports; cannot write notes, change statuses, or email. <strong>AR Specialist</strong> (collectors): everything viewers see, plus notes/@mentions, collection statuses, contacts, attachments, customer email, statement schedules, and EDI previews. <strong>Manager</strong>: adds dunning runs, InterNex/Velocity (the Finance section is visible to managers and admins only), statement runs, user invitations, and live transmits. <strong>Admin</strong>: adds user administration, templates, dunning rule deletion, and system settings. Access is enforced on the server; if a button or section is missing for you, that is your role, not a bug.')}
      ${card('For managers: automation', '<strong>Comms → Dunning</strong> runs reminder sequences: rules by days past due, previewed before anything sends, with per-customer targeting. <strong>Comms → Statements</strong> emails monthly statements on a schedule. Customers only receive automated email when their contact is explicitly approved for it, and both engines are armed by administrators.')}
  `;
}

// ─── Permissions matrix (Admin → Permissions) ────────────────────────────────
async function commsLoadPermissions() {
  const root = document.getElementById('permissions-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const d = await apiFetch('/api/admin/permissions');
    window._permData = d;
    root.innerHTML = `
      <h1 style="font-size:26px;font-weight:700;margin:6px 0 4px">Permissions</h1>
      <div style="font-size:12.5px;color:#6b6458;margin-bottom:14px">Each cell is a capability. <span style="color:#3f7238;font-weight:700">●</span> from role default · <span style="color:#1d4ed8;font-weight:700">●</span> granted individually · <span style="color:#b32020;font-weight:700">○</span> revoked individually · gray = off. Click a cell to toggle an individual override; overrides survive role changes.</div>
      <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;overflow-x:auto">
        <table style="border-collapse:collapse;font-size:11px;min-width:100%">
          <thead><tr>
            <th style="padding:8px 10px;text-align:left;position:sticky;left:0;background:#faf8f3">User</th>
            ${d.capabilities.map(cap => `<th style="padding:8px 4px;writing-mode:vertical-rl;transform:rotate(180deg);text-align:left;font-weight:600;color:#6b6458;white-space:nowrap">${escHtml(cap)}</th>`).join('')}
          </tr></thead>
          <tbody>${d.users.map(u => {
            const defaults = d.roleDefaults[u.role] === null ? d.capabilities : (d.roleDefaults[u.role] || []);
            return `<tr style="border-top:1px solid #f1ede3">
              <td style="padding:8px 10px;position:sticky;left:0;background:#fff;white-space:nowrap"><b>${escHtml(u.name || u.email.split('@')[0])}</b> <span style="color:#a8a093;font-size:10px">${escHtml(u.role)}</span></td>
              ${d.capabilities.map(cap => {
                const byDefault = defaults.includes(cap);
                const granted = (u.overrides.grant || []).includes(cap);
                const revoked = (u.overrides.revoke || []).includes(cap);
                const on = u.effective.includes(cap);
                let dot, color;
                if (revoked) { dot = '○'; color = '#b32020'; }
                else if (granted) { dot = '●'; color = '#1d4ed8'; }
                else if (byDefault) { dot = '●'; color = '#3f7238'; }
                else { dot = '·'; color = '#d5cfc2'; }
                return `<td style="padding:6px 4px;text-align:center;cursor:pointer;font-size:15px;color:${color}" title="${escHtml(u.email)} · ${escHtml(cap)} · ${on ? 'ON' : 'off'}${revoked ? ' (revoked)' : granted ? ' (granted)' : byDefault ? ' (role default)' : ''}"
                  onclick="commsTogglePerm('${escHtml(u.email)}', '${escHtml(cap)}')">${dot}</td>`;
              }).join('')}
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
  } catch (e) { root.innerHTML = `<div style="padding:40px;color:var(--red)">${escHtml(e.message)}</div>`; }
}

async function commsTogglePerm(email, cap) {
  const d = window._permData;
  const u = d.users.find(x => x.email === email);
  const defaults = d.roleDefaults[u.role] === null ? d.capabilities : (d.roleDefaults[u.role] || []);
  const byDefault = defaults.includes(cap);
  let grant = [...(u.overrides.grant || [])], revoke = [...(u.overrides.revoke || [])];
  if (revoke.includes(cap)) revoke = revoke.filter(x => x !== cap);          // revoked -> back to default
  else if (grant.includes(cap)) grant = grant.filter(x => x !== cap);        // granted -> back to default
  else if (byDefault) revoke.push(cap);                                      // default-on -> revoke
  else grant.push(cap);                                                      // default-off -> grant
  try {
    await apiFetch(`/api/admin/users/${encodeURIComponent(email)}/permissions`, { method: 'POST', body: JSON.stringify({ grant, revoke }) });
    commsLoadPermissions();
  } catch (e) { alert('Failed: ' + e.message); }
}

// ─── Collector auto-assignment rules (Operations → Auto-Assignment) ──────────
async function commsLoadAutoAssign() {
  const root = document.getElementById('autoassign-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const [rules, meta, locs] = await Promise.all([
      apiFetch('/api/assignment-rules'), commsGridMeta(), apiFetch('/api/locations-view').catch(() => [])]);
    root.innerHTML = `
      <h1 style="font-size:26px;font-weight:700;margin:6px 0 4px">Collector Auto-Assignment</h1>
      <div style="font-size:12.5px;color:#6b6458;margin-bottom:14px">Rules fill in a collector for UNASSIGNED invoices only (existing assignments are never overwritten). First matching rule by priority wins. Runs daily at ~7:45 AM ET, or on demand.</div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button class="btn-sm" style="background:#1a1814;color:#fff;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsAutoAssignRun(this)">▶ Run rules now</button>
      </div>
      <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;overflow:hidden;margin-bottom:14px">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="text-align:left;color:#6b6458;font-size:10.5px;text-transform:uppercase">
            ${['Active', 'Priority', 'Name', 'Location', 'Aging (days past due)', 'Collector', ''].map(x => `<th style="padding:8px 12px">${x}</th>`).join('')}
          </tr></thead>
          <tbody>${rules.map(r => `
            <tr style="border-top:1px solid #f1ede3">
              <td style="padding:8px 12px;cursor:pointer;font-size:15px" onclick="commsAutoAssignSave({id:${r.id},active:${r.active ? 0 : 1}})">${r.active ? '🟢' : '⚪'}</td>
              <td style="padding:8px 12px">${r.priority}</td>
              <td style="padding:8px 12px;font-weight:600">${escHtml(r.name)}</td>
              <td style="padding:8px 12px">${r.location_id ? escHtml((locs.find(l => l.locationId === r.location_id) || {}).locationName || r.location_id) : 'Any'}</td>
              <td style="padding:8px 12px">${r.min_days_past_due || 0}${r.max_days_past_due != null ? '–' + r.max_days_past_due : '+'}</td>
              <td style="padding:8px 12px">${escHtml(((_gridMeta.users || []).find(u => u.email.toLowerCase() === (r.collector_email || '').toLowerCase()) || {}).name || r.collector_email)}</td>
              <td style="padding:8px 12px"><button class="btn-sm" style="background:#fee2e2;color:#b91c1c;border:none;padding:3px 9px;border-radius:5px;cursor:pointer;font-size:11px" onclick="commsAutoAssignDelete(${r.id})">✕</button></td>
            </tr>`).join('') || '<tr><td colspan="7" style="padding:20px;text-align:center;color:#6b6458">No rules yet — add one below.</td></tr>'}</tbody>
        </table>
      </div>
      <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:12px 16px">
        <div style="font-size:12px;font-weight:700;color:#6b6458;margin-bottom:8px">ADD RULE</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input id="ar-name" placeholder="Rule name" style="flex:1.4;min-width:160px;padding:7px 9px;border:1px solid var(--line,#e7e1d4);border-radius:8px;font-size:13px">
          <select id="ar-loc" style="padding:7px 9px;border:1px solid var(--line,#e7e1d4);border-radius:8px;font-size:13px">
            <option value="">Any location</option>
            ${locs.map(l => `<option value="${escHtml(l.locationId)}">${escHtml(l.locationName)}</option>`).join('')}
          </select>
          <label style="font-size:11.5px;color:#6b6458">Days ≥ <input id="ar-min" type="number" value="0" style="width:64px;padding:7px;border:1px solid var(--line,#e7e1d4);border-radius:8px;font-size:13px"></label>
          <label style="font-size:11.5px;color:#6b6458">≤ <input id="ar-max" type="number" placeholder="∞" style="width:64px;padding:7px;border:1px solid var(--line,#e7e1d4);border-radius:8px;font-size:13px"></label>
          <select id="ar-collector" style="padding:7px 9px;border:1px solid var(--line,#e7e1d4);border-radius:8px;font-size:13px">
            <option value="">Collector…</option>
            ${(_gridMeta.users || []).map(u => `<option value="${escHtml(u.email.toLowerCase())}">${escHtml(u.name || u.email)}</option>`).join('')}
          </select>
          <label style="font-size:11.5px;color:#6b6458">Priority <input id="ar-priority" type="number" value="${rules.length + 1}" style="width:56px;padding:7px;border:1px solid var(--line,#e7e1d4);border-radius:8px;font-size:13px"></label>
          <button class="btn-sm" style="background:#1a1814;color:#fff;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsAutoAssignAdd()">+ Add rule</button>
        </div>
      </div>`;
  } catch (e) { root.innerHTML = `<div style="padding:40px;color:var(--red)">${escHtml(e.message)}</div>`; }
}

async function commsAutoAssignSave(f) {
  try { await apiFetch('/api/assignment-rules', { method: 'POST', body: JSON.stringify(f) }); commsLoadAutoAssign(); }
  catch (e) { alert('Failed: ' + e.message); }
}

async function commsAutoAssignAdd() {
  const f = {
    name: document.getElementById('ar-name').value.trim(),
    active: 1,
    location_id: document.getElementById('ar-loc').value || null,
    min_days_past_due: parseInt(document.getElementById('ar-min').value, 10) || 0,
    max_days_past_due: document.getElementById('ar-max').value ? parseInt(document.getElementById('ar-max').value, 10) : null,
    collector_email: document.getElementById('ar-collector').value,
    priority: parseInt(document.getElementById('ar-priority').value, 10) || 1,
  };
  if (!f.name || !f.collector_email) { alert('Name and collector are required.'); return; }
  commsAutoAssignSave(f);
}

async function commsAutoAssignDelete(id) {
  if (!confirm('Delete this rule? Existing assignments it made are kept.')) return;
  try { await apiFetch('/api/assignment-rules/' + id, { method: 'DELETE' }); commsLoadAutoAssign(); }
  catch (e) { alert('Failed: ' + e.message); }
}

async function commsAutoAssignRun(btn) {
  btn.disabled = true; btn.textContent = '▶ Running…';
  try {
    const r = await apiFetch('/api/assignment-rules/run', { method: 'POST' });
    alert(r.assigned ? `Assigned ${r.assigned} invoice(s):\n` + Object.entries(r.byRule || {}).map(([n, x]) => `${n}: ${x}`).join('\n') : 'Nothing to assign — every matching invoice already has a collector.');
  } catch (e) { alert('Run failed: ' + e.message); }
  btn.disabled = false; btn.textContent = '▶ Run rules now';
}

// ─── Invite user (Admin) ─────────────────────────────────────────────────────
async function commsInviteUser() {
  const email = prompt('Invite who? (@eastcoastfacilities.com email)');
  if (!email) return;
  const name = prompt('Their name (for the invitation):') || '';
  const role = prompt('Role: admin, manager, ar_specialist, or viewer', 'ar_specialist');
  if (!role) return;
  try {
    const r = await apiFetch('/api/admin/invite', { method: 'POST', body: JSON.stringify({ email, name, role }) });
    alert(`Invitation sent to ${r.email} (${r.role}). They sign in with their ECF Microsoft account — no separate password.`);
  } catch (e) { alert('Invite failed: ' + e.message); }
}

// ─── Reports v2 (real charts from live data; legacy kept one click away) ─────
const _legacyLoadReports = typeof loadReports === 'function' ? loadReports : null;

function commsHBar(rows, { color = '#3763a0', money = true } = {}) {
  // Horizontal bars: thin marks, direct labels, one measure, no dual axis.
  const max = Math.max(1, ...rows.map(r => r.v));
  const fmt = (n) => money ? '$' + Math.round(n).toLocaleString() : n.toLocaleString();
  return rows.map(r => `
    <div style="margin-bottom:10px" title="${escHtml(r.label)}: ${fmt(r.v)}">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%">${escHtml(r.label)}</span>
        <span style="font-variant-numeric:tabular-nums;font-weight:600">${fmt(r.v)}</span>
      </div>
      <div style="height:8px;background:rgba(128,120,100,.14);border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${Math.max(1, (r.v / max) * 100)}%;background:${r.color || color};border-radius:4px"></div>
      </div>
    </div>`).join('');
}

async function commsReportsV2() {
  const view = document.getElementById('view-reports');
  if (!view) return;
  let host = document.getElementById('reports2-root');
  if (!host) { view.innerHTML = '<div id="reports2-root" style="padding:4px 8px"></div>'; host = document.getElementById('reports2-root'); }
  host.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const [o, dso, fc, locs] = await Promise.all([
      apiFetch('/api/overview'),
      apiFetch('/api/reports/dso-cei').catch(() => null),
      apiFetch('/api/reports/collection-forecast').catch(() => null),
      apiFetch('/api/locations-view').catch(() => []),
    ]);
    const fmt$ = (n) => '$' + Math.round(n || 0).toLocaleString();
    const card = (title, sub, inner) => `
      <div style="flex:1;min-width:340px;background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:16px 20px">
        <div style="font-weight:700;font-size:15px">${title}</div>
        <div style="font-size:11.5px;color:#6b6458;margin-bottom:12px">${sub}</div>${inner}
      </div>`;
    const sev = { '1-30': '#e8b93c', '31-60': '#e0862f', '61-90': '#d64530', '91-180': '#a02020', '181+': '#7a1a1a' };
    const agingRows = Object.entries(o.buckets).map(([k, v]) => ({ label: k + ' days', v, color: sev[k] }));
    const scRows = locs.filter(l => l.pastDue > 0).sort((a, b) => b.pastDue - a.pastDue)
      .map(l => ({ label: (l.sc ? l.sc + ' · ' : '') + l.locationName, v: l.pastDue }));
    const topRows = (o.top10 || []).map(t => ({ label: t.name, v: t.pastDue }));
    let fcInner = '';
    if (fc && fc.weekBuckets) {
      const wb = Array.isArray(fc.weekBuckets) ? fc.weekBuckets
        : Object.entries(fc.weekBuckets).map(([k, v]) => ({ label: k, amount: typeof v === 'number' ? v : (v.amount || 0) }));
      const rows = wb.map(w => ({ label: w.label || w.week || w.name || '', v: w.amount || w.total || w.v || 0 })).filter(r => r.label);
      if (rows.length) fcInner = commsHBar(rows, { color: '#3f7238' });
    }
    host.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin:6px 0 12px">
        <h1 style="font-size:26px;font-weight:700;margin:0">Reports</h1>
        ${_legacyLoadReports ? '<button class="btn-sm" style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:6px 14px;border-radius:8px;cursor:pointer" onclick="_legacyLoadReports()">Legacy reports</button>' : ''}
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
        ${['Total AR|' + fmt$(o.totalAR) + '|' + o.openInvoices.toLocaleString() + ' invoices',
           'Past due|' + fmt$(o.pastDueAR) + '|' + o.pctPastDue + '% of AR',
           'Avg days outstanding|' + ((dso && dso.avgDaysOutstanding) != null ? dso.avgDaysOutstanding + 'd' : '—') + '|DSO proxy',
           'Promised to pay|' + (fc ? fmt$(fc.ptpTotal) : '—') + '|' + (fc ? fc.ptpCount + ' open promises' : '')]
          .map(x => { const [l, v, sub] = x.split('|'); return `
          <div style="flex:1;min-width:170px;background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:14px 16px">
            <div style="font-size:10.5px;font-weight:600;letter-spacing:.06em;color:#6b6458;text-transform:uppercase">${l}</div>
            <div style="font-size:23px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:3px">${v}</div>
            <div style="font-size:11.5px;color:#6b6458">${sub}</div>
          </div>`; }).join('')}
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px">
        ${card('Past-due aging', 'Remaining past-due dollars by bucket', commsHBar(agingRows))}
        ${card('Past due by service center', 'Where the exposure sits', commsHBar(scRows) || '<div style="font-size:12px;color:#6b6458">Nothing past due.</div>')}
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap">
        ${card('Top 10 past-due customers', 'Ranked by remaining past-due balance', commsHBar(topRows))}
        ${fcInner ? card('Expected collections', 'Open promises to pay by week', fcInner) : ''}
      </div>`;
  } catch (e) {
    host.innerHTML = `<div style="padding:40px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}
loadReports = commsReportsV2;

// ─── Theme toggle (light/dark, persisted) ────────────────────────────────────
(function commsTheme() {
  const saved = localStorage.getItem('arTheme');
  if (saved === 'dark') document.documentElement.dataset.theme = 'dark';
  const inject = () => {
    if (document.getElementById('theme-toggle')) return;
    document.body.insertAdjacentHTML('beforeend',
      '<button id="theme-toggle" title="Light / dark mode" onclick="commsToggleTheme()">🌓</button>');
  };
  if (document.body) inject(); else document.addEventListener('DOMContentLoaded', inject);
})();
function commsToggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  if (dark) { delete document.documentElement.dataset.theme; localStorage.setItem('arTheme', 'light'); }
  else { document.documentElement.dataset.theme = 'dark'; localStorage.setItem('arTheme', 'dark'); }
}

// ─── InterNex Capital / Velocity (Finance) ───────────────────────────────────

function velPad(prefix, n) { return String(n).padStart(prefix === 'S' ? 4 : 6, '0'); }

async function commsLoadVelocity() {
  const root = document.getElementById('velocity-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const s = await apiFetch('/api/velocity/status');
    const marks = s.marks || {};
    const nextFrom = marks.ECI ? velPad('ECI', marks.ECI + 1) : '';
    window._velMarks = marks;
    const marksLabel = Object.entries(marks).map(([p, n]) => `${p}-${velPad(p, n)}`).join(' · ') || 'not tracked yet';
    root.innerHTML = `
      <h1 style="font-size:26px;font-weight:700;margin:6px 0 4px">InterNex Capital (Velocity)</h1>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
        <span style="background:${s.armed ? '#dcfce7;color:#15803d' : '#fee2e2;color:#b32020'};padding:4px 12px;border-radius:12px;font-size:12px;font-weight:700">${s.armed ? '🟢 ARMED — live uploads enabled' : '🔒 UNARMED — preview only'}</span>
        <span style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:4px 12px;border-radius:12px;font-size:12px">Last confirmed on Velocity: <strong>${marksLabel}</strong>${s.pendingConfirmation ? ` · <span style=\"color:#8a6d1a\">${s.pendingConfirmation} awaiting confirmation</span>` : ''}</span>
        ${s.feedAgeHours != null ? `<span style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:4px 12px;border-radius:12px;font-size:12px">Velocity feed: ${s.feedAgeHours}h old</span>` : ''}
        ${commsIsManager() ? `<button class="btn-sm" style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:6px 12px;border-radius:8px;cursor:pointer" onclick="commsVelocitySync(this)">⟳ Sync feed from iMac</button>` : ''}
        ${commsIsManager() ? `<button class="btn-sm" style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:6px 12px;border-radius:8px;cursor:pointer" onclick="commsVelocityRefresh(this)">🔄 Refresh from Velocity now</button>` : ''}
        <button class="btn-sm" style="background:#1a1814;color:#fff;border:none;padding:6px 14px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsVelocityReconcile(this)">⚖ Reconcile</button>
      </div>
      ${s.facilities ? `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
        ${Object.values(s.facilities).map(f => `
          <div style="flex:1;min-width:280px;background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:14px 18px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <span class="sc-chip ${f.account === 'LOC1' ? 'sc-BSC' : 'sc-HSC'}">${escHtml(f.account)}</span>
              <span style="font-size:10.5px;color:#a8a093">${f.capturedAt ? 'as of ' + escHtml(f.capturedAt.slice(0, 16).replace('T', ' ')) : ''}</span>
            </div>
            ${f.error ? `<div style="font-size:12px;color:#b32020">Harvest error: ${escHtml(f.error)}</div>`
              : f.borrowingBase ? [['Borrowing Base', f.borrowingBase], ['Principal Balance', f.principalBalance], ['Available', f.available], ['Total Unpaid Invoices', f.totalUnpaid]]
                  .filter(x => x[1]).map(x => `
                <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid #f5f1e8">
                  <span style="color:#6b6458">${x[0]}</span>
                  <span style="font-variant-numeric:tabular-nums;font-weight:700${x[0] === 'Available' ? ';color:#3f7238' : x[0] === 'Principal Balance' ? ';color:#b32020' : ''}">${escHtml(x[1])}</span>
                </div>`).join('')
              : (f.rawPairs || []).map(p => `
                <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid #f5f1e8">
                  <span style="color:#6b6458">${escHtml(p.label)}</span>
                  <span style="font-variant-numeric:tabular-nums;font-weight:700">${escHtml(p.value)}</span>
                </div>`).join('') || '<div style="font-size:12px;color:#a8a093">No metrics captured yet — populates after the next Velocity scrape.</div>'}
          </div>`).join('')}
      </div>` : ''}
      <div id="vel-payapp" style="margin-bottom:14px"></div>
      ${s.lock && s.lock.locked ? `<div style="background:#fef3c7;color:#92400e;padding:10px 14px;border-radius:10px;font-size:12.5px;font-weight:600;margin-bottom:14px">⏳ Safeguard active: the Velocity browser is in use by the <strong>${escHtml(s.lock.tool)}</strong> (since ${escHtml((s.lock.since || '').slice(11, 16))} UTC). Transmits and refreshes are paused until it finishes — usually a few minutes. This protects both systems from driving the same session.</div>` : ''}
      <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:14px 16px;margin-bottom:14px">
        <div style="font-size:12px;font-weight:700;color:#6b6458;margin-bottom:8px">SELECT INVOICES (ECI number range — same number for a single invoice)</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label style="font-size:12px;color:#6b6458">Series <select id="vel-prefix" onchange="(function(){const m=(window._velMarks||{})[document.getElementById('vel-prefix').value];document.getElementById('vel-from').value=m?velPad(document.getElementById('vel-prefix').value,m+1):'';document.getElementById('vel-to').value='';})()" style="padding:7px 9px;border:1px solid var(--line,#e7e1d4);border-radius:8px;font-size:13px">
            ${(s.prefixes || ['ECI', 'AST', 'ASTM', 'S', 'SPI', 'SS']).map(p => `<option value="${p}">${p}-</option>`).join('')}
          </select></label>
          <label style="font-size:12px;color:#6b6458">From <input id="vel-from" type="text" inputmode="numeric" value="${nextFrom}" placeholder="025424" style="width:100px;padding:7px 9px;border:1px solid var(--line,#e7e1d4);border-radius:8px;font-size:13px;font-variant-numeric:tabular-nums"></label>
          <label style="font-size:12px;color:#6b6458">To <input id="vel-to" type="text" inputmode="numeric" placeholder="same for single" style="width:100px;padding:7px 9px;border:1px solid var(--line,#e7e1d4);border-radius:8px;font-size:13px;font-variant-numeric:tabular-nums"></label>
          <label style="font-size:12px;display:flex;align-items:center;gap:5px"><input type="checkbox" id="vel-retrans"> include already-transmitted (retransmit)</label>
          <button class="btn-sm" style="background:#1a1814;color:#fff;border:none;padding:7px 16px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsVelocityPreview()">Preview</button>
        </div>
      </div>
      <div id="vel-preview"></div>
      <div style="font-size:13px;font-weight:700;color:#6b6458;text-transform:uppercase;letter-spacing:.05em;margin:16px 0 8px">Transmit history</div>
      ${s.recent.length ? `<div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;overflow:hidden"><table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="text-align:left;color:#6b6458;font-size:10.5px;text-transform:uppercase"><th style="padding:7px 12px">Invoice</th><th style="padding:7px 12px">Batch</th><th style="padding:7px 12px">Line</th><th style="padding:7px 12px">Result</th><th style="padding:7px 12px">By</th><th style="padding:7px 12px">At</th></tr></thead>
        <tbody>${s.recent.map(t => `<tr style="border-top:1px solid #f1ede3">
          <td style="padding:7px 12px;font-weight:600">${escHtml(t.invoice_id)}</td><td style="padding:7px 12px">${escHtml(t.batch || '')}</td>
          <td style="padding:7px 12px">${escHtml(t.line)}</td>
          <td style="padding:7px 12px">${t.result === 'OK' ? (t.confirmed_at ? '<span style="color:#15803d;font-weight:700">✓ Confirmed</span>' : '<span style="color:#8a6d1a;font-weight:700">Sent — awaiting Velocity</span>') : `<span style="color:#b32020;font-weight:700">${escHtml(t.result || '')}</span>`}</td>
          <td style="padding:7px 12px">${escHtml((t.transmitted_by || '').split('@')[0])}</td>
          <td style="padding:7px 12px;color:#6b6458">${escHtml((t.transmitted_at || '').slice(0, 16))}</td></tr>`).join('')}</tbody></table></div>`
        : '<div style="font-size:12.5px;color:#6b6458">No portal transmits yet. Earlier uploads live in the iMac manifest.</div>'}
      <div style="font-size:11.5px;color:#6b6458;margin-top:10px;white-space:pre-wrap">${escHtml(String(s.uploader || '').slice(0, 500))}</div>`;
    commsLoadPaymentWorklist();
  } catch (e) { root.innerHTML = `<div style="padding:40px;color:var(--red)">${escHtml(e.message)}</div>`; }
}

async function commsLoadPaymentWorklist() {
  const el = document.getElementById('vel-payapp');
  if (!el) return;
  try {
    const w = await apiFetch('/api/velocity/payment-worklist');
    if (!w.count) { el.innerHTML = ''; return; }
    const fmt$ = (n) => '$' + Math.round(n || 0).toLocaleString();
    el.innerHTML = `
      <div style="background:#fff;border:1px solid #e0862f;border-radius:14px;padding:12px 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div>
            <div style="font-weight:700;font-size:14px">💸 Payments to apply on Velocity: ${w.count} invoice(s) · ${fmt$(w.total)}</div>
            <div style="font-size:11.5px;color:#6b6458">Paid into our lockbox (closed or reduced in Sage) but still carried open on the lender side. Apply these in Velocity so the borrowing base stays honest. Credits/discounts: classify in the export until automated.</div>
          </div>
          <span style="display:flex;gap:8px">
            <a class="btn-sm" style="background:#1a1814;color:#fff;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-weight:600;text-decoration:none" href="/api/velocity/payment-worklist.csv?t=${Date.now()}">⬇ Download apply-list CSV</a>
            <button class="btn-sm" style="background:#fff;border:1px solid var(--line,#e7e1d4);padding:6px 12px;border-radius:8px;cursor:pointer" onclick="commsTogglePayList()">View list</button>
          </span>
        </div>
        <div id="vel-payapp-list" style="display:none;margin-top:10px">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="text-align:left;color:#6b6458;font-size:10px;text-transform:uppercase"><th style="padding:5px 10px">Invoice</th><th style="padding:5px 10px">Customer</th><th style="padding:5px 10px">Account</th><th style="padding:5px 10px">Status here</th><th style="padding:5px 10px">Paid date</th><th style="padding:5px 10px;text-align:right">Velocity balance</th><th style="padding:5px 10px;text-align:right">Apply</th></tr></thead>
            <tbody>${w.rows.slice(0, 60).map(r => `<tr style="border-top:1px solid #f5f1e8">
              <td style="padding:5px 10px;font-weight:600">${escHtml(r.invoiceId)}</td>
              <td style="padding:5px 10px">${escHtml(r.customer || '')}</td>
              <td style="padding:5px 10px">${escHtml(r.account || '')}</td>
              <td style="padding:5px 10px;font-size:11px;color:#6b6458">${escHtml(r.kind)}</td>
              <td style="padding:5px 10px;font-size:11px">${r.paidDate ? escHtml(String(r.paidDate).slice(0, 10)) : '—'}</td>
              <td style="padding:5px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmt$(r.velocityBalance)}</td>
              <td style="padding:5px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:700">${fmt$(r.amountToApply)}</td>
            </tr>`).join('')}</tbody>
          </table>
          ${w.rows.length > 60 ? '<div style="font-size:11px;color:#6b6458;padding:6px 10px">Showing 60 — full list in the CSV.</div>' : ''}
        </div>
      </div>`;
  } catch (e) { el.innerHTML = ''; }
}

function commsTogglePayList() {
  const l = document.getElementById('vel-payapp-list');
  if (l) l.style.display = l.style.display === 'none' ? '' : 'none';
}

async function commsVelocityPreview() {
  const prefix = document.getElementById('vel-prefix').value;
  const from = parseInt(document.getElementById('vel-from').value, 10), to = parseInt(document.getElementById('vel-to').value, 10) || from;
  const out = document.getElementById('vel-preview');
  if (!from) { alert('Enter a starting invoice number.'); return; }
  out.innerHTML = '<div style="padding:14px;color:#6b6458">Loading…</div>';
  try {
    const p = await apiFetch(`/api/velocity/pending?prefix=${prefix}&from=${from}&to=${to}`);
    const fmt$ = (n) => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
    const loc1 = p.rows.filter(r => r.line === 'LOC1'), loc2 = p.rows.filter(r => r.line === 'LOC2');
    if (!p.rows.length) {
      out.innerHTML = `<div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:16px 18px;font-size:13px">
        No open invoices found for ${prefix}-${velPad(prefix, from)}${to !== from ? ' through ' + prefix + '-' + velPad(prefix, to) : ''}.
        <div style="color:#6b6458;font-size:12px;margin-top:6px">The transmit picker only shows invoices that are currently OPEN in Sage — paid, voided, or out-of-scope invoices never appear, even for retransmit (a closed invoice must not be financed). If this invoice should be open, check it in Sage; if it is open but Amazon-related, it may be under LOC2 rules.</div>
      </div>`;
      return;
    }
    const total = loc1.reduce((s, r) => s + r.amount, 0);
    out.innerHTML = `
      <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;overflow:hidden">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:#faf8f3;font-size:12.5px;flex-wrap:wrap;gap:8px">
          <span><strong>${loc1.length}</strong> LOC1 invoice(s) · ${fmt$(total)}${loc2.length ? ` · <span style="color:#b0472a">${loc2.length} LOC2 (Amazon, held — see below)</span>` : ''}</span>
          <span style="display:flex;gap:6px;flex-wrap:wrap">
          ${commsIsManager() && loc1.length ? `<button class="btn-sm" style="background:${p.armed ? '#1a1814' : '#e2e8f0'};color:${p.armed ? '#fff' : '#94a3b8'};border:none;padding:6px 16px;border-radius:8px;cursor:${p.armed ? 'pointer' : 'not-allowed'};font-weight:600" ${p.armed ? `onclick="commsVelocityTransmit('${prefix}', ${from}, ${to}, this, 'LOC1')"` : 'title="Set VELOCITY_TRANSMIT_ARMED=1 to enable"'}>🚀 Transmit LOC1${p.armed ? '' : ' (unarmed)'}</button>` : ''}
          ${commsIsManager() && loc2.length && p.armed ? `<button class="btn-sm" style="background:#fff;border:2px solid #b0472a;color:#b0472a;padding:5px 14px;border-radius:8px;cursor:pointer;font-weight:700" onclick="commsVelocityTransmit('${prefix}', ${from}, ${to}, this, 'LOC2')">⚠ Express LOC2 (${loc2.length})</button>` : ''}
          </span>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="text-align:left;color:#6b6458;font-size:10.5px;text-transform:uppercase"><th style="padding:7px 12px">Invoice</th><th style="padding:7px 12px">Customer (Velocity name)</th><th style="padding:7px 12px">Line</th><th style="padding:7px 12px;text-align:right">Amount</th><th style="padding:7px 12px;text-align:right">Balance</th><th style="padding:7px 12px">Prior transmit</th><th style="padding:7px 12px">InterNex status</th></tr></thead>
          <tbody>${p.rows.map(r => `<tr style="border-top:1px solid #f1ede3;${r.line === 'LOC2' ? 'opacity:.6' : ''}">
            <td style="padding:7px 12px;font-weight:600">${escHtml(r.invoiceId)}</td>
            <td style="padding:7px 12px">${escHtml(r.velocityCustomer)}${r.velocityCustomer !== r.customer ? ` <span style="color:#a8a093;font-size:10.5px">(${escHtml(r.customer)})</span>` : ''}</td>
            <td style="padding:7px 12px"><span class="sc-chip ${r.line === 'LOC1' ? 'sc-BSC' : 'sc-HSC'}">${r.line}</span></td>
            <td style="padding:7px 12px;text-align:right;font-variant-numeric:tabular-nums">${fmt$(r.amount)}</td>
            <td style="padding:7px 12px;text-align:right;font-variant-numeric:tabular-nums">${fmt$(r.balance)}</td>
            <td style="padding:7px 12px;font-size:11px;color:#6b6458">${r.transmitted ? '✓ ' + r.transmitted.times + 'x, last ' + (r.transmitted.at || '').slice(0, 10) : '—'}</td>
            <td style="padding:7px 12px;font-size:11px">${r.feed ? `<span style="color:${r.feed.status === 'open' ? '#3763a0' : r.feed.status === 'closed' ? '#3f7238' : '#8a6d1a'};font-weight:600">${escHtml(r.feed.account)} ${escHtml(r.feed.status)}</span>` : '<span style="color:#a8a093">not on portal</span>'}</td>
          </tr>`).join('')}</tbody>
        </table>
        ${loc2.length ? '<div style="padding:9px 16px;font-size:11.5px;color:#b0472a;border-top:1px solid #f1ede3">LOC2 rows (Amazon invoices not in Payee) are shown for review but transmitted ONLY via the express LOC2 button with typed confirmation.</div>' : ''}
      </div>`;
  } catch (e) { out.innerHTML = `<div style="padding:14px;color:var(--red)">${escHtml(e.message)}</div>`; }
}

let _velRefreshTimer = null;
async function commsVelocityRefresh(btn) {
  if (!confirm('Run a full Velocity scrape now? Takes about 6 minutes; transmits are blocked while it runs (browser mutex).')) return;
  btn.disabled = true; btn.textContent = '🔄 Scraping…';
  try {
    await apiFetch('/api/velocity/refresh', { method: 'POST' });
  } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = '🔄 Refresh from Velocity now'; return; }
  clearInterval(_velRefreshTimer);
  _velRefreshTimer = setInterval(async () => {
    try {
      const s = await apiFetch('/api/velocity/refresh-status');
      if (s.done) {
        clearInterval(_velRefreshTimer);
        btn.disabled = false; btn.textContent = '🔄 Refresh from Velocity now';
        commsLoadVelocity();
        alert('Velocity refresh complete — feed synced and confirmations reconciled. Run ⚖ Reconcile for the fresh comparison.');
      } else if (s.stalled) {
        clearInterval(_velRefreshTimer);
        btn.disabled = false; btn.textContent = '🔄 Refresh from Velocity now';
        alert('Refresh stalled: ' + (s.note || 'unknown'));
      } else {
        btn.textContent = `🔄 Scraping… ${s.runningFor || 0}m`;
      }
    } catch (e) { /* keep polling */ }
  }, 30000);
}

function commsEnsureReconModal() {
  if (document.getElementById('velrecon-modal')) return;
  document.body.insertAdjacentHTML('beforeend', `
<div id="velrecon-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)this.style.display='none'">
  <div class="modal-box" style="width:1000px;max-width:97vw;max-height:92vh;overflow-y:auto">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <h3 style="margin:0">⚖ Velocity Reconciliation</h3>
      <button class="btn-sm" style="background:#f1f5f9;border:none;padding:6px 12px;border-radius:8px;cursor:pointer" onclick="document.getElementById('velrecon-modal').style.display='none'">Close</button>
    </div>
    <div id="velrecon-body"></div>
  </div>
</div>`);
}

async function commsVelocityReconcile(btn) {
  btn.disabled = true; btn.textContent = '⚖ Reconciling…';
  commsEnsureReconModal();
  document.getElementById('velrecon-modal').style.display = 'flex';
  const out = document.getElementById('velrecon-body');
  try {
    const r = await apiFetch('/api/velocity/reconcile');
    const fmt$ = (n) => '$' + Math.round(n || 0).toLocaleString();
    const s = r.summary;
    const tile = (label, v, sub, warn) => `
      <div style="flex:1;min-width:170px;background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:12px 16px">
        <div style="font-size:10.5px;font-weight:600;letter-spacing:.05em;color:#6b6458;text-transform:uppercase">${label}</div>
        <div style="font-size:21px;font-weight:700;font-variant-numeric:tabular-nums;${warn ? 'color:#b32020' : ''}">${v}</div>
        <div style="font-size:11.5px;color:#6b6458">${sub}</div>
      </div>`;
    const table = (title, rows, cols, note) => rows.length ? `
      <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;overflow:hidden;margin-top:12px">
        <div style="padding:9px 14px;background:#faf8f3;font-size:12.5px;font-weight:700">${title} (${rows.length}${rows.length === 100 ? '+' : ''})</div>
        ${note ? `<div style="padding:6px 14px;font-size:11.5px;color:#6b6458;border-bottom:1px solid #f1ede3">${note}</div>` : ''}
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="text-align:left;color:#6b6458;font-size:10px;text-transform:uppercase">${cols.map(x => `<th style="padding:6px 12px">${x[0]}</th>`).join('')}</tr></thead>
          <tbody>${rows.slice(0, 50).map(row => `<tr style="border-top:1px solid #f1ede3">${cols.map(x => `<td style="padding:6px 12px${x[2] ? ';text-align:right;font-variant-numeric:tabular-nums' : ''}">${x[1](row)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>${rows.length > 50 ? '<div style="padding:6px 14px;font-size:11px;color:#6b6458">Showing 50.</div>' : ''}
      </div>` : '';
    out.innerHTML = `
      <div style="font-size:11.5px;color:#6b6458;margin-bottom:8px">Reconciled against the Velocity feed generated ${escHtml((r.feedGeneratedAt || '?').slice(0, 16).replace('T', ' '))}. Sync the feed first for the freshest comparison.</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${tile('Open on our side', s.ourOpenCount.toLocaleString(), fmt$(s.ourOpenTotal))}
        ${tile('Open on Velocity', s.velocityOpenCount.toLocaleString(), fmt$(s.velocityOpenTotal))}
        ${tile('Matched open', s.matched.toLocaleString(), 'open both sides')}
        ${tile('Ours only', s.oursOnly.toLocaleString(), fmt$(s.oursOnlyTotal) + ' not open on Velocity', s.oursOnly > 0)}
        ${tile('Velocity only', s.velocityOnly.toLocaleString(), fmt$(s.velocityOnlyTotal) + ' likely paid — close there', s.velocityOnly > 0)}
        ${tile('Balance mismatches', s.balanceMismatch.toLocaleString(), 'differ by > $1', s.balanceMismatch > 0)}
      </div>
      ${table('Open here, not open on Velocity', r.oursOnly, [
        ['<input type=\"checkbox\" onclick=\"document.querySelectorAll(\'.velrecon-pick\').forEach(c=>c.checked=this.checked)\">', x => `<input type=\"checkbox\" class=\"velrecon-pick\" value=\"${escHtml(x.invoiceId)}\">`],
        ['Invoice', x => escHtml(x.invoiceId)], ['Customer', x => escHtml(x.customer || '')],
        ['Velocity status', x => escHtml(x.velocityStatus)], ['Our balance', x => fmt$(x.balance), 1]],
        'Candidates to transmit, or intentionally unsubmitted. Tick rows and use the button below.')}
      ${r.oursOnly.length && commsIsManager() ? `<div style="margin-top:8px"><button class="btn-sm" style="background:#1a1814;color:#fff;border:none;padding:7px 16px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsReconTransmitSelected(this)">🚀 Transmit selected to InterNex (LOC1)</button></div>` : ''}
      ${table('Open on Velocity, not open here', r.velocityOnly, [
        ['Invoice', x => escHtml(x.invoiceId)], ['Customer', x => escHtml(x.customer || '')],
        ['Account', x => escHtml(x.account || '')], ['Velocity balance', x => fmt$(x.velocityBalance), 1]],
        'Paid or closed in Sage but still open on the lender side — these should be closed on Velocity.')}
      ${table('Balance mismatches', r.balanceMismatch, [
        ['Invoice', x => escHtml(x.invoiceId)], ['Customer', x => escHtml(x.customer || '')],
        ['Ours', x => fmt$(x.ourBalance), 1], ['Velocity', x => fmt$(x.velocityBalance), 1],
        ['Diff', x => fmt$(x.ourBalance - x.velocityBalance), 1]])}`;
  } catch (e) { out.innerHTML = `<div style="padding:14px;color:var(--red)">${escHtml(e.message)}</div>`; }
  btn.disabled = false; btn.textContent = '⚖ Reconcile';
}

async function commsVelocityTransmit(prefix, from, to, btn, line) {
  const retrans = document.getElementById('vel-retrans').checked;
  let confirmLoc2 = false;
  if (line === 'LOC2') {
    const typed = prompt('EXPRESS LOC2 TRANSMIT — these Amazon invoices upload to Line of Credit 2 (facility 144).\n\nType LOC2 to confirm:');
    if (typed !== 'LOC2') { alert('Cancelled — LOC2 requires typing LOC2 exactly.'); return; }
    confirmLoc2 = true;
  } else if (!confirm(`Transmit ${prefix}-${velPad(prefix, from)}${to !== from ? ' through ' + prefix + '-' + velPad(prefix, to) : ''} to InterNex Capital (LOC1)?${retrans ? ' (including retransmits)' : ''}\n\nThis runs the live browser upload on the iMac.`)) return;
  btn.disabled = true; btn.textContent = '🚀 Transmitting…';
  try {
    const r = await apiFetch('/api/velocity/transmit', { method: 'POST', body: JSON.stringify({ prefix, from, to, includeRetransmit: retrans, line, confirmLoc2 }) });
    alert(`${r.ok ? 'Success' : 'FAILED'} — batch ${r.batch}: ${r.count} invoice(s)${r.skippedRetrans ? `, ${r.skippedRetrans} skipped (already sent)` : ''}\n\nUploader output tail:\n${(r.output || '').slice(-400)}`);
    commsLoadVelocity();
  } catch (e) { alert('Transmit failed: ' + e.message); btn.disabled = false; btn.textContent = '🚀 Transmit to InterNex'; }
}

async function commsReconTransmitSelected(btn) {
  const ids = [...document.querySelectorAll('.velrecon-pick:checked')].map(x => x.value);
  if (!ids.length) { alert('Tick at least one invoice.'); return; }
  if (!confirm(`Transmit ${ids.length} selected invoice(s) to InterNex (LOC1 rules apply; LOC2 candidates are skipped)?`)) return;
  btn.disabled = true; btn.textContent = '🚀 Transmitting…';
  try {
    const r = await apiFetch('/api/velocity/transmit', { method: 'POST', body: JSON.stringify({ invoiceIds: ids, line: 'LOC1' }) });
    alert(`${r.ok ? 'Success' : 'FAILED'} — ${r.count} invoice(s) sent (batch ${r.batch}).\n\n${(r.output || '').slice(-300)}`);
    document.getElementById('velrecon-modal').style.display = 'none';
    commsLoadVelocity();
  } catch (e) { alert('Transmit failed: ' + e.message); }
  btn.disabled = false; btn.textContent = '🚀 Transmit selected to InterNex (LOC1)';
}

async function commsVelocitySync(btn) {
  btn.disabled = true; btn.textContent = '⟳ Syncing…';
  try { const r = await apiFetch('/api/velocity/sync-feed', { method: 'POST' }); alert('Synced: ' + JSON.stringify(r)); commsLoadVelocity(); }
  catch (e) { alert('Sync failed: ' + e.message); }
}

// ─── Unified notifications bell (mentions + needs-reply + triage) ────────────
async function commsUnifiedBell() {
  try {
    const [m, a] = await Promise.all([
      apiFetch('/api/mentions'),
      apiFetch('/api/comms/action-items').catch(() => ({ needsReplyTotal: 0, triage: 0, items: [] })),
    ]);
    const unconfirmed = (m.unconfirmedCount != null ? m.unconfirmedCount : m.unseenCount) || 0;
    const total = unconfirmed + (a.needsReplyTotal || 0) + (a.triage || 0);
    const badge = document.getElementById('mention-badge');
    if (badge) { badge.textContent = total > 99 ? '99+' : total; badge.style.display = total > 0 ? '' : 'none'; }
    const el = document.getElementById('mention-list');
    if (!el) return;
    let html = '';
    if (a.needsReplyTotal || a.triage) {
      html += `<div style="padding:8px 16px;background:#faf8f3;font-size:11px;font-weight:700;color:#6b6458;letter-spacing:.05em">CONVERSATIONS</div>`;
      html += (a.items || []).slice(0, 5).map(cv => `
        <div class="mention-item" onclick="closeMentionDropdown();navGo('comms-mailbox');setTimeout(() => commsOpenThread(${cv.id}), 400)">
          <div class="mention-item-invoice">📩 ${escHtml(cv.customer_id || 'unfiled')} <span style="float:right;background:#fee2e2;color:#b91c1c;padding:0 6px;border-radius:7px;font-size:9.5px;font-weight:700">NEEDS REPLY</span></div>
          <div class="mention-item-body">${escHtml((cv.subject || '').replace(/\s*\[ECF#[^\]]+\]/, '').slice(0, 70))}</div>
        </div>`).join('');
      if (a.triage) html += `<div class="mention-item" onclick="closeMentionDropdown();navGo('comms-triage')"><div class="mention-item-invoice">🚨 Triage</div><div class="mention-item-body">${a.triage} unfiled thread(s) need attention</div></div>`;
    }
    if (m.mentions && m.mentions.length) {
      html += `<div style="padding:8px 16px;background:#faf8f3;font-size:11px;font-weight:700;color:#6b6458;letter-spacing:.05em">MENTIONS</div>`;
      renderMentionList(m.mentions);
      html += el.innerHTML;
    }
    el.innerHTML = html || '<div class="mention-empty">All clear — nothing needs you.</div>';
  } catch (e) { /* quiet */ }
}
loadMentions = commsUnifiedBell;

// ─── Stop Service list (their Operations screen) ─────────────────────────────
async function commsLoadStopService() {
  const root = document.getElementById('stopservice-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const rows = await apiFetch('/api/stop-service-view');
    const fmt$ = (n) => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    root.innerHTML = `
      <h1 style="font-size:26px;font-weight:700;margin:6px 0 12px">Stop Service</h1>
      ${rows.length ? `<div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="text-align:left;color:#6b6458;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em">
            ${['Customer', 'Service Centers', 'Past Due', 'Oldest Past Due', 'Effective Date', 'Issued By'].map(x => `<th style="padding:8px 12px">${x}</th>`).join('')}
          </tr></thead>
          <tbody>${rows.map(r => `
            <tr style="border-top:1px solid #f1ede3;cursor:pointer" onclick="commsOpenCustomerPage('${escHtml(r.customerId)}')">
              <td style="padding:9px 12px;font-weight:600">${escHtml(r.name || r.customerId)}</td>
              <td style="padding:9px 12px">${commsScChips(r.scs)}</td>
              <td style="padding:9px 12px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;color:#b32020">${fmt$(r.pastDue)}</td>
              <td style="padding:9px 12px">${r.oldest ? `<span class="age-pill ${commsAgePillClass(r.oldest)}">${r.oldest}d</span>` : '—'}</td>
              <td style="padding:9px 12px">${escHtml(r.effectiveDate || '—')}</td>
              <td style="padding:9px 12px;font-size:12px">${escHtml((r.issuedBy || '—').split('@')[0])}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>` : '<div style="padding:30px;text-align:center;color:#6b6458">No customers currently on stop service.</div>'}`;
  } catch (e) { root.innerHTML = `<div style="padding:40px;color:var(--red)">${escHtml(e.message)}</div>`; }
}

// ─── Service Centers rollup ──────────────────────────────────────────────────
async function commsLoadServiceCenters() {
  const root = document.getElementById('servicecenters-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const locs = await apiFetch('/api/locations-view');
    const fmt$ = (n) => '$' + (n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
    root.innerHTML = `
      <h1 style="font-size:26px;font-weight:700;margin:6px 0 12px">Service Centers</h1>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        ${locs.map(r => `
          <div style="min-width:230px;flex:1;max-width:320px;background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:14px 16px">
            <div style="display:flex;justify-content:space-between;align-items:center">${r.sc ? commsScChips([r.sc]) : ''}<span style="font-size:11px;color:#6b6458">${r.customers} customers</span></div>
            <div style="font-weight:700;font-size:14px;margin:6px 0 2px">${escHtml(r.locationName)}</div>
            <div style="font-size:13px;font-variant-numeric:tabular-nums"><span style="color:#b32020;font-weight:700">${fmt$(r.pastDue)}</span> past due · ${fmt$(r.totalAR)} total</div>
            <div style="font-size:11.5px;color:#6b6458">${r.invoices.toLocaleString()} open invoices</div>
          </div>`).join('')}
      </div>`;
  } catch (e) { root.innerHTML = `<div style="padding:40px;color:var(--red)">${escHtml(e.message)}</div>`; }
}

// ─── Overview dashboard (Phase 2 — their home screen, live data) ─────────────

function commsAgePillClass(days) {
  if (days <= 30) return 'age-low';
  if (days <= 60) return 'age-mid';
  if (days <= 90) return 'age-high';
  return 'age-severe';
}

function commsScChips(codes) {
  const KNOWN = ['ASC','BSC','BTSC','CTSC','FC','HSC','HTSC','SCSC','SSC','TSC','RTSC','PTSC'];
  return (codes || []).map(c =>
    `<span class="sc-chip ${KNOWN.includes(c) ? 'sc-' + c : 'sc-unknown'}">${escHtml(c)}</span>`).join(' ');
}

async function commsLoadOverview() {
  const root = document.getElementById('overview-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const o = await apiFetch('/api/overview');
    const fmt$ = (n) => '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tile = (label, value, sub, accent) => `
      <div style="flex:1;min-width:200px;background:#fff;border:1px solid var(--line,#e7e1d4);${accent ? 'border-left:4px solid ' + accent + ';' : ''}border-radius:14px;padding:16px 18px">
        <div style="font-size:11px;font-weight:600;letter-spacing:.06em;color:#6b6458;text-transform:uppercase">${label}</div>
        <div style="font-size:26px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums">${value}</div>
        <div style="font-size:12px;color:#6b6458;margin-top:2px">${sub}</div>
      </div>`;
    const maxBucket = Math.max(1, ...Object.values(o.buckets));
    const barColor = { '1-30': '#e8b93c', '31-60': '#e0862f', '61-90': '#d64530', '91-180': '#a02020', '181+': '#7a1a1a' };
    root.innerHTML = `
      <h1 style="font-size:26px;font-weight:700;margin:6px 0 2px">AR Dashboard</h1>
      <div style="font-size:12.5px;color:#6b6458;margin-bottom:16px">Role: ${escHtml(o.role)} · Service centers: ${commsScChips(o.serviceCenters)}</div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
        ${tile('Total AR', fmt$(o.totalAR), o.openInvoices.toLocaleString() + ' open invoices', '#3763a0')}
        ${tile('Past Due AR', fmt$(o.pastDueAR), o.pastDueCount.toLocaleString() + ' past due invoices', '#b32020')}
        ${tile('Current AR', fmt$(o.currentAR), 'Not currently past due', '#3f7238')}
        ${tile('Customers', o.customers.toLocaleString(), 'with open AR · ' + o.serviceCenters.length + ' service centers', null)}
        ${tile('Oldest Still Open', o.oldestDays + 'd', 'days past due', null)}
      </div>

      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:16px">
        <div style="flex:1.4;min-width:380px;background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:16px 20px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
            <div style="font-size:16px;font-weight:700">Aging Breakdown</div>
            <div style="font-size:11.5px;color:#6b6458">Remaining past-due dollars by bucket</div>
          </div>
          ${Object.entries(o.buckets).map(([k, v]) => `
            <div style="margin-bottom:11px">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px">
                <span>${k} days</span><span style="font-variant-numeric:tabular-nums">${fmt$(v)}</span>
              </div>
              <div style="height:7px;background:#f1ede3;border-radius:4px;overflow:hidden">
                <div style="height:100%;width:${Math.max(1, Math.round((v / maxBucket) * 100))}%;background:${barColor[k]};border-radius:4px"></div>
              </div>
            </div>`).join('')}
        </div>
        <div style="flex:1;min-width:280px;background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:16px 20px">
          <div style="font-size:16px;font-weight:700;margin-bottom:12px">Quick Stats</div>
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:7px 0;border-bottom:1px solid #f1ede3"><span style="color:#6b6458">Total AR (visible)</span><span style="font-variant-numeric:tabular-nums;font-weight:600">${fmt$(o.totalAR)}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:7px 0;border-bottom:1px solid #f1ede3"><span style="color:#6b6458">Sent to legal</span><span style="font-variant-numeric:tabular-nums;font-weight:600">${fmt$(o.sentToLegal)}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:7px 0"><span style="color:#6b6458">% past due</span><span style="font-variant-numeric:tabular-nums;font-weight:600">${o.pctPastDue}%</span></div>
        </div>
      </div>

      <div style="background:#fff;border:1px solid var(--line,#e7e1d4);border-radius:14px;padding:16px 20px">
        <div style="font-size:16px;font-weight:700">Top 10 past-due customers</div>
        <div style="font-size:11.5px;color:#6b6458;margin-bottom:10px">Ranked by remaining past-due balance</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="text-align:left;color:#6b6458;font-size:11px;text-transform:uppercase;letter-spacing:.05em">
            <th style="padding:7px 10px">Customer</th><th style="padding:7px 10px">SC</th>
            <th style="padding:7px 10px;text-align:right">Invoices</th><th style="padding:7px 10px">Oldest</th>
            <th style="padding:7px 10px;text-align:right">Past Due Balance</th>
          </tr></thead>
          <tbody>${o.top10.map(c => `
            <tr style="border-top:1px solid #f1ede3;cursor:pointer" onclick="filterByCustomer('${escHtml(c.id)}')">
              <td style="padding:9px 10px"><div style="font-weight:600">${escHtml(c.name)}</div><div style="font-size:11px;color:#6b6458">${escHtml(c.id)}</div></td>
              <td style="padding:9px 10px">${commsScChips(c.scs)}</td>
              <td style="padding:9px 10px;text-align:right;font-variant-numeric:tabular-nums">${c.invoices.toLocaleString()}</td>
              <td style="padding:9px 10px"><span class="age-pill ${commsAgePillClass(c.oldest)}">${c.oldest}d</span></td>
              <td style="padding:9px 10px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">${fmt$(c.pastDue)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;
  } catch (e) {
    root.innerHTML = `<div style="padding:40px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

// ─── Collection status (drawer control; collector sets, AR updates) ──────────

let _csVocab = null;
async function commsCollectionVocab() {
  if (!_csVocab) _csVocab = (await apiFetch('/api/collection-status')).statuses;
  return _csVocab;
}

function commsCsClass(status) {
  return 'cs-' + String(status || 'open').toLowerCase().replace(/[^a-z]+/g, '-');
}

async function commsDecorateDrawerStatus(inv) {
  try {
    const all = await apiFetch('/api/collection-status');
    const vocab = all.statuses;
    const cur = all.byRecord[inv.recordNo];
    const line = document.getElementById('drawer-contact-line');
    if (!line) return;
    const old = document.getElementById('drawer-cs-line');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'drawer-cs-line';
    el.style.cssText = 'padding:8px 12px;background:#faf8f3;border:1px solid #e7e1d4;border-radius:8px;margin-bottom:10px;font-size:12.5px;display:flex;justify-content:space-between;align-items:center;gap:8px';
    el.innerHTML = `
      <span>Collection status: <span class="cs-chip ${commsCsClass(cur ? cur.status : 'Open')}">${escHtml(cur ? cur.status : 'Open')}</span>
        ${cur ? `<span style="color:var(--gray-500);font-size:11px;margin-left:6px">set by ${escHtml((cur.set_by || '').split('@')[0])} · ${escHtml((cur.updated_at || '').slice(0, 10))}</span>` : ''}</span>
      ${commsCanEdit() ? `<select style="padding:4px 8px;border:1px solid var(--gray-200);border-radius:6px;font-size:12px" onchange="commsSetCollectionStatus('${escHtml(inv.recordNo)}', this.value, this)">
        <option value="">change…</option>
        ${vocab.map(s => `<option value="${escHtml(s)}" ${cur && cur.status === s ? 'disabled' : ''}>${escHtml(s)}</option>`).join('')}
      </select>` : ''}`;
    line.insertAdjacentElement('afterend', el);
  } catch (e) { /* decoration only */ }
}

async function commsSetCollectionStatus(recordNo, status, sel) {
  if (!status) return;
  try {
    await apiFetch(`/api/invoice/${encodeURIComponent(recordNo)}/collection-status`, {
      method: 'POST', body: JSON.stringify({ status }),
    });
    const chip = sel.closest('#drawer-cs-line').querySelector('.cs-chip');
    chip.textContent = status;
    chip.className = 'cs-chip ' + commsCsClass(status);
    sel.value = '';
  } catch (e) { alert('Status update failed: ' + e.message); }
}

// ─── Customer attachments (in the customer hub modal) ────────────────────────

async function commsLoadAttachments(customerId, containerId) {
  const wrap = document.getElementById(containerId || 'contacts-attachments');
  if (!wrap) return;
  try {
    const files = await apiFetch(`/api/customers/${encodeURIComponent(customerId)}/attachments`);
    wrap.innerHTML = `
      <div style="border-top:1px solid var(--gray-100);margin-top:12px;padding-top:10px">
        <div style="font-size:12px;font-weight:700;color:var(--gray-600);margin-bottom:6px">ATTACHMENTS (${files.length})</div>
        ${files.map(f => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:12.5px;gap:8px">
            <span>📎 <a href="/api/attachments/${f.id}/download" style="color:#1d4ed8;text-decoration:none">${escHtml(f.filename)}</a>
              <span style="color:var(--gray-400);font-size:11px">${Math.round((f.size || 0) / 1024)}KB · ${escHtml((f.uploaded_by || '').split('@')[0])} · ${escHtml((f.uploaded_at || '').slice(0, 10))}</span></span>
            ${commsCanEdit() ? `<button class="btn-sm" style="background:#fee2e2;color:#b91c1c;border:none;padding:2px 8px;border-radius:5px;cursor:pointer;font-size:11px" onclick="commsRemoveAttachment(${f.id}, '${escHtml(customerId)}')">✕</button>` : ''}
          </div>`).join('') || '<div style="font-size:12px;color:var(--gray-400);padding:4px 0">No files yet.</div>'}
        ${commsCanEdit() ? `
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
            <input type="file" id="contacts-att-file" style="font-size:12px">
            <button class="btn-sm" style="background:var(--navy);color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px" onclick="commsUploadAttachment('${escHtml(customerId)}', this)">Upload</button>
          </div>` : ''}
      </div>`;
  } catch (e) {
    wrap.innerHTML = `<div style="font-size:12px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

async function commsUploadAttachment(customerId, btn) {
  const input = document.getElementById('contacts-att-file');
  const file = input.files && input.files[0];
  if (!file) { alert('Choose a file first.'); return; }
  if (file.size > 15 * 1024 * 1024) { alert('15MB max.'); return; }
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    const dataBase64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    await apiFetch(`/api/customers/${encodeURIComponent(customerId)}/attachments`, {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, contentType: file.type, dataBase64 }),
    });
    commsLoadAttachments(customerId, document.getElementById('custpage-attachments-inner') ? 'custpage-attachments-inner' : undefined);
  } catch (e) { alert('Upload failed: ' + e.message); }
  btn.disabled = false; btn.textContent = 'Upload';
}

async function commsRemoveAttachment(id, customerId) {
  if (!confirm('Remove this attachment from the list? The file is archived, not destroyed.')) return;
  try {
    await apiFetch(`/api/attachments/${id}`, { method: 'DELETE' });
    commsLoadAttachments(customerId, document.getElementById('custpage-attachments-inner') ? 'custpage-attachments-inner' : undefined);
  } catch (e) { alert('Failed: ' + e.message); }
}

// ─── Live-data footer (replaces their "Last Reconciled" line) ────────────────
async function commsUpdateFooter() {
  try {
    const c = await apiFetch('/api/comms/config');
    const el = document.getElementById('live-footer-age');
    if (el && c.sageCacheAgeMin != null) el.textContent = ` · Sage synced ${c.sageCacheAgeMin}m ago`;
  } catch (e) { /* quiet */ }
}

// ─── URL routing: the address bar tracks the current view so refresh and
// back/forward keep your place (Edwin 2026-08-13: refresh was resetting to
// the dashboard). Hash format: #view or #customer-page/C-00576.
(function commsRouting() {
  const orig = typeof switchView === 'function' ? switchView : null;
  if (orig) {
    switchView = function (name, el) {
      orig(name, el);
      try {
        if (name !== 'customer-page') history.replaceState(null, '', '#' + name);
      } catch (e) {}
    };
  }
  const restore = () => {
    const h = (location.hash || '').slice(1);
    if (!h) { commsLoadOverview(); return; }
    const [view, param] = h.split('/');
    if (view === 'customer-page' && param) { commsOpenCustomerPage(decodeURIComponent(param)); return; }
    if (document.getElementById('view-' + view)) { navGo(view); return; }
    commsLoadOverview();
  };
  setTimeout(restore, 900);
  window.addEventListener('hashchange', () => {
    const h = (location.hash || '').slice(1);
    const [view, param] = h.split('/');
    const active = document.querySelector('.view.active');
    if (view && active && active.id !== 'view-' + view) {
      if (view === 'customer-page' && param) commsOpenCustomerPage(decodeURIComponent(param));
      else if (document.getElementById('view-' + view)) navGo(view);
    }
  });
})();

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
  const roleGateNav = () => {
    if (!commsUser()) return;
    const fin = document.querySelector('.nav-group[data-group="finance"]');
    if (fin) fin.style.display = commsHasCap('finance.view') ? '' : 'none';
  };
  setTimeout(commsFetchCaps, 1500);
  setInterval(commsFetchCaps, 10 * 60 * 1000);
  const tickAll = () => { tick(); commsUpdateFooter(); roleGateNav(); };
  setTimeout(tickAll, 5000);
  setInterval(tickAll, 2 * 60 * 1000);
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

// ─── Dunning console (redesigned 2026-08-12) ─────────────────────────────────
// Everything is data-driven: rules are created/edited/targeted in the editor
// modal, never in code. Layout: stat tiles → escalation pipeline (rules as
// stepper cards ordered by trigger day, click to edit) → run history.
// Live impact preview shows what a rule would match against TODAY's invoices
// before it is ever saved or activated.

let _dunningCtx = null;   // { rules, templates, config, customers, editing }

(function commsInjectDunningModal() {
  const html = `
<div id="dunning-rule-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)commsDunningCloseEditor()">
  <div class="modal-box" style="width:680px;max-width:95vw;max-height:92vh;overflow-y:auto">
    <h3 id="dunning-rule-title" style="margin-bottom:10px">Dunning rule</h3>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="dr-name" placeholder="Rule name" style="flex:2;min-width:220px;padding:8px 10px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;padding:0 4px"><input type="checkbox" id="dr-active"> Active</label>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label style="flex:1;min-width:130px;font-size:11.5px;color:var(--gray-500)">Triggers at (days past due)
          <input id="dr-trigger" type="number" min="0" style="width:100%;padding:8px 10px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px;margin-top:3px"></label>
        <label style="flex:1;min-width:130px;font-size:11.5px;color:var(--gray-500)">Repeat every (days, blank = once)
          <input id="dr-repeat" type="number" min="1" style="width:100%;padding:8px 10px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px;margin-top:3px"></label>
        <label style="flex:1;min-width:110px;font-size:11.5px;color:var(--gray-500)">Escalation order
          <input id="dr-sequence" type="number" min="1" style="width:100%;padding:8px 10px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px;margin-top:3px"></label>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label style="flex:1.4;min-width:170px;font-size:11.5px;color:var(--gray-500)">Email template
          <select id="dr-template" style="width:100%;padding:8px 10px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px;margin-top:3px"></select></label>
        <label style="flex:1;min-width:130px;font-size:11.5px;color:var(--gray-500)">Billing stream
          <select id="dr-stream" style="width:100%;padding:8px 10px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px;margin-top:3px">
            <option value="all">All (Sage + Omnia)</option>
            <option value="sage">Sage only (ECI-)</option>
            <option value="omnia">Omnia only (AST/ASTM/S-)</option>
          </select></label>
        <label style="flex:0.9;min-width:110px;font-size:11.5px;color:var(--gray-500)">Min invoice $
          <input id="dr-minbal" type="number" min="0" style="width:100%;padding:8px 10px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px;margin-top:3px"></label>
      </div>

      <div style="border:1px solid var(--gray-100);border-radius:10px;padding:10px 12px">
        <div style="font-size:12px;font-weight:700;color:var(--gray-600);margin-bottom:6px">CUSTOMER TARGETING</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:13px;margin-bottom:8px">
          <label style="display:flex;align-items:center;gap:5px"><input type="radio" name="dr-tmode" value="all" onchange="commsDunningTargetModeChanged()"> All customers</label>
          <label style="display:flex;align-items:center;gap:5px"><input type="radio" name="dr-tmode" value="only" onchange="commsDunningTargetModeChanged()"> Only selected</label>
          <label style="display:flex;align-items:center;gap:5px"><input type="radio" name="dr-tmode" value="except" onchange="commsDunningTargetModeChanged()"> All except selected</label>
        </div>
        <div id="dr-target-picker" style="display:none">
          <div id="dr-target-chips" style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px"></div>
          <input id="dr-target-search" placeholder="Search customers to add…" oninput="commsDunningRenderTargetList()"
            style="width:100%;padding:7px 10px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px;margin-bottom:5px">
          <div id="dr-target-list" style="max-height:150px;overflow-y:auto;border:1px solid var(--gray-100);border-radius:8px"></div>
        </div>
      </div>

      <div id="dr-impact" style="background:#f8fafc;border:1px solid var(--gray-100);border-radius:10px;padding:10px 14px;font-size:12.5px;color:var(--gray-600)">
        Impact preview loads as you edit…
      </div>
      <div style="font-size:11.5px;color:var(--gray-500)">Always excluded regardless of targeting: Amazon (EDI collections), stop-service customers, invoices with an open promise to pay, contacts not approved for dunning, and anything already sent this step.</div>
    </div>
    <div class="modal-footer" style="display:flex;justify-content:space-between;gap:8px;margin-top:12px">
      <span id="dr-delete-wrap"></span>
      <span style="display:flex;gap:8px">
        <button class="btn-sm" style="background:#f1f5f9;border:none;padding:7px 14px;border-radius:8px;cursor:pointer" onclick="commsDunningCloseEditor()">Cancel</button>
        <button class="btn-sm" style="background:var(--navy);color:#fff;border:none;padding:7px 18px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsDunningSaveRule(this)">Save rule</button>
      </span>
    </div>
  </div>
</div>`;
  if (document.body) document.body.insertAdjacentHTML('beforeend', html);
  else document.addEventListener('DOMContentLoaded', () => document.body.insertAdjacentHTML('beforeend', html));
})();

async function commsLoadDunning() {
  const root = document.getElementById('comms-dunning-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:30px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const [rules, runs, config, templates, customers, actionItems] = await Promise.all([
      apiFetch('/api/dunning/rules'),
      apiFetch('/api/dunning/runs'),
      apiFetch('/api/comms/config'),
      apiFetch('/api/comms/templates'),
      apiFetch('/api/customers'),
      apiFetch('/api/comms/action-items').catch(() => ({})),
    ]);
    _dunningCtx = { rules, templates, config, customers, editing: null, targetSel: new Set() };

    // Impact per rule, in parallel (small N)
    const impacts = await Promise.all(rules.map(r => apiFetch('/api/dunning/rules/impact', {
      method: 'POST',
      body: JSON.stringify({
        trigger_days_past_due: r.trigger_days_past_due, min_invoice_balance: r.min_invoice_balance,
        billing_stream: r.billing_stream, target_mode: r.target_mode || 'all',
        target_customers: JSON.parse(r.target_customers || '[]'),
      }),
    }).catch(() => null)));
    rules.forEach((r, i) => r._impact = impacts[i]);

    const activeRules = rules.filter(r => r.active);
    const reachableNow = activeRules.length
      ? activeRules.reduce((s, r) => Math.max(s, (r._impact && r._impact.reachable) || 0), 0) : 0;
    const lastRun = runs[0];
    const lastStats = lastRun && lastRun.stats_json ? JSON.parse(lastRun.stats_json) : null;

    const tile = (num, label, sub) => `
      <div style="flex:1;min-width:150px;background:#fff;border:1px solid var(--gray-100);border-radius:12px;padding:14px 16px">
        <div style="font-size:24px;font-weight:700;color:var(--navy);line-height:1.1">${num}</div>
        <div style="font-size:12px;font-weight:600;color:var(--gray-600);margin-top:2px">${label}</div>
        ${sub ? `<div style="font-size:11px;color:var(--gray-500);margin-top:1px">${sub}</div>` : ''}
      </div>`;

    const sorted = [...rules].sort((a, b) => a.trigger_days_past_due - b.trigger_days_past_due || a.sequence - b.sequence);
    const targetLabel = (r) => {
      const n = JSON.parse(r.target_customers || '[]').length;
      if (r.target_mode === 'only') return `🎯 ${n} customer${n === 1 ? '' : 's'} only`;
      if (r.target_mode === 'except') return `🚫 all except ${n}`;
      return '🌐 all customers';
    };

    root.innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin:4px 0 16px">
        ${tile(config.dunningArmed ? '🟢' : '🔒', config.dunningArmed ? 'Engine armed' : 'Engine unarmed', config.dunningArmed ? 'live sends enabled' : 'preview only — arming is the go-live step')}
        ${tile(activeRules.length + '<span style="font-size:14px;color:var(--gray-400)">/' + rules.length + '</span>', 'Rules active', activeRules.length ? '' : 'activate rules to start matching')}
        ${tile(String(reachableNow), 'Customers reachable now', 'match a rule + dunning-approved contact')}
        ${tile(lastStats ? String(lastStats.digests || 0) : '—', 'Digests in last run', lastRun ? new Date((lastRun.started_at || '').replace(' ', 'T') + 'Z').toLocaleString() : 'no runs yet')}
      </div>
      ${config.testMode ? `<div style="background:#fef3c7;color:#92400e;padding:8px 14px;border-radius:10px;font-size:12px;font-weight:600;margin-bottom:14px">🧪 TEST MODE — every send (including armed dunning runs) is restricted to the internal allowlist until it is cleared.</div>` : ''}

      <div style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 10px">
        <div style="font-size:13px;font-weight:700;color:var(--gray-600);text-transform:uppercase;letter-spacing:.05em">Escalation pipeline</div>
        ${commsIsManager() ? `<button class="btn-sm" style="background:var(--navy);color:#fff;border:none;padding:6px 14px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsDunningGenerate(this)">▶ Generate preview run</button>` : ''}
      </div>
      <div style="display:flex;gap:0;align-items:stretch;overflow-x:auto;padding-bottom:8px">
        ${sorted.map((r, i) => `
          ${i > 0 ? '<div style="align-self:center;color:var(--gray-300);font-size:18px;padding:0 2px">→</div>' : ''}
          <div onclick="commsDunningOpenEditor(${r.id})" style="min-width:200px;max-width:230px;background:#fff;border:2px solid ${r.active ? 'var(--navy)' : 'var(--gray-200)'};border-radius:12px;padding:12px 14px;cursor:pointer;opacity:${r.active ? 1 : 0.62}">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <span style="background:${r.active ? 'var(--navy)' : 'var(--gray-200)'};color:${r.active ? '#fff' : 'var(--gray-600)'};padding:2px 9px;border-radius:9px;font-size:11px;font-weight:700">Day ${r.trigger_days_past_due}${r.repeat_every_days ? '+' : ''}</span>
              <span style="font-size:10.5px;font-weight:700;color:${r.active ? '#15803d' : 'var(--gray-400)'}">${r.active ? '● ACTIVE' : '○ inactive'}</span>
            </div>
            <div style="font-weight:600;font-size:13px;line-height:1.25;margin-bottom:3px">${escHtml(r.name)}</div>
            <div style="font-size:11px;color:var(--gray-500)">${escHtml(r.template_key)} · ${r.repeat_every_days ? 'every ' + r.repeat_every_days + 'd' : 'once'} · ${r.billing_stream === 'all' ? 'both streams' : r.billing_stream}</div>
            <div style="font-size:11px;color:var(--gray-500);margin-top:2px">${targetLabel(r)}</div>
            ${r._impact ? `<div style="border-top:1px solid var(--gray-100);margin-top:7px;padding-top:6px;font-size:11.5px;color:var(--gray-600)">
              matches <strong>${r._impact.customers}</strong> cust · <strong>${r._impact.invoices}</strong> inv · <strong>$${Math.round(r._impact.totalDue).toLocaleString()}</strong>
              <div style="color:${r._impact.reachable ? '#15803d' : 'var(--gray-400)'}">✉ ${r._impact.reachable} reachable now</div></div>` : ''}
          </div>`).join('')}
        ${commsIsManager() ? `
          <div style="align-self:center;color:var(--gray-300);font-size:18px;padding:0 2px">${sorted.length ? '→' : ''}</div>
          <div onclick="commsDunningOpenEditor(null)" style="min-width:130px;border:2px dashed var(--gray-200);border-radius:12px;display:flex;align-items:center;justify-content:center;color:var(--gray-400);font-weight:600;font-size:13px;cursor:pointer;padding:12px">+ New rule</div>` : ''}
      </div>

      <div style="font-size:13px;font-weight:700;color:var(--gray-600);text-transform:uppercase;letter-spacing:.05em;margin:18px 0 8px">Run history</div>
      <div id="dunning-runs">${runs.length ? runs.map(r => `
        <div style="border:1px solid var(--gray-200);border-radius:10px;padding:10px 14px;margin-bottom:6px;cursor:pointer;background:#fff" onclick="commsDunningOpenRun(${r.id})">
          <strong>Run ${r.id}</strong>
          <span style="background:#f1f5f9;padding:1px 8px;border-radius:9px;font-size:11px;font-weight:600;margin:0 4px">${escHtml(r.mode)}</span>
          ${escHtml((r.started_at || '').slice(0, 16).replace('T', ' '))}
          <span style="font-size:12px;color:var(--gray-500)">by ${escHtml(r.triggered_by || '')}</span>
          <span style="font-size:12px;color:var(--gray-600)">${r.stats_json ? ' · ' + escHtml(commsDunningStatsLine(r.stats_json)) : ''}</span>
        </div>`).join('') : '<div style="padding:14px;color:var(--gray-500);font-size:13px">No runs yet. Generate a preview to see exactly who would be emailed and why others are skipped.</div>'}</div>
      <div id="dunning-run-detail"></div>`;
  } catch (e) {
    root.innerHTML = `<div style="padding:30px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

// ─── Rule editor ─────────────────────────────────────────────────────────────
function commsDunningOpenEditor(ruleId) {
  if (!commsIsManager()) return;
  const c = _dunningCtx;
  const r = ruleId ? c.rules.find(x => x.id === ruleId) : null;
  c.editing = r ? r.id : null;
  c.targetSel = new Set(r ? JSON.parse(r.target_customers || '[]') : []);
  document.getElementById('dunning-rule-modal').style.display = 'flex';
  document.getElementById('dunning-rule-title').textContent = r ? '✎ ' + r.name : '+ New dunning rule';
  document.getElementById('dr-name').value = r ? r.name : '';
  document.getElementById('dr-active').checked = r ? !!r.active : false;
  document.getElementById('dr-trigger').value = r ? r.trigger_days_past_due : 5;
  document.getElementById('dr-repeat').value = r && r.repeat_every_days ? r.repeat_every_days : '';
  document.getElementById('dr-sequence').value = r ? r.sequence : (Math.max(0, ...c.rules.map(x => x.sequence)) + 1);
  document.getElementById('dr-minbal').value = r ? (r.min_invoice_balance || 0) : 50;
  document.getElementById('dr-stream').value = r ? (r.billing_stream || 'all') : 'all';
  const tsel = document.getElementById('dr-template');
  tsel.innerHTML = c.templates.filter(t => t.kind === 'external' && t.active)
    .map(t => `<option value="${escHtml(t.key)}">${escHtml(t.name || t.key)}</option>`).join('');
  if (r) tsel.value = r.template_key;
  const mode = r ? (r.target_mode || 'all') : 'all';
  document.querySelectorAll('input[name="dr-tmode"]').forEach(x => { x.checked = x.value === mode; });
  document.getElementById('dr-target-search').value = '';
  document.getElementById('dr-delete-wrap').innerHTML = (r && commsUser() && commsUser().role === 'admin')
    ? `<button class="btn-sm" style="background:#fee2e2;color:#b91c1c;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsDunningDeleteRule(${r.id})">Delete rule</button>` : '';
  commsDunningTargetModeChanged();
  // Recompute impact on any field edit
  ['dr-trigger', 'dr-repeat', 'dr-minbal', 'dr-stream'].forEach(id => {
    document.getElementById(id).oninput = commsDunningImpactDebounced;
  });
  commsDunningImpactDebounced();
}

function commsDunningCloseEditor() {
  document.getElementById('dunning-rule-modal').style.display = 'none';
  if (_dunningCtx) _dunningCtx.editing = null;
}

function commsDunningTargetMode() {
  const el = document.querySelector('input[name="dr-tmode"]:checked');
  return el ? el.value : 'all';
}

function commsDunningTargetModeChanged() {
  document.getElementById('dr-target-picker').style.display = commsDunningTargetMode() === 'all' ? 'none' : '';
  commsDunningRenderTargetChips();
  commsDunningRenderTargetList();
  commsDunningImpactDebounced();
}

function commsDunningRenderTargetChips() {
  const c = _dunningCtx;
  const wrap = document.getElementById('dr-target-chips');
  const nameOf = (id) => (c.customers.find(x => x.id === id) || {}).name || id;
  wrap.innerHTML = [...c.targetSel].map(id => `
    <span style="background:#eff6ff;color:#1d4ed8;padding:3px 9px;border-radius:10px;font-size:11.5px;font-weight:600;display:inline-flex;align-items:center;gap:5px">
      ${escHtml(nameOf(id))}
      <span style="cursor:pointer;font-weight:700" onclick="_dunningCtx.targetSel.delete('${escHtml(id)}');commsDunningRenderTargetChips();commsDunningRenderTargetList();commsDunningImpactDebounced()">✕</span>
    </span>`).join('') || '<span style="font-size:11.5px;color:var(--gray-400)">no customers selected yet</span>';
}

function commsDunningRenderTargetList() {
  const c = _dunningCtx;
  const list = document.getElementById('dr-target-list');
  const q = (document.getElementById('dr-target-search').value || '').toLowerCase();
  const rows = c.customers
    .filter(x => !c.targetSel.has(x.id) && (!q || x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q)))
    .slice(0, 40);
  list.innerHTML = rows.length ? rows.map(x => `
    <div style="padding:6px 10px;font-size:12.5px;cursor:pointer;border-bottom:1px solid var(--gray-100)"
      onclick="_dunningCtx.targetSel.add('${escHtml(x.id)}');commsDunningRenderTargetChips();commsDunningRenderTargetList();commsDunningImpactDebounced()">
      ${escHtml(x.name)} <span style="color:var(--gray-400)">${escHtml(x.id)}</span>
    </div>`).join('')
    : '<div style="padding:10px;font-size:12px;color:var(--gray-400)">no matches</div>';
}

let _dunningImpactTimer = null;
function commsDunningImpactDebounced() {
  clearTimeout(_dunningImpactTimer);
  _dunningImpactTimer = setTimeout(commsDunningImpact, 350);
}

async function commsDunningImpact() {
  const el = document.getElementById('dr-impact');
  try {
    const im = await apiFetch('/api/dunning/rules/impact', {
      method: 'POST',
      body: JSON.stringify({
        trigger_days_past_due: document.getElementById('dr-trigger').value,
        min_invoice_balance: document.getElementById('dr-minbal').value,
        billing_stream: document.getElementById('dr-stream').value,
        target_mode: commsDunningTargetMode(),
        target_customers: [..._dunningCtx.targetSel],
      }),
    });
    el.innerHTML = `As of today this rule matches <strong>${im.customers}</strong> customer(s) · <strong>${im.invoices}</strong> invoice(s) · <strong>$${Math.round(im.totalDue).toLocaleString()}</strong>.
      <span style="color:${im.reachable ? '#15803d' : '#b45309'};font-weight:600">✉ ${im.reachable} would actually be emailed</span>
      <span style="color:var(--gray-500)">(${[im.amazon ? im.amazon + ' Amazon' : '', im.stopService ? im.stopService + ' stop-service' : '', im.noContact ? im.noContact + ' without an approved contact' : ''].filter(Boolean).join(', ') || 'no holdouts'})</span>`;
  } catch (e) {
    el.innerHTML = `<span style="color:var(--red)">${escHtml(e.message)}</span>`;
  }
}

async function commsDunningSaveRule(btn) {
  const c = _dunningCtx;
  const body = {
    id: c.editing || undefined,
    name: document.getElementById('dr-name').value.trim(),
    active: document.getElementById('dr-active').checked ? 1 : 0,
    sequence: parseInt(document.getElementById('dr-sequence').value, 10) || 1,
    trigger_days_past_due: parseInt(document.getElementById('dr-trigger').value, 10) || 0,
    repeat_every_days: document.getElementById('dr-repeat').value ? parseInt(document.getElementById('dr-repeat').value, 10) : null,
    template_key: document.getElementById('dr-template').value,
    billing_stream: document.getElementById('dr-stream').value,
    min_invoice_balance: parseFloat(document.getElementById('dr-minbal').value) || 0,
    target_mode: commsDunningTargetMode(),
    target_customers: [...c.targetSel],
  };
  if (!body.name) { alert('Give the rule a name.'); return; }
  btn.disabled = true;
  try {
    await apiFetch('/api/dunning/rules', { method: 'POST', body: JSON.stringify(body) });
    commsDunningCloseEditor();
    commsLoadDunning();
  } catch (e) { alert('Save failed: ' + e.message); }
  btn.disabled = false;
}

async function commsDunningDeleteRule(id) {
  if (!confirm('Delete this rule? Run history is kept; only the rule definition is removed.')) return;
  try {
    await apiFetch(`/api/dunning/rules/${id}`, { method: 'DELETE' });
    commsDunningCloseEditor();
    commsLoadDunning();
  } catch (e) { alert('Delete failed: ' + e.message); }
}

function commsDunningStatsLine(statsJson) {
  try {
    const s = JSON.parse(statsJson);
    const skips = Object.entries(s.skipped || {}).map(([k, v]) => `${k}:${v}`).join(' ');
    return `${s.digests || 0} digests / ${s.eligible || 0} invoices${skips ? ' · skipped ' + skips : ''}`;
  } catch (e) { return ''; }
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
      no_contact: 'No dunning-approved contact', recent_send: 'Emailed within gap window', idempotent: 'Already sent this step', manual: 'Manually skipped',
    };
    el.innerHTML = `
      <div style="border-top:2px solid var(--gray-200);margin-top:14px;padding-top:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
          <strong>Run ${runId} — ${sendable.length} digest(s) ready, ${actions.length - sendable.length} skipped</strong>
          ${commsIsManager() && sendable.length ? `
            <button class="btn-sm" style="background:${config.dunningArmed ? 'var(--navy)' : '#e2e8f0'};color:${config.dunningArmed ? '#fff' : '#94a3b8'};border:none;padding:6px 14px;border-radius:8px;cursor:${config.dunningArmed ? 'pointer' : 'not-allowed'};font-weight:600"
              ${config.dunningArmed ? `onclick="commsDunningExecute(${runId}, this)"` : 'title="Requires DUNNING_ARMED=1 in .env (the go-live step)"'}>
              🚀 Execute run${config.dunningArmed ? '' : ' (unarmed)'}</button>` : ''}
        </div>
        ${actions.map(a => {
          const rns = JSON.parse(a.record_nos || '[]');
          const badge = a.status === 'preview' ? '#dbeafe;color:#1d4ed8' : a.status === 'sent' ? '#dcfce7;color:#15803d'
            : a.status === 'failed' ? '#fee2e2;color:#b91c1c' : '#f1f5f9;color:#64748b';
          return `<div style="border:1px solid var(--gray-200);border-radius:10px;padding:8px 12px;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;background:#fff">
            <span><strong>${escHtml(a.customer_id)}</strong> · ${rns.length} invoice(s) <span style="font-size:11.5px;color:var(--gray-500)">${escHtml(rns.slice(0, 6).join(', '))}${rns.length > 6 ? '…' : ''}</span></span>
            <span style="display:flex;gap:6px;align-items:center">
              <span style="background:${badge};padding:2px 9px;border-radius:10px;font-size:11px;font-weight:700">${escHtml(a.status)}</span>
              ${a.skip_reason ? `<span style="font-size:11.5px;color:var(--gray-500)">${escHtml(reasonLabel[a.skip_reason] || a.skip_reason)}</span>` : ''}
              ${a.status === 'preview' && commsIsManager() ? `<button class="btn-sm" style="background:#f1f5f9;border:none;padding:3px 9px;border-radius:6px;cursor:pointer;font-size:11px" onclick="commsDunningSkipAction(${a.id}, ${runId})">Skip</button>` : ''}
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

// ─── Scheduled statements (2026-08-12) ───────────────────────────────────────
// Per-customer opt-in monthly statement delivery. Engine in statements.js;
// unarmed runs report would-sends without sending.

async function commsLoadStatements() {
  const root = document.getElementById('comms-statements-root');
  if (!root) return;
  root.innerHTML = '<div style="padding:30px;text-align:center;color:var(--gray-500)">Loading…</div>';
  try {
    const [{ armed, schedules }, customers] = await Promise.all([
      apiFetch('/api/statements/schedules'),
      apiFetch('/api/customers'),
    ]);
    window._commsCustomers = customers;
    const nameOf = (id) => (customers.find(x => x.id === id) || {}).name || id;
    root.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0 14px">
        <span style="background:${armed ? '#dcfce7;color:#15803d' : '#fee2e2;color:#b91c1c'};padding:4px 12px;border-radius:12px;font-size:12px;font-weight:700">${armed ? '🟢 ARMED — statements send automatically' : '🔒 UNARMED — schedules only log would-sends'}</span>
        ${commsIsManager() ? `<button class="btn-sm" style="background:#eff6ff;color:#1d4ed8;border:none;padding:6px 14px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsStatementsRunNow(this)">▶ Run now (test)</button>` : ''}
      </div>
      <div style="font-size:12.5px;color:var(--gray-600);margin-bottom:12px">Each enabled customer gets their statement (PDF attached, all open invoices) emailed once a month on/after the chosen day, to the primary contact unless specific contacts are chosen in their Contacts panel. Zero balances and Amazon are skipped automatically.</div>
      ${commsCanEdit() ? `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#fff;border:1px solid var(--gray-100);border-radius:12px;padding:12px 14px;margin-bottom:14px">
        <select id="stmt-add-cust" style="flex:2;min-width:220px;padding:8px 10px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px">
          <option value="">Add customer to statement schedule…</option>
          ${customers.filter(c => !schedules.some(s => s.customer_id === c.id)).map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)} (${escHtml(c.id)})</option>`).join('')}
        </select>
        <label style="font-size:12px;color:var(--gray-500)">on day <input id="stmt-add-day" type="number" min="1" max="28" value="1" style="width:60px;padding:8px;border:1px solid var(--gray-200);border-radius:8px;font-size:13px"></label>
        <button class="btn-sm" style="background:var(--navy);color:#fff;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:600" onclick="commsStatementsAdd()">+ Schedule</button>
      </div>` : ''}
      ${schedules.length ? `<table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border:1px solid var(--gray-100);border-radius:12px;overflow:hidden">
        <thead><tr style="text-align:left;color:var(--gray-500);font-size:11px;text-transform:uppercase;background:#f8fafc">
          <th style="padding:8px 12px">Enabled</th><th style="padding:8px 12px">Customer</th><th style="padding:8px 12px">Sends on day</th>
          <th style="padding:8px 12px">Recipients</th><th style="padding:8px 12px">Last sent</th><th style="padding:8px 12px"></th>
        </tr></thead>
        <tbody>${schedules.map(s => `
          <tr style="border-top:1px solid var(--gray-100)">
            <td style="padding:8px 12px">${commsCanEdit() ? `<span style="cursor:pointer;font-size:16px" onclick="commsStatementsToggle('${escHtml(s.customer_id)}', ${s.enabled ? 0 : 1}, ${s.day_of_month})">${s.enabled ? '🟢' : '⚪'}</span>` : (s.enabled ? '🟢' : '⚪')}</td>
            <td style="padding:8px 12px"><strong>${escHtml(nameOf(s.customer_id))}</strong> <span style="color:var(--gray-400);font-size:11.5px">${escHtml(s.customer_id)}</span></td>
            <td style="padding:8px 12px">${commsCanEdit() ? `<input type="number" min="1" max="28" value="${s.day_of_month}" style="width:56px;padding:5px;border:1px solid var(--gray-200);border-radius:6px;font-size:12.5px" onchange="commsStatementsToggle('${escHtml(s.customer_id)}', ${s.enabled}, this.value)">` : s.day_of_month}</td>
            <td style="padding:8px 12px;font-size:12px;color:var(--gray-600)">${s.contact_ids ? JSON.parse(s.contact_ids).length + ' selected' : 'primary contact'}
              ${commsCanEdit() ? `<button class="btn-sm" style="background:#f1f5f9;border:none;padding:2px 8px;border-radius:5px;cursor:pointer;font-size:11px;margin-left:4px" onclick="commsPickStmtRecipients('${escHtml(s.customer_id)}', ${s.enabled}, ${s.day_of_month})">choose…</button>` : ''}</td>
            <td style="padding:8px 12px;font-size:12px;color:var(--gray-500)">${escHtml(s.last_sent_period || 'never')}</td>
            <td style="padding:8px 12px"></td>
          </tr>`).join('')}</tbody></table>`
        : '<div style="padding:24px;text-align:center;color:var(--gray-500)">No statement schedules yet. Add a customer above to start automated delivery.</div>'}
      <div id="stmt-run-result" style="margin-top:12px"></div>`;
  } catch (e) {
    root.innerHTML = `<div style="padding:30px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

async function commsStatementsAdd() {
  const cust = document.getElementById('stmt-add-cust').value;
  const day = document.getElementById('stmt-add-day').value;
  if (!cust) { alert('Pick a customer.'); return; }
  try {
    await apiFetch(`/api/statements/schedules/${encodeURIComponent(cust)}`, { method: 'POST', body: JSON.stringify({ enabled: 1, day_of_month: day }) });
    commsLoadStatements();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function commsStatementsToggle(customerId, enabled, day) {
  try {
    await apiFetch(`/api/statements/schedules/${encodeURIComponent(customerId)}`, { method: 'POST', body: JSON.stringify({ enabled, day_of_month: day }) });
    commsLoadStatements();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function commsPickStmtRecipients(customerId, enabled, day) {
  try {
    const contacts = await apiFetch(`/api/customers/${encodeURIComponent(customerId)}/contacts`);
    if (!contacts.length) { alert('No contacts on file — add one in the Contacts panel first.'); return; }
    const listing = contacts.map((x, i) => `${i + 1}. ${x.name || x.email} <${x.email}>${x.is_primary ? ' ⭐' : ''}`).join('\n');
    const pick = prompt(`Statement recipients for ${customerId} — enter numbers separated by commas, or blank for primary contact only:\n\n${listing}`);
    if (pick === null) return;
    const ids = pick.trim() ? pick.split(/[ ,]+/).map(n => (contacts[parseInt(n, 10) - 1] || {}).id).filter(Boolean) : [];
    await apiFetch(`/api/statements/schedules/${encodeURIComponent(customerId)}`, { method: 'POST', body: JSON.stringify({ enabled, day_of_month: day, contact_ids: ids }) });
    commsLoadStatements();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function commsStatementsRunNow(btn) {
  if (!confirm('Run the statement schedules now? Unarmed, this only reports who WOULD receive a statement. Armed, it sends (allowlist still applies).')) return;
  btn.disabled = true; btn.textContent = '▶ Running…';
  try {
    const r = await apiFetch('/api/statements/run', { method: 'POST', body: JSON.stringify({ force: true }) });
    document.getElementById('stmt-run-result').innerHTML = `
      <div style="background:#f8fafc;border:1px solid var(--gray-100);border-radius:10px;padding:12px 14px;font-size:12.5px">
        <strong>Run result (${escHtml(r.period)}):</strong> ${r.sent} sent · ${r.wouldSend} would-send · ${r.failed} failed · ${r.skipped} skipped
        ${(r.results || []).filter(x => x.status !== 'skipped' || x.reason !== 'disabled').map(x => `<div style="margin-top:4px">${escHtml(x.customerId)} — <strong>${escHtml(x.status)}</strong> <span style="color:var(--gray-500)">${escHtml(x.reason || '')}</span></div>`).join('')}
      </div>`;
  } catch (e) { alert('Run failed: ' + e.message); }
  btn.disabled = false; btn.textContent = '▶ Run now (test)';
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
    commsDecorateDrawerStatus(inv);

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
