/* ───────────────────────────────────────────────────────────────────────────
   sitepos.js — Site POs, for the people doing the work.

   The question this screen answers is not an accounting one. It is: "has a PO
   arrived for this site, is it worth enough to cover what we are about to do,
   and does it describe the service we actually provide?" Answered before the
   work starts, so an uplift can be requested rather than discovered at billing
   (Edwin 2026-09-21).

   Deliberately NOT the PO ledger with permissions bolted on. No consumed-by-
   invoice breakdown, no AR, no customer balances. Value, spent, remaining,
   description, and the document.

   Scope is enforced on the SERVER. This file only asks; it cannot widen what
   it is given.
   ─────────────────────────────────────────────────────────────────────────── */
'use strict';

let _sp = { data: null, site: '', po: '', centre: '', service: '', openOnly: true };
let _spTimer = null;

async function spLoad() {
  const root = document.getElementById('sitepos-root');
  if (!root) return;
  root.innerHTML = `<div style="padding:8px 0">${dsSkeleton(2)}
    <div class="ds-card" style="margin-top:16px"><div class="ds-card-body">${dsSkeleton(6)}</div></div></div>`;
  await spFetch(true);
}

async function spFetch(rebuild) {
  const q = new URLSearchParams();
  if (_sp.site) q.set('site', _sp.site);
  if (_sp.po) q.set('po', _sp.po);
  if (_sp.centre) q.set('serviceCenter', _sp.centre);
  if (_sp.service) q.set('service', _sp.service);
  if (_sp.openOnly) q.set('openOnly', '1');
  try {
    _sp.data = await apiFetch('/api/site-pos?' + q.toString());
    spRender(rebuild);
  } catch (e) {
    document.getElementById('sitepos-root').innerHTML = dsCard({
      title: 'Purchase orders unavailable',
      body: dsEmpty({ icon: '!', title: 'Could not load', body: e.message }),
    });
  }
}

function spSearch(field, value) {
  _sp[field] = String(value || '').trim();
  clearTimeout(_spTimer);
  _spTimer = setTimeout(() => spFetch(false), 200);
}

function spRender(rebuild) {
  const d = _sp.data;
  const root = document.getElementById('sitepos-root');
  if (rebuild || !document.getElementById('sp-results')) {
    root.innerHTML = `
      <div style="margin:6px 0 var(--sp-4)">
        <h1 style="font:700 var(--fs-2xl)/1.15 var(--ds-font);margin:0;color:var(--ink)">Purchase orders</h1>
        <div class="ds-muted" style="font:500 var(--fs-sm)/1.5 var(--ds-font);margin-top:2px">
          Check a PO exists and covers the work before you start.
          Showing <strong>${dsEsc(d.scope)}</strong>.
        </div>
      </div>

      <div class="ds-card" style="margin-bottom:var(--sp-3)">
        <div class="ds-card-body" style="padding:var(--sp-3) var(--sp-4)">
          <div class="ds-row" style="flex-wrap:wrap;gap:var(--sp-2)">
            <input id="sp-site" class="exp-input" style="flex:1;min-width:190px"
                   placeholder="Site code — e.g. BDL4, or several"
                   value="${dsEsc(_sp.site)}" oninput="spSearch('site', this.value)">
            <input id="sp-po" class="exp-input" style="flex:1;min-width:180px"
                   placeholder="PO number — e.g. 2D-206"
                   value="${dsEsc(_sp.po)}" oninput="spSearch('po', this.value)">
            ${d.serviceCenters.length > 1 ? `<select class="exp-input" onchange="_sp.centre=this.value;spFetch(false)">
              <option value="">All my service centers</option>
              ${d.serviceCenters.map(c => `<option value="${dsEsc(c)}" ${_sp.centre === c ? 'selected' : ''}>${dsEsc(c)}</option>`).join('')}
            </select>` : ''}
            <select class="exp-input" onchange="_sp.service=this.value;spFetch(false)">
              <option value="">Snow and landscaping</option>
              <option value="snow" ${_sp.service === 'snow' ? 'selected' : ''}>❄️ Snow only</option>
              <option value="landscaping" ${_sp.service === 'landscaping' ? 'selected' : ''}>🌱 Landscaping only</option>
            </select>
            <label class="ds-row" style="gap:6px;font:500 var(--fs-sm) var(--ds-font);color:var(--ink-soft);cursor:pointer">
              <input type="checkbox" ${_sp.openOnly ? 'checked' : ''}
                     onchange="_sp.openOnly=this.checked;spFetch(false)"> Open POs only
            </label>
            <button class="ds-btn ds-btn-ghost is-sm" onclick="spReset()">Reset</button>
          </div>
        </div>
      </div>

      <div id="sp-summary" class="ds-tiles" style="margin-bottom:var(--sp-3)"></div>
      <div id="sp-results"></div>`;
  }
  spSummary();
  spResults();
}

