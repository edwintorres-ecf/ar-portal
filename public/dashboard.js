/* ───────────────────────────────────────────────────────────────────────────
   dashboard.js — redesign Phase 2, the landing view.
   Built on ds.css / ds.js. No new endpoints: every figure here already existed
   on /api/overview, /api/comms/action-items, /api/ptp/all, /api/snapshots and
   /api/activity-log. This is presentation.

   The job of this screen is to answer, in the order a collector actually asks:
     1. How much is owed, and is it getting better or worse?
     2. How old is it?
     3. What do I do next?
   Everything else is a link away.
   ─────────────────────────────────────────────────────────────────────────── */
'use strict';

/* Aging colours come from the sequential ramp, oldest darkest, so severity is
   readable without consulting the legend. Deliberately NOT the status palette:
   a bar is a quantity, not a warning. */
const DASH_AGE_COLORS = {
  'current': 'var(--ramp-1)',
  '1-30':    'var(--ramp-2)',
  '31-60':   'var(--ramp-3)',
  '61-90':   'var(--ramp-4)',
  '91-180':  'var(--ramp-5)',
  '181+':    'var(--age-4)',
  '91+':     'var(--ramp-5)',
};

async function dashLoad() {
  const root = document.getElementById('overview-root');
  if (!root) return;
  root.innerHTML = `<div style="padding:8px 0">${dsSkeleton(2)}
    <div class="ds-tiles" style="margin-top:16px">${'<div class="ds-tile"><div class="ds-skeleton" style="height:56px"></div></div>'.repeat(5)}</div></div>`;

  // Fetched together; a slow or broken side-panel must not stop the numbers.
  const settle = p => p.then(v => ({ ok: true, v })).catch(e => ({ ok: false, e }));
  const [ov, act, ptp, snaps, log] = await Promise.all([
    settle(apiFetch('/api/overview')),
    settle(apiFetch('/api/comms/action-items')),
    settle(apiFetch('/api/ptp/all')),
    settle(apiFetch('/api/snapshots?days=30')),
    settle(apiFetch('/api/activity-log?limit=10')),
  ]);

  if (!ov.ok) {
    root.innerHTML = dsCard({ title: 'Dashboard unavailable',
      body: dsEmpty({ icon: '!', title: 'Could not load the book',
        body: ov.e && ov.e.message ? ov.e.message : 'The overview endpoint did not respond.' }) });
    return;
  }
  const o = ov.v;
  const history = (snaps.ok && Array.isArray(snaps.v.snapshots)) ? snaps.v.snapshots : [];

  root.innerHTML = [
    dashHeader(o),
    dashHero(o, history),
    `<div class="ds-grid-2" style="margin-top:16px;align-items:start">
       ${dashAging(o)}
       ${dashAttention(o, act, ptp)}
     </div>`,
    `<div class="ds-grid-2" style="margin-top:16px;align-items:start">
       ${dashTopAccounts(o)}
       ${dashActivity(log)}
     </div>`,
  ].join('');
}

function dashHeader(o) {
  // Every field is read defensively. /api/overview answering with a partial or
  // empty body — a degraded Sage cache, a scoped user with no locations — must
  // leave a thinner header, not throw and blank the whole landing page. The
  // rest of this file already guards `buckets` and `top10`; this line did not,
  // and it is the first thing rendered, so it took everything down with it.
  const scs = Array.isArray(o.serviceCenters) ? o.serviceCenters.length : null;
  const age = typeof o.sageCacheAgeMin === 'number' ? o.sageCacheAgeMin : null;
  const stale = age != null && age > 30;
  const ageLabel = age == null ? 'Data age unknown' : age === 0 ? 'Data just refreshed' : `Data ${age}m old`;
  return `<div style="display:flex;align-items:flex-end;gap:var(--sp-4);flex-wrap:wrap;margin:6px 0 var(--sp-4)">
    <div>
      <h1 style="font:700 var(--fs-2xl)/1.15 var(--ds-font);margin:0;color:var(--ink)">AR Dashboard</h1>
      <div style="font:500 var(--fs-sm)/1.5 var(--ds-font);color:var(--ink-soft);margin-top:2px">
        ${[
          o.role ? dsEsc(o.role) : null,
          scs != null ? `${scs} service center${scs === 1 ? '' : 's'}` : null,
          o.customers != null ? `${dsNum(o.customers)} customers` : null,
        ].filter(Boolean).join(' · ')}
      </div>
    </div>
    <div style="margin-left:auto" class="ds-row">
      <span class="ds-chip ${stale ? 'is-yellow' : ''}" title="How old the Sage figures are">
        ${stale ? '⚠ ' : ''}${ageLabel}
      </span>
      <button class="ds-btn ds-btn-secondary is-sm" onclick="dashLoad()">Refresh</button>
    </div>
  </div>`;
}

/* ── Hero row ──────────────────────────────────────────────────────────────
   Deltas and sparklines come from ar_snapshots. There is only one snapshot so
   far, so rather than draw a flat line through a single reading or imply a
   change we cannot evidence, the tiles say what they know and no more. */
