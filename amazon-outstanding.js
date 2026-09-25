'use strict';
// ─── amazon-outstanding.js ──────────────────────────────────────────────────
// Every open Amazon dollar, in one place, split by WHERE IT IS STUCK.
//
// The portal already answered both halves of this question, on two screens
// that never met: "Needs Upload" is what we have not sent, "⏳ Aging" is what
// Amazon is sitting on. Neither shows the whole book, and neither ties to the
// Sage balance — so "how much Amazon money is outstanding, and whose move is
// it" could only be answered by adding up tabs by hand.
//
// This builds ONE ledger where every open Amazon invoice lands in exactly one
// stage and the stages sum to total open Amazon AR. That is the property that
// makes it trustworthy: if the segments do not add up to Sage, the screen says
// so rather than quietly dropping rows.
//
// ─── THE UPLOADED / NOT-UPLOADED LINE ───────────────────────────────────────
// Drawn on whether a LIVE attempt exists in Payee Central, never on whether we
// once transmitted it. An invoice whose every attempt was rejected or cancelled
// is NOT uploaded, however many times it was sent — Edwin's standing rule:
// "if it does not exist in payee it does not exist and should be considered
// failed or needing upload".
//
// `payeeIsLive` is that test (payee.resolveInvoice walks the S8604 → S8604A
// suffix chain and reports whether ANY attempt survives). Splitting on "has a
// payee status" instead would file 6 invoices / $50,607 of dead attempts under
// "waiting on Amazon" when Amazon is not holding them at all, and would put
// this screen 6 rows out of step with Needs Upload.

const siteLedger = require('./site-ledger');
const poLedger = require('./po-ledger');
const payee = require('./payee');

const round = (n) => Math.round((n || 0) * 100) / 100;

// ─── Stages, in pipeline order ──────────────────────────────────────────────
// `whose` is the point of the whole screen: it turns $25.7M of status labels
// into a short list of who has to do something. Four owners, no overlap:
//   us         — we act: send it, or fix and resend it
//   funds      — the PO cannot pay it; someone has to ask Amazon for money
//   amazon     — with Amazon, moving (or not) on their clock
//   accounting — Amazon already paid; the balance is open in Intacct only
//
// Funds is deliberately NOT folded into "us" or "amazon". It is the single
// largest owner and it spans both halves — invoices we cannot send AND invoices
// Amazon is holding, both waiting on the same PO funding request. Splitting
// them by upload state, which is how the old screens divided them, hid that
// they are one problem.
const STAGES = [
  // ── not uploaded ──
  { key: 'no-po',        label: 'No PO on the invoice',      half: 'not-uploaded', whose: 'us',
    reason: 'Never submitted and cannot be: assign a PO to pull it into Needs Upload' },
  { key: 'ready',        label: 'Clear to send',             half: 'not-uploaded', whose: 'us',
    reason: 'The PO has headroom. Nothing is blocking this but transmitting it' },
  { key: 'resubmit',     label: 'Failed — needs resending',  half: 'not-uploaded', whose: 'us',
    reason: 'Every attempt was rejected or cancelled, so Amazon holds nothing. Fix and resubmit' },
  { key: 'blocked-funds', label: 'Held back — PO has no room', half: 'not-uploaded', whose: 'funds',
    reason: 'Sending it would overage the PO. Amazon would reject or hold it' },
  // ── uploaded and live ──
  { key: 'funds-hold',   label: 'Insufficient PO funds hold', half: 'uploaded', whose: 'funds',
    reason: 'Amazon has it and will not pay until the PO is funded' },
  { key: 'goods-receipt', label: 'Pending goods receipt',     half: 'uploaded', whose: 'amazon',
    reason: 'Waiting on Amazon to receipt the work' },
  { key: 'in-progress',  label: 'In progress',               half: 'uploaded', whose: 'amazon',
    reason: 'Moving normally through Amazon' },
  { key: 'scheduled',    label: 'Scheduled for payment',     half: 'uploaded', whose: 'amazon',
    reason: 'Amazon has scheduled it for payment' },
  // ── settled ──
  { key: 'apply-cash',   label: 'Paid — needs applying',     half: 'settled', whose: 'accounting',
    reason: 'Amazon paid. The balance is open in Intacct only, and chasing it would be wrong' },
];
const STAGE_BY_KEY = Object.fromEntries(STAGES.map(s => [s.key, s]));

