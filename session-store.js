'use strict';
/**
 * session-store.js — Custom express-session store using Node.js built-in node:sqlite
 * Drop-in replacement for connect-sqlite3
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { Store } = require('express-session');

class SqliteStore extends Store {
  constructor(options = {}) {
    super();
    const dbPath = options.db ? path.join(options.dir || __dirname, options.db) : path.join(__dirname, 'sessions.db');
    this.ttl = options.ttl || 86400; // default 1 day in seconds
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
    `);
    // Clean expired sessions every 10 minutes
    setInterval(() => this._cleanExpired(), 10 * 60 * 1000).unref();
  }

  _cleanExpired() {
    try {
      const now = Math.floor(Date.now() / 1000);
      this.db.prepare('DELETE FROM sessions WHERE expired < ?').run(now);
    } catch (e) {
      // ignore
    }
  }

  get(sid, cb) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const row = this.db.prepare('SELECT sess FROM sessions WHERE sid=? AND expired > ?').get(sid, now);
      if (!row) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) ? Math.floor(sess.cookie.maxAge / 1000) : this.ttl;
      const expired = Math.floor(Date.now() / 1000) + maxAge;
      const json = JSON.stringify(sess);
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?,?,?)').run(sid, json, expired);
      if (cb) cb(null);
    } catch (e) {
      if (cb) cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
      if (cb) cb(null);
    } catch (e) {
      if (cb) cb(e);
    }
  }

  touch(sid, sess, cb) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) ? Math.floor(sess.cookie.maxAge / 1000) : this.ttl;
      const expired = Math.floor(Date.now() / 1000) + maxAge;
      this.db.prepare('UPDATE sessions SET expired=? WHERE sid=?').run(expired, sid);
      if (cb) cb(null);
    } catch (e) {
      if (cb) cb(e);
    }
  }
}

module.exports = SqliteStore;
