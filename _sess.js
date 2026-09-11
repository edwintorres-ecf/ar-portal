// Mint a short-lived session cookie so endpoints can be exercised the way the
// browser does. Diagnostic only — the row is removed by _sessdel.js.
const path = require('path');
const sqlite = require('node:sqlite');
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const signature = require('/home/ecf-admin/ar-portal/node_modules/cookie-signature');
const db = require('/home/ecf-admin/ar-portal/db');
db.getDb();

const email = process.argv[2] || 'edwin.torres@eastcoastfacilities.com';
const role = db.getUserRole(email);
if (!role) { console.error('no user_roles row for ' + email); process.exit(1); }

const sid = 'diag-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
const sess = JSON.stringify({
  cookie: { originalMaxAge: 600000, expires, httpOnly: true, path: '/', secure: true, sameSite: 'none' },
  user: { email, name: role.name || 'Diag', role: role.role, location_filter: role.location_filter || null,
          org_role: role.org_role || null, customer_filter: role.customer_filter || null },
});

const s = new sqlite.DatabaseSync(path.join('/home/ecf-admin/ar-portal', 'sessions.db'));
s.exec('CREATE TABLE IF NOT EXISTS sessions (sid PRIMARY KEY, expired, sess)');
s.prepare('INSERT OR REPLACE INTO sessions (sid, expired, sess) VALUES (?,?,?)')
  .run(sid, Date.now() + 600000, sess);
s.close();

const secret = process.env.SESSION_SECRET || 'ecf-ar-portal-secret-change-me';
console.log('connect.sid=s%3A' + encodeURIComponent(signature.sign(sid, secret)).replace(/%2[Ff]/g, '%2F'));
console.log('SID=' + sid);
