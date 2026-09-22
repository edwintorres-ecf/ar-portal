/* ───────────────────────────────────────────────────────────────────────────
   customer.js — redesign Phase 4, the account-centric customer page.

   Header carries the balance, the aging bar and the contacts. Everything else
   goes behind tabs, because the old page stacked KPIs, a service-centre
   breakdown, attachments, notes and up to 200 invoice rows into one column and
   you had to scroll past the lot to reach the invoices.

   No new endpoints. Every tab is fed by something that already exists:
     Invoices      /api/customer-page/:id  (already in the payload)
     Conversations /api/comms/conversations?customerId=
     Statements    /api/customer-statement/:id + /api/statements/schedules
     Notes         commsLoadCustNotes — customer-level notes already existed
     Files         commsLoadAttachments

   The plan lists four tabs. Files is a fifth because the old page showed
   customer attachments and dropping them to match the plan would have been a
   regression.
   ─────────────────────────────────────────────────────────────────────────── */
'use strict';

const CUST_TABS = [
  { key: 'invoices',      label: 'Invoices' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'statements',    label: 'Statements' },
  { key: 'notes',         label: 'Notes' },
  { key: 'files',         label: 'Files' },
];
const CUST_AGE_COLORS = {
  current: 'var(--ramp-1)', '1-30': 'var(--ramp-2)', '31-60': 'var(--ramp-3)',
  '61-90': 'var(--ramp-4)', '91+': 'var(--age-4)',
};
let _cust = { id: null, data: null, tab: 'invoices', contacts: [] };

async function custLoad() {
  const root = document.getElementById('customer-page-root');
  if (!root || !_custPageId) return;
  _cust.id = _custPageId;
  _cust.tab = 'invoices';
  root.innerHTML = `<div style="padding:8px 0">${dsSkeleton(2)}
    <div class="ds-tiles" style="margin-top:16px">${'<div class="ds-tile"><div class="ds-skeleton" style="height:52px"></div></div>'.repeat(4)}</div></div>`;
  try {
    const [c] = await Promise.all([
      apiFetch(`/api/customer-page/${encodeURIComponent(_custPageId)}`),
      commsGridMeta(),
    ]);
    _cust.data = c;
    try { _cust.contacts = await apiFetch(`/api/customers/${encodeURIComponent(c.id)}/contacts`); }
    catch (e) { _cust.contacts = []; }
    custRender();
  } catch (e) {
    root.innerHTML = dsCard({ title: 'Customer unavailable',
      body: dsEmpty({ icon: '!', title: 'Could not load this customer', body: e.message }) });
  }
}

function custRender() {
  const c = _cust.data;
  const root = document.getElementById('customer-page-root');
  root.innerHTML = custHeader(c) + custTabStrip() +
    CUST_TABS.map(t => `<div id="cust-pane-${t.key}" class="cust-pane" style="display:none"></div>`).join('');
  custShow(_cust.tab);
}

