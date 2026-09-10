'use strict';
/**
 * db.js — SQLite database init and helpers for ECF AR Portal
 * Uses Node.js built-in node:sqlite (Node 22+)
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ar-portal.db');
let db;

// NOTE: do NOT quarantine a WAL proactively by comparing mtimes. A checkpoint
// writes the database file and leaves the WAL untouched, so a perfectly live
// WAL routinely ends up OLDER than the database — the mtime test cannot tell
// that apart from an abandoned one. The proactive check added 2026-09-02 did
// exactly this to the running server: it renamed the WAL out from under an
// open connection, leaving the server writing to an orphaned inode that no
// other reader could see, and split the -shm locking two ways. Quarantine is
// only safe REACTIVELY, once an open has actually failed as malformed — see
// the catch in getDb() below, which is the path the crash-loop fix needs.

function openDatabase() {
  const d = new DatabaseSync(DB_PATH);
  try {
    d.exec('PRAGMA journal_mode = WAL');   // better concurrency
    // WAL lets readers and one writer coexist, but a SECOND writer still gets
    // SQLITE_BUSY immediately with no wait. The portal is not the only process
    // that writes — scrapers and maintenance scripts do too — and a rejection
    // reason was lost to "database is locked" during the first scrape pass
    // (2026-09-10). Wait for the other writer instead of failing instantly.
    d.exec('PRAGMA busy_timeout = 10000');
  } catch (e) {
    // Close the failed handle; a half-open connection keeps the bad WAL state
    // in-process and poisons any retry made inside this same process.
    try { d.close(); } catch (_) {}
    throw e;
  }
  return d;
}

function getDb() {
  if (!db) {
    try {
      db = openDatabase();
    } catch (e) {
      // Last resort: quarantine whatever WAL is present and exit so systemd
      // restarts into a FRESH process — reopening in-process re-poisons it.
      const fs = require('fs');
      const wal = DB_PATH + '-wal';
      if (/malformed|not a database/i.test(e.message) && fs.existsSync(wal)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
        try { fs.renameSync(wal, `${wal}.stale-${stamp}`); } catch (_) {}
        try { if (fs.existsSync(DB_PATH + '-shm')) fs.renameSync(DB_PATH + '-shm', `${DB_PATH}-shm.stale-${stamp}`); } catch (_) {}
        console.error(`[db] MALFORMED on open — quarantined ${wal}.stale-${stamp}; restarting for a clean open`);
      }
      throw e;
    }
    db.exec('PRAGMA foreign_keys = ON');

    // customer_accounts: stop_service flag + owner assignment
    db.exec(`
      CREATE TABLE IF NOT EXISTS customer_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT UNIQUE NOT NULL,
        customer_name TEXT,
        stop_service INTEGER DEFAULT 0,
        owner_name TEXT DEFAULT NULL,
        owner_email TEXT DEFAULT NULL,
        notes TEXT DEFAULT NULL,
        updated_by TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_ca_cid ON customer_accounts(customer_id)');

    // watchlist: per-user pinned invoices
    db.exec(`
      CREATE TABLE IF NOT EXISTS watchlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        record_no TEXT NOT NULL,
        invoice_id TEXT,
        customer_name TEXT,
        added_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_email, record_no)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_wl_user ON watchlist(user_email)');


    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_no TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_name TEXT NOT NULL,
      type TEXT DEFAULT 'note',
      body TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS promises_to_pay (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_no TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_name TEXT NOT NULL,
      amount REAL NOT NULL,
      promise_date TEXT NOT NULL,
      note TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'viewer',
      location_filter TEXT,
      customer_filter TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT,
      action TEXT,
      record_no TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notes_record ON notes(record_no);
    CREATE INDEX IF NOT EXISTS idx_ptp_record ON promises_to_pay(record_no);
    CREATE INDEX IF NOT EXISTS idx_ptp_date ON promises_to_pay(promise_date);
    CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_log(record_no);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_email);

    CREATE TABLE IF NOT EXISTS invoice_location (
      record_no    TEXT PRIMARY KEY,
      location_id  TEXT,
      location_name TEXT,
      fetched_at   TEXT DEFAULT (datetime('now'))
    );

    -- Intacct DEPARTMENT per invoice, read from ARINVOICEITEM alongside the
    -- location. Department is a LINE-level field in Intacct, so dept_id holds
    -- the invoice's department and dept_mixed flags the case where the lines
    -- disagree — a mixed invoice cannot be filed under one service line and has
    -- to be visible rather than silently bucketed by whichever line came first.
    -- all_depts keeps the full pipe-joined set so the disagreement is inspectable.
    CREATE TABLE IF NOT EXISTS invoice_department (
      record_no    TEXT PRIMARY KEY,
      dept_id      TEXT,
      dept_name    TEXT,
      dept_mixed   INTEGER DEFAULT 0,
      all_depts    TEXT,
      fetched_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_invdept_dept ON invoice_department(dept_id);

    -- Amazon's own location master: site code -> business unit, region, zone,
    -- address. Loaded from the network location workbook, and the authority for
    -- gate 2 of the Amazon view. Kept as a table rather than read from the
    -- spreadsheet at request time so a filter is a join, not a file parse.
    CREATE TABLE IF NOT EXISTS amazon_locations (
      site_code     TEXT PRIMARY KEY,
      business_unit TEXT,
      region        TEXT,
      zone          TEXT,
      city          TEXT,
      state         TEXT,
      country       TEXT,
      serviced      TEXT,
      omnia_loc_id  TEXT,
      address       TEXT,
      ops_parent    TEXT,
      loaded_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_amzloc_bu ON amazon_locations(business_unit);

    -- Retired / variant site codes mapped to the code Amazon uses today.
    -- Amazon renames sites, but the old code lives forever in the ship-to text
    -- of every invoice raised before the change (MDT9 became QYY4). Without a
    -- mapping those invoices orphan from the location master permanently and
    -- drop out of any business-unit view, which is silent revenue loss on a
    -- report. Aliases are data, not code, so a rename is a row, not a deploy.
    CREATE TABLE IF NOT EXISTS site_aliases (
      alias          TEXT PRIMARY KEY,
      canonical_code TEXT NOT NULL,
      note           TEXT,
      set_by         TEXT,
      set_at         TEXT DEFAULT (datetime('now'))
    );

    -- Codes that appear where a site code belongs but are NOT service sites.
    -- BNA12 is Amazon's Nashville HQ at 101 Platform Way N: it is the SHIP TO on
    -- the header of multi-site blanket POs whose real sites are the line items
    -- (2D-20105615 header BNA12, lines DBL1 / DJR5 / DPP1 / DYY8). Resolving an
    -- invoice to the header code would file four sites' revenue under a
    -- corporate address, so these are refused as an answer everywhere.
    CREATE TABLE IF NOT EXISTS site_code_blocklist (
      code    TEXT PRIMARY KEY,
      reason  TEXT,
      set_by  TEXT,
      set_at  TEXT DEFAULT (datetime('now'))
    );

    -- Ship-to text that marks an invoice as belonging to a DIFFERENT process,
    -- not as one missing a site. "CW Amazon Services" is its own workflow
    -- (Edwin 2026-09-09), so those invoices are not site-attributed and must
    -- not sit in the site cleanup queue pretending to be unfinished work.
    CREATE TABLE IF NOT EXISTS shipto_exemptions (
      pattern TEXT PRIMARY KEY,
      label   TEXT,
      reason  TEXT,
      set_by  TEXT,
      set_at  TEXT DEFAULT (datetime('now'))
    );

    -- The org roles themselves, as DATA. They were hardcoded, which meant adding
    -- a role or changing who manages whom was a code change. The list drives the
    -- org chart's validation; individual placements can still override it for
    -- one-off adjustments, and those overrides are recorded as exceptions.
    CREATE TABLE IF NOT EXISTS org_role_defs (
      code       TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      rank       INTEGER NOT NULL DEFAULT 5,
      manages    TEXT,            -- JSON array of role codes
      sort_order INTEGER NOT NULL DEFAULT 100,
      active     INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Who owns an Amazon SITE. Collectors were only ever assignable per invoice
    -- or per customer, and Amazon is ONE customer with 219 sites — so customer
    -- level is useless here and per invoice means reassigning thousands of rows
    -- forever. The site is the unit of ownership that matches how the work is
    -- actually divided. Precedence stays invoice > site > customer.
    CREATE TABLE IF NOT EXISTS site_collectors (
      site_code       TEXT PRIMARY KEY,
      collector_email TEXT NOT NULL,
      assigned_by     TEXT,
      assigned_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sitecoll_email ON site_collectors(collector_email);

    -- Which departments a service center is allowed to accrue against. Not every
    -- branch does every kind of work, and offering all six on every form invites
    -- an accrual booked to a department the branch does not run. Absence of a
    -- row means NO restriction, so configuring one branch never silently
    -- constrains the others.
    CREATE TABLE IF NOT EXISTS sc_departments (
      service_center TEXT NOT NULL,
      dept_id        TEXT NOT NULL,
      updated_by     TEXT,
      updated_at     TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (service_center, dept_id)
    );

    -- Work performed for Amazon with no PO yet, waiting on an accrual. This is
    -- revenue earned that cannot be invoiced, so it is invisible in AR by
    -- definition — the whole point of the register is that the money is
    -- somewhere other than an invoice. Never hard-deleted: a mistake becomes
    -- status 'cancelled' with a reason, per the never-delete rule.
    CREATE TABLE IF NOT EXISTS amazon_accruals (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id    TEXT NOT NULL DEFAULT 'C-00403',
      site_code      TEXT,
      dept_id        TEXT,
      description    TEXT NOT NULL,
      amount         REAL NOT NULL,
      work_date      TEXT,
      status         TEXT NOT NULL DEFAULT 'awaiting_po',
      po_number      TEXT,
      invoice_id     TEXT,
      service_center TEXT,
      notes          TEXT,
      cancel_reason  TEXT,
      created_by     TEXT,
      created_at     TEXT DEFAULT (datetime('now')),
      updated_by     TEXT,
      updated_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_accrual_status ON amazon_accruals(status);
    CREATE INDEX IF NOT EXISTS idx_accrual_site ON amazon_accruals(site_code);

    -- Resolved Amazon site per invoice WITH its provenance. site_code is empty
    -- when nothing authoritative said where the work happened; those rows are
    -- the review queue rather than a silent guess. See site-ledger.js.
    CREATE TABLE IF NOT EXISTS invoice_site_ledger (
      record_no   TEXT PRIMARY KEY,
      invoice_id  TEXT,
      site_code   TEXT,
      source      TEXT,
      confidence  TEXT,
      evidence    TEXT,
      candidates  TEXT,
      amount      REAL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sledger_site ON invoice_site_ledger(site_code);
    CREATE INDEX IF NOT EXISTS idx_sledger_source ON invoice_site_ledger(source);

    CREATE TABLE IF NOT EXISTS location_map (
      sage_recordno  INTEGER PRIMARY KEY,
      location_id    TEXT NOT NULL,
      location_name  TEXT NOT NULL,
      fetched_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS note_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      mentioned_email TEXT NOT NULL,
      seen INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (note_id) REFERENCES notes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_email ON note_mentions(mentioned_email);
    CREATE INDEX IF NOT EXISTS idx_mentions_note ON note_mentions(note_id);

    CREATE TABLE IF NOT EXISTS note_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(note_id, user_email, emoji),
      FOREIGN KEY (note_id) REFERENCES notes(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      po_number TEXT PRIMARY KEY,
      location_id TEXT,
      customer_id TEXT DEFAULT 'C-00403',
      ceiling_amount REAL,
      ceiling_email_amount REAL,
      ceiling_scrape_amount REAL,
      ceiling_source TEXT,
      discrepancy_flag INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      notes TEXT,
      updated_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS po_source_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT NOT NULL,
      source TEXT NOT NULL,
      file_ref TEXT,
      extracted_amount REAL,
      extracted_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_po_source_docs_po ON po_source_documents(po_number);

    CREATE TABLE IF NOT EXISTS po_document_intake (
      file_id TEXT PRIMARY KEY,
      folder TEXT,
      seen_at TEXT DEFAULT (datetime('now')),
      processed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS regions (
      region_code TEXT PRIMARY KEY,
      region_name TEXT NOT NULL,
      location_ids TEXT NOT NULL DEFAULT '[]',
      updated_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invoice_po_assignments (
      record_no TEXT PRIMARY KEY,
      invoice_id TEXT,
      original_po TEXT,
      assigned_po TEXT NOT NULL,
      note TEXT,
      assigned_by TEXT,
      assigned_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invoice_site_overrides (
      record_no TEXT PRIMARY KEY,
      invoice_id TEXT,
      site_code TEXT NOT NULL,
      set_by TEXT,
      set_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invoice_collector (
      record_no TEXT PRIMARY KEY,
      invoice_id TEXT,
      collector_email TEXT NOT NULL,
      assigned_by TEXT,
      assigned_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ops_health (
      check_key TEXT PRIMARY KEY,
      status TEXT NOT NULL,            -- ok | warn | fail
      detail TEXT,
      metric REAL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ops_alert_log (
      alert_key TEXT PRIMARY KEY,
      last_sent_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invoice_stop_service (
      record_no TEXT PRIMARY KEY,
      invoice_id TEXT,
      effective_date TEXT,
      note TEXT,
      issued_by TEXT,
      issued_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Collector + richer stop-service on customer_accounts (idempotent)
  try { db.exec("ALTER TABLE customer_accounts ADD COLUMN collector_email TEXT DEFAULT NULL"); } catch(e) {}
  try { db.exec("ALTER TABLE customer_accounts ADD COLUMN stop_service_effective_date TEXT DEFAULT NULL"); } catch(e) {}
  try { db.exec("ALTER TABLE customer_accounts ADD COLUMN stop_service_issued_by TEXT DEFAULT NULL"); } catch(e) {}
  try { db.exec("ALTER TABLE customer_accounts ADD COLUMN stop_service_at TEXT DEFAULT NULL"); } catch(e) {}

  // House accounts (2026-09-10, Edwin): customers collected centrally at the
  // office rather than by a service-centre collector — Amazon above all. An
  // aging-window rule swept 52 Amazon invoices ($906k) onto one collector
  // because nothing told the engine those are not hers to chase. The flag both
  // LABELS the customer everywhere and excludes it from every auto-assign rule;
  // assignment on a house account is deliberate and individual.
  try { db.exec("ALTER TABLE customer_accounts ADD COLUMN house_account INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE customer_accounts ADD COLUMN house_account_label TEXT DEFAULT NULL"); } catch(e) {}

  // Dunning hold is SEPARATE from house_account on purpose: being collected at
  // the office does not by itself mean a customer should never be chased by
  // email, and conflating the two would have silently changed behaviour for
  // accounts nobody asked about (Edwin 2026-09-10).
  try { db.exec("ALTER TABLE customer_accounts ADD COLUMN dunning_hold INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE customer_accounts ADD COLUMN dunning_hold_reason TEXT DEFAULT NULL"); } catch(e) {}

  // ─── Requested reports (2026-09-10, Edwin) ────────────────────────────────
  // An Omnia invoice PDF takes 17-26 seconds to fetch, so asking for a handful
  // of copies meant sitting on a spinner for minutes and being unable to do
  // anything else. Requests are queued here, a worker fills them, and the file
  // waits in the Reports section for collection.
  db.exec(`
    CREATE TABLE IF NOT EXISTS report_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      kind TEXT NOT NULL,                -- 'invoice-copies'
      label TEXT,                        -- what the user sees in the list
      params TEXT,                       -- JSON: the request, replayed by the worker
      status TEXT NOT NULL DEFAULT 'queued',   -- queued|running|done|failed|cancelled
      done_count INTEGER DEFAULT 0,
      total_count INTEGER DEFAULT 0,
      missing TEXT,                      -- JSON array of invoice ids with no PDF source
      filename TEXT,
      file_path TEXT,
      size_bytes INTEGER,
      content_type TEXT,
      error TEXT,
      downloaded_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT,
      expires_at TEXT
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_report_jobs_user ON report_jobs(user_email, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_report_jobs_status ON report_jobs(status, id)');

  // One user row per address, whatever the capitalisation. Created here so the
  // standby database gets it too; it fails harmlessly if duplicates still exist
  // (run _dupusers.js --apply to merge them first).
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_email_nocase ON user_roles(email COLLATE NOCASE)'); } catch (e) {}

  // ─── Site contacts (2026-09-10, Edwin) ────────────────────────────────────
  // Two different people, deliberately kept apart:
  //  - the AMAZON contact named on the site's POs (purchaser contact), who is
  //    the recipient of site correspondence;
  //  - the INTERNAL contact, who a rejection gets routed to so somebody here
  //    owns fixing it.
  // Learned values are overwritten by each newer PO; a pinned value never is.
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_contacts (
      site_code TEXT PRIMARY KEY,
      amazon_name TEXT,
      amazon_email TEXT,
      amazon_source TEXT,              -- 'po:2D-…' when learned, 'manual' when pinned
      amazon_pinned INTEGER DEFAULT 0,
      amazon_seen_at TEXT,             -- PO date the learned value came from
      internal_email TEXT,
      internal_pinned INTEGER DEFAULT 0,
      note TEXT,
      updated_by TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Per-PO contact, kept separately from the site roll-up: a site can have
  // several POs raised by different people, and a rejection belongs to ONE PO.
  db.exec(`
    CREATE TABLE IF NOT EXISTS po_contacts (
      po_number TEXT PRIMARY KEY,
      site_code TEXT,
      contact_name TEXT,
      contact_email TEXT,
      attn_name TEXT,
      revised_by_email TEXT,
      source TEXT,
      doc_date TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_po_contacts_site ON po_contacts(site_code)');

  // ─── Rejection register ───────────────────────────────────────────────────
  // Amazon rejections were only ever visible as a status on a feed row, so
  // nobody owned them and nothing recorded that they had been dealt with. Each
  // one is now a tracked item with a route and a resolution.
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_rejections (
      payee_id TEXT PRIMARY KEY,
      invoice_id TEXT,
      record_no TEXT,
      po_number TEXT,
      site_code TEXT,
      business_unit TEXT,
      amount REAL,
      status TEXT,
      reason TEXT,
      entry_date TEXT,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      routed_to TEXT,
      routed_at TEXT,
      notified INTEGER DEFAULT 0,
      acknowledged_by TEXT,
      acknowledged_at TEXT,
      resolved_at TEXT,
      resolution TEXT,
      superseded_by TEXT
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_rejections_open ON invoice_rejections(resolved_at, site_code)');
  // Read off the invoice's own Payee Central detail page — the Excel export
  // carries neither the reason nor the Amazon contact (2026-09-10).
  try { db.exec('ALTER TABLE invoice_rejections ADD COLUMN rejected_by TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE invoice_rejections ADD COLUMN amazon_contact TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE invoice_rejections ADD COLUMN description TEXT'); } catch (e) {}
  try { db.exec('ALTER TABLE invoice_rejections ADD COLUMN detail_at TEXT'); } catch (e) {}

  // Manual site assignment for POs whose documents/invoices don't reveal one
  try { db.exec("ALTER TABLE purchase_orders ADD COLUMN site_code TEXT DEFAULT NULL"); } catch(e) {}

  // Manual service-type override for POs the doc description can't classify
  // (e.g. a PO doc that's just an address) — wins over classifyService().
  try { db.exec("ALTER TABLE purchase_orders ADD COLUMN service_type TEXT DEFAULT NULL"); } catch(e) {}

  // Add mentions column if missing (idempotent)
  try { db.exec("ALTER TABLE notes ADD COLUMN mentions TEXT DEFAULT NULL"); } catch(e) { /* already exists */ }
  // Threaded replies (2026-08-12): a note may answer another note.
  try { db.exec("ALTER TABLE notes ADD COLUMN parent_id INTEGER DEFAULT NULL"); } catch(e) {}
  // Mentions-confirm workflow: seen is passive; confirmed is the explicit
  // "I've got this" acknowledgment visible to the author.
  try { db.exec("ALTER TABLE note_mentions ADD COLUMN confirmed_at TEXT DEFAULT NULL"); } catch(e) {}
  // Add photo column to user_roles if missing
  try { db.exec("ALTER TABLE user_roles ADD COLUMN photo_data_url TEXT DEFAULT NULL"); } catch(e) { /* already exists */ }
  // Add job_title column to user_roles if missing
  try { db.exec("ALTER TABLE user_roles ADD COLUMN job_title TEXT DEFAULT NULL"); } catch(e) { /* already exists */ }

  // Email notification prefs. The master switch (notify_master) is a fresh
  // column defaulting to 0, so every user — existing and new — starts opted
  // OUT; no email is sent until the user explicitly turns notifications on.
  // The per-event columns default ON so that once a user opts in they receive
  // all three unless they uncheck one. (notify_email is the retired v1 master.)
  try { db.exec("ALTER TABLE user_roles ADD COLUMN notify_email INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE user_roles ADD COLUMN notify_master INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE user_roles ADD COLUMN notify_mentions INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE user_roles ADD COLUMN notify_collector INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE user_roles ADD COLUMN notify_stop INTEGER DEFAULT 1"); } catch(e) {}
  // Add stated_amount to purchase_orders if missing — the PO's original value,
  // set once and preserved even when ceiling_amount is later revised
  try { db.exec("ALTER TABLE purchase_orders ADD COLUMN stated_amount REAL DEFAULT NULL"); } catch(e) { /* already exists */ }

  // Contact purpose (Edwin 2026-08-13): Sage-synced addresses are invoice-
  // DELIVERY (AP inboxes); collections contacts are captured separately.
  try {
    db.exec("ALTER TABLE customer_contacts ADD COLUMN contact_type TEXT DEFAULT 'billing'");
    // one-time: existing manual rows were added by humans doing collections
    db.exec("UPDATE customer_contacts SET contact_type='collections' WHERE source='manual'");
  } catch(e) {}

  // Per-user granular permission overrides: JSON {grant:[caps], revoke:[caps]}
  try { db.exec("ALTER TABLE user_roles ADD COLUMN permissions TEXT DEFAULT NULL"); } catch(e) {}
  // Phone for the comms signature renderer (pulled from Graph /me at login)
  try { db.exec("ALTER TABLE user_roles ADD COLUMN phone TEXT DEFAULT NULL"); } catch(e) {}
  // Customer-reply notifications default ON — a customer reply is the one
  // notification a collector must not miss (unlike the opt-out internal prefs).
  try { db.exec("ALTER TABLE user_roles ADD COLUMN notify_replies INTEGER DEFAULT 1"); } catch(e) {}

  initCommsSchema();
  seedDefaultRegions();
}

