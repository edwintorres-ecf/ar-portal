'use strict';
/**
 * payee.js — Payee Central feed integration for ECF AR Portal
 *
 * Reads the locally-synced payee-central-feed.json (refreshed nightly by iMac cron).
 * Exposes lookupInvoice(sageInvoiceId) → { status, po, amount, dueDate, entryDate } | null
 *
 * Sage uses  : ECI-023017   (with dash)
 * Payee uses : ECI023017    (no dash)
 */

const fs   = require('fs');
const path = require('path');

// NOTE: renamed from payee-central-feed.json on 2026-07-17. The retired iMac
// scraper's "sync-payee-feed-to-spark" OpenClaw cron job still scp's a partial
// feed onto the OLD path at 6am daily and clobbered our good data. Our scraper
// owns this new path; the old filename is a dead-drop the iMac can hit freely.
const FEED_PATH = path.join(__dirname, 'payee-feed.spark.json');
const OPEN_POS_PATH = path.join(__dirname, 'payee-open-pos.json');

// ─── Status display helpers ──────────────────────────────────────────────────

const STATUS_LABEL = {
  'Applied':                    { label: 'Applied',         color: '#16a34a', bg: '#dcfce7', icon: '✅' },
  'Paid':                       { label: 'Paid',            color: '#0369a1', bg: '#e0f2fe', icon: '💰' },
  'In Progress':                { label: 'In Progress',     color: '#d97706', bg: '#fef3c7', icon: '🔄' },
  'Pending Goods Receipt Hold': { label: 'GR Hold',         color: '#b45309', bg: '#fef3c7', icon: '⏳' },
  'Insufficient PO Funds Hold': { label: 'PO Funds Hold',   color: '#dc2626', bg: '#fee2e2', icon: '🚫' },
  'Rejected':                   { label: 'Rejected',        color: '#dc2626', bg: '#fee2e2', icon: '❌' },
  'Cancelled':                  { label: 'Cancelled',       color: '#6b7280', bg: '#f3f4f6', icon: '🚫' },
  'Cancellation in Progress':   { label: 'Cancelling',      color: '#6b7280', bg: '#f3f4f6', icon: '🚫' },
};

// Normalize Sage invoice ID → Payee Central format (remove dash after prefix)
// ECI-023017 → ECI023017
// AST-001857 → AST001857
// S-8496 → S8496
function toPayeeId(sageId) {
  if (!sageId) return null;
  return sageId.replace(/^([A-Z]+)-/, '$1');
}

// ─── Feed loader (cached in memory, TTL 30 min) ──────────────────────────────

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 30 * 60 * 1000;

// Amazon can carry multiple entries for the same invoice # over its lifecycle:
// an original plus letter-suffixed resubmissions (S8604 / S8604A / S8604B). Any
// one of them being alive means the invoice IS in the system. So the "current
// true state" is the BEST attempt by status, NOT simply the latest by date — a
// live original must win over a later cancelled resubmission (real case: an
// invoice resubmitted by mistake, then the resubmission cancelled, while the
// original stayed live). Date only breaks ties between equal statuses.
const STATUS_PRIORITY = {
  'Paid': 5,
  'Applied': 5,
  'Scheduled for payment': 4,
  'In Progress': 3,
  'Pending Goods Receipt Hold': 2,
  'Insufficient PO Funds Hold': 2,
  'Rejected': 1,
  'Cancelled': 1,
  'Cancellation in Progress': 1,
};

// Cancelled/Rejected are terminal-dead. 'Cancellation in Progress' counts as
// dead too: once a cancellation is requested the attempt will never pay, and
// the resubmission goes out under a suffixed number (…A) so it doesn't collide
// with the original while Amazon finishes processing the cancellation.
// Everything else means the attempt is live in Amazon's system.
const DEAD_STATUSES = new Set(['Cancelled', 'Rejected', 'Cancellation in Progress']);
function isLiveStatus(status) { return !DEAD_STATUSES.has((status || '').trim()); }