function custHeader(c) {
  const k = c.kpis || {};
  // Aging computed from the invoices already in the payload rather than a
  // second request.
  const buckets = {};
  for (const i of c.invoices || []) buckets[i.bucket] = (buckets[i.bucket] || 0) + (i.totalDue || 0);
  const segs = ['current', '1-30', '31-60', '61-90', '91+']
    .filter(b => (buckets[b] || 0) > 0)
    .map(b => ({ label: b === 'current' ? 'Current' : b + ' days', value: buckets[b], color: CUST_AGE_COLORS[b] }));

  const primary = _cust.contacts.find(x => x.is_primary) || _cust.contacts[0];
  const canEmail = typeof commsCanEdit === 'function' && commsCanEdit();
  const contactStrip = primary
    ? `<span class="ds-row" style="gap:var(--sp-2)">
         <span>👤 <strong>${dsEsc(primary.name || primary.email)}</strong></span>
         <span class="ds-muted" style="font-size:var(--fs-sm)">${dsEsc(primary.email || '')}</span>
         ${primary.phone ? `<span class="ds-muted" style="font-size:var(--fs-sm)">${dsEsc(primary.phone)}</span>` : ''}
         ${_cust.contacts.length > 1 ? `<span class="ds-chip">+${_cust.contacts.length - 1} more</span>` : ''}
       </span>`
    : '<span class="ds-muted">No contacts on file</span>';

  return `
  <div style="margin:6px 0 var(--sp-4)">
    <div class="ds-muted" style="font-size:var(--fs-xs)">
      <a href="#" onclick="switchView('customers');return false" style="color:inherit">Customers</a> / ${dsEsc(c.id)}
    </div>
    <div class="ds-row" style="flex-wrap:wrap;margin-top:2px">
      <h1 style="font:700 var(--fs-2xl)/1.15 var(--ds-font);margin:0;color:var(--ink)">${dsEsc(c.name)}</h1>
      <span style="margin-left:auto" class="ds-row">
        ${canEmail ? `<button class="ds-btn ds-btn-primary is-sm"
          onclick='commsOpenComposer({customerId:"${dsEsc(c.id)}",customerName:"${dsEsc(c.name)}"})'>✉ Email</button>` : ''}
        <button class="ds-btn ds-btn-secondary is-sm" onclick="commsOpenContacts('${dsEsc(c.id)}','${dsEsc(c.name)}')">Contacts</button>
        ${typeof dsDensityControl === 'function' ? dsDensityControl() : ''}
        <button class="ds-btn ds-btn-secondary is-sm" onclick="custLoad()">Refresh</button>
      </span>
    </div>
  </div>

  <div class="ds-tiles" style="margin-bottom:var(--sp-3)">
    ${dsTile({ label: 'Total open', value: dsMoneyShort(k.totalAR), title: dsMoney(k.totalAR, { cents: true }),
      sub: `${dsNum(k.invoices)} invoices`, accent: 'var(--c2)' })}
    ${dsTile({ label: 'Past due', value: dsMoneyShort(k.pastDue), title: dsMoney(k.pastDue, { cents: true }),
      sub: k.totalAR ? `${Math.round(k.pastDue / k.totalAR * 100)}% of the balance` : '', accent: 'var(--div-neg)' })}
    ${dsTile({ label: 'Oldest', value: (k.oldest || 0) + 'd', sub: 'past its due date', accent: 'var(--age-4)' })}
    ${dsTile({ label: 'Locations', value: dsNum(k.locations), sub: `${(c.scBreakdown || []).length} service centers`, accent: 'var(--c4)' })}
  </div>

  ${segs.length ? `<div class="ds-card" style="margin-bottom:var(--sp-3)">
    <div class="ds-card-body">${dsBar(segs)}</div></div>` : ''}

  <div class="ds-card" style="margin-bottom:var(--sp-3)">
    <div class="ds-card-body ds-row" style="padding:var(--sp-3) var(--sp-4);flex-wrap:wrap">
      ${contactStrip}
      <span style="margin-left:auto" class="ds-row">
        ${(c.scBreakdown || []).slice(0, 6).map(b =>
          `<span title="${dsEsc(b.sc)}: ${dsMoney(b.pastDue)} past due of ${dsMoney(b.open)}">${
            typeof commsScChips === 'function' ? commsScChips([b.sc]) : dsEsc(b.sc)}</span>`).join('')}
      </span>
    </div>
  </div>`;
}

function custTabStrip() {
  const c = _cust.data;
  const n = { invoices: (c.invoices || []).length };
  return `<div class="rail-tabs" id="cust-tabs" style="border-radius:var(--r-lg) var(--r-lg) 0 0;border:1px solid var(--line);border-bottom:0">
    ${CUST_TABS.map(t => `<button class="rail-tab${_cust.tab === t.key ? ' is-on' : ''}" data-tab="${t.key}"
        onclick="custShow('${t.key}')">${dsEsc(t.label)}<span class="rail-tab-n" id="cust-n-${t.key}">${n[t.key] ? ' ' + dsNum(n[t.key]) : ''}</span></button>`).join('')}
  </div>`;
}