// ─── Communications platform schema ─────────────────────────────────────────
// Customer-facing email: contacts, conversations, messages, templates, dunning.
// Design notes (2026-08-11 plan):
//  - messages/conversations are NEW tables; notes stays internal-only.
//  - One conversation row = one email thread, owned by a customer; invoices
//    are tagged per message via message_invoices.
//  - messages stores the SEND-TIME SNAPSHOT (resolved body, recipients,
//    signature, template version). Old messages are never re-rendered.
//  - All emails stored lowercase (graph.normEmail).
function initCommsSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      name TEXT, email TEXT, phone TEXT, title TEXT,
      source TEXT DEFAULT 'manual',        -- 'manual' | 'intacct'
      is_active INTEGER DEFAULT 1,
      is_primary INTEGER DEFAULT 0,
      consent_email INTEGER DEFAULT 1,     -- may be emailed at all
      dunning_enabled INTEGER DEFAULT 0,   -- human-approved for automated dunning
      notes TEXT,
      created_by TEXT, updated_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(customer_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_cc_customer ON customer_contacts(customer_id);
    CREATE INDEX IF NOT EXISTS idx_cc_email ON customer_contacts(email);

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT,                    -- NULL only while status='triage'
      contact_id INTEGER,
      subject TEXT,
      subject_token TEXT UNIQUE,           -- signed opaque reply token
      graph_conversation_id TEXT,
      mailbox TEXT,
      status TEXT DEFAULT 'open',          -- open|waiting|due|completed|archived|triage
      assigned_email TEXT,
      last_message_at TEXT, last_direction TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conv_customer ON conversations(customer_id);
    CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status);
    CREATE INDEX IF NOT EXISTS idx_conv_graph ON conversations(graph_conversation_id);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      direction TEXT NOT NULL,             -- 'out' | 'in'
      actor_type TEXT NOT NULL,            -- 'human' | 'automation' | 'external' | 'mailbox_user'
      actor_email TEXT,                    -- real internal user (impersonation-proof) or 'dunning-engine'
      corresponding_email TEXT,            -- signature identity; attribution only, NEVER routing
      from_email TEXT NOT NULL,
      to_emails TEXT NOT NULL,             -- JSON array snapshot
      cc_emails TEXT,                      -- JSON array snapshot
      subject TEXT,
      body_text TEXT, body_html TEXT,      -- resolved snapshot as sent/received
      template_id INTEGER, template_version INTEGER,
      token_values TEXT,                   -- JSON snapshot of substituted tokens
      signature_snapshot TEXT,
      graph_message_id TEXT,
      internet_message_id TEXT,            -- RFC Message-ID
      in_reply_to TEXT, references_hdr TEXT,
      graph_conversation_id TEXT,
      sent_at TEXT, received_at TEXT,
      status TEXT DEFAULT 'sent',          -- queued|sent|failed|received
      error TEXT,
      has_attachments INTEGER DEFAULT 0,
      attachments_json TEXT,               -- [{name,size,contentType,graphAttachmentId}]
      dunning_action_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_msg_imid ON messages(internet_message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_graphid
      ON messages(graph_message_id) WHERE graph_message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS message_invoices (
      message_id INTEGER NOT NULL,
      record_no TEXT NOT NULL,
      PRIMARY KEY (message_id, record_no)
    );
    CREATE INDEX IF NOT EXISTS idx_mi_record ON message_invoices(record_no);

    CREATE TABLE IF NOT EXISTS comm_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      name TEXT,
      kind TEXT DEFAULT 'external',        -- external | internal
      active INTEGER DEFAULT 1,
      current_version INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS comm_template_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      tokens_used TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(template_id, version)
    );

    CREATE TABLE IF NOT EXISTS comm_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dunning_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 0,
      sequence INTEGER NOT NULL,
      trigger_days_past_due INTEGER NOT NULL,
      repeat_every_days INTEGER,           -- NULL = one-shot step
      template_key TEXT NOT NULL,
      billing_stream TEXT DEFAULT 'all',   -- 'sage' (ECI-) | 'omnia' (AST/ASTM/S-) | 'all'
      min_invoice_balance REAL DEFAULT 0,
      exclude_customers TEXT,              -- JSON; engine ALSO hard-excludes Amazon
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dunning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,                  -- 'preview' | 'live'
      triggered_by TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      status TEXT DEFAULT 'running',
      stats_json TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS dunning_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      rule_id INTEGER NOT NULL,
      customer_id TEXT NOT NULL,
      record_nos TEXT NOT NULL,            -- JSON: invoices in this digest
      status TEXT DEFAULT 'preview',       -- preview|approved|sent|skipped|failed
      skip_reason TEXT,                    -- amazon|stop_service|open_ptp|no_contact|recent_send|idempotent
      message_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_da_run ON dunning_actions(run_id);

    CREATE TABLE IF NOT EXISTS dunning_sent (
      idem_key TEXT PRIMARY KEY,           -- record_no:rule_id or record_no:rule_id:cycle_no
      record_no TEXT NOT NULL,
      rule_id INTEGER NOT NULL,
      message_id INTEGER,
      sent_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ds_record ON dunning_sent(record_no);
  `);

  // Scheduled statement delivery (2026-08-12, Edwin): per-customer opt-in.
  db.exec(`
    CREATE TABLE IF NOT EXISTS statement_schedules (
      customer_id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      day_of_month INTEGER DEFAULT 1,    -- sends on/after this day (1-28)
      contact_ids TEXT,                  -- JSON array; NULL = primary contact
      min_balance REAL DEFAULT 0.01,     -- skip when total due is below this
      last_sent_period TEXT,             -- 'YYYY-MM' idempotency per month
      created_by TEXT, updated_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // InterNex (Velocity) transmit log + last-number high-water in comm_state
  db.exec(`
    CREATE TABLE IF NOT EXISTS velocity_transmits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_no TEXT NOT NULL,
      invoice_id TEXT NOT NULL,
      line TEXT DEFAULT 'LOC1',
      batch TEXT,
      result TEXT,
      transmitted_by TEXT,
      transmitted_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vt_record ON velocity_transmits(record_no);
  `);

  // Collection-status workflow (2026-08-12, emulating the reconciliation
  // platform's vocabulary): assigned collector sets it, AR staff can update.
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_collection_status (
      record_no TEXT PRIMARY KEY,
      invoice_id TEXT,
      status TEXT NOT NULL,
      note TEXT,
      set_by TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customer_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      size INTEGER,
      content_type TEXT,
      uploaded_by TEXT,
      uploaded_at TEXT DEFAULT (datetime('now')),
      deleted INTEGER DEFAULT 0
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ca_att_cust ON customer_attachments(customer_id)');

  // Velocity confirmation: transmits count toward the high-water mark only
  // once the invoice appears in the scraped feed (accepted on the portal).
  try { db.exec("ALTER TABLE velocity_transmits ADD COLUMN confirmed_at TEXT DEFAULT NULL"); } catch (e) {}

  // Collector auto-assignment rules (2026-08-13): location + aging → collector
  db.exec(`
    CREATE TABLE IF NOT EXISTS assignment_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 1,
      location_id TEXT,                 -- NULL = any location
      min_days_past_due INTEGER DEFAULT 0,
      max_days_past_due INTEGER,        -- NULL = no upper bound
      collector_email TEXT NOT NULL,
      created_by TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Per-rule customer TARGETING (2026-08-12, Edwin): JSON array of customer
  // ids. Combined with target_mode: 'all' (ignore list), 'only' (rule applies
  // ONLY to listed customers), 'except' (applies to everyone BUT the listed).
  // exclude_customers is retired in favor of mode 'except' but kept readable.
  try { db.exec("ALTER TABLE dunning_rules ADD COLUMN target_mode TEXT DEFAULT 'all'"); } catch (e) {}
  try { db.exec("ALTER TABLE dunning_rules ADD COLUMN target_customers TEXT DEFAULT NULL"); } catch (e) {}
}

// Pre-populate the existing hardcoded region definitions on first run so
// nothing changes visually until someone actually edits them.
function seedDefaultRegions() {
  const existing = db.prepare('SELECT COUNT(*) as c FROM regions').get();
  if (existing.c > 0) return;
  const defaults = [
    { code: 'I95',  name: 'I-95 Corridor', locs: ['L-ECF-BLT', 'L-ECF-TRN', 'L-ECF-HCT', 'L-ECF-SRN'] },
    { code: 'SE',   name: 'Southeast',     locs: ['L-ECF-BRW', 'L-ECF-WPB'] },
    { code: 'MW',   name: 'Midwest',       locs: ['L-ECF-CIN', 'L-ECF-SCSC'] },
    { code: 'MA',   name: 'Mid-Atlantic',  locs: ['L-ECF-ALN', 'L-ECF-HBG'] },
    { code: 'CORP', name: 'Corporate',     locs: ['L-ECF-FCR', 'E-ECF'] },
  ];
  const stmt = db.prepare('INSERT INTO regions (region_code, region_name, location_ids) VALUES (?,?,?)');
  for (const r of defaults) stmt.run(r.code, r.name, JSON.stringify(r.locs));
}

// ─── User Roles ────────────────────────────────────────────────────────────

// Email addresses are case-insensitive; SQLite's TEXT comparison is not. A
// case-sensitive lookup here is what let one person become two accounts: the
// seeded row was "justin.gamez@", Microsoft signed them in as "Justin.Gamez@",
// this found nothing, and provisionNewUser inserted a second row as a viewer
// (Edwin spotted the duplicate in the org chart, 2026-09-10).
function getUserRole(email) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM user_roles WHERE email = ? COLLATE NOCASE');
  return stmt.get(email) || null;
}

function upsertUserRole(email, name, role, locationFilter, customerFilter) {
  const db = getDb();
  const existing = getUserRole(email);
  if (existing) {
    db.prepare(`
      UPDATE user_roles SET name=?, role=?, location_filter=?, customer_filter=?, updated_at=datetime('now')
      WHERE email=? COLLATE NOCASE
    `).run(name, role, locationFilter, customerFilter, email);
  } else {
    db.prepare(`
      INSERT INTO user_roles (email, name, role, location_filter, customer_filter)
      VALUES (?, ?, ?, ?, ?)
    `).run(email, name, role, locationFilter, customerFilter);
  }
  return getUserRole(email);
}

function provisionNewUser(email, name) {
  const db = getDb();
  // Someone seeded ahead of their first sign-in already HAS a row, possibly
  // under a different capitalisation. Never create a second one — and never
  // reset the role they were given to 'viewer'.
  const existing = getUserRole(email);
  if (existing) {
    if (!existing.name && name) {
      db.prepare('UPDATE user_roles SET name=? WHERE email=? COLLATE NOCASE').run(name, email);
    }
    return getUserRole(email);
  }
  // Edwin always gets admin
  const role = (email.toLowerCase() === 'edwin.torres@eastcoastfacilities.com') ? 'admin' : 'viewer';
  db.prepare(`
    INSERT OR IGNORE INTO user_roles (email, name, role)
    VALUES (?, ?, ?)
  `).run(email, name, role);
  console.log(`[auth] Auto-provisioned ${email} as ${role}`);
  return getUserRole(email);
}

function listUsers() {
  const db = getDb();
  return db.prepare('SELECT * FROM user_roles ORDER BY created_at DESC').all();
}

// notify_email in the returned object is the effective master switch, sourced
// from notify_master (defaults 0 = opted out until the user turns it on).
function getNotifyPrefs(email) {
  const u = getUserRole(email);
  return {
    notify_email:     u ? (u.notify_master == null ? 0 : u.notify_master) : 0,
    notify_mentions:  u ? (u.notify_mentions == null ? 1 : u.notify_mentions) : 1,
    notify_collector: u ? (u.notify_collector == null ? 1 : u.notify_collector) : 1,
    notify_stop:      u ? (u.notify_stop == null ? 1 : u.notify_stop) : 1,
    // Customer-reply notifications sit OUTSIDE the master opt-out: a reply on
    // an assigned thread is operational work, not an FYI. Only its own toggle
    // silences it.
    notify_replies:   u ? (u.notify_replies == null ? 1 : u.notify_replies) : 1,
  };
}

function updateNotifyPrefs(email, prefs) {
  const db = getDb();
  const cur = getNotifyPrefs(email);
  const next = {
    notify_email:     prefs.notify_email     !== undefined ? (prefs.notify_email ? 1 : 0)     : cur.notify_email,
    notify_mentions:  prefs.notify_mentions  !== undefined ? (prefs.notify_mentions ? 1 : 0)  : cur.notify_mentions,
    notify_collector: prefs.notify_collector !== undefined ? (prefs.notify_collector ? 1 : 0) : cur.notify_collector,
    notify_stop:      prefs.notify_stop      !== undefined ? (prefs.notify_stop ? 1 : 0)      : cur.notify_stop,
    notify_replies:   prefs.notify_replies   !== undefined ? (prefs.notify_replies ? 1 : 0)   : cur.notify_replies,
  };
  db.prepare(`UPDATE user_roles SET notify_master=?, notify_mentions=?, notify_collector=?, notify_stop=?, notify_replies=?, updated_at=datetime('now') WHERE email=?`)
    .run(next.notify_email, next.notify_mentions, next.notify_collector, next.notify_stop, next.notify_replies, email);
  return next;
}

function updateUserRole(email, updates) {
  const db = getDb();
  const fields = [];
  const vals = [];
  if (updates.role !== undefined) { fields.push('role=?'); vals.push(updates.role); }
  if (updates.name !== undefined) { fields.push('name=?'); vals.push(updates.name); }
  if (updates.location_filter !== undefined) { fields.push('location_filter=?'); vals.push(updates.location_filter); }
  if (updates.customer_filter !== undefined) { fields.push('customer_filter=?'); vals.push(updates.customer_filter); }
  if (fields.length === 0) return;
  fields.push("updated_at=datetime('now')");
  vals.push(email);
  db.prepare(`UPDATE user_roles SET ${fields.join(', ')} WHERE email=?`).run(...vals);
}

// ─── Notes ─────────────────────────────────────────────────────────────────

function getNotes(recordNo) {
  const db = getDb();
  return db.prepare('SELECT * FROM notes WHERE record_no=? ORDER BY created_at ASC').all(recordNo);
}

function addNote(recordNo, userEmail, userName, body, type = 'note', mentions, parentId) {
  if (mentions && Array.isArray(mentions) && mentions.length > 0) {
    return addNoteWithMentions(recordNo, userEmail, userName, body, type, mentions, parentId);
  }
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO notes (record_no, user_email, user_name, type, body, parent_id) VALUES (?,?,?,?,?,?)
  `).run(recordNo, userEmail, userName, type, body, parentId || null);
  return db.prepare('SELECT * FROM notes WHERE id=?').get(result.lastInsertRowid);
}

// ─── Promises to Pay ───────────────────────────────────────────────────────

function getPtpForRecord(recordNo) {
  const db = getDb();
  return db.prepare('SELECT * FROM promises_to_pay WHERE record_no=? ORDER BY created_at DESC').all(recordNo);
}

function getAllOpenPtp() {
  const db = getDb();
  return db.prepare("SELECT * FROM promises_to_pay WHERE status='open' ORDER BY promise_date ASC").all();
}

function addPtp(recordNo, userEmail, userName, amount, promiseDate, note) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO promises_to_pay (record_no, user_email, user_name, amount, promise_date, note)
    VALUES (?,?,?,?,?,?)
  `).run(recordNo, userEmail, userName, amount, promiseDate, note || null);
  return db.prepare('SELECT * FROM promises_to_pay WHERE id=?').get(result.lastInsertRowid);
}

function updatePtpStatus(id, status) {
  const db = getDb();
  db.prepare("UPDATE promises_to_pay SET status=?, updated_at=datetime('now') WHERE id=?").run(status, id);
}

// ─── Audit Log ─────────────────────────────────────────────────────────────

function auditLog(userEmail, action, recordNo, detail) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (user_email, action, record_no, detail) VALUES (?,?,?,?)
  `).run(userEmail, action, recordNo || null, detail || null);
}

