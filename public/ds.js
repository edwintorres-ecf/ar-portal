/* ───────────────────────────────────────────────────────────────────────────
   ds.js — the portal's shared UI primitives.
   Phase 1 of the redesign. Loaded by index.html before every other script, so
   comms.js and amazon.js can use these without caring about load order.

   Deliberately plain: no framework, no build step, no dependencies. Everything
   here is a function that returns a string of HTML or touches one element.

   Pairs with ds.css. Colour comes from the tokens styles.css already owns, so
   every component follows the existing theme including dark mode.
   ─────────────────────────────────────────────────────────────────────────── */
'use strict';

/* ── Toasts ────────────────────────────────────────────────────────────────
   Replaces alert(), which blocks the page, cannot be styled, and says nothing
   about whether the news is good. comms.js already had a private showToast;
   this is the same idea promoted to the whole portal. If comms.js has already
   defined one, that definition wins and this becomes a no-op wrapper, so this
   file can land without touching comms.js in the same change.
   -------------------------------------------------------------------------- */
function dsToast(message, kind = 'info', ms = 4000) {
  let host = document.getElementById('ds-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ds-toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'ds-toast is-' + (['success', 'error', 'warn', 'info'].includes(kind) ? kind : 'info');
  const icon = { success: '✓', error: '✕', warn: '!', info: 'i' }[kind] || 'i';
  el.innerHTML = `<span aria-hidden="true">${icon}</span><span>${dsEsc(message)}</span>`
    + `<button class="ds-toast-x" aria-label="Dismiss">×</button>`;
  // Errors stay until dismissed. A failure that vanishes after four seconds is
  // a failure nobody acts on.
  const life = kind === 'error' ? 0 : ms;
  const close = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 160);
  };
  el.querySelector('.ds-toast-x').onclick = close;
  host.appendChild(el);
  if (life) setTimeout(close, life);
  return close;
}

/* Announce to assistive tech as well as on screen. */
function dsAnnounce(message) {
  let live = document.getElementById('ds-live');
  if (!live) {
    live = document.createElement('div');
    live.id = 'ds-live';
    live.setAttribute('aria-live', 'polite');
    live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
    document.body.appendChild(live);
  }
  live.textContent = message;
}

function dsNotify(message, kind = 'info', ms) {
  dsAnnounce(message);
  return dsToast(message, kind, ms);
}

/* ── Formatting ────────────────────────────────────────────────────────────
   One definition of what money looks like. The portal had several.
   -------------------------------------------------------------------------- */
function dsEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function dsMoney(n, { cents = false, sign = false } = {}) {
  const v = Number(n) || 0;
  const s = v.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0,
  });
  return sign && v > 0 ? '+' + s : s;
}
/* Compact form for tiles, where $27,449,267 does not fit and the exact cent
   does not matter. The full figure goes in the title attribute. */
function dsMoneyShort(n) {
  const v = Number(n) || 0, a = Math.abs(v), sg = v < 0 ? '-' : '';
  if (a >= 1e9) return `${sg}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sg}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sg}$${Math.round(a / 1e3)}K`;
  return `${sg}$${Math.round(a)}`;
}
function dsNum(n) { return (Number(n) || 0).toLocaleString('en-US'); }
function dsPct(n, digits = 1) { return `${(Number(n) || 0).toFixed(digits)}%`; }

/* ── Components as strings ─────────────────────────────────────────────── */
function dsTile({ label, value, sub, delta, accent, onclick, title, spark }) {
  const d = delta == null ? '' : (() => {
    const v = Number(delta) || 0;
    const dir = Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'down';
    const arrow = dir === 'flat' ? '–' : dir === 'up' ? '▲' : '▼';
    return `<span class="ds-delta is-${dir}">${arrow} ${dsMoneyShort(Math.abs(v))}</span>`;
  })();
  return `<div class="ds-tile${onclick ? ' is-clickable' : ''}"${onclick ? ` onclick="${onclick}"` : ''}${title ? ` title="${dsEsc(title)}"` : ''}>
    ${accent ? `<span class="ds-tile-accent" style="background:${accent}"></span>` : ''}
    <div class="ds-tile-label">${dsEsc(label)}</div>
    <div class="ds-tile-value">${value}</div>
    ${spark || ''}
    ${sub || d ? `<div class="ds-tile-sub">${sub ? dsEsc(sub) : ''}${sub && d ? ' · ' : ''}${d}</div>` : ''}
  </div>`;
}

function dsCard({ title, sub, actions, body, flush }) {
  return `<div class="ds-card">
    ${title ? `<div class="ds-card-head">
      <div><div class="ds-card-title">${dsEsc(title)}</div>${sub ? `<div class="ds-card-sub">${dsEsc(sub)}</div>` : ''}</div>
      ${actions ? `<div class="ds-card-actions">${actions}</div>` : ''}
    </div>` : ''}
    <div class="ds-card-body${flush ? ' is-flush' : ''}">${body || ''}</div>
  </div>`;
}

