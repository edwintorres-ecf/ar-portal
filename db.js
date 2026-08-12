'use strict';
/**
 * db.js — SQLite database init and helpers for ECF AR Portal
 * Uses Node.js built-in node:sqlite (Node 22+)
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ar-portal.db');
let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    // WAL mode for better concurrency
    db.exec('PRAGMA journal_mode = WAL');
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

  // Manual site assignment for POs whose documents/invoices don't reveal one
  try { db.exec("ALTER TABLE purchase_orders ADD COLUMN site_code TEXT DEFAULT NULL"); } catch(e) {}

  // Manual service-type override for POs the doc description can't classify
  // (e.g. a PO doc that's just an address) — wins over classifyService().
  try { db.exec("ALTER TABLE purchase_orders ADD COLUMN service_type TEXT DEFAULT NULL"); } catch(e) {}

  // Add mentions column if missing (idempotent)
  try { db.exec("ALTER TABLE notes ADD COLUMN mentions TEXT DEFAULT NULL"); } catch(e) { /* already exists */ }
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

function getUserRole(email) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM user_roles WHERE email = ?');
  return stmt.get(email) || null;
}

function upsertUserRole(email, name, role, locationFilter, customerFilter) {
  const db = getDb();
  const existing = getUserRole(email);
  if (existing) {
    db.prepare(`
      UPDATE user_roles SET name=?, role=?, location_filter=?, customer_filter=?, updated_at=datetime('now')
      WHERE email=?
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

function addNote(recordNo, userEmail, userName, body, type = 'note', mentions) {
  if (mentions && Array.isArray(mentions) && mentions.length > 0) {
    return addNoteWithMentions(recordNo, userEmail, userName, body, type, mentions);
  }
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO notes (record_no, user_email, user_name, type, body) VALUES (?,?,?,?,?)
  `).run(recordNo, userEmail, userName, type, body);
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

function getMissingLocationRecordNos(recordNos) {
  // Returns those not yet in the cache
  const d = getDb();
  const stmt = d.prepare('SELECT record_no FROM invoice_location WHERE record_no=?');
  return recordNos.filter(rn => !stmt.get(rn));
}

// ─── Notes with Mentions ───────────────────────────────────────────────────

function addNoteWithMentions(recordNo, userEmail, userName, body, type, mentions) {
  const d = getDb();
  const mentionList = Array.isArray(mentions) ? mentions : [];
  const mentionsJson = mentionList.length ? JSON.stringify(mentionList) : null;

  const result = d.prepare(`
    INSERT INTO notes (record_no, user_email, user_name, type, body, mentions) VALUES (?,?,?,?,?,?)
  `).run(recordNo, userEmail, userName, type || 'note', body, mentionsJson);

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
    SELECT nm.id as mention_id, nm.note_id, nm.mentioned_email, nm.seen, nm.created_at as mention_created_at,
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
    INSERT INTO customer_contacts (customer_id, name, email, phone, title, source, is_primary, consent_email, dunning_enabled, notes, created_by, updated_by)
    VALUES (?,?,?,?,?,'manual',?,?,?,?,?,?)
  `).run(customerId, fields.name || null, email, fields.phone || null, fields.title || null,
    fields.is_primary ? 1 : 0, fields.consent_email === 0 ? 0 : 1, fields.dunning_enabled ? 1 : 0,
    fields.notes || null, createdBy || null, createdBy || null);
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

function preProvisionUser(email, name, role, jobTitle) {
  const d = getDb();
  d.prepare(`
    INSERT OR IGNORE INTO user_roles (email, name, role, job_title)
    VALUES (?, ?, ?, ?)
  `).run(email, name || '', role || 'viewer', jobTitle || null);
  return d.prepare('SELECT * FROM user_roles WHERE email=?').get(email);
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
      INSERT INTO customer_accounts (customer_id, customer_name, stop_service, owner_name, owner_email, notes, updated_by)
      VALUES (?,?,?,?,?,?,?)
    `).run(customerId, customerName,
      fields.stop_service ?? 0,
      fields.owner_name ?? null,
      fields.owner_email ?? null,
      fields.notes ?? null,
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
  getMissingLocationRecordNos,
  getLocationMap,
  setLocationMapEntries,
  locationMapSize,
  getCustomerAccount,
  upsertCustomerAccount,
  getAllCustomerAccounts,
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