function moreCurrentEntry(a, b) {
  const prioA = STATUS_PRIORITY[(a['Invoice Status'] || '').trim()] || 0;
  const prioB = STATUS_PRIORITY[(b['Invoice Status'] || '').trim()] || 0;
  if (prioA !== prioB) return prioA > prioB ? a : b;
  const dateA = Date.parse(a['Entry Date']) || 0;
  const dateB = Date.parse(b['Entry Date']) || 0;
  return dateA >= dateB ? a : b;
}

function loadFeed() {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL) return _cache;

  try {
    const raw  = fs.readFileSync(FEED_PATH, 'utf8');
    const feed = JSON.parse(raw);

    // Build lookup index: payeeInvoiceId (uppercase, no spaces) → item
    const index = {};
    let duplicatesResolved = 0;
    for (const item of (feed.items || [])) {
      const k = (item['Invoice #'] || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!k) continue;
      if (index[k]) { index[k] = moreCurrentEntry(index[k], item); duplicatesResolved++; }
      else index[k] = item;
    }
    if (duplicatesResolved > 0) console.log(`[payee] Resolved ${duplicatesResolved} duplicate invoice # entries to their most current status`);

    _cache = { generatedAt: feed.generatedAt, index, total: (feed.items || []).length };
    _cacheTs = now;
    console.log(`[payee] Feed loaded: ${_cache.total} items, generated ${feed.generatedAt}`);
  } catch (e) {
    console.error('[payee] Failed to load feed:', e.message);
    _cache = { generatedAt: null, index: {}, total: 0 };
    _cacheTs = now;
  }
  return _cache;
}

// ─── Public API ─────────────────────────────────────────────────────────────

function toEntryShape(matchedId, item, extra) {
  const status   = (item['Invoice Status'] || '').trim();
  const statusMeta = STATUS_LABEL[status] || { label: status, color: '#6b7280', bg: '#f3f4f6', icon: '•' };
  return {
    payeeId: matchedId,
    status,
    statusMeta,
    isLive:    isLiveStatus(status),
    po:        (item['Purchase Order #'] || '').trim(),
    amount:    item['Invoice Amount'] ?? null,
    dueDate:   (item['Estimated Due Date'] || '').trim(),
    entryDate: (item['Entry Date'] || '').trim(),
    invoiceDate: (item['Invoice Date'] || '').trim(),
    ...extra,
  };
}

/**
 * Resolve a Payee Central invoice ID to its current TRUE state across the
 * resubmission chain. Payee Central rejects reused invoice numbers, so a
 * cancelled/rejected invoice is resubmitted with a letter appended (S8604 ->
 * S8604A -> S8604B) while Sage keeps the original number. We gather the base ID
 * plus every letter-suffixed attempt and return the BEST by status (a live
 * attempt beats a dead one regardless of date — so a live original wins over a
 * mistaken, later, cancelled resubmission). Also surfaces monitoring info:
 * how many attempts exist, how many are still live, and an anomaly flag when
 * more than one attempt is simultaneously live (a likely duplicate submission).
 */
