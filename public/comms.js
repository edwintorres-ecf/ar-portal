'use strict';
// ─── comms.js — customer communications UI (AR Portal) ───────────────────────
// Deploy 2 scope: customer contacts management + drawer primary-contact line.
// Loaded by index.html as /comms.js; later deploys add the composer, mailbox,
// triage, and dunning console here so index.html stays lean. Relies on globals
// from index.html: apiFetch, escHtml, currentUser.

const COMMS_AMAZON = ['C-00403', 'C-00566'];

function commsCanEdit() {
  return window.currentUser && ['admin', 'manager', 'ar_specialist'].includes(window.currentUser.role);
}
function commsIsManager() {
  return window.currentUser && ['admin', 'manager'].includes(window.currentUser.role);
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
      <button class="btn-sm" style="background:#f1f5f9;border:none;padding:6px 14px;border-radius:6px;cursor:pointer" onclick="commsCloseContacts()">Close</button>
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

async function commsSyncContacts(btn) {
  btn.disabled = true; btn.textContent = '⟳ Syncing…';
  try {
    const s = await apiFetch('/api/contacts/sync', { method: 'POST' });
    alert(`Sync complete.\n\nInserted: ${s.inserted}\nUpdated: ${s.updated}\nManual rows preserved: ${s.skippedManual}\nCustomers with contacts in Intacct: ${s.customersWithContacts}/${s.customers}`);
    await commsReloadContacts();
  } catch (e) { alert('Sync failed: ' + e.message); }
  btn.disabled = false; btn.textContent = '⟳ Sync from Sage';
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
    line.innerHTML = primary
      ? `<span>👤 <strong>${escHtml(primary.name || primary.email)}</strong>${primary.name ? ` · <span style="font-family:monospace;font-size:11.5px">${escHtml(primary.email)}</span>` : ''}${primary.phone ? ' · ' + escHtml(primary.phone) : ''}</span>
         <button class="btn-sm" style="background:#f1f5f9;border:none;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:11px" onclick="commsOpenContacts('${escHtml(inv.customerId)}','${escHtml(inv.customerName || '')}')">Manage</button>`
      : `<span style="color:var(--gray-500)">No customer contacts on file</span>
         <button class="btn-sm" style="background:#f1f5f9;border:none;padding:3px 10px;border-radius:5px;cursor:pointer;font-size:11px" onclick="commsOpenContacts('${escHtml(inv.customerId)}','${escHtml(inv.customerName || '')}')">${commsCanEdit() ? '+ Add' : 'View'}</button>`;
    const old = document.getElementById('drawer-contact-line');
    if (old) old.remove();
    body.insertBefore(line, body.firstChild);
  } catch (e) { /* decoration only — never break the drawer */ }
}