function dashHero(o, history) {
  const series = k => history.map(h => h[k]).filter(n => typeof n === 'number');
  const latest = history[history.length - 1];
  const delta = k => (latest && latest.delta && typeof latest.delta[k] === 'number') ? latest.delta[k] : null;

  const tiles = [
    dsTile({ label: 'Total AR', value: dsMoneyShort(o.totalAR), title: dsMoney(o.totalAR, { cents: true }),
      sub: `${dsNum(o.openInvoices)} open`, accent: 'var(--c2)',
      delta: delta('open_ar'), spark: dsSpark(series('open_ar'), { color: 'var(--c2)' }) }),
    dsTile({ label: 'Past due', value: dsMoneyShort(o.pastDueAR), title: dsMoney(o.pastDueAR, { cents: true }),
      sub: `${dsNum(o.pastDueCount)} invoices · ${o.pctPastDue}% of AR`, accent: 'var(--div-neg)' }),
    dsTile({ label: 'Current', value: dsMoneyShort(o.currentAR), title: dsMoney(o.currentAR, { cents: true }),
      sub: 'not yet due', accent: 'var(--div-pos)' }),
    dsTile({ label: 'Oldest open', value: o.oldestDays + 'd', sub: 'past its due date', accent: 'var(--age-4)',
      onclick: "switchView('dashboard')" }),
    dsTile({ label: 'Sent to legal', value: dsMoneyShort(o.sentToLegal), title: dsMoney(o.sentToLegal, { cents: true }),
      sub: 'escalated', accent: 'var(--c4)' }),
  ].join('');

  // Say plainly why there is no trend line yet, instead of leaving a gap that
  // looks like a bug.
  const note = history.length < 2
    ? `<div class="ds-muted" style="font:500 var(--fs-xs)/1.5 var(--ds-font);margin-top:var(--sp-2)">
         Trend lines need at least two daily snapshots. ${history.length === 1
           ? 'The first was taken today, so comparisons begin tomorrow.'
           : 'No snapshots recorded yet.'}
       </div>` : '';

  return `<div class="ds-tiles">${tiles}</div>${note}`;
}

/* ── Aging ─────────────────────────────────────────────────────────────────
   One stacked bar rather than five separate progress bars. The question this
   answers is "how is the book distributed", which is a question about shares
   of a whole, and five independent bars scaled to the largest bucket actively
   obscures that. The figures sit underneath for anyone who needs them exactly.
*/
function dashAging(o) {
  const entries = Object.entries(o.buckets || {}).filter(([, v]) => (v || 0) > 0);
  if (!entries.length) {
    return dsCard({ title: 'Aging', body: dsEmpty({ icon: '✓', title: 'Nothing past due', body: 'Every open invoice is still within terms.' }) });
  }
  const segs = entries.map(([k, v]) => ({ label: k + ' days', value: v, color: DASH_AGE_COLORS[k] || 'var(--ramp-3)' }));
  const total = segs.reduce((t, s) => t + s.value, 0);

  const rows = segs.map(s => `<tr>
      <td><span class="ds-legend-dot" style="display:inline-block;background:${s.color};margin-right:8px"></span>${dsEsc(s.label)}</td>
      <td class="is-money">${dsMoney(s.value)}</td>
      <td class="is-num ds-muted">${dsPct(s.value / total * 100)}</td>
    </tr>`).join('');

  return dsCard({
    title: 'Aging', sub: 'Past-due dollars by bucket',
    body: `${dsBar(segs)}
      <table class="ds-table" style="margin-top:var(--sp-4)">
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total past due</td><td class="is-money">${dsMoney(total)}</td><td class="is-num">100%</td></tr></tfoot>
      </table>`,
  });
}

/* ── Needs attention ───────────────────────────────────────────────────────
   The point of the screen. Each line is a thing a person does next, with the
   count that justifies doing it, and a click that lands where the work is.
   A row with nothing in it is hidden rather than shown as a zero: a list of
   zeroes trains people to stop reading the list. */