function dsEmpty({ icon = '—', title, body }) {
  return `<div class="ds-empty">
    <div class="ds-empty-icon">${icon}</div>
    <div class="ds-empty-title">${dsEsc(title || 'Nothing here')}</div>
    ${body ? `<div class="ds-empty-body">${dsEsc(body)}</div>` : ''}
  </div>`;
}

function dsChip(text, cls = '') { return `<span class="ds-chip ${cls}">${dsEsc(text)}</span>`; }

/* A proportional bar plus the table that carries the same numbers. The bar is
   for scanning; the table is what a screen reader and a sceptic both need. */
function dsBar(segments, { total } = {}) {
  const sum = total || segments.reduce((t, s) => t + (s.value || 0), 0) || 1;
  const bar = segments.map(s =>
    `<div class="ds-bar-seg" style="width:${((s.value || 0) / sum * 100).toFixed(3)}%;background:${s.color}"
          title="${dsEsc(s.label)}: ${dsMoney(s.value)} (${((s.value || 0) / sum * 100).toFixed(1)}%)"></div>`).join('');
  const legend = segments.map(s =>
    `<span class="ds-legend-item"><span class="ds-legend-dot" style="background:${s.color}"></span>
       ${dsEsc(s.label)} <span class="ds-legend-val">${dsMoneyShort(s.value)}</span></span>`).join('');
  return `<div class="ds-bar" role="img" aria-label="${dsEsc(segments.map(s => `${s.label} ${dsMoney(s.value)}`).join(', '))}">${bar}</div>
          <div class="ds-bar-legend">${legend}</div>`;
}

/* Sparkline from an array of numbers. Returns '' for fewer than two points
   rather than drawing a misleading flat line through a single reading. */
function dsSpark(values, { color = 'var(--brand, #45893f)', height = 28 } = {}) {
  const v = (values || []).map(Number).filter(n => isFinite(n));
  if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v), span = (max - min) || 1;
  const pts = v.map((n, i) => `${(i / (v.length - 1) * 100).toFixed(2)},${(100 - (n - min) / span * 100).toFixed(2)}`).join(' ');
  return `<svg class="ds-spark" viewBox="0 0 100 100" preserveAspectRatio="none" style="height:${height}px" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="3" vector-effect="non-scaling-stroke"
              stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function dsSkeleton(rows = 3) {
  return Array.from({ length: rows }, (_, i) =>
    `<div class="ds-skeleton" style="margin:${i ? '10px' : '0'} 0 0;width:${[100, 82, 64][i % 3]}%"></div>`).join('');
}


/* ── Density (Phase 6) ─────────────────────────────────────────────────────
   Comfortable or compact, on <html data-density>, persisted per browser.
   Deliberately changes SPACING only and never type size: shrinking the text to
   fit more rows on screen makes a table of money harder to read, which is the
   opposite of the point.
   -------------------------------------------------------------------------- */
function dsDensity() {
  try { return localStorage.getItem('ar-density') === 'compact' ? 'compact' : 'comfortable'; }
  catch (e) { return 'comfortable'; }
}
function dsSetDensity(mode) {
  const m = mode === 'compact' ? 'compact' : 'comfortable';
  document.documentElement.setAttribute('data-density', m);
  try { localStorage.setItem('ar-density', m); } catch (e) {}
  document.querySelectorAll('.ds-density button').forEach(b =>
    b.classList.toggle('is-on', b.dataset.density === m));
  // The virtualized table positions rows by arithmetic, so it has to be told
  // the row height changed or it will tear.
  if (typeof expOnDensityChange === 'function') expOnDensityChange();
  dsAnnounce(`Density: ${m}`);
}
function dsDensityControl() {
  const m = dsDensity();
  return `<span class="ds-density" role="group" aria-label="Row density">
    <button data-density="comfortable" class="${m === 'comfortable' ? 'is-on' : ''}"
            onclick="dsSetDensity('comfortable')">Comfortable</button>
    <button data-density="compact" class="${m === 'compact' ? 'is-on' : ''}"
            onclick="dsSetDensity('compact')">Compact</button>
  </span>`;
}

/* Read a pixel token from CSS rather than duplicating the number in JS. */
function dsPx(token, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    const n = parseFloat(v);
    return isFinite(n) && n > 0 ? n : fallback;
  } catch (e) { return fallback; }
}

(function dsInitChrome() {
  if (typeof document === 'undefined') return;
  const go = () => {
    document.documentElement.setAttribute('data-density', dsDensity());
    // Skip link, for a nav that is thirteen items wide before the content.
    if (!document.querySelector('.ds-skip')) {
      const a = document.createElement('a');
      a.className = 'ds-skip';
      a.href = '#main';
      a.textContent = 'Skip to content';
      a.onclick = (e) => {
        e.preventDefault();
        const v = document.querySelector('.view.active') || document.querySelector('.view');
        if (v) { v.setAttribute('tabindex', '-1'); v.focus(); }
      };
      document.body.insertBefore(a, document.body.firstChild);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();