function spReset() {
  _sp = { ..._sp, site: '', po: '', centre: '', service: '', openOnly: true };
  spFetch(true);
}

function spSummary() {
  const t = _sp.data.totals;
  const el = document.getElementById('sp-summary');
  if (!el) return;
  el.innerHTML = [
    dsTile({ label: 'Purchase orders', value: dsNum(t.pos), sub: `${dsNum(_sp.data.sites.length)} sites`, accent: 'var(--c2)' }),
    dsTile({ label: 'Total PO value', value: dsMoneyShort(t.value), title: dsMoney(t.value, { cents: true }),
      sub: 'across these POs', accent: 'var(--brand)' }),
    dsTile({ label: 'Remaining to bill', value: dsMoneyShort(t.remaining), title: dsMoney(t.remaining, { cents: true }),
      sub: 'capacity still available', accent: 'var(--div-pos)' }),
  ].join('');
}

/* Grouped by site, because that is the unit a field user thinks in — "what has
   BDL4 got?" — not a flat list of PO numbers. */
function spResults() {
  const el = document.getElementById('sp-results');
  const pos = _sp.data.pos;
  if (!pos.length) {
    el.innerHTML = dsCard({ body: dsEmpty({
      icon: '🔍',
      title: _sp.site || _sp.po ? 'No purchase order matches that' : 'No purchase orders to show',
      body: _sp.site || _sp.po
        ? 'Check the spelling, or clear "Open POs only" in case it has been closed. If a PO genuinely has not arrived, tell accounting before starting the work.'
        : 'Nothing is assigned to your service center yet. If that looks wrong, ask accounting to check the site assignments.',
    }) });
    return;
  }
  const bySite = {};
  for (const p of pos) (bySite[p.siteCode] = bySite[p.siteCode] || []).push(p);

  el.innerHTML = Object.entries(bySite).map(([site, list]) => {
    const value = list.reduce((t, p) => t + (p.value || 0), 0);
    const remaining = list.reduce((t, p) => t + Math.max(0, p.remaining || 0), 0);
    const bu = list.find(p => p.businessUnit);
    return dsCard({
      title: site,
      sub: `${list.length} PO${list.length === 1 ? '' : 's'} · ${dsMoney(value)} · ${dsMoney(remaining)} remaining`
        + (bu ? ` · ${bu.businessUnit}` : ''),
      actions: spCentreControl(site),
      flush: true,
      body: `<table class="ds-table">
        <thead><tr><th>PO</th><th>Service</th><th>Description</th>
          <th class="is-num">Value</th><th class="is-num">Remaining</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map(spRow).join('')}</tbody></table>`,
    });
  }).join('<div style="height:var(--sp-3)"></div>');
}

/* ── Moving a site between service centres ─────────────────────────────────
   Only for admin/manager/ar_specialist — the server decides, this only asks.
   A field user must never set this: the service centre IS their access
   boundary, so setting it would let them pull any site into their own scope.

   The control states which layer is in force, because "Hartford" meaning
   "Omnia says so" and "Hartford" meaning "somebody overrode this" are
   different facts, and only the second one survives the next export. */
const SP_SOURCE_LABEL = {
  manual: { text: 'set by hand', cls: 'is-orange' },
  billing: { text: 'from billing', cls: 'is-blue' },
  omnia: { text: 'from Omnia', cls: '' },
};

function spCentreControl(site) {
  const d = _sp.data;
  if (!d.canReassign) return '';
  const info = (d.siteServiceCenters || {})[site] || {};
  const lab = SP_SOURCE_LABEL[info.source] || { text: 'not set', cls: 'is-orange' };
  const opts = ['<option value="">— no service center —</option>']
    .concat((d.allServiceCenters || []).map(c =>
      `<option value="${dsEsc(c)}" ${info.centre === c ? 'selected' : ''}>${dsEsc(c)}</option>`));
  return `<span class="ds-row" style="gap:6px;align-items:center">
    <span class="ds-chip ${lab.cls}" title="${dsEsc(spCentreTitle(info))}">${dsEsc(lab.text)}</span>
    <select class="exp-input is-sm" style="min-width:150px" aria-label="Service center for ${dsEsc(site)}"
            onchange="spSetCentre('${dsEsc(site)}', this.value, this)">${opts.join('')}</select>
    ${info.source === 'manual' ? `<button class="ds-btn ds-btn-ghost is-sm"
      title="Drop the override and go back to what Omnia and billing say"
      onclick="spReleaseCentre('${dsEsc(site)}', this)">Release</button>` : ''}
  </span>`;
}

