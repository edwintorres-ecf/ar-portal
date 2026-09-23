'use strict';
// ─── po-doc-recheck.js ──────────────────────────────────────────────────────
// When the portal says a PO document disagrees with Amazon, re-read EVERY
// document we hold for that PO before anyone goes and argues with Amazon.
//
// Why this exists. `po-doc-watcher` parses ONE file per PO — whichever it picks
// as the latest — and stores a single `docAmount`. So "PO value disagrees with
// the document" can mean two completely different things:
//
//   · we are reading an OLDER revision and Amazon is right (nothing to do but
//     point the portal at the newer file), or
//   · every document we hold really does disagree (a genuine reconciliation,
//     worth someone's time and an email to Amazon).
//
// Those need opposite actions, and the intake-health sheet could not tell them
// apart. This re-parses every file on the PO and says which case it is.
//
// It is deliberately NOT part of the hourly intake sweep. Each check means
// downloading and parsing PDFs from SharePoint through Graph, which is far too
// slow to sit behind a screen refresh or a download button — the reason the
// workbook's "Exceptions checked" sheet only ever existed when someone ran a
// script by hand. It runs on its own slow timer and caches, and the workbook
// reads the cache.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const PO_DOCS_PATH = path.join(__dirname, 'po-docs.json');
// Amazon and the document are allowed to differ by small change; $1 is the
// same tolerance po-ledger uses to raise the discrepancy in the first place.
const MATCH_TOLERANCE = 1;

function docsByPo() {
  try { return JSON.parse(fs.readFileSync(PO_DOCS_PATH, 'utf8')).byPo || {}; }
  catch (e) { return {}; }
}

/** A stable signature of the files we hold, so unchanged POs are not re-parsed. */
function fileSig(entry) {
  return (entry.files || [])
    .map(f => `${f.name}@${f.modified || ''}`)
    .sort()
    .join('|');
}

function ensureTable() {
  try {
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS po_doc_recheck (
      po_number   TEXT PRIMARY KEY,
      file_sig    TEXT,
      amazon      REAL,
      portal      REAL,
      newest      REAL,
      newest_file TEXT,
      resolves    INTEGER,
      stale       INTEGER,
      per_file    TEXT,
      action      TEXT,
      site        TEXT,
      checked_at  TEXT
    )`);
  } catch (e) { console.error('[po-doc-recheck] table:', e.message); }
}

/**
 * Re-read every document for each PO the ledger flags as a ceiling
 * discrepancy. Only POs whose file set has changed since the last run are
 * re-parsed; everything else is served from cache.
 */
async function run(invoices, { limit = 40, force = false } = {}) {
  ensureTable();
  const d = db.getDb();
  const ledger = require('./po-ledger').getPoLedger(invoices);
  const flagged = ledger.filter(p => p.ceilingDiscrepancy);
  const byPo = docsByPo();

  const cached = {};
  for (const r of d.prepare('SELECT po_number, file_sig FROM po_doc_recheck').all()) cached[r.po_number] = r.file_sig;

  const save = d.prepare(`INSERT INTO po_doc_recheck
    (po_number, file_sig, amazon, portal, newest, newest_file, resolves, stale, per_file, action, site, checked_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(po_number) DO UPDATE SET
      file_sig=excluded.file_sig, amazon=excluded.amazon, portal=excluded.portal,
      newest=excluded.newest, newest_file=excluded.newest_file, resolves=excluded.resolves,
      stale=excluded.stale, per_file=excluded.per_file, action=excluded.action,
      site=excluded.site, checked_at=excluded.checked_at`);

  let parsed = 0, skipped = 0, failed = 0;
  const watcher = require('./po-doc-watcher');
  for (const p of flagged.slice(0, limit)) {
    const entry = byPo[p.poNumber];
    if (!entry || !(entry.files || []).length) { skipped++; continue; }
    const sig = fileSig(entry);
    if (!force && cached[p.poNumber] === sig) { skipped++; continue; }

    // scrapedCeiling is Amazon's own figure; ceilingAmount may have been
    // sourced from the document, which would make the comparison circular.
    const amazon = p.scrapedCeiling != null ? p.scrapedCeiling : null;
    const perFile = [];
    for (const f of entry.files) {
      try {
        // Gentle pacing: Graph answered a bulk re-parse with 910 straight 429s.
        await new Promise(r => setTimeout(r, 300));
        const x = await watcher.fetchAndExtract(f.name, f.folder);
        perFile.push({ name: f.name, docDate: f.docDate || null, version: f.version,
          amount: x.amount == null ? null : x.amount, isCurrent: entry.latestFile && f.name === entry.latestFile.name });
      } catch (e) {
        failed++;
        perFile.push({ name: f.name, docDate: f.docDate || null, version: f.version,
          amount: null, error: e.message.slice(0, 80), isCurrent: entry.latestFile && f.name === entry.latestFile.name });
      }
    }
    parsed++;

    // "Newest" means the document that AGREES with Amazon if one does —
    // that is the question being asked. Otherwise the most recent readable one.
    const readable = perFile.filter(f => f.amount != null);
    const agreeing = readable.filter(f => amazon != null && Math.abs(f.amount - amazon) <= MATCH_TOLERANCE);
    const byDate = readable.slice().sort((a, b) =>
      String(b.docDate || '').localeCompare(String(a.docDate || '')) || (b.version || 0) - (a.version || 0));
    const winner = agreeing[0] || byDate[0] || null;
    const resolves = !!agreeing.length;
    // The portal is reading a file other than the one that answers the question.
    const stale = resolves && winner && !winner.isCurrent;

    const action = !readable.length
      ? 'No document on file could be read — check the PDF opens, then re-file it.'
      : resolves
        ? (stale
          ? `Resolved: "${winner.name}" matches Amazon. The portal is reading a different file — no dispute to raise.`
          : 'Resolved: the document the portal already reads matches Amazon. The discrepancy has cleared.')
        : `Genuine disagreement: no document on file matches Amazon's ${amazon == null ? 'figure' : '$' + Math.round(amazon).toLocaleString('en-US')}. Reconcile with Amazon.`;

    save.run(p.poNumber, sig, amazon, p.docAmount ?? null,
      winner ? winner.amount : null, winner ? winner.name : null,
      resolves ? 1 : 0, stale ? 1 : 0, JSON.stringify(perFile), action,
      p.siteCode || '', new Date().toISOString());
  }

  // Anything no longer flagged should stop being reported.
  const live = new Set(flagged.map(p => p.poNumber));
  let dropped = 0;
  for (const r of d.prepare('SELECT po_number FROM po_doc_recheck').all()) {
    if (!live.has(r.po_number)) {
      d.prepare('DELETE FROM po_doc_recheck WHERE po_number=?').run(r.po_number);
      dropped++;
    }
  }
  return { flagged: flagged.length, parsed, skipped, failed, dropped };
}

/** The cached result, in the shape po-intake-workbook's sheet 4 expects. */
function latest() {
  ensureTable();
  try {
    return db.getDb().prepare(`SELECT * FROM po_doc_recheck ORDER BY resolves ASC, po_number`).all()
      .map(r => ({
        poNumber: r.po_number,
        site: r.site || '',
        amazon: r.amazon,
        portal: r.portal,
        newest: r.newest,
        newestFile: r.newest_file,
        resolves: !!r.resolves,
        stale: !!r.stale,
        action: r.action,
        perFile: (() => { try { return JSON.parse(r.per_file || '[]'); } catch (e) { return []; } })(),
        checkedAt: r.checked_at,
      }));
  } catch (e) { return []; }
}

module.exports = { run, latest, ensureTable, MATCH_TOLERANCE };