function dashAttention(o, act, ptp) {
  const items = [];

  if (act.ok) {
    const a = act.v;
    if (a.needsReplyMine) items.push({ icon: '📬', label: 'Replies waiting on you', n: a.needsReplyMine,
      go: "switchView('comms-mailbox')", tone: 'is-red' });
    if (a.needsReplyUnassigned) items.push({ icon: '⚠', label: 'Unowned conversations', n: a.needsReplyUnassigned,
      go: "switchView('comms-mailbox')", tone: 'is-orange', hint: 'Nobody has picked these up' });
    if (a.triage) items.push({ icon: '🚨', label: 'In triage', n: a.triage, go: "switchView('comms-triage')", tone: 'is-yellow' });
  }

  if (ptp.ok && Array.isArray(ptp.v)) {
    const today = new Date().toISOString().slice(0, 10);
    // "Broken" is a promise whose date has passed while it is still open. The
    // status field only changes when a human sets it, so the date is the truth.
    const overdue = ptp.v.filter(p => p.promise_date && p.promise_date < today && p.status === 'open');
    const soon = ptp.v.filter(p => p.promise_date && p.promise_date >= today && p.status === 'open');
    if (overdue.length) items.push({ icon: '💔', label: 'Promises past their date', n: overdue.length,
      sub: dsMoney(overdue.reduce((t, p) => t + (p.amount || 0), 0)), go: "switchView('ptp-board')", tone: 'is-red' });
    if (soon.length) items.push({ icon: '💰', label: 'Promises coming due', n: soon.length,
      sub: dsMoney(soon.reduce((t, p) => t + (p.amount || 0), 0)), go: "switchView('ptp-board')", tone: 'is-blue' });
  }

  const body = items.length
    ? items.map(i => `<div class="ds-row" style="padding:var(--sp-3) var(--sp-4);border-bottom:1px solid var(--line);cursor:pointer"
           onclick="${i.go}" onkeydown="if(event.key==='Enter'){${i.go}}" tabindex="0" role="button">
        <span style="font-size:var(--fs-lg)" aria-hidden="true">${i.icon}</span>
        <span style="flex:1">
          <span style="font:600 var(--fs-base)/1.4 var(--ds-font);color:var(--ink)">${dsEsc(i.label)}</span>
          ${i.sub || i.hint ? `<span style="display:block;font:500 var(--fs-sm)/1.4 var(--ds-font);color:var(--ink-soft)">${dsEsc(i.sub || i.hint)}</span>` : ''}
        </span>
        <span class="ds-chip ${i.tone}">${dsNum(i.n)}</span>
      </div>`).join('')
    : dsEmpty({ icon: '✓', title: 'Nothing needs attention', body: 'No unanswered mail, no triage, no promises past their date.' });

  const failed = [act, ptp].filter(x => !x.ok).length;
  return dsCard({
    title: 'Needs attention',
    sub: failed ? `${failed} source unavailable` : 'Everything that is waiting on a person',
    flush: true, body,
  });
}

/* top10 from /api/overview is sorted by PAST DUE, not by total balance, and its
   amount field is `pastDue`. Naming it "largest balances" and reading .total
   gave a list of $0 — right customers, wrong column. */
function dashTopAccounts(o) {
  const top = (o.top10 || []).slice(0, 8);
  if (!top.length) {
    return dsCard({ title: 'Largest past due', body: dsEmpty({ icon: '✓', title: 'Nothing past due', body: 'No customer is carrying an overdue balance.' }) });
  }
  const agePill = d => {
    const cls = d > 90 ? 'age-severe' : d > 60 ? 'age-high' : d > 30 ? 'age-mid' : 'age-low';
    return `<span class="age-pill ${cls}">${dsNum(d)}d</span>`;
  };
  const rows = top.map(c => `<tr style="cursor:pointer" onclick="goToCustomer('${dsEsc(c.id)}')"
      title="Open ${dsEsc(c.name || c.id)}">
      <td><strong>${dsEsc(c.name || c.id)}</strong>
        <span class="ds-muted" style="display:block;font-size:var(--fs-xs)">${dsNum(c.invoices)} invoice${c.invoices === 1 ? '' : 's'}</span></td>
      <td style="white-space:nowrap">${agePill(c.oldest || 0)}</td>
      <td class="is-money">${dsMoney(c.pastDue)}</td>
    </tr>`).join('');
  return dsCard({ title: 'Largest past due', sub: 'Where the overdue money is concentrated', flush: true,
    body: `<table class="ds-table"><tbody>${rows}</tbody></table>` });
}

function dashActivity(log) {
  if (!log.ok) return dsCard({ title: 'Recent activity', body: dsEmpty({ title: 'Activity unavailable' }) });
  // /api/activity-log answers { rows, total }. Guessing at `entries` silently
  // produced an empty feed that looked like "nothing has happened".
  const rows = (Array.isArray(log.v) ? log.v : (log.v.rows || [])).slice(0, 10);
  if (!rows.length) return dsCard({ title: 'Recent activity', body: dsEmpty({ title: 'Nothing logged yet' }) });
  const when = ts => {
    const d = new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'));
    if (isNaN(d)) return '';
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (mins < 1440) return Math.round(mins / 60) + 'h ago';
    return Math.round(mins / 1440) + 'd ago';
  };
  return dsCard({ title: 'Recent activity', sub: 'Across the team', flush: true,
    body: `<table class="ds-table"><tbody>${rows.map(r => `<tr>
        <td style="width:40%"><span class="ds-muted">${dsEsc(String(r.user_email || '').split('@')[0])}</span></td>
        <td>${dsEsc(String(r.action || '').replace(/_/g, ' '))}</td>
        <td class="ds-muted" style="text-align:right;white-space:nowrap">${when(r.created_at)}</td>
      </tr>`).join('')}</tbody></table>` });
}