function resolveInvoice(payeeId) {
  const feed = loadFeed();
  if (!payeeId) return null;
  const base = payeeId.toUpperCase();
  const candidates = [];
  if (feed.index[base]) candidates.push({ id: base, item: feed.index[base] });
  for (const k of Object.keys(feed.index)) {
    if (k !== base && k.startsWith(base) && /^[A-Z]{1,2}$/.test(k.slice(base.length))) {
      candidates.push({ id: k, item: feed.index[k] });
    }
  }
  if (!candidates.length) return null;

  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    if (moreCurrentEntry(best.item, c.item) === c.item) best = c;
  }

  const liveAttempts = candidates.filter(c => isLiveStatus((c.item['Invoice Status'] || '').trim()));
  const attempts = candidates
    .map(c => ({ id: c.id, status: (c.item['Invoice Status'] || '').trim(), entryDate: (c.item['Entry Date'] || '').trim() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Next free suffix (for a genuine resubmission need): one past the highest used.
  const suffixes = candidates.map(c => c.id.slice(base.length)).filter(Boolean).sort();
  const lastSuffix = suffixes.length ? suffixes[suffixes.length - 1] : '';
  const suggestedResubmitId = base + (lastSuffix ? String.fromCharCode(lastSuffix.charCodeAt(lastSuffix.length - 1) + 1) : 'A');

  // Anomaly: more than one attempt live at once = likely a duplicate submission
  // that someone needs to look at (the ECI-022485 pattern, before cancellation).
  const duplicateLive = liveAttempts.length > 1;

  return toEntryShape(best.id, best.item, {
    attemptCount: candidates.length,
    liveCount: liveAttempts.length,
    attempts,
    suggestedResubmitId,
    duplicateLive,
    // "needs (re)submission" only when NOTHING is live — every attempt is dead.
    needsResubmission: liveAttempts.length === 0,
  });
}

/**
 * Look up a Sage invoice ID in the Payee Central feed (resubmission-aware).
 * @param {string} sageInvoiceId  e.g. "ECI-023017"
 * @returns {{ status, statusMeta, po, amount, dueDate, entryDate, payeeId, attemptCount, suggestedResubmitId } | null}
 */
function lookupInvoice(sageInvoiceId) {
  const payeeId = toPayeeId(sageInvoiceId);
  if (!payeeId) return null;
  return resolveInvoice(payeeId);
}

/**
 * Check if this invoice is an Amazon invoice (customer C-00403 or invoice prefix ECI-).
 * For the portal we consider any ECI- or AST- that appears in the Payee Central feed.
 */
function isAmazonInvoice(sageInvoiceId) {
  const feed = loadFeed();
  const payeeId = toPayeeId(sageInvoiceId);
  if (!payeeId) return false;
  return !!feed.index[payeeId.toUpperCase()];
}

function feedMeta() {
  const feed = loadFeed();
  return { generatedAt: feed.generatedAt, total: feed.total };
}

function invalidateCache() {
  _cache = null;
  _cacheTs = 0;
}


/**
 * Returns a map of ALL Payee Central entries keyed by payeeId (uppercase, no dash).
 * Each value: { status, statusMeta, po, dueDate }
 * Used by the client for table-row badge rendering.
 */
function getIndex() {
  const feed = loadFeed();
  const result = {};
  for (const [k, item] of Object.entries(feed.index)) {
    const status    = (item['Invoice Status'] || '').trim();
    const statusMeta = STATUS_LABEL[status] || { label: status, color: '#6b7280', bg: '#f3f4f6', icon: '•' };
    result[k] = {
      status,
      statusMeta,
      po:      (item['Purchase Order #'] || '').trim(),
      dueDate: (item['Estimated Due Date'] || '').trim(),
      amount:  item['Invoice Amount'] ?? null,
    };
  }
  return result;
}

// ─── Open PO ceilings (from Payee Central SearchOpenPOs) ──────────────────

let _openPoCache = null;
let _openPoCacheTs = 0;

/**
 * Returns { generatedAt, byPo: { poNumber -> {amount, status, currency,...} } }
 * from the authoritative open-PO amounts captured by payee-scraper's openpos run.
 */
function getOpenPoMap() {
  const now = Date.now();
  if (_openPoCache && (now - _openPoCacheTs) < CACHE_TTL) return _openPoCache;
  try {
    const data = JSON.parse(fs.readFileSync(OPEN_POS_PATH, 'utf8'));
    const byPo = {};
    for (const p of (data.pos || [])) {
      if (p.poNumber) byPo[p.poNumber.trim().toUpperCase()] = p;
    }
    _openPoCache = { generatedAt: data.generatedAt, byPo, total: (data.pos || []).length };
  } catch (e) {
    _openPoCache = { generatedAt: null, byPo: {}, total: 0 };
  }
  _openPoCacheTs = now;
  return _openPoCache;
}

function invalidateOpenPoCache() { _openPoCache = null; _openPoCacheTs = 0; }

module.exports = { lookupInvoice, resolveInvoice, isAmazonInvoice, feedMeta, getIndex, invalidateCache, toPayeeId, getOpenPoMap, invalidateOpenPoCache };