function custShow(tab) {
  _cust.tab = tab;
  for (const t of CUST_TABS) {
    const p = document.getElementById('cust-pane-' + t.key);
    if (p) p.style.display = tab === t.key ? '' : 'none';
  }
  document.querySelectorAll('#cust-tabs .rail-tab').forEach(b => b.classList.toggle('is-on', b.dataset.tab === tab));
  const pane = document.getElementById('cust-pane-' + tab);
  if (!pane || pane.dataset.loaded === '1') return;
  pane.innerHTML = `<div class="ds-card" style="border-radius:0 0 var(--r-lg) var(--r-lg)"><div class="ds-card-body">${dsSkeleton(5)}</div></div>`;
  custFill(tab, pane);
}

async function custFill(tab, pane) {
  const c = _cust.data;
  const wrap = inner => `<div class="ds-card" style="border-radius:0 0 var(--r-lg) var(--r-lg)">${inner}</div>`;
  try {
    if (tab === 'invoices') {
      pane.innerHTML = wrap(custInvoices(c));
    } else if (tab === 'conversations') {
      const rows = await apiFetch(`/api/comms/conversations?customerId=${encodeURIComponent(c.id)}`);
      pane.innerHTML = wrap(custConversations(rows));
    } else if (tab === 'statements') {
      pane.innerHTML = wrap(await custStatements(c));
    } else if (tab === 'notes') {
      pane.innerHTML = wrap('<div class="ds-card-body"><div id="custpage-notes"></div></div>');
      if (typeof commsLoadCustNotes === 'function') commsLoadCustNotes(c.id);
    } else if (tab === 'files') {
      pane.innerHTML = wrap('<div class="ds-card-body"><div id="custpage-attachments-inner"></div></div>');
      if (typeof commsLoadAttachments === 'function') commsLoadAttachments(c.id, 'custpage-attachments-inner');
    }
    pane.dataset.loaded = '1';
  } catch (e) {
    pane.innerHTML = wrap(`<div class="ds-card-body">${dsEmpty({ icon: '!', title: 'Could not load', body: e.message })}</div>`);
  }
}

/* The full invoice list, not a 200-row slice. This customer can have 1,800
   invoices, so it scrolls inside the card rather than down the page. */
function custInvoices(c) {
  const rows = c.invoices || [];
  if (!rows.length) return `<div class="ds-card-body">${dsEmpty({ icon: '✓', title: 'No open invoices' })}</div>`;
  const total = rows.reduce((t, i) => t + (i.totalDue || 0), 0);
  return `<div class="ds-table-wrap" style="max-height:62vh">
    <table class="ds-table">
      <thead><tr><th>Invoice</th><th>SC</th><th>Location</th><th>Due</th><th class="is-num">Aging</th>
        <th>Status</th><th>Collector</th><th class="is-num">Amount</th></tr></thead>
      <tbody>${rows.map(i => {
        const cs = ((_gridMeta.csByRecord[i.recordNo] || {}).status) || 'Open';
        const col = typeof commsEffectiveCollector === 'function' ? commsEffectiveCollector(i) : null;
        return `<tr style="cursor:pointer" onclick="openDrawer('${dsEsc(i.recordNo)}')">
          <td><strong>${dsEsc(i.invoiceId || i.recordNo)}</strong></td>
          <td>${typeof commsScChipFor === 'function' ? commsScChipFor(i) : ''}</td>
          <td>${dsEsc(i.locationName || '—')}</td>
          <td class="ds-muted">${dsEsc((i.whenDue || '').slice(0, 10) || '—')}</td>
          <td class="is-num">${i.daysOverdue > 0
            ? `<span class="age-pill ${commsAgePillClass(i.daysOverdue)}">${i.daysOverdue}d</span>`
            : '<span style="color:#3f7238;font-weight:600;font-size:11.5px">Current</span>'}</td>
          <td><span class="cs-chip ${typeof commsCsClass === 'function' ? commsCsClass(cs) : ''}">${dsEsc(cs)}</span></td>
          <td class="ds-muted">${col ? dsEsc(col.split('@')[0]) : 'Unassigned'}</td>
          <td class="is-money">${dsMoney(i.totalDue, { cents: true })}</td>
        </tr>`;
      }).join('')}</tbody>
      <tfoot><tr><td colspan="7">${dsNum(rows.length)} invoices</td>
        <td class="is-money">${dsMoney(total)}</td></tr></tfoot>
    </table></div>`;
}