const HALVES = {
  'not-uploaded': { label: 'Not uploaded',         note: 'Nothing is in Amazon’s hands' },
  'uploaded':     { label: 'Uploaded, not yet paid', note: 'Live in Payee Central' },
  'settled':      { label: 'Paid by Amazon',       note: 'Open in Intacct only' },
};

const WHOSE = {
  us:         { label: 'Ours to send',     note: 'We can move this today' },
  funds:      { label: 'Waiting on PO funds', note: 'Needs money added to a PO' },
  amazon:     { label: 'With Amazon',      note: 'On their clock' },
  accounting: { label: 'Cash application', note: 'Paid — apply it in Intacct' },
};

/**
 * Which stage an invoice is in.
 *
 * `nu` is its Needs Upload row when it has one, which is where the funds
 * verdict comes from. That verdict is computed against the PO's real remaining
 * headroom with the PO's OTHER pending invoices already charged — reproducing
 * it here from `poAvailable` would drift from what Needs Upload shows and the
 * two screens would disagree about the same invoice.
 */
function stageOf(row, nu) {
  if (!row.payeeIsLive) {
    if (!row.po) return 'no-po';
    // A dead attempt means Amazon saw it and threw it back. That is a different
    // job from a first send — someone has to find out why before resending —
    // so it gets its own stage rather than being counted as "clear to send".
    if (row.payeeStatus) return 'resubmit';
    if (nu && nu.wouldOverage) return 'blocked-funds';
    return 'ready';
  }
  const st = (row.payeeStatus || '').trim();
  if (row.amazonSettled) return 'apply-cash';
  if (st === 'Insufficient PO Funds Hold' || st === 'Insufficient Amazon PO Manager Hold') return 'funds-hold';
  if (st === 'Pending Goods Receipt Hold') return 'goods-receipt';
  if (st === 'Scheduled for payment') return 'scheduled';
  return 'in-progress';
}