function getAuditLog(recordNo) {
  const db = getDb();
  return db.prepare('SELECT * FROM audit_log WHERE record_no=? ORDER BY created_at DESC').all(recordNo);
}

// ─── Location Map (Sage LOCATION objects → ID/name) ───────────────────────

function getLocationMap() {
  const d = getDb();
  const rows = d.prepare('SELECT sage_recordno, location_id, location_name FROM location_map').all();
  const map = {};
  rows.forEach(r => { map[r.sage_recordno] = { locationId: r.location_id, locationName: r.location_name }; });
  return map;
}

function setLocationMapEntries(entries) {
  const d = getDb();
  const stmt = d.prepare('INSERT OR REPLACE INTO location_map (sage_recordno, location_id, location_name) VALUES (?, ?, ?)');
  for (const e of entries) {
    stmt.run(e.recordNo, e.locationId, e.locationName);
  }
}

function locationMapSize() {
  const d = getDb();
  return d.prepare('SELECT COUNT(*) as c FROM location_map').get().c;
}

// ─── Invoice Location Cache ────────────────────────────────────────────────

function getLocation(recordNo) {
  const d = getDb();
  return d.prepare('SELECT location_id, location_name FROM invoice_location WHERE record_no=?').get(recordNo) || null;
}

function setLocation(recordNo, locationId, locationName) {
  const d = getDb();
  d.prepare(`
    INSERT OR REPLACE INTO invoice_location (record_no, location_id, location_name, fetched_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(recordNo, locationId || '', locationName || '');
}

// ─── Ship-to exemptions (separate business processes) ───────────────────────
function setShipToExemption(pattern, label, reason, setBy) {
  const p = String(pattern || '').trim().toUpperCase();
  if (!p) return false;
  getDb().prepare(`
    INSERT INTO shipto_exemptions (pattern, label, reason, set_by, set_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(pattern) DO UPDATE SET label=excluded.label, reason=excluded.reason,
      set_by=excluded.set_by, set_at=datetime('now')
  `).run(p, label || p, reason || null, setBy || null);
  return true;
}

function deleteShipToExemption(pattern) {
  getDb().prepare('DELETE FROM shipto_exemptions WHERE pattern=?').run(String(pattern || '').trim().toUpperCase());
}

function getShipToExemptions() {
  try {
    return getDb().prepare('SELECT pattern, label, reason FROM shipto_exemptions').all();
  } catch (e) { return []; }
}

// ─── Non-site codes (corporate HQ / PO header addresses) ────────────────────
function setBlockedSiteCode(code, reason, setBy) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return false;
  getDb().prepare(`
    INSERT INTO site_code_blocklist (code, reason, set_by, set_at)
    VALUES (?,?,?,datetime('now'))
    ON CONFLICT(code) DO UPDATE SET reason=excluded.reason, set_by=excluded.set_by, set_at=datetime('now')
  `).run(c, reason || null, setBy || null);
  return true;
}

function deleteBlockedSiteCode(code) {
  getDb().prepare('DELETE FROM site_code_blocklist WHERE code=?').run(String(code || '').trim().toUpperCase());
}

function getBlockedSiteCodes() {
  const out = {};
  try {
    for (const r of getDb().prepare('SELECT code, reason FROM site_code_blocklist').all()) out[r.code] = r.reason || '';
  } catch (e) { /* table missing on an old database */ }
  return out;
}

// ─── Retired site codes ─────────────────────────────────────────────────────
function setSiteAlias(alias, canonicalCode, note, setBy) {
  const d = getDb();
  const a = String(alias || '').trim().toUpperCase();
  const c = String(canonicalCode || '').trim().toUpperCase();
  if (!a || !c) return false;
  if (a === c) return false;               // an alias to itself would loop
  d.prepare(`
    INSERT INTO site_aliases (alias, canonical_code, note, set_by, set_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(alias) DO UPDATE SET
      canonical_code=excluded.canonical_code, note=excluded.note,
      set_by=excluded.set_by, set_at=datetime('now')
  `).run(a, c, note || null, setBy || null);
  return true;
}

function deleteSiteAlias(alias) {
  getDb().prepare('DELETE FROM site_aliases WHERE alias=?').run(String(alias || '').trim().toUpperCase());
}

function getSiteAliasMap() {
  const d = getDb();
  const out = {};
  try {
    for (const r of d.prepare('SELECT alias, canonical_code, note FROM site_aliases').all()) {
      out[r.alias] = { canonical: r.canonical_code, note: r.note || '' };
    }
  } catch (e) { /* table missing on an old database */ }
  return out;
}

// ─── Chain of command ───────────────────────────────────────────────────────
// Edwin 2026-09-09: a VPO manages his DOOs; a DOO manages AEs, BAs, OPMs and
// PMs. People are assigned work at three levels — an invoice, a site code, or a
// whole customer — and **visibility rolls UP**: everyone sees their own book,
// and a manager sees the union of everything beneath them.
//
// Stored as two columns on user_roles rather than a separate org table: the
// hierarchy IS a property of the user, and a join table would let a user exist
// in the org chart without existing as a user, which is the classic way these
// structures drift out of sync.
// Seeded once, then owned by the table. Kept here only as the starting shape.
const ORG_ROLE_SEED = [
  { code: 'VPO', label: 'VP of Operations',       rank: 1, manages: ['DOO'], sort_order: 10 },
  { code: 'DOO', label: 'Director of Operations', rank: 2, manages: ['AE', 'BA', 'OPM', 'PM'], sort_order: 20 },
  { code: 'AE',  label: 'Account Executive',      rank: 3, manages: [], sort_order: 30 },
  { code: 'BA',  label: 'Branch Administrator',   rank: 3, manages: [], sort_order: 40 },
  { code: 'OPM', label: 'Operations Manager',     rank: 3, manages: [], sort_order: 50 },
  { code: 'PM',  label: 'Production Manager',     rank: 3, manages: [], sort_order: 60 },
];

function seedOrgRoles() {
  const d = getDb();
  const n = d.prepare('SELECT COUNT(*) c FROM org_role_defs').get().c;
  if (n) return;
  const ins = d.prepare('INSERT INTO org_role_defs (code, label, rank, manages, sort_order) VALUES (?,?,?,?,?)');
  for (const r of ORG_ROLE_SEED) ins.run(r.code, r.label, r.rank, JSON.stringify(r.manages), r.sort_order);
}

/** The live role list, shaped like the old constant so callers are unchanged. */
function getOrgRoles() {
  const d = getDb();
  try { seedOrgRoles(); } catch (e) { /* table not ready */ }
  const out = {};
  try {
    for (const r of d.prepare('SELECT * FROM org_role_defs WHERE active=1 ORDER BY sort_order, code').all()) {
      let manages = [];
      try { manages = JSON.parse(r.manages || '[]'); } catch (e) {}
      out[r.code] = { label: r.label, rank: r.rank, manages, sortOrder: r.sort_order };
    }
  } catch (e) { /* fall back below */ }
  if (!Object.keys(out).length) {
    for (const r of ORG_ROLE_SEED) out[r.code] = { label: r.label, rank: r.rank, manages: r.manages, sortOrder: r.sort_order };
  }
  return out;
}

function upsertOrgRole(def, byEmail) {
  const d = getDb();
  const code = String(def.code || '').trim().toUpperCase();
  if (!code || !/^[A-Z0-9]{1,8}$/.test(code)) throw new Error('Role code must be 1-8 letters or digits');
  if (!def.label || !String(def.label).trim()) throw new Error('Role label is required');
  const manages = Array.isArray(def.manages) ? def.manages.map(m => String(m).toUpperCase()) : [];
  if (manages.includes(code)) throw new Error('A role cannot manage itself');
  d.prepare(`
    INSERT INTO org_role_defs (code, label, rank, manages, sort_order, active, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(code) DO UPDATE SET label=excluded.label, rank=excluded.rank, manages=excluded.manages,
      sort_order=excluded.sort_order, active=excluded.active, updated_by=excluded.updated_by, updated_at=datetime('now')
  `).run(code, String(def.label).trim(), parseInt(def.rank, 10) || 5, JSON.stringify(manages),
    parseInt(def.sortOrder, 10) || 100, def.active === false ? 0 : 1, byEmail || null);
  return getOrgRoles()[code] || null;
}

function ensureOrgColumns() {
  const d = getDb();
  for (const col of ['org_role TEXT', 'reports_to TEXT']) {
    try { d.exec(`ALTER TABLE user_roles ADD COLUMN ${col}`); } catch (e) { /* already present */ }
  }
}

function setOrgAssignment(email, orgRole, reportsTo, byEmail, allowException) {
  ensureOrgColumns();
  const d = getDb();
  const e = String(email || '').toLowerCase().trim();
  if (!e) throw new Error('User email is required');
  const role = orgRole ? String(orgRole).toUpperCase() : null;
  if (role && !getOrgRoles()[role]) throw new Error(`Unknown org role: ${orgRole}`);
  const mgr = reportsTo ? String(reportsTo).toLowerCase().trim() : null;

  if (mgr) {
    if (mgr === e) throw new Error('A user cannot report to themselves');
    const m = d.prepare('SELECT org_role FROM user_roles WHERE lower(email)=?').get(mgr);
    if (!m) throw new Error('Manager is not a portal user');
    if (!m.org_role) throw new Error('Manager has no org role yet — set theirs first');
    const roles = getOrgRoles();
    const mgrDef = roles[m.org_role] || { manages: [] };
    // One-off adjustments are legitimate — a PM reporting straight to a VPO
    // during a vacancy, say — but they must be DELIBERATE, so the caller has to
    // ask for the exception rather than the rule quietly not applying.
    if (role && !(mgrDef.manages || []).includes(role) && !allowException) {
      throw new Error(`A ${m.org_role} does not normally manage a ${role}. Tick "one-off exception" to allow it.`);
    }
    // A cycle would make the rollup recurse forever and, worse, silently grant
    // everyone everything. Walk up from the proposed manager before accepting.
    let cur = mgr, hops = 0;
    while (cur && hops++ < 50) {
      if (cur === e) throw new Error('That would create a reporting loop');
      const row = d.prepare('SELECT reports_to FROM user_roles WHERE lower(email)=?').get(cur);
      cur = row && row.reports_to ? String(row.reports_to).toLowerCase() : null;
    }
  }
  d.prepare('UPDATE user_roles SET org_role=?, reports_to=?, updated_at=datetime(\'now\') WHERE lower(email)=?')
    .run(role, mgr, e);
  return getOrgUser(e);
}

function getOrgUser(email) {
  ensureOrgColumns();
  return getDb().prepare('SELECT email, name, role, org_role, reports_to, job_title FROM user_roles WHERE lower(email)=?')
    .get(String(email || '').toLowerCase()) || null;
}

function getOrgUsers() {
  ensureOrgColumns();
  return getDb().prepare('SELECT email, name, role, org_role, reports_to, job_title FROM user_roles ORDER BY org_role, name').all();
}

/** Every email beneath this one, transitively. Cycle-guarded. */
function getSubordinates(email) {
  ensureOrgColumns();
  const d = getDb();
  const start = String(email || '').toLowerCase();
  const out = new Set();
  let frontier = [start];
  let hops = 0;
  while (frontier.length && hops++ < 50) {
    const next = [];
    for (const mgr of frontier) {
      for (const r of d.prepare('SELECT email FROM user_roles WHERE lower(reports_to)=?').all(mgr)) {
        const e = String(r.email).toLowerCase();
        if (out.has(e) || e === start) continue;
        out.add(e); next.push(e);
      }
    }
    frontier = next;
  }
  return [...out];
}

/** Self plus everyone beneath — the set whose work this user may see. */
function getVisibleEmails(email) {
  const e = String(email || '').toLowerCase();
  return [e, ...getSubordinates(e)];
}

// ─── Site collectors (Amazon) ───────────────────────────────────────────────
function setSiteCollector(siteCode, collectorEmail, byEmail) {
  const d = getDb();
  const code = String(siteCode || '').trim().toUpperCase();
  if (!code) throw new Error('Site code is required');
  if (!collectorEmail) {
    d.prepare('DELETE FROM site_collectors WHERE site_code=?').run(code);
    return null;
  }
  d.prepare(`
    INSERT INTO site_collectors (site_code, collector_email, assigned_by, assigned_at)
    VALUES (?,?,?,datetime('now'))
    ON CONFLICT(site_code) DO UPDATE SET
      collector_email=excluded.collector_email, assigned_by=excluded.assigned_by, assigned_at=datetime('now')
  `).run(code, String(collectorEmail).toLowerCase(), byEmail || null);
  return getSiteCollector(code);
}

function getSiteCollector(siteCode) {
  return getDb().prepare('SELECT * FROM site_collectors WHERE site_code=?')
    .get(String(siteCode || '').trim().toUpperCase()) || null;
}

// One call for the whole grid — the drill-down renders hundreds of sites.
function getAllSiteCollectors() {
  const out = {};
  try {
    for (const r of getDb().prepare('SELECT * FROM site_collectors').all()) {
      out[r.site_code] = { email: r.collector_email, assignedBy: r.assigned_by, assignedAt: r.assigned_at };
    }
  } catch (e) { /* table missing on an old database */ }
  return out;
}

// ─── Departments allowed per service center ─────────────────────────────────
function setScDepartments(serviceCenter, deptIds, byEmail) {
  const d = getDb();
  const sc = String(serviceCenter || '').trim();
  if (!sc) throw new Error('Service center is required');
  const list = Array.isArray(deptIds) ? [...new Set(deptIds.map(x => String(x).trim().toUpperCase()).filter(Boolean))] : [];
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM sc_departments WHERE service_center=?').run(sc);
    const ins = d.prepare('INSERT INTO sc_departments (service_center, dept_id, updated_by) VALUES (?,?,?)');
    for (const id of list) ins.run(sc, id, byEmail || null);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return list;
}

/** { serviceCenter -> [deptId] }. A branch with no row is unrestricted. */
function getScDepartments() {
  const out = {};
  try {
    for (const r of getDb().prepare('SELECT service_center, dept_id FROM sc_departments ORDER BY service_center, dept_id').all()) {
      (out[r.service_center] = out[r.service_center] || []).push(r.dept_id);
    }
  } catch (e) { /* table missing on an old database */ }
  return out;
}

// ─── Amazon accruals (work done, no PO yet) ─────────────────────────────────
const ACCRUAL_STATUSES = ['awaiting_po', 'po_received', 'invoiced', 'cancelled'];

function assertDeptAllowed(serviceCenter, deptId) {
  if (!serviceCenter || !deptId) return;
  const allowed = getScDepartments()[serviceCenter];
  if (!allowed || !allowed.length) return;              // unconfigured = unrestricted
  if (!allowed.includes(String(deptId).toUpperCase())) {
    throw new Error(`${serviceCenter} is not set up to accrue against ${deptId}`);
  }
}

function createAccrual(a, byEmail) {
  const d = getDb();
  const amount = parseFloat(a.amount);
  if (!a.description || !String(a.description).trim()) throw new Error('Description is required');
  if (!isFinite(amount) || amount <= 0) throw new Error('Amount must be a positive number');
  assertDeptAllowed(a.serviceCenter, a.deptId);
  const info = d.prepare(`
    INSERT INTO amazon_accruals (customer_id, site_code, dept_id, description, amount, work_date,
      status, po_number, service_center, notes, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(a.customerId || 'C-00403', (a.siteCode || '').toUpperCase() || null, a.deptId || null,
    String(a.description).trim(), amount, a.workDate || null,
    ACCRUAL_STATUSES.includes(a.status) ? a.status : 'awaiting_po',
    a.poNumber || null, a.serviceCenter || null, a.notes || null, byEmail || null, byEmail || null);
  return getAccrual(info.lastInsertRowid);
}

function getAccrual(id) {
  return getDb().prepare('SELECT * FROM amazon_accruals WHERE id=?').get(id) || null;
}

// Status transitions carry their own evidence: receiving a PO means recording
// which PO, and invoicing means recording which invoice. Enforced here so a
// row can never claim to be invoiced with nothing to point at.
function updateAccrual(id, patch, byEmail) {
  const d = getDb();
  const cur = getAccrual(id);
  if (!cur) throw new Error('Accrual not found');
  const next = { ...cur, ...patch };
  if (patch.status && !ACCRUAL_STATUSES.includes(patch.status)) throw new Error('Invalid status');
  // Checked against the values the row will END UP with, so changing either the
  // branch or the department alone still has to leave a legal pairing.
  assertDeptAllowed(
    patch.serviceCenter !== undefined ? patch.serviceCenter : cur.service_center,
    patch.deptId !== undefined ? patch.deptId : cur.dept_id);
  if (next.status === 'po_received' && !String(next.po_number || patch.poNumber || '').trim()) {
    throw new Error('A PO number is required to mark an accrual as PO received');
  }
  if (next.status === 'invoiced' && !String(next.invoice_id || patch.invoiceId || '').trim()) {
    throw new Error('An invoice number is required to mark an accrual as invoiced');
  }
  if (next.status === 'cancelled' && !String(next.cancel_reason || patch.cancelReason || '').trim()) {
    throw new Error('A reason is required to cancel an accrual');
  }
  const fields = [], vals = [];
  const set = (col, v) => { if (v !== undefined) { fields.push(col + '=?'); vals.push(v); } };
  set('site_code', patch.siteCode !== undefined ? (patch.siteCode || '').toUpperCase() || null : undefined);
  set('dept_id', patch.deptId);
  set('description', patch.description);
  set('amount', patch.amount !== undefined ? parseFloat(patch.amount) : undefined);
  set('work_date', patch.workDate);
  set('status', patch.status);
  set('po_number', patch.poNumber);
  set('invoice_id', patch.invoiceId);
  set('service_center', patch.serviceCenter);
  set('notes', patch.notes);
  set('cancel_reason', patch.cancelReason);
  if (!fields.length) return cur;
  fields.push('updated_by=?'); vals.push(byEmail || null);
  fields.push("updated_at=datetime('now')");
  vals.push(id);
  d.prepare(`UPDATE amazon_accruals SET ${fields.join(', ')} WHERE id=?`).run(...vals);
  return getAccrual(id);
}

function getAccruals(opts = {}) {
  const d = getDb();
  const where = [], vals = [];
  if (opts.status) { where.push('status=?'); vals.push(opts.status); }
  if (opts.siteCodes && opts.siteCodes.length) {
    where.push(`site_code IN (${opts.siteCodes.map(() => '?').join(',')})`);
    vals.push(...opts.siteCodes);
  }
  if (!opts.includeCancelled && !opts.status) where.push("status != 'cancelled'");
  const sql = 'SELECT * FROM amazon_accruals' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY amount DESC';
  return d.prepare(sql).all(...vals);
}

// ─── Amazon location master ─────────────────────────────────────────────────
function replaceAmazonLocations(rows) {
  const d = getDb();
  const ins = d.prepare(`
    INSERT INTO amazon_locations (site_code, business_unit, region, zone, city, state, country, serviced, omnia_loc_id, address, ops_parent, loaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(site_code) DO UPDATE SET
      business_unit=excluded.business_unit, region=excluded.region, zone=excluded.zone,
      city=excluded.city, state=excluded.state, country=excluded.country,
      serviced=excluded.serviced, omnia_loc_id=excluded.omnia_loc_id,
      address=excluded.address, ops_parent=excluded.ops_parent, loaded_at=datetime('now')
  `);
  d.exec('BEGIN');
  try {
    for (const r of rows) {
      const code = String(r.siteCode || '').trim().toUpperCase();
      if (!code) continue;
      ins.run(code, r.businessUnit || '', r.region || '', r.zone || '', r.city || '',
              r.state || '', r.country || '', r.serviced || '', r.omniaLocId || '',
              r.address || '', r.opsParent || '');
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return d.prepare('SELECT COUNT(*) n FROM amazon_locations').get().n;
}

// The network master and the landscape RFP list are two real sources that
// overlap on 459 codes and each carry codes the other lacks. Provenance is kept
// per row so a later disagreement is answerable rather than a mystery, and the
// master wins on business unit because it is the network-wide list.
function ensureAmazonLocationColumns() {
  const d = getDb();
  for (const col of ['source TEXT', 'site_type TEXT', 'service_center TEXT', 'service_months TEXT', 'note TEXT']) {
    try { d.exec(`ALTER TABLE amazon_locations ADD COLUMN ${col}`); } catch (e) { /* already present */ }
  }
}

// Adds locations from a secondary list. Never overwrites an existing business
// unit: it only fills codes the master does not carry, and enriches the shared
// ones with the detail the master lacks.
function mergeAmazonLocations(rows, source) {
  ensureAmazonLocationColumns();
  const d = getDb();
  const existing = new Set(d.prepare('SELECT site_code FROM amazon_locations').all().map(r => r.site_code));
  const ins = d.prepare(`
    INSERT INTO amazon_locations (site_code, business_unit, region, city, state, country, address, site_type, service_center, service_months, source, note, loaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `);
  const enrich = d.prepare(`
    UPDATE amazon_locations SET site_type=COALESCE(NULLIF(?,''), site_type),
      service_center=COALESCE(NULLIF(?,''), service_center),
      service_months=COALESCE(NULLIF(?,''), service_months)
    WHERE site_code=?
  `);
  let added = 0, enriched = 0;
  d.exec('BEGIN');
  try {
    for (const r of rows) {
      const code = String(r.siteCode || '').trim().toUpperCase();
      if (!code) continue;
      if (existing.has(code)) {
        enrich.run(r.siteType || '', r.serviceCenter || '', r.serviceMonths || '', code);
        enriched++;
      } else {
        ins.run(code, r.businessUnit || '', r.region || '', r.city || '', r.state || '',
                r.country || '', r.address || '', r.siteType || '', r.serviceCenter || '',
                r.serviceMonths || '', source || 'secondary', r.note || null);
        existing.add(code);
        added++;
      }
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return { added, enriched, total: d.prepare('SELECT COUNT(*) n FROM amazon_locations').get().n };
}

function getAmazonLocationMap() {
  const d = getDb();
  const out = {};
  try {
    for (const r of d.prepare('SELECT * FROM amazon_locations').all()) {
      out[r.site_code] = {
        siteCode: r.site_code, businessUnit: r.business_unit || '', region: r.region || '',
        zone: r.zone || '', city: r.city || '', state: r.state || '', country: r.country || '',
        serviced: r.serviced || '', omniaLocId: r.omnia_loc_id || '', address: r.address || '',
        opsParent: r.ops_parent || '',
        siteType: r.site_type || '', serviceCenter: r.service_center || '',
        source: r.source || '', note: r.note || '',
      };
    }
  } catch (e) { /* not loaded yet */ }
  return out;
}

function getBusinessUnits() {
  const d = getDb();
  try {
    return d.prepare(`SELECT business_unit bu, COUNT(*) n FROM amazon_locations
                      WHERE business_unit != '' GROUP BY business_unit ORDER BY business_unit`).all();
  } catch (e) { return []; }
}

// ─── Intacct department per invoice ─────────────────────────────────────────
function setDepartment(recordNo, deptId, deptName, allDepts) {
  const d = getDb();
  const list = (allDepts || []).filter(Boolean);
  d.prepare(`
    INSERT OR REPLACE INTO invoice_department (record_no, dept_id, dept_name, dept_mixed, all_depts, fetched_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(String(recordNo), deptId || '', deptName || '', list.length > 1 ? 1 : 0, list.length ? list.join('|') : null);
}

function getDepartment(recordNo) {
  const d = getDb();
  return d.prepare('SELECT dept_id, dept_name, dept_mixed, all_depts FROM invoice_department WHERE record_no=?')
    .get(String(recordNo)) || null;
}

// One call for the whole grid; the Amazon view filters thousands of rows and
// must not do a query per invoice.
function getAllDepartments() {
  const d = getDb();
  const out = {};
  for (const r of d.prepare('SELECT record_no, dept_id, dept_name, dept_mixed, all_depts FROM invoice_department').all()) {
    out[r.record_no] = { deptId: r.dept_id || '', deptName: r.dept_name || '', mixed: !!r.dept_mixed, allDepts: r.all_depts || '' };
  }
  return out;
}

function getMissingDepartmentRecordNos(recordNos) {
  const d = getDb();
  const stmt = d.prepare('SELECT record_no FROM invoice_department WHERE record_no=?');
  return recordNos.filter(rn => !stmt.get(String(rn)));
}

function getMissingLocationRecordNos(recordNos) {
  // Returns those not yet in the cache
  const d = getDb();
  const stmt = d.prepare('SELECT record_no FROM invoice_location WHERE record_no=?');
  return recordNos.filter(rn => !stmt.get(rn));
}

// ─── Notes with Mentions ───────────────────────────────────────────────────

function addNoteWithMentions(recordNo, userEmail, userName, body, type, mentions, parentId) {
  const d = getDb();
  const mentionList = Array.isArray(mentions) ? mentions : [];
  const mentionsJson = mentionList.length ? JSON.stringify(mentionList) : null;

  const result = d.prepare(`
    INSERT INTO notes (record_no, user_email, user_name, type, body, mentions, parent_id) VALUES (?,?,?,?,?,?,?)
  `).run(recordNo, userEmail, userName, type || 'note', body, mentionsJson, parentId || null);

  const noteId = result.lastInsertRowid;

  if (mentionList.length > 0) {
    const mentionStmt = d.prepare(`
      INSERT OR IGNORE INTO note_mentions (note_id, mentioned_email) VALUES (?, ?)
    `);
    for (const email of mentionList) {
      mentionStmt.run(noteId, email);
    }
  }

  return d.prepare('SELECT * FROM notes WHERE id=?').get(noteId);
}

function getMentionsForUser(email) {
  const d = getDb();
  return d.prepare(`
    SELECT nm.id as mention_id, nm.note_id, nm.mentioned_email, nm.seen, nm.confirmed_at, nm.created_at as mention_created_at,
           n.record_no, n.user_email as author_email, n.user_name as author_name,
           n.body, n.type, n.created_at as note_created_at
    FROM note_mentions nm
    JOIN notes n ON n.id = nm.note_id
    WHERE nm.mentioned_email = ?
    ORDER BY nm.created_at DESC
    LIMIT 100
  `).all(email);
}

function markMentionSeen(noteId, email) {
  const d = getDb();
  d.prepare(`UPDATE note_mentions SET seen=1 WHERE note_id=? AND mentioned_email=?`).run(noteId, email);
}

function markMentionConfirmed(noteId, email) {
  getDb().prepare(`UPDATE note_mentions SET confirmed_at=datetime('now'), seen=1 WHERE note_id=? AND mentioned_email=?`).run(noteId, email);
}

function getUnconfirmedMentionCount(email) {
  const row = getDb().prepare(`SELECT COUNT(*) AS c FROM note_mentions WHERE mentioned_email=? AND confirmed_at IS NULL`).get(email);
  return row ? row.c : 0;
}

function getUnseenMentionCount(email) {
  const d = getDb();
  const row = d.prepare(`SELECT COUNT(*) as c FROM note_mentions WHERE mentioned_email=? AND seen=0`).get(email);
  return row ? row.c : 0;
}

// ─── Reactions ─────────────────────────────────────────────────────────────

function addReaction(noteId, userEmail, emoji) {
  const d = getDb();
  d.prepare(`INSERT OR IGNORE INTO note_reactions (note_id, user_email, emoji) VALUES (?,?,?)`).run(noteId, userEmail, emoji);
}

function removeReaction(noteId, userEmail, emoji) {
  const d = getDb();
  d.prepare(`DELETE FROM note_reactions WHERE note_id=? AND user_email=? AND emoji=?`).run(noteId, userEmail, emoji);
}

function getReactionsForNote(noteId) {
  const d = getDb();
  const rows = d.prepare(`SELECT emoji, user_email FROM note_reactions WHERE note_id=? ORDER BY created_at ASC`).all(noteId);
  const map = {};
  for (const row of rows) {
    if (!map[row.emoji]) map[row.emoji] = { emoji: row.emoji, count: 0, users: [] };
    map[row.emoji].count++;
    map[row.emoji].users.push(row.user_email);
  }
  return Object.values(map);
}

function getReactionsForNotes(noteIds) {
  if (!noteIds || noteIds.length === 0) return {};
  const d = getDb();
  const placeholders = noteIds.map(() => '?').join(',');
  const rows = d.prepare(`SELECT note_id, emoji, user_email FROM note_reactions WHERE note_id IN (${placeholders}) ORDER BY created_at ASC`).all(...noteIds);
  const result = {};
  for (const row of rows) {
    if (!result[row.note_id]) result[row.note_id] = {};
    if (!result[row.note_id][row.emoji]) result[row.note_id][row.emoji] = { emoji: row.emoji, count: 0, users: [] };
    result[row.note_id][row.emoji].count++;
    result[row.note_id][row.emoji].users.push(row.user_email);
  }
  const final = {};
  for (const [nid, emojis] of Object.entries(result)) {
    final[nid] = Object.values(emojis);
  }
  return final;
}

function updateUserPhoto(email, photoDataUrl) {
  const d = getDb();
  d.prepare("UPDATE user_roles SET photo_data_url=? WHERE email=?").run(photoDataUrl || null, email);
}

function updateUserJobTitle(email, jobTitle) {
  const d = getDb();
  d.prepare("UPDATE user_roles SET job_title=? WHERE email=?").run(jobTitle || null, email);
}

// `location_ids` (JSON array) supersedes the single `location_id`; the old
// column is kept and still honoured so existing rules keep working untouched.
// `target_mode`/`target_customers` mirror the dunning rules: 'all' ignores the
// list, 'only' restricts the rule to the listed customers, 'except' runs it on
// everyone but them. House accounts are excluded on top of this, globally.
function ensureAssignmentRuleColumns() {
  const d = getDb();
  try { d.exec('ALTER TABLE assignment_rules ADD COLUMN location_ids TEXT'); } catch (e) { /* already present */ }
  try { d.exec("ALTER TABLE assignment_rules ADD COLUMN target_mode TEXT DEFAULT 'all'"); } catch (e) { /* already present */ }
  try { d.exec('ALTER TABLE assignment_rules ADD COLUMN target_customers TEXT'); } catch (e) { /* already present */ }
}

function listAssignmentRules() {
  ensureAssignmentRuleColumns();
  return getDb().prepare('SELECT * FROM assignment_rules ORDER BY priority ASC, id ASC').all().map(r => {
    let ids = [];
    try { ids = JSON.parse(r.location_ids || '[]'); } catch (e) { ids = []; }
    if (!ids.length && r.location_id) ids = [r.location_id];
    let custs = [];
    try { custs = JSON.parse(r.target_customers || '[]'); } catch (e) { custs = []; }
    return { ...r, locationIds: ids, targetMode: r.target_mode || 'all', targetCustomers: custs };
  });
}
function upsertAssignmentRule(id, f, by) {
  const d2 = getDb();
  ensureAssignmentRuleColumns();
  // Accept an array of locations from the caller and store it as JSON, keeping
  // the legacy single column in step so nothing that still reads it breaks.
  if (Array.isArray(f.locationIds)) {
    const list = f.locationIds.filter(Boolean);
    f.location_ids = list.length ? JSON.stringify(list) : null;
    f.location_id = list.length === 1 ? list[0] : null;
  }
  if (Array.isArray(f.targetCustomers)) {
    const list = f.targetCustomers.map(c => String(c).trim()).filter(Boolean);
    f.target_customers = list.length ? JSON.stringify(list) : null;
  }
  if (f.targetMode !== undefined) f.target_mode = f.targetMode;
  if (id) {
    const sets = [], vals = [];
    for (const k of ['name', 'active', 'priority', 'location_id', 'location_ids', 'min_days_past_due', 'max_days_past_due', 'collector_email', 'target_mode', 'target_customers']) {
      if (f[k] !== undefined) { sets.push(k + '=?'); vals.push(f[k]); }
    }
    if (sets.length) { sets.push("updated_at=datetime('now')"); vals.push(id);
      d2.prepare('UPDATE assignment_rules SET ' + sets.join(',') + ' WHERE id=?').run(...vals); }
    return d2.prepare('SELECT * FROM assignment_rules WHERE id=?').get(id);
  }
  const r = d2.prepare('INSERT INTO assignment_rules (name, active, priority, location_id, location_ids, min_days_past_due, max_days_past_due, collector_email, target_mode, target_customers, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(f.name, f.active ? 1 : 0, f.priority || 1, f.location_id || null, f.location_ids || null,
      // Days are relative to the DUE DATE and may be negative, so a rule can
      // fire before an invoice is due. `|| 0` would swallow a legitimate 0 but
      // also a legitimate negative, hence the explicit null check.
      f.min_days_past_due == null ? 0 : parseInt(f.min_days_past_due, 10),
      f.max_days_past_due == null || f.max_days_past_due === '' ? null : parseInt(f.max_days_past_due, 10),
      f.collector_email, f.target_mode || 'all', f.target_customers || null, by || null);
  return d2.prepare('SELECT * FROM assignment_rules WHERE id=?').get(r.lastInsertRowid);
}
function deleteAssignmentRule(id) { getDb().prepare('DELETE FROM assignment_rules WHERE id=?').run(id); }

function setUserPermissions(email, permissionsJson) {
  getDb().prepare("UPDATE user_roles SET permissions=?, updated_at=datetime('now') WHERE email=? COLLATE NOCASE")
    .run(permissionsJson || null, email);
}

function updateUserPhone(email, phone) {
  const d = getDb();
  d.prepare("UPDATE user_roles SET phone=? WHERE email=?").run(phone || null, email);
}

// ─── Customer contacts (comms platform) ────────────────────────────────────
// Sync-seed, manual-authoritative: Intacct DISPLAYCONTACT rows are suggestions
// (source='intacct'); any human edit flips a row to source='manual' and the
// sync never touches it again. Synced contacts arrive with consent_email=1 but
// dunning_enabled=0 — a human must approve each contact for automated dunning.
// Rows are never deleted, only is_active=0.

const _normCEmail = (e) => String(e || '').trim().toLowerCase();
const _validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function listCustomerContacts(customerId, includeInactive = false) {
  const d = getDb();
  const sql = includeInactive
    ? 'SELECT * FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC, name ASC'
    : 'SELECT * FROM customer_contacts WHERE customer_id=? AND is_active=1 ORDER BY is_primary DESC, name ASC';
  return d.prepare(sql).all(customerId);
}

function getCustomerContact(id) {
  return getDb().prepare('SELECT * FROM customer_contacts WHERE id=?').get(id) || null;
}

function addCustomerContact(customerId, fields, createdBy) {
  const d = getDb();
  const email = _normCEmail(fields.email);
  if (!_validEmail(email)) throw new Error('invalid email');
  d.prepare(`
    INSERT INTO customer_contacts (customer_id, name, email, phone, title, source, is_primary, consent_email, dunning_enabled, notes, contact_type, created_by, updated_by)
    VALUES (?,?,?,?,?,'manual',?,?,?,?,?,?,?)
  `).run(customerId, fields.name || null, email, fields.phone || null, fields.title || null,
    fields.is_primary ? 1 : 0, fields.consent_email === 0 ? 0 : 1, fields.dunning_enabled ? 1 : 0,
    fields.notes || null, fields.contact_type === 'billing' ? 'billing' : 'collections',
    createdBy || null, createdBy || null);
  const row = d.prepare('SELECT * FROM customer_contacts WHERE customer_id=? AND email=?').get(customerId, email);
  if (fields.is_primary) setContactPrimary(customerId, row.id);
  return getCustomerContact(row.id);
}

// Any human update makes the row manual-authoritative (source='manual').
function updateCustomerContact(id, fields, updatedBy) {
  const d = getDb();
  const existing = getCustomerContact(id);
  if (!existing) throw new Error('contact not found');
  const sets = ["source='manual'", "updated_at=datetime('now')"];
  const vals = [];
  if (fields.name !== undefined)  { sets.push('name=?');  vals.push(fields.name || null); }
  if (fields.phone !== undefined) { sets.push('phone=?'); vals.push(fields.phone || null); }
  if (fields.title !== undefined) { sets.push('title=?'); vals.push(fields.title || null); }
  if (fields.notes !== undefined) { sets.push('notes=?'); vals.push(fields.notes || null); }
  if (fields.email !== undefined) {
    const email = _normCEmail(fields.email);
    if (!_validEmail(email)) throw new Error('invalid email');
    sets.push('email=?'); vals.push(email);
  }
  if (fields.contact_type !== undefined)    { sets.push('contact_type=?');    vals.push(fields.contact_type === 'billing' ? 'billing' : 'collections'); }
  if (fields.consent_email !== undefined)   { sets.push('consent_email=?');   vals.push(fields.consent_email ? 1 : 0); }
  if (fields.dunning_enabled !== undefined) { sets.push('dunning_enabled=?'); vals.push(fields.dunning_enabled ? 1 : 0); }
  if (fields.is_active !== undefined)       { sets.push('is_active=?');       vals.push(fields.is_active ? 1 : 0); }
  sets.push('updated_by=?'); vals.push(updatedBy || null);
  vals.push(id);
  d.prepare(`UPDATE customer_contacts SET ${sets.join(',')} WHERE id=?`).run(...vals);
  if (fields.is_primary) setContactPrimary(existing.customer_id, id);
  else if (fields.is_primary === 0 || fields.is_primary === false) {
    d.prepare('UPDATE customer_contacts SET is_primary=0 WHERE id=?').run(id);
  }
  return getCustomerContact(id);
}

function setContactPrimary(customerId, id) {
  const d = getDb();
  d.prepare('UPDATE customer_contacts SET is_primary=0 WHERE customer_id=?').run(customerId);
  d.prepare("UPDATE customer_contacts SET is_primary=1, updated_at=datetime('now') WHERE id=?").run(id);
}

// Seed/refresh from Sage DISPLAYCONTACT rows: [{id, name, contactName, email1, email2, phone1}].
// AP email fields often pack several addresses ("a@x.com; b@y.com") — split them.
function syncCustomerContactsFromSage(rows) {
  const d = getDb();
  let inserted = 0, updated = 0, skippedManual = 0, customersWithContacts = 0;
  const findStmt = d.prepare('SELECT * FROM customer_contacts WHERE customer_id=? AND email=?');
  const primaryStmt = d.prepare('SELECT COUNT(*) AS c FROM customer_contacts WHERE customer_id=? AND is_primary=1 AND is_active=1');
  const insStmt = d.prepare(`
    INSERT INTO customer_contacts (customer_id, name, email, phone, title, source, is_primary, consent_email, dunning_enabled, created_by, updated_by)
    VALUES (?,?,?,?,NULL,'intacct',?,1,0,'intacct-sync','intacct-sync')
  `);
  const updStmt = d.prepare(`
    UPDATE customer_contacts SET name=?, phone=?, updated_by='intacct-sync', updated_at=datetime('now')
    WHERE id=? AND source='intacct'
  `);
  for (const r of rows) {
    const emails = [];
    for (const [src, isFirstField] of [[r.email1, true], [r.email2, false]]) {
      for (const part of String(src || '').split(/[;,]+/)) {
        const e = _normCEmail(part);
        if (_validEmail(e) && !emails.some(x => x.email === e)) emails.push({ email: e, firstField: isFirstField && emails.length === 0 });
      }
    }
    if (!emails.length) continue;
    customersWithContacts++;
    for (const { email, firstField } of emails) {
      const existing = findStmt.get(r.id, email);
      // Name/phone belong to the DISPLAYCONTACT person — only meaningful on the
      // first address of EMAIL1; extra split addresses get no name.
      const name = firstField ? (r.contactName || null) : null;
      const phone = firstField ? (r.phone1 || null) : null;
      if (!existing) {
        const hasPrimary = primaryStmt.get(r.id).c > 0;
        insStmt.run(r.id, name, email, phone, firstField && !hasPrimary ? 1 : 0);
        inserted++;
      } else if (existing.source === 'intacct') {
        if ((name && existing.name !== name) || (phone && existing.phone !== phone)) {
          updStmt.run(name ?? existing.name, phone ?? existing.phone, existing.id);
          updated++;
        }
      } else {
        skippedManual++;
      }
    }
  }
  return { customers: rows.length, customersWithContacts, inserted, updated, skippedManual };
}

// ─── User lookup, case-insensitive ─────────────────────────────────────────
// user_roles.email is mixed-case (Edwin.Torres@ etc.) and getUserRole is
// exact-match; comms code stores lowercase and must not miss on case.
function getUserRoleAnyCase(email) {
  if (!email) return null;
  return getDb().prepare('SELECT * FROM user_roles WHERE email = ? COLLATE NOCASE').get(String(email).trim()) || null;
}

// ─── Comm templates (versioned; saving always creates a new version) ────────

function getTemplateByKey(key) {
  const d = getDb();
  const t = d.prepare('SELECT * FROM comm_templates WHERE key=?').get(key);
  if (!t) return null;
  t.version_row = d.prepare('SELECT * FROM comm_template_versions WHERE template_id=? AND version=?')
    .get(t.id, t.current_version) || null;
  return t;
}

function listTemplates() {
  const d = getDb();
  return d.prepare('SELECT * FROM comm_templates ORDER BY key').all().map(t => ({
    ...t,
    version_row: d.prepare('SELECT * FROM comm_template_versions WHERE template_id=? AND version=?').get(t.id, t.current_version) || null,
  }));
}

function saveTemplateVersion(key, name, kind, subject, bodyHtml, tokensUsed, createdBy) {
  const d = getDb();
  let t = d.prepare('SELECT * FROM comm_templates WHERE key=?').get(key);
  if (!t) {
    d.prepare('INSERT INTO comm_templates (key, name, kind) VALUES (?,?,?)').run(key, name || key, kind || 'external');
    t = d.prepare('SELECT * FROM comm_templates WHERE key=?').get(key);
  } else if (name && name !== t.name) {
    d.prepare("UPDATE comm_templates SET name=?, updated_at=datetime('now') WHERE id=?").run(name, t.id);
  }
  const version = (t.current_version || 0) + 1;
  d.prepare(`
    INSERT INTO comm_template_versions (template_id, version, subject, body_html, tokens_used, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(t.id, version, subject, bodyHtml, tokensUsed || null, createdBy || null);
  d.prepare("UPDATE comm_templates SET current_version=?, updated_at=datetime('now') WHERE id=?").run(version, t.id);
  return getTemplateByKey(key);
}

function listTemplateVersions(key) {
  const d = getDb();
  const t = d.prepare('SELECT * FROM comm_templates WHERE key=?').get(key);
  if (!t) return [];
  return d.prepare('SELECT * FROM comm_template_versions WHERE template_id=? ORDER BY version DESC').all(t.id);
}

// ─── Conversations + messages ───────────────────────────────────────────────

function createConversation({ customerId, contactId, mailbox, assignedEmail, subject, status }) {
  const d = getDb();
  const r = d.prepare(`
    INSERT INTO conversations (customer_id, contact_id, mailbox, assigned_email, subject, status)
    VALUES (?,?,?,?,?,?)
  `).run(customerId || null, contactId || null, mailbox || null, assignedEmail || null, subject || null, status || 'open');
  return d.prepare('SELECT * FROM conversations WHERE id=?').get(r.lastInsertRowid);
}

function setConversationSubject(id, subject, subjectToken) {
  getDb().prepare("UPDATE conversations SET subject=?, subject_token=?, updated_at=datetime('now') WHERE id=?")
    .run(subject, subjectToken || null, id);
}

function getConversation(id) {
  return getDb().prepare('SELECT * FROM conversations WHERE id=?').get(id) || null;
}

function getConversationByGraphId(graphConversationId) {
  if (!graphConversationId) return null;
  return getDb().prepare('SELECT * FROM conversations WHERE graph_conversation_id=?').get(graphConversationId) || null;
}

function listConversations({ customerId, status, assigned, limit } = {}) {
  const where = [], vals = [];
  if (customerId) { where.push('customer_id=?'); vals.push(customerId); }
  if (status)     { where.push('status=?');      vals.push(status); }
  if (assigned)   { where.push('assigned_email=?'); vals.push(assigned); }
  const sql = `SELECT * FROM conversations ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?`;
  vals.push(limit || 200);
  return getDb().prepare(sql).all(...vals);
}

function touchConversation(id, { lastDirection, status, graphConversationId, assignedEmail } = {}) {
  const sets = ["last_message_at=datetime('now')", "updated_at=datetime('now')"];
  const vals = [];
  if (lastDirection) { sets.push('last_direction=?'); vals.push(lastDirection); }
  if (status)        { sets.push('status=?');         vals.push(status); }
  if (graphConversationId) { sets.push('graph_conversation_id=COALESCE(graph_conversation_id, ?)'); vals.push(graphConversationId); }
  if (assignedEmail !== undefined) { sets.push('assigned_email=?'); vals.push(assignedEmail); }
  vals.push(id);
  getDb().prepare(`UPDATE conversations SET ${sets.join(',')} WHERE id=?`).run(...vals);
}

const MESSAGE_COLS = [
  'conversation_id', 'direction', 'actor_type', 'actor_email', 'corresponding_email',
  'from_email', 'to_emails', 'cc_emails', 'subject', 'body_text', 'body_html',
  'template_id', 'template_version', 'token_values', 'signature_snapshot',
  'graph_message_id', 'internet_message_id', 'in_reply_to', 'references_hdr',
  'graph_conversation_id', 'sent_at', 'received_at', 'status', 'error',
  'has_attachments', 'attachments_json', 'dunning_action_id',
];

function insertMessage(fields) {
  const d = getDb();
  const cols = MESSAGE_COLS.filter(c => fields[c] !== undefined);
  const r = d.prepare(`INSERT INTO messages (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(c => fields[c]));
  return d.prepare('SELECT * FROM messages WHERE id=?').get(r.lastInsertRowid);
}

function getMessage(id) {
  return getDb().prepare('SELECT * FROM messages WHERE id=?').get(id) || null;
}

function getMessageByGraphId(graphMessageId) {
  if (!graphMessageId) return null;
  return getDb().prepare('SELECT * FROM messages WHERE graph_message_id=?').get(graphMessageId) || null;
}

function getMessageByInternetMessageId(imid) {
  if (!imid) return null;
  return getDb().prepare('SELECT * FROM messages WHERE internet_message_id=?').get(imid) || null;
}

function getMessagesForConversation(conversationId) {
  return getDb().prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY COALESCE(sent_at, received_at, created_at) ASC')
    .all(conversationId);
}

function tagMessageInvoices(messageId, recordNos) {
  if (!recordNos || !recordNos.length) return;
  const d = getDb();
  const stmt = d.prepare('INSERT OR IGNORE INTO message_invoices (message_id, record_no) VALUES (?,?)');
  for (const rn of recordNos) if (rn) stmt.run(messageId, rn);
}

function getMessagesForInvoice(recordNo) {
  return getDb().prepare(`
    SELECT m.* FROM messages m
    JOIN message_invoices mi ON mi.message_id = m.id
    WHERE mi.record_no = ?
    ORDER BY COALESCE(m.sent_at, m.received_at, m.created_at) ASC
  `).all(recordNo);
}

// ─── Dunning rules / runs / actions / idempotency ledger ────────────────────

function listDunningRules() {
  return getDb().prepare('SELECT * FROM dunning_rules ORDER BY sequence ASC').all();
}

function upsertDunningRule(id, f) {
  const d = getDb();
  if (id) {
    const sets = [], vals = [];
    for (const k of ['name', 'active', 'sequence', 'trigger_days_past_due', 'repeat_every_days', 'template_key', 'billing_stream', 'min_invoice_balance', 'exclude_customers', 'target_mode', 'target_customers']) {
      if (f[k] !== undefined) { sets.push(`${k}=?`); vals.push(f[k]); }
    }
    if (!sets.length) return d.prepare('SELECT * FROM dunning_rules WHERE id=?').get(id);
    sets.push("updated_at=datetime('now')");
    vals.push(id);
    d.prepare(`UPDATE dunning_rules SET ${sets.join(',')} WHERE id=?`).run(...vals);
    return d.prepare('SELECT * FROM dunning_rules WHERE id=?').get(id);
  }
  const r = d.prepare(`
    INSERT INTO dunning_rules (name, active, sequence, trigger_days_past_due, repeat_every_days, template_key, billing_stream, min_invoice_balance, exclude_customers, target_mode, target_customers)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(f.name, f.active ? 1 : 0, f.sequence, f.trigger_days_past_due, f.repeat_every_days ?? null,
    f.template_key, f.billing_stream || 'all', f.min_invoice_balance ?? 0, f.exclude_customers ?? null,
    f.target_mode || 'all', f.target_customers ?? null);
  return d.prepare('SELECT * FROM dunning_rules WHERE id=?').get(r.lastInsertRowid);
}

function deleteDunningRule(id) {
  getDb().prepare('DELETE FROM dunning_rules WHERE id=?').run(id);
}

// ─── Collection status (collector sets, AR updates) ─────────────────────────

function getAllCollectionStatuses() {
  const map = {};
  for (const r of getDb().prepare('SELECT * FROM invoice_collection_status').all()) map[r.record_no] = r;
  return map;
}

function setCollectionStatus(recordNo, invoiceId, status, note, setBy) {
  getDb().prepare(`
    INSERT INTO invoice_collection_status (record_no, invoice_id, status, note, set_by, updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(record_no) DO UPDATE SET
      status=excluded.status, note=excluded.note, set_by=excluded.set_by, updated_at=datetime('now')
  `).run(recordNo, invoiceId || null, status, note || null, setBy || null);
  return getDb().prepare('SELECT * FROM invoice_collection_status WHERE record_no=?').get(recordNo);
}

// ─── Customer attachments (files on disk, metadata here; soft delete only) ──

function listCustomerAttachments(customerId) {
  return getDb().prepare('SELECT id, customer_id, filename, size, content_type, uploaded_by, uploaded_at FROM customer_attachments WHERE customer_id=? AND deleted=0 ORDER BY uploaded_at DESC').all(customerId);
}

function getCustomerAttachment(id) {
  return getDb().prepare('SELECT * FROM customer_attachments WHERE id=?').get(id) || null;
}

function addCustomerAttachment(customerId, filename, storedPath, size, contentType, uploadedBy) {
  const r = getDb().prepare(`
    INSERT INTO customer_attachments (customer_id, filename, stored_path, size, content_type, uploaded_by)
    VALUES (?,?,?,?,?,?)
  `).run(customerId, filename, storedPath, size, contentType || null, uploadedBy || null);
  return getCustomerAttachment(r.lastInsertRowid);
}

function softDeleteCustomerAttachment(id) {
  getDb().prepare('UPDATE customer_attachments SET deleted=1 WHERE id=?').run(id);
}

// ─── InterNex (Velocity) transmits ──────────────────────────────────────────

function insertVelocityTransmit(recordNo, invoiceId, line, batch, result, by) {
  getDb().prepare(`INSERT INTO velocity_transmits (record_no, invoice_id, line, batch, result, transmitted_by) VALUES (?,?,?,?,?,?)`)
    .run(recordNo, invoiceId, line, batch, result, by);
}

function getVelocityTransmitMap() {
  const map = {};
  for (const r of getDb().prepare('SELECT record_no, MAX(transmitted_at) AS at, COUNT(*) AS n FROM velocity_transmits GROUP BY record_no').all()) {
    map[r.record_no] = { at: r.at, times: r.n };
  }
  return map;
}

function confirmVelocityTransmits(invoiceIds) {
  if (!invoiceIds.length) return 0;
  const d2 = getDb();
  const stmt = d2.prepare("UPDATE velocity_transmits SET confirmed_at=datetime('now') WHERE invoice_id=? AND result='OK' AND confirmed_at IS NULL");
  let n = 0;
  for (const id of invoiceIds) n += stmt.run(id).changes;
  return n;
}

function countUnconfirmedVelocity() {
  return getDb().prepare("SELECT COUNT(*) AS c FROM velocity_transmits WHERE result='OK' AND confirmed_at IS NULL").get().c;
}

function listVelocityTransmits(limit = 100) {
  return getDb().prepare('SELECT * FROM velocity_transmits ORDER BY id DESC LIMIT ?').all(limit);
}

// ─── Statement schedules ────────────────────────────────────────────────────

function listStatementSchedules() {
  return getDb().prepare('SELECT * FROM statement_schedules ORDER BY customer_id').all();
}

function getStatementSchedule(customerId) {
  return getDb().prepare('SELECT * FROM statement_schedules WHERE customer_id=?').get(customerId) || null;
}

function upsertStatementSchedule(customerId, f, updatedBy) {
  const d = getDb();
  d.prepare(`
    INSERT INTO statement_schedules (customer_id, enabled, day_of_month, contact_ids, min_balance, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(customer_id) DO UPDATE SET
      enabled=excluded.enabled, day_of_month=excluded.day_of_month,
      contact_ids=excluded.contact_ids, min_balance=excluded.min_balance,
      updated_by=excluded.updated_by, updated_at=datetime('now')
  `).run(customerId, f.enabled ? 1 : 0, Math.min(28, Math.max(1, parseInt(f.day_of_month, 10) || 1)),
    f.contact_ids ?? null, f.min_balance ?? 0.01, updatedBy || null, updatedBy || null);
  return getStatementSchedule(customerId);
}

function setStatementSent(customerId, period) {
  getDb().prepare("UPDATE statement_schedules SET last_sent_period=?, updated_at=datetime('now') WHERE customer_id=?")
    .run(period, customerId);
}

function createDunningRun(mode, triggeredBy) {
  const d = getDb();
  const r = d.prepare('INSERT INTO dunning_runs (mode, triggered_by) VALUES (?,?)').run(mode, triggeredBy || null);
  return d.prepare('SELECT * FROM dunning_runs WHERE id=?').get(r.lastInsertRowid);
}

function finishDunningRun(id, status, statsJson, error) {
  getDb().prepare("UPDATE dunning_runs SET finished_at=datetime('now'), status=?, stats_json=?, error=? WHERE id=?")
    .run(status, statsJson || null, error || null, id);
}

function getDunningRun(id) {
  return getDb().prepare('SELECT * FROM dunning_runs WHERE id=?').get(id) || null;
}

function listDunningRuns(limit = 30) {
  return getDb().prepare('SELECT * FROM dunning_runs ORDER BY id DESC LIMIT ?').all(limit);
}

function insertDunningAction(f) {
  const d = getDb();
  const r = d.prepare(`
    INSERT INTO dunning_actions (run_id, rule_id, customer_id, record_nos, status, skip_reason, message_id)
    VALUES (?,?,?,?,?,?,?)
  `).run(f.run_id, f.rule_id, f.customer_id, f.record_nos, f.status || 'preview', f.skip_reason || null, f.message_id || null);
  return d.prepare('SELECT * FROM dunning_actions WHERE id=?').get(r.lastInsertRowid);
}

function listDunningActions(runId) {
  return getDb().prepare('SELECT * FROM dunning_actions WHERE run_id=? ORDER BY status ASC, customer_id ASC').all(runId);
}

function updateDunningAction(id, f) {
  const sets = [], vals = [];
  for (const k of ['status', 'skip_reason', 'message_id']) {
    if (f[k] !== undefined) { sets.push(`${k}=?`); vals.push(f[k]); }
  }
  if (!sets.length) return;
  vals.push(id);
  getDb().prepare(`UPDATE dunning_actions SET ${sets.join(',')} WHERE id=?`).run(...vals);
}

function dunningSentExists(idemKey) {
  return !!getDb().prepare('SELECT 1 FROM dunning_sent WHERE idem_key=?').get(idemKey);
}

function recordDunningSent(idemKey, recordNo, ruleId, messageId) {
  getDb().prepare('INSERT OR IGNORE INTO dunning_sent (idem_key, record_no, rule_id, message_id) VALUES (?,?,?,?)')
    .run(idemKey, recordNo, ruleId, messageId || null);
}

// ─── Comms state (kv: delta links, run locks, cursors) ─────────────────────

function getCommState(key) {
  const row = getDb().prepare('SELECT value FROM comm_state WHERE key=?').get(key);
  return row ? row.value : null;
}

function setCommState(key, value) {
  getDb().prepare(`
    INSERT INTO comm_state (key, value, updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `).run(key, value == null ? null : String(value));
}

// Seeding and inviting are separate acts: a user can be set up, assigned work
// and tested against long before anyone tells them the portal exists. The
// invite mail records itself with markInvited so "who has actually been told"
// stays answerable (Edwin 2026-09-10).
function ensureInviteColumns() {
  const d = getDb();
  try { d.exec('ALTER TABLE user_roles ADD COLUMN invited_at TEXT'); } catch (e) {}
  try { d.exec('ALTER TABLE user_roles ADD COLUMN invited_by TEXT'); } catch (e) {}
}

function preProvisionUser(email, name, role, jobTitle) {
  const d = getDb();
  ensureInviteColumns();
  // Store lower-case so what is seeded matches what Microsoft later signs in
  // with, whatever case it hands back.
  email = String(email || '').trim().toLowerCase();
  d.prepare(`
    INSERT OR IGNORE INTO user_roles (email, name, role, job_title)
    VALUES (?, ?, ?, ?)
  `).run(email, name || '', role || 'viewer', jobTitle || null);
  // An existing row is UPDATED rather than left alone: re-seeding with a
  // corrected name or role should take effect, which INSERT OR IGNORE alone
  // would silently skip.
  const sets = [], vals = [];
  if (name) { sets.push('name=?'); vals.push(name); }
  if (role) { sets.push('role=?'); vals.push(role); }
  if (jobTitle !== undefined && jobTitle !== null) { sets.push('job_title=?'); vals.push(jobTitle); }
  if (sets.length) { vals.push(email); d.prepare('UPDATE user_roles SET ' + sets.join(',') + ' WHERE email=? COLLATE NOCASE').run(...vals); }
  return d.prepare('SELECT * FROM user_roles WHERE email=?').get(email);
}

function markInvited(email, byEmail) {
  ensureInviteColumns();
  getDb().prepare("UPDATE user_roles SET invited_at=datetime('now'), invited_by=? WHERE email=? COLLATE NOCASE").run(byEmail || null, email);
}

function listUninvitedUsers() {
  ensureInviteColumns();
  try { return getDb().prepare('SELECT * FROM user_roles WHERE invited_at IS NULL ORDER BY email').all(); }
  catch (e) { return []; }
}

// Returns { record_no: count } for all records that have notes
function getNoteCounts() {
  const d = getDb();
  const rows = d.prepare('SELECT record_no, COUNT(*) as cnt FROM notes GROUP BY record_no').all();
  const map = {};
  for (const r of rows) map[r.record_no] = r.cnt;
  return map;
}


function getCustomerAccount(customerId) {
  return db.prepare('SELECT * FROM customer_accounts WHERE customer_id=?').get(customerId) || null;
}

function upsertCustomerAccount(customerId, customerName, fields, updatedBy) {
  const existing = getCustomerAccount(customerId);
  if (!existing) {
    db.prepare(`
      INSERT INTO customer_accounts (customer_id, customer_name, stop_service, owner_name, owner_email, notes, house_account, house_account_label, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(customerId, customerName,
      fields.stop_service ?? 0,
      fields.owner_name ?? null,
      fields.owner_email ?? null,
      fields.notes ?? null,
      fields.house_account ? 1 : 0,
      fields.house_account_label ?? null,
      updatedBy ?? null);
  } else {
    const sets = [];
    const vals = [];
    if (fields.stop_service !== undefined) { sets.push('stop_service=?'); vals.push(fields.stop_service ? 1 : 0); }
    if (fields.owner_name !== undefined)   { sets.push('owner_name=?');   vals.push(fields.owner_name); }
    if (fields.owner_email !== undefined)  { sets.push('owner_email=?');  vals.push(fields.owner_email); }
    if (fields.collector_email !== undefined) { sets.push('collector_email=?'); vals.push(fields.collector_email); }
    if (fields.stop_service_effective_date !== undefined) { sets.push('stop_service_effective_date=?'); vals.push(fields.stop_service_effective_date); }
    if (fields.stop_service_issued_by !== undefined) { sets.push('stop_service_issued_by=?'); vals.push(fields.stop_service_issued_by); }
    if (fields.stop_service_at !== undefined) { sets.push('stop_service_at=?'); vals.push(fields.stop_service_at); }
    if (fields.house_account !== undefined) { sets.push('house_account=?'); vals.push(fields.house_account ? 1 : 0); }
    if (fields.dunning_hold !== undefined) { sets.push('dunning_hold=?'); vals.push(fields.dunning_hold ? 1 : 0); }
    if (fields.dunning_hold_reason !== undefined) { sets.push('dunning_hold_reason=?'); vals.push(fields.dunning_hold_reason || null); }
    if (fields.house_account_label !== undefined) { sets.push('house_account_label=?'); vals.push(fields.house_account_label || null); }
    if (fields.notes !== undefined)        { sets.push('notes=?');        vals.push(fields.notes); }
    if (fields.customer_name || customerName) { sets.push('customer_name=?'); vals.push(fields.customer_name || customerName); }
    sets.push("updated_at=datetime('now')");
    sets.push('updated_by=?'); vals.push(updatedBy ?? null);
    vals.push(customerId);
    db.prepare(`UPDATE customer_accounts SET ${sets.join(',')} WHERE customer_id=?`).run(...vals);
  }
  return getCustomerAccount(customerId);
}

function getAllCustomerAccounts() {
  return db.prepare('SELECT * FROM customer_accounts').all();
}

// Customers collected centrally at the office. Read on every auto-assign run,
// so it stays a plain Set lookup rather than a per-invoice query.
function getHouseAccounts() {
  try {
    return db.prepare('SELECT customer_id, customer_name, house_account_label, dunning_hold, dunning_hold_reason FROM customer_accounts WHERE house_account=1').all();
  } catch (e) { return []; }   // column absent until the migration has run
}

// Customers held back from dunning. Independent of house_account — a customer
// can be either, both, or neither.
// ─── Site + PO contacts ─────────────────────────────────────────────────────
// Learned from PO documents. A newer PO wins, EXCEPT where someone has pinned
// the value by hand — a manual correction must survive the next scan.
function upsertPoContact({ poNumber, siteCode, name, email, attnName, revisedByEmail, source, docDate }) {
  if (!poNumber) return;
  getDb().prepare(`
    INSERT INTO po_contacts (po_number, site_code, contact_name, contact_email, attn_name, revised_by_email, source, doc_date, updated_at)
    VALUES (?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(po_number) DO UPDATE SET
      site_code=excluded.site_code, contact_name=excluded.contact_name, contact_email=excluded.contact_email,
      attn_name=excluded.attn_name, revised_by_email=excluded.revised_by_email, source=excluded.source,
      doc_date=excluded.doc_date, updated_at=datetime('now')
  `).run(poNumber, siteCode || null, name || null, email || null, attnName || null, revisedByEmail || null, source || null, docDate || null);
}

function getPoContact(poNumber) {
  return getDb().prepare('SELECT * FROM po_contacts WHERE po_number=?').get(poNumber) || null;
}
function getPoContactMap() {
  const out = {};
  try { for (const r of getDb().prepare('SELECT * FROM po_contacts').all()) out[r.po_number] = r; } catch (e) {}
  return out;
}

function learnSiteAmazonContact({ siteCode, name, email, source, seenAt }) {
  if (!siteCode || !email) return;
  const d = getDb();
  const cur = d.prepare('SELECT * FROM site_contacts WHERE site_code=?').get(siteCode);
  if (cur && cur.amazon_pinned) return;             // hand-set: leave it alone
  // Only move forward in time, so a back-fill of old PO documents cannot
  // overwrite the contact learned from a more recent PO.
  if (cur && cur.amazon_seen_at && seenAt && String(seenAt) < String(cur.amazon_seen_at)) return;
  d.prepare(`
    INSERT INTO site_contacts (site_code, amazon_name, amazon_email, amazon_source, amazon_seen_at, updated_at)
    VALUES (?,?,?,?,?, datetime('now'))
    ON CONFLICT(site_code) DO UPDATE SET
      amazon_name=excluded.amazon_name, amazon_email=excluded.amazon_email,
      amazon_source=excluded.amazon_source, amazon_seen_at=excluded.amazon_seen_at, updated_at=datetime('now')
  `).run(siteCode, name || null, email, source || null, seenAt || null);
}

function setSiteContact(siteCode, fields, updatedBy) {
  const d = getDb();
  d.prepare('INSERT OR IGNORE INTO site_contacts (site_code) VALUES (?)').run(siteCode);
  const sets = [], vals = [];
  for (const k of ['amazon_name', 'amazon_email', 'amazon_source', 'amazon_pinned',
                   'internal_email', 'internal_pinned', 'note']) {
    if (fields[k] !== undefined) { sets.push(k + '=?'); vals.push(fields[k]); }
  }
  if (!sets.length) return getSiteContact(siteCode);
  sets.push("updated_at=datetime('now')", 'updated_by=?');
  vals.push(updatedBy || null, siteCode);
  d.prepare('UPDATE site_contacts SET ' + sets.join(',') + ' WHERE site_code=?').run(...vals);
  return getSiteContact(siteCode);
}

function getSiteContact(siteCode) {
  return getDb().prepare('SELECT * FROM site_contacts WHERE site_code=?').get(siteCode) || null;
}
function getSiteContactMap() {
  const out = {};
  try { for (const r of getDb().prepare('SELECT * FROM site_contacts').all()) out[r.site_code] = r; } catch (e) {}
  return out;
}

// ─── Rejections ─────────────────────────────────────────────────────────────
function upsertRejection(r) {
  const d = getDb();
  const cur = d.prepare('SELECT * FROM invoice_rejections WHERE payee_id=?').get(r.payeeId);
  if (cur) {
    // Seen again: refresh the facts, but never trample a resolution or an
    // acknowledgement someone has already recorded.
    d.prepare(`UPDATE invoice_rejections SET last_seen=datetime('now'), amount=?, reason=COALESCE(?, reason),
       po_number=COALESCE(?, po_number), site_code=COALESCE(?, site_code), business_unit=COALESCE(?, business_unit),
       record_no=COALESCE(?, record_no), invoice_id=COALESCE(?, invoice_id) WHERE payee_id=?`)
      .run(r.amount ?? cur.amount, r.reason || null, r.poNumber || null, r.siteCode || null,
           r.businessUnit || null, r.recordNo || null, r.invoiceId || null, r.payeeId);
    return { row: d.prepare('SELECT * FROM invoice_rejections WHERE payee_id=?').get(r.payeeId), isNew: false };
  }
  d.prepare(`INSERT INTO invoice_rejections
      (payee_id, invoice_id, record_no, po_number, site_code, business_unit, amount, status, reason, entry_date)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(r.payeeId, r.invoiceId || null, r.recordNo || null, r.poNumber || null, r.siteCode || null,
         r.businessUnit || null, r.amount || 0, r.status || 'Rejected', r.reason || null, r.entryDate || null);
  return { row: d.prepare('SELECT * FROM invoice_rejections WHERE payee_id=?').get(r.payeeId), isNew: true };
}

// Never blanks a value it could not read: a transient scrape failure must not
// erase a reason we already have.
function updateRejectionDetail(payeeId, f) {
  getDb().prepare(`UPDATE invoice_rejections SET
      reason=COALESCE(?, reason), rejected_by=COALESCE(?, rejected_by),
      amazon_contact=COALESCE(?, amazon_contact), description=COALESCE(?, description),
      detail_at=datetime('now') WHERE payee_id=?`)
    .run(f.reason || null, f.rejected_by || null, f.amazon_contact || null, f.description || null, payeeId);
}

function setRejectionRoute(payeeId, email) {
  getDb().prepare("UPDATE invoice_rejections SET routed_to=?, routed_at=datetime('now') WHERE payee_id=?").run(email || null, payeeId);
}
function markRejectionNotified(payeeId) {
  getDb().prepare('UPDATE invoice_rejections SET notified=1 WHERE payee_id=?').run(payeeId);
}
function resolveRejection(payeeId, { resolution, supersededBy, by }) {
  getDb().prepare("UPDATE invoice_rejections SET resolved_at=datetime('now'), resolution=?, superseded_by=COALESCE(?, superseded_by), acknowledged_by=COALESCE(acknowledged_by, ?) WHERE payee_id=?")
    .run(resolution || null, supersededBy || null, by || null, payeeId);
}
function acknowledgeRejection(payeeId, by) {
  getDb().prepare("UPDATE invoice_rejections SET acknowledged_by=?, acknowledged_at=datetime('now') WHERE payee_id=?").run(by, payeeId);
}
function listRejections({ includeResolved = false } = {}) {
  const sql = includeResolved
    ? 'SELECT * FROM invoice_rejections ORDER BY (resolved_at IS NOT NULL), first_seen DESC'
    : 'SELECT * FROM invoice_rejections WHERE resolved_at IS NULL ORDER BY first_seen DESC';
  try { return getDb().prepare(sql).all(); } catch (e) { return []; }
}
function rejectionSummary() {
  try {
    return getDb().prepare(`SELECT
        SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN resolved_at IS NULL THEN amount ELSE 0 END) AS openAmount,
        SUM(CASE WHEN resolved_at IS NULL AND acknowledged_at IS NULL THEN 1 ELSE 0 END) AS unacknowledged,
        COUNT(*) AS total
      FROM invoice_rejections`).get() || {};
  } catch (e) { return {}; }
}

// ─── Report jobs ────────────────────────────────────────────────────────────
function createReportJob({ userEmail, kind, label, params, totalCount, expiresDays }) {
  const d = getDb();
  const r = d.prepare(`INSERT INTO report_jobs (user_email, kind, label, params, total_count, expires_at)
    VALUES (?,?,?,?,?, datetime('now','+' || ? || ' days'))`)
    .run(userEmail, kind, label || null, JSON.stringify(params || {}), totalCount || 0, String(expiresDays || 7));
  return d.prepare('SELECT * FROM report_jobs WHERE id=?').get(r.lastInsertRowid);
}

function listReportJobs(userEmail, { all = false, limit = 100 } = {}) {
  const d = getDb();
  const rows = all
    ? d.prepare('SELECT * FROM report_jobs ORDER BY id DESC LIMIT ?').all(limit)
    : d.prepare('SELECT * FROM report_jobs WHERE user_email=? COLLATE NOCASE ORDER BY id DESC LIMIT ?').all(userEmail, limit);
  return rows.map(r => {
    let missing = [];
    try { missing = JSON.parse(r.missing || '[]'); } catch (e) { missing = []; }
    return { ...r, missing };
  });
}

function getReportJob(id) {
  return getDb().prepare('SELECT * FROM report_jobs WHERE id=?').get(id) || null;
}

// Claims the oldest queued job for the worker. Marking it running in the same
// statement that selects it is what stops two ticks grabbing the same job.
function claimNextReportJob() {
  const d = getDb();
  const row = d.prepare("SELECT * FROM report_jobs WHERE status='queued' ORDER BY id ASC LIMIT 1").get();
  if (!row) return null;
  const upd = d.prepare("UPDATE report_jobs SET status='running', started_at=datetime('now') WHERE id=? AND status='queued'").run(row.id);
  if (!upd.changes) return null;
  return d.prepare('SELECT * FROM report_jobs WHERE id=?').get(row.id);
}

function updateReportJob(id, f) {
  const d = getDb();
  const sets = [], vals = [];
  for (const k of ['status', 'label', 'done_count', 'total_count', 'missing', 'filename', 'file_path',
                   'size_bytes', 'content_type', 'error', 'downloaded_at', 'finished_at']) {
    if (f[k] !== undefined) { sets.push(k + '=?'); vals.push(f[k]); }
  }
  if (!sets.length) return getReportJob(id);
  vals.push(id);
  d.prepare('UPDATE report_jobs SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
  return getReportJob(id);
}

function deleteReportJob(id) { getDb().prepare('DELETE FROM report_jobs WHERE id=?').run(id); }

// Jobs past their keep-until date, plus anything left 'running' from before a
// restart — a process that died mid-job would otherwise block the queue for
// ever behind a job nobody is working on.
function expiredReportJobs() {
  return getDb().prepare("SELECT * FROM report_jobs WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')").all();
}
function resetStuckReportJobs() {
  return getDb().prepare("UPDATE report_jobs SET status='queued', started_at=NULL WHERE status='running'").run().changes;
}

function reportJobSummary(userEmail) {
  const d = getDb();
  const row = d.prepare(`SELECT
      SUM(CASE WHEN status='queued'  THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status='done' AND downloaded_at IS NULL THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
    FROM report_jobs WHERE user_email=? COLLATE NOCASE`).get(userEmail) || {};
  return { queued: row.queued || 0, running: row.running || 0, ready: row.ready || 0, failed: row.failed || 0 };
}

function getDunningHolds() {
  try {
    return db.prepare('SELECT customer_id, customer_name, dunning_hold_reason FROM customer_accounts WHERE dunning_hold=1').all();
  } catch (e) { return []; }
}
function getHouseAccountIds() {
  return new Set(getHouseAccounts().map(r => r.customer_id));
}


function getWatchlist(userEmail) {
  return db.prepare('SELECT * FROM watchlist WHERE user_email=? ORDER BY added_at DESC').all(userEmail);
}
function addToWatchlist(userEmail, recordNo, invoiceId, customerName) {
  try {
    db.prepare('INSERT OR IGNORE INTO watchlist (user_email, record_no, invoice_id, customer_name) VALUES (?,?,?,?)')
      .run(userEmail, recordNo, invoiceId || null, customerName || null);
    return true;
  } catch { return false; }
}
function removeFromWatchlist(userEmail, recordNo) {
  db.prepare('DELETE FROM watchlist WHERE user_email=? AND record_no=?').run(userEmail, recordNo);
}
function isWatched(userEmail, recordNo) {
  return !!db.prepare('SELECT 1 FROM watchlist WHERE user_email=? AND record_no=?').get(userEmail, recordNo);
}


// ─── Purchase Orders ───────────────────────────────────────────────────────

function getPurchaseOrders() {
  const db = getDb();
  return db.prepare('SELECT * FROM purchase_orders ORDER BY po_number ASC').all();
}

function getPurchaseOrder(poNumber) {
  const db = getDb();
  return db.prepare('SELECT * FROM purchase_orders WHERE po_number=?').get(poNumber) || null;
}

// Manually pin a PO to a site (wins over every automatic attribution source).
// Creates a minimal purchase_orders row if the PO isn't tracked yet.
function setPoSite(poNumber, siteCode, updatedBy) {
  const db = getDb();
  const existing = getPurchaseOrder(poNumber);
  if (!existing) {
    db.prepare(`INSERT INTO purchase_orders (po_number, site_code, updated_by) VALUES (?,?,?)`)
      .run(poNumber, siteCode ?? null, updatedBy ?? null);
  } else {
    db.prepare(`UPDATE purchase_orders SET site_code=?, updated_by=?, updated_at=datetime('now') WHERE po_number=?`)
      .run(siteCode ?? null, updatedBy ?? null, poNumber);
  }
  return getPurchaseOrder(poNumber);
}

// Manually pin a PO's service type (wins over doc-description classification).
// Used to resolve POs flagged for manual review because their document text
// carries no service keyword. null clears the override (back to auto-classify).
function setPoService(poNumber, serviceType, updatedBy) {
  const db = getDb();
  const existing = getPurchaseOrder(poNumber);
  if (!existing) {
    db.prepare(`INSERT INTO purchase_orders (po_number, service_type, updated_by) VALUES (?,?,?)`)
      .run(poNumber, serviceType ?? null, updatedBy ?? null);
  } else {
    db.prepare(`UPDATE purchase_orders SET service_type=?, updated_by=?, updated_at=datetime('now') WHERE po_number=?`)
      .run(serviceType ?? null, updatedBy ?? null, poNumber);
  }
  return getPurchaseOrder(poNumber);
}

function upsertPo(poNumber, fields, updatedBy) {
  const db = getDb();
  const existing = getPurchaseOrder(poNumber);
  if (!existing) {
    db.prepare(`
      INSERT INTO purchase_orders (po_number, location_id, customer_id, ceiling_amount, stated_amount, ceiling_source, status, notes, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      poNumber,
      fields.location_id ?? null,
      fields.customer_id ?? 'C-00403',
      fields.ceiling_amount ?? null,
      fields.ceiling_amount ?? null, // stated_amount mirrors ceiling_amount on first entry — it's the "original" value
      fields.ceiling_source ?? (fields.ceiling_amount != null ? 'manual' : null),
      fields.status ?? 'active',
      fields.notes ?? null,
      updatedBy ?? null
    );
    if (fields.ceiling_amount != null) {
      addPoSourceDocument(poNumber, fields.ceiling_source || 'manual', null, fields.ceiling_amount);
    }
  } else {
    const sets = [];
    const vals = [];
    if (fields.location_id !== undefined)    { sets.push('location_id=?');    vals.push(fields.location_id); }
    if (fields.customer_id !== undefined)    { sets.push('customer_id=?');    vals.push(fields.customer_id); }
    if (fields.ceiling_amount !== undefined) {
      sets.push('ceiling_amount=?'); vals.push(fields.ceiling_amount);
      if (existing.stated_amount == null && fields.ceiling_amount != null) {
        // First real ceiling ever recorded for this PO — that's the stated/original value.
        sets.push('stated_amount=?'); vals.push(fields.ceiling_amount);
      } else if (existing.ceiling_amount != null && fields.ceiling_amount != null && existing.ceiling_amount !== fields.ceiling_amount) {
        // Existing ceiling changing to a different value — a genuine revision. stated_amount
        // is left untouched so the original value is preserved; log the revision for history.
        addPoSourceDocument(poNumber, 'revision', null, fields.ceiling_amount);
      }
    }
    if (fields.ceiling_source !== undefined) { sets.push('ceiling_source=?'); vals.push(fields.ceiling_source); }
    if (fields.status !== undefined)         { sets.push('status=?');        vals.push(fields.status); }
    if (fields.notes !== undefined)          { sets.push('notes=?');         vals.push(fields.notes); }
    sets.push("updated_at=datetime('now')");
    sets.push('updated_by=?'); vals.push(updatedBy ?? null);
    vals.push(poNumber);
    db.prepare(`UPDATE purchase_orders SET ${sets.join(',')} WHERE po_number=?`).run(...vals);
  }
  return getPurchaseOrder(poNumber);
}

function deletePo(poNumber) {
  const db = getDb();
  db.prepare('DELETE FROM purchase_orders WHERE po_number=?').run(poNumber);
}

// ─── PO Source Documents ───────────────────────────────────────────────────

function addPoSourceDocument(poNumber, source, fileRef, extractedAmount) {
  const db = getDb();
  db.prepare(`
    INSERT INTO po_source_documents (po_number, source, file_ref, extracted_amount)
    VALUES (?,?,?,?)
  `).run(poNumber, source, fileRef ?? null, extractedAmount ?? null);
}

function getPoSourceDocuments(poNumber) {
  const db = getDb();
  return db.prepare('SELECT * FROM po_source_documents WHERE po_number=? ORDER BY extracted_at DESC').all(poNumber);
}

// ─── Regions ────────────────────────────────────────────────────────────────

function getRegions() {
  const db = getDb();
  return db.prepare('SELECT * FROM regions ORDER BY region_name ASC').all()
    .map(r => ({ ...r, location_ids: JSON.parse(r.location_ids || '[]') }));
}

function getRegion(regionCode) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM regions WHERE region_code=?').get(regionCode);
  return row ? { ...row, location_ids: JSON.parse(row.location_ids || '[]') } : null;
}

function upsertRegion(regionCode, regionName, locationIds, updatedBy) {
  const db = getDb();
  const existing = getRegion(regionCode);
  const locsJson = JSON.stringify(locationIds || []);
  if (!existing) {
    db.prepare(`
      INSERT INTO regions (region_code, region_name, location_ids, updated_by)
      VALUES (?,?,?,?)
    `).run(regionCode, regionName, locsJson, updatedBy ?? null);
  } else {
    db.prepare(`
      UPDATE regions SET region_name=?, location_ids=?, updated_at=datetime('now'), updated_by=?
      WHERE region_code=?
    `).run(regionName ?? existing.region_name, locsJson, updatedBy ?? null, regionCode);
  }
  return getRegion(regionCode);
}

function deleteRegion(regionCode) {
  const db = getDb();
  db.prepare('DELETE FROM regions WHERE region_code=?').run(regionCode);
}

// ─── Invoice PO Assignments (manual reroute before upload) ────────────────

function getAllPoAssignments() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM invoice_po_assignments').all();
  const map = {};
  for (const r of rows) map[r.record_no] = r;
  return map;
}

function setInvoicePoAssignment(recordNo, invoiceId, originalPo, assignedPo, note, assignedBy) {
  const db = getDb();
  db.prepare(`
    INSERT INTO invoice_po_assignments (record_no, invoice_id, original_po, assigned_po, note, assigned_by, assigned_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(record_no) DO UPDATE SET
      assigned_po=excluded.assigned_po, note=excluded.note, assigned_by=excluded.assigned_by, assigned_at=datetime('now')
  `).run(recordNo, invoiceId, originalPo, assignedPo, note ?? null, assignedBy ?? null);
}

function clearInvoicePoAssignment(recordNo) {
  const db = getDb();
  db.prepare('DELETE FROM invoice_po_assignments WHERE record_no=?').run(recordNo);
}

// ─── Invoice-level site overrides ────────────────────────────────────────
// For multi-site blanket POs (e.g. 2D-20105615: ship-to is Amazon's Nashville
// HQ "BNA12", line items serve DBL1/DJR5/DPP1/DYY8) the PO-site fallback labels
// the invoice with a non-site. This pins the true service site per invoice; it
// wins over both the Sage ship-to and the PO fallback.

function getAllInvoiceSiteOverrides() {
  const db = getDb();
  const map = {};
  for (const r of db.prepare('SELECT * FROM invoice_site_overrides').all()) map[r.record_no] = r;
  return map;
}

function setInvoiceSite(recordNo, invoiceId, siteCode, setBy) {
  const db = getDb();
  if (!siteCode) {
    db.prepare('DELETE FROM invoice_site_overrides WHERE record_no=?').run(recordNo);
    return;
  }
  db.prepare(`
    INSERT INTO invoice_site_overrides (record_no, invoice_id, site_code, set_by, set_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(record_no) DO UPDATE SET
      site_code=excluded.site_code, set_by=excluded.set_by, set_at=datetime('now')
  `).run(recordNo, invoiceId ?? null, siteCode, setBy ?? null);
}

// ─── Invoice-level collector ownership ───────────────────────────────────

function getAllInvoiceCollectors() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM invoice_collector').all();
  const map = {};
  for (const r of rows) map[r.record_no] = r;
  return map;
}

function setInvoiceCollector(recordNo, invoiceId, collectorEmail, assignedBy) {
  const db = getDb();
  db.prepare(`
    INSERT INTO invoice_collector (record_no, invoice_id, collector_email, assigned_by, assigned_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(record_no) DO UPDATE SET
      collector_email=excluded.collector_email, assigned_by=excluded.assigned_by, assigned_at=datetime('now')
  `).run(recordNo, invoiceId ?? null, collectorEmail, assignedBy ?? null);
}

function clearInvoiceCollector(recordNo) {
  const db = getDb();
  db.prepare('DELETE FROM invoice_collector WHERE record_no=?').run(recordNo);
}

// ─── Invoice-level stop-service ──────────────────────────────────────────

function getAllInvoiceStopService() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM invoice_stop_service').all();
  const map = {};
  for (const r of rows) map[r.record_no] = r;
  return map;
}

function setInvoiceStopService(recordNo, invoiceId, effectiveDate, note, issuedBy) {
  const db = getDb();
  db.prepare(`
    INSERT INTO invoice_stop_service (record_no, invoice_id, effective_date, note, issued_by, issued_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(record_no) DO UPDATE SET
      effective_date=excluded.effective_date, note=excluded.note, issued_by=excluded.issued_by, issued_at=datetime('now')
  `).run(recordNo, invoiceId ?? null, effectiveDate ?? null, note ?? null, issuedBy ?? null);
}

function clearInvoiceStopService(recordNo) {
  const db = getDb();
  db.prepare('DELETE FROM invoice_stop_service WHERE record_no=?').run(recordNo);
}

// ─── Ops health + alert throttle ─────────────────────────────────────────

function setHealth(checkKey, status, detail, metric) {
  const db = getDb();
  db.prepare(`
    INSERT INTO ops_health (check_key, status, detail, metric, updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(check_key) DO UPDATE SET
      status=excluded.status, detail=excluded.detail, metric=excluded.metric, updated_at=datetime('now')
  `).run(checkKey, status, detail ?? null, metric ?? null);
}

function getHealth() {
  return getDb().prepare('SELECT * FROM ops_health ORDER BY check_key').all();
}

// True (and records the send) if this alert key hasn't fired within the window.
function shouldAlert(alertKey, minIntervalHours = 6) {
  const db = getDb();
  const row = db.prepare('SELECT last_sent_at FROM ops_alert_log WHERE alert_key=?').get(alertKey);
  if (row) {
    const ok = db.prepare(`SELECT datetime(?, '+' || ? || ' hours') <= datetime('now') AS due`).get(row.last_sent_at, String(minIntervalHours));
    if (!ok || !ok.due) return false;
  }
  db.prepare(`INSERT INTO ops_alert_log (alert_key, last_sent_at) VALUES (?, datetime('now'))
              ON CONFLICT(alert_key) DO UPDATE SET last_sent_at=datetime('now')`).run(alertKey);
  return true;
}

function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}
function get(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}

module.exports = {
  getDb,
  getNoteCounts,
  updateUserPhoto,
  updateUserJobTitle,
  updateUserPhone,
  setUserPermissions,
  ensureAssignmentRuleColumns,
  listAssignmentRules,
  upsertAssignmentRule,
  deleteAssignmentRule,
  getCommState,
  setCommState,
  listCustomerContacts,
  getCustomerContact,
  addCustomerContact,
  updateCustomerContact,
  setContactPrimary,
  syncCustomerContactsFromSage,
  getUserRoleAnyCase,
  getTemplateByKey,
  listTemplates,
  saveTemplateVersion,
  listTemplateVersions,
  createConversation,
  setConversationSubject,
  getConversation,
  getConversationByGraphId,
  listConversations,
  touchConversation,
  insertMessage,
  getMessage,
  getMessageByGraphId,
  getMessageByInternetMessageId,
  getMessagesForConversation,
  tagMessageInvoices,
  getMessagesForInvoice,
  listDunningRules,
  upsertDunningRule,
  deleteDunningRule,
  listStatementSchedules,
  getStatementSchedule,
  upsertStatementSchedule,
  setStatementSent,
  insertVelocityTransmit,
  getVelocityTransmitMap,
  listVelocityTransmits,
  confirmVelocityTransmits,
  countUnconfirmedVelocity,
  getAllCollectionStatuses,
  setCollectionStatus,
  listCustomerAttachments,
  getCustomerAttachment,
  addCustomerAttachment,
  softDeleteCustomerAttachment,
  createDunningRun,
  finishDunningRun,
  getDunningRun,
  listDunningRuns,
  insertDunningAction,
  listDunningActions,
  updateDunningAction,
  dunningSentExists,
  recordDunningSent,
  preProvisionUser,
  ensureInviteColumns,
  markInvited,
  listUninvitedUsers,
  getUserRole,
  upsertUserRole,
  provisionNewUser,
  listUsers,
  getNotifyPrefs,
  updateNotifyPrefs,
  updateUserRole,
  getNotes,
  addNote,
  addNoteWithMentions,
  getMentionsForUser,
  markMentionSeen,
  markMentionConfirmed,
  getUnconfirmedMentionCount,
  getUnseenMentionCount,
  addReaction,
  removeReaction,
  getReactionsForNote,
  getReactionsForNotes,
  getPtpForRecord,
  getAllOpenPtp,
  addPtp,
  updatePtpStatus,
  auditLog,
  getAuditLog,
  getLocation,
  setLocation,
  setShipToExemption,
  deleteShipToExemption,
  getShipToExemptions,
  setBlockedSiteCode,
  deleteBlockedSiteCode,
  getBlockedSiteCodes,
  getOrgRoles,
  upsertOrgRole,
  seedOrgRoles,
  ensureOrgColumns,
  setOrgAssignment,
  getOrgUser,
  getOrgUsers,
  getSubordinates,
  getVisibleEmails,
  setScDepartments,
  getScDepartments,
  setSiteCollector,
  getSiteCollector,
  getAllSiteCollectors,
  createAccrual,
  getAccrual,
  updateAccrual,
  getAccruals,
  ACCRUAL_STATUSES,
  setSiteAlias,
  deleteSiteAlias,
  getSiteAliasMap,
  replaceAmazonLocations,
  mergeAmazonLocations,
  ensureAmazonLocationColumns,
  getAmazonLocationMap,
  getBusinessUnits,
  setDepartment,
  getDepartment,
  getAllDepartments,
  getMissingDepartmentRecordNos,
  getMissingLocationRecordNos,
  getLocationMap,
  setLocationMapEntries,
  locationMapSize,
  getCustomerAccount,
  upsertCustomerAccount,
  getAllCustomerAccounts,
  getHouseAccounts,
  getHouseAccountIds,
  getDunningHolds,
  upsertPoContact,
  getPoContact,
  getPoContactMap,
  learnSiteAmazonContact,
  setSiteContact,
  getSiteContact,
  getSiteContactMap,
  upsertRejection,
  updateRejectionDetail,
  setRejectionRoute,
  markRejectionNotified,
  resolveRejection,
  acknowledgeRejection,
  listRejections,
  rejectionSummary,
  createReportJob,
  listReportJobs,
  getReportJob,
  claimNextReportJob,
  updateReportJob,
  deleteReportJob,
  expiredReportJobs,
  resetStuckReportJobs,
  reportJobSummary,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  isWatched,
  getPurchaseOrders,
  getPurchaseOrder,
  setPoSite,
  setPoService,
  upsertPo,
  deletePo,
  addPoSourceDocument,
  getPoSourceDocuments,
  getRegions,
  getRegion,
  upsertRegion,
  deleteRegion,
  getAllPoAssignments,
  setInvoicePoAssignment,
  clearInvoicePoAssignment,
  getAllInvoiceSiteOverrides,
  setInvoiceSite,
  getAllInvoiceCollectors,
  setInvoiceCollector,
  clearInvoiceCollector,
  getAllInvoiceStopService,
  setInvoiceStopService,
  clearInvoiceStopService,
  setHealth,
  getHealth,
  shouldAlert,
  all,
  get,
};