function custConversations(rows) {
  if (!rows.length) {
    return `<div class="ds-card-body">${dsEmpty({ icon: '✉', title: 'No conversations with this customer',
      body: 'Email sent from the portal, and any reply, appears here.' })}</div>`;
  }
  return `<table class="ds-table"><tbody>${rows.map(r => `
    <tr style="cursor:pointer" onclick="switchView('comms-mailbox');setTimeout(()=>commsSelectThread(${r.id}),600)">
      <td><strong>${dsEsc(r.subject || '(no subject)')}</strong>
        <span class="ds-muted" style="display:block;font-size:var(--fs-xs)">
          ${dsEsc(r.assigned_email ? r.assigned_email.split('@')[0] : 'unassigned')}
          ${r.last_direction === 'in' ? ' · awaiting reply' : ''}</span></td>
      <td><span class="ds-chip ${r.status === 'open' ? 'is-green' : ''}">${dsEsc(r.status || '')}</span></td>
      <td class="ds-muted" style="text-align:right;white-space:nowrap">${dsEsc((r.last_message_at || r.created_at || '').slice(0, 10))}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function custStatements(c) {
  let schedule = null;
  // The schedules route is manager-only; a specialist simply sees no schedule
  // rather than an error.
  try {
    const all = await apiFetch('/api/statements/schedules');
    const list = Array.isArray(all) ? all : (all.schedules || []);
    schedule = list.find(s => s.customer_id === c.id) || null;
  } catch (e) { schedule = null; }

  const statementUrl = `/api/customer-statement/${encodeURIComponent(c.id)}`;
  return `<div class="ds-card-body">
    <div class="rail-docs" style="padding:0">
      <a class="rail-doc" href="${statementUrl}" target="_blank" rel="noopener">
        <span class="rail-doc-icon">📄</span>
        <span><span class="rail-doc-title">Statement of account</span>
          <span class="rail-doc-sub">Every open invoice for ${dsEsc(c.name)} · ${dsMoney((c.kpis || {}).totalAR)}</span></span>
        <span class="rail-doc-go">↗</span>
      </a>
      <div class="rail-doc${schedule && schedule.enabled ? '' : ' is-muted'}">
        <span class="rail-doc-icon">🗓</span>
        <span><span class="rail-doc-title">${schedule && schedule.enabled
            ? `Emailed monthly on day ${dsEsc(String(schedule.day_of_month || '?'))}`
            : 'No monthly statement scheduled'}</span>
          <span class="rail-doc-sub">${schedule && schedule.enabled
            ? 'Sent to the primary contact unless specific contacts are chosen'
            : 'Set one up under Collections → Statements'}</span></span>
      </div>
    </div>
    ${typeof commsCanEdit === 'function' && commsCanEdit()
      ? `<div style="margin-top:var(--sp-3)">
           <button class="ds-btn ds-btn-secondary is-sm"
             onclick='commsOpenComposer({customerId:"${dsEsc(c.id)}",customerName:"${dsEsc(c.name)}",defaultAttach:"statement"})'>
             ✉ Email this statement</button></div>`
      : ''}
  </div>`;
}