function spCentreTitle(info) {
  const parts = [];
  if (info.manual) parts.push(`Set by hand: ${info.manual}`);
  if (info.billing) parts.push(`Billing says: ${info.billing}`);
  if (info.omnia) parts.push(`Omnia says: ${info.omnia}`);
  if (!parts.length) return 'No service center on this site';
  return parts.join('\n') + '\nA hand-set value wins, then billing, then Omnia.';
}

async function spSetCentre(site, centre, el) {
  const info = (_sp.data.siteServiceCenters || {})[site] || {};
  if (centre && info.centre === centre && info.source === 'manual') return;
  // Moving a site hides it from one crew and shows it to another, so say so.
  const to = centre || 'no service center';
  if (!confirm(`Move ${site} to ${to}?\n\n`
    + `This overrides Omnia${info.billing ? ' and billing' : ''} and survives the next `
    + `Omnia import. ${site}'s purchase orders stop showing for `
    + `${info.centre || 'its current center'} and start showing for ${to}.`)) {
    el.value = info.centre || '';
    return;
  }
  await spPostCentre(site, centre, el);
}

async function spReleaseCentre(site, el) {
  const info = (_sp.data.siteServiceCenters || {})[site] || {};
  const back = info.billing || info.omnia || '';
  if (!confirm(`Release the override on ${site}?\n\n`
    + (back ? `It goes back to ${back} (${info.billing ? 'what billing shows' : 'what Omnia says'}).`
            : 'Neither Omnia nor billing has a value, so it will have no service center.'))) return;
  await spPostCentre(site, '', el, true);
}

async function spPostCentre(site, centre, el, release) {
  el.disabled = true;
  try {
    const r = await apiFetch('/api/site-pos/service-center', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site, serviceCenter: release ? '' : centre }),
    });
    dsToast(r.serviceCenter
      ? `${site} → ${r.serviceCenter} (${(SP_SOURCE_LABEL[r.source] || {}).text || r.source})`
      : `${site} has no service center`, 'success');
    // The site may have just left this user's scope, so reload rather than
    // patching the row in place and leaving a card that should be gone.
    await spFetch(true);
  } catch (e) {
    dsToast('Could not change it: ' + e.message, 'error');
    el.disabled = false;
  }
}

function spRow(p) {
  // Remaining is the number that decides whether to start work, so it is the
  // one that carries colour. Negative means already over the PO.
  const rem = p.remaining;
  const remCls = rem == null ? 'ds-muted' : rem < 0 ? 'is-over' : rem === 0 ? 'is-none' : '';
  const remTxt = rem == null ? 'not set' : dsMoney(rem);
  const closed = p.status && p.status !== 'OPEN_FOR_INVOICING';
  return `<tr>
    <td><strong>${dsEsc(p.poNumber)}</strong>
      ${p.orderDate ? `<span class="ds-muted" style="display:block;font-size:var(--fs-xs)">raised ${dsEsc(p.orderDate)}</span>` : ''}</td>
    <td>${p.serviceType === 'snow' ? '<span class="ds-chip is-blue">❄️ Snow</span>'
       : p.serviceType === 'landscaping' ? '<span class="ds-chip is-green">🌱 Landscaping</span>'
       : '<span class="ds-muted">—</span>'}</td>
    <td style="max-width:420px;white-space:normal">${p.description
      ? dsEsc(p.description)
      : '<span class="ds-muted">no description on the PO document</span>'}</td>
    <td class="is-money">${p.value == null
      ? '<span style="color:#b32020;font-style:italic">not set</span>' : dsMoney(p.value)}</td>
    <td class="is-money ${remCls}">${remTxt}</td>
    <td>${closed ? `<span class="ds-chip is-orange">${dsEsc(String(p.status).replace(/_/g, ' ').toLowerCase())}</span>`
       : '<span class="ds-chip is-green">open</span>'}</td>
    <td>${p.docUrl ? `<a class="ds-btn ds-btn-secondary is-sm" href="${dsEsc(p.docUrl)}" target="_blank" rel="noopener">📄 PO</a>`
       : '<span class="ds-muted" style="font-size:var(--fs-xs)">no document</span>'}</td>
  </tr>`;
}