/** Days since we billed it. The one clock that applies to every stage. */
function ageDays(row) {
  const t = Date.parse(row.invoiceDate);
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/**
 * Days past AMAZON's own Estimated Due Date, or null if that date has not
 * passed (or there is none).
 *
 * ─── THIS IS A FLAG, NOT A STAGE ────────────────────────────────────────────
 * It was first built as a stage, "Scheduled — date passed", on TWO wrong
 * assumptions. First it read Sage's due date, which is OUR payment terms, and
 * so called all 264 scheduled invoices late ($5.37M) when not one had passed
 * Amazon's date. Second, even corrected, a stage can only describe invoices in
 * the "Scheduled" status — and lateness is not confined to them: 255 invoices
 * on Pending Goods Receipt Hold and 83 on a funds hold are past Amazon's date
 * too, and those are the more chaseable, because nothing is scheduled at all.
 *
 * So the stage says WHERE the invoice is and this says WHETHER Amazon has
 * blown its own clock. The two are independent, and every uploaded stage can
 * carry it.
 */
function lateDays(row) {
  const t = Date.parse(row.payeeDueDate);
  if (isNaN(t)) return null;
  const d = Math.floor((Date.now() - t) / 86400000);
  return d > 0 ? d : null;
}

const BANDS = [['0-30', 0, 30], ['31-60', 31, 60], ['61-90', 61, 90], ['90+', 91, null]];
function bandsOf(list) {
  const out = {};
  for (const [k, lo, hi] of BANDS) {
    const sel = list.filter(i => i.ageDays !== null && i.ageDays >= lo && (hi === null || i.ageDays <= hi));
    out[k] = { count: sel.length, amount: round(sel.reduce((t, i) => t + i.amount, 0)) };
  }
  return out;
}

function tally(list) {
  return { count: list.length, amount: round(list.reduce((t, i) => t + i.amount, 0)) };
}

/**
 * The whole outstanding book, as a flat list — one row per open Amazon invoice,
 * each tagged with its stage, half and owner.
 *
 * Deliberately NOT pre-aggregated. The screen has to re-total anyway whenever
 * the business-unit or site filter is on, and a second set of sums computed
 * here would be a second thing to keep in step. Totals are sums over these
 * rows wherever they appear, so they cannot disagree with the rows behind them.
 *
 * @param invoices already scoped to the caller by applyUserFilter, exactly as
 *        every other /api/po route does — the scoping is not repeated here.
 */
function classify(invoices) {
  const rows = siteLedger.buildAmazonRows(invoices, { payee });

  // Needs Upload's own rows, for the funds verdict. Cheap: getPoLedger is
  // memoised on the invoice array identity, so this reuses the ledger the
  // caller has almost certainly just built.
  const nuByRec = {};
  try {
    for (const r of poLedger.getNeedsUpload(invoices)) nuByRec[String(r.recordNo)] = r;
  } catch (e) { /* degrade to no funds verdict rather than no screen */ }

  // What KIND of work each dollar is, so the screen can be scoped to snow in
  // season. Keyed on the PO the invoice will be billed against — `r.po` from
  // buildAmazonRows is already assignment-aware — which is the same chain
  // Needs Upload, Pending by Site and Amazon AR use. getPoLedger is memoised
  // on the invoice array, so this reuses the ledger getNeedsUpload just built.
  const svcByPo = {};
  try {
    for (const r of poLedger.getPoLedger(invoices)) svcByPo[r.poNumber] = r.serviceType || '';
  } catch (e) { /* every row falls back to unclassified */ }

  const items = [];
  for (const r of rows) {
    const amount = r.amount || 0;
    if (amount <= 0.005) continue;            // settled and applied — not outstanding
    const nu = nuByRec[String(r.recordNo)];
    const key = stageOf(r, nu);
    const st = STAGE_BY_KEY[key];
    items.push({
      recordNo: r.recordNo,
      invoiceId: r.invoiceId,
      amount,
      site: r.site || '',
      siteCode: r.site || '',                 // poRowMatches/poSiteCell read siteCode
      businessUnit: r.businessUnit || '',
      serviceCenter: r.serviceCenter || '',
      region: r.region || '',
      po: r.po || '',
      poNumber: r.po || '',
      // '' and 'unknown' both mean nobody has said what this work is; the
      // screen folds them into one Unclassified bucket.
      serviceType: svcByPo[r.po] || '',
      invoiceDate: r.invoiceDate || '',
      dueDate: r.dueDate || '',                 // Sage's, i.e. OUR terms
      amazonDueDate: r.payeeDueDate || '',      // Amazon's Estimated Due Date
      ageDays: ageDays(r),
      daysInPayee: r.daysInPayee ?? null,
      lateDays: lateDays(r),                    // past AMAZON's date, null if not
      amazonLate: lateDays(r) !== null,
      payeeStatus: r.payeeStatus || '',
      payeeId: r.payeeId || '',
      stage: key,
      stageLabel: st.label,
      half: st.half,
      whose: st.whose,
      // What to ask for, when the answer is money — from Needs Upload's own
      // figure, computed against real headroom with the PO's other pending
      // already charged. Left null for held invoices: their shortfall is a
      // property of the PO, not of one invoice, and summing per-invoice
      // shortfalls across a shared PO would count the same gap several times.
      shortfall: key === 'blocked-funds' && nu && nu.poAvailable != null
        ? round(amount - Math.max(0, nu.poAvailable))
        : null,
    });
  }

  let feedGeneratedAt = null;
  try { feedGeneratedAt = payee.feedMeta().generatedAt || null; } catch (e) {}

  return {
    generatedAt: new Date().toISOString(),
    feedGeneratedAt,
    totals: tally(items),
    items: items.sort((a, b) => b.amount - a.amount),
    stageMeta: STAGES,
    halfMeta: HALVES,
    whoseMeta: WHOSE,
  };
}

/**
 * Aggregates over a set of classified rows. Used by the tests and the nightly
 * check; the screen does the same sums in the browser over the same rows.
 */
function summarize(items) {
  const byKey = (field, order) => order.map(key => {
    const list = items.filter(i => i[field] === key);
    const ages = list.map(i => i.ageDays).filter(n => n !== null).sort((a, b) => a - b);
    return {
      key, ...tally(list),
      medianAge: ages.length ? ages[Math.floor(ages.length / 2)] : null,
      oldestAge: ages.length ? ages[ages.length - 1] : null,
    };
  }).filter(x => x.count > 0);
  return {
    totals: tally(items),
    stages: byKey('stage', STAGES.map(s => s.key)),
    halves: byKey('half', Object.keys(HALVES)),
    whose: byKey('whose', Object.keys(WHOSE)),
    bands: bandsOf(items),
  };
}

module.exports = { classify, summarize, STAGES, HALVES, WHOSE, stageOf };
