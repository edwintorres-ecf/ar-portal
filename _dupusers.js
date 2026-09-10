// Find and (with --apply) merge user_roles rows that are the same address in
// different capitalisation. SQLite compares TEXT case-sensitively, so
// "Justin.Gamez@" and "justin.gamez@" became two people.
const db = require('/home/ecf-admin/ar-portal/db');
const d = db.getDb();
const APPLY = process.argv.includes('--apply');

const rows = d.prepare('SELECT * FROM user_roles').all();
const groups = {};
for (const r of rows) (groups[String(r.email).toLowerCase()] = groups[String(r.email).toLowerCase()] || []).push(r);
const dupes = Object.entries(groups).filter(([, list]) => list.length > 1);

// Every place an email is stored as a reference, so a merge does not orphan one.
const REFS = [
  ['user_roles', 'reports_to'],
  ['invoice_collector', 'collector_email'],
  ['customer_accounts', 'collector_email'],
  ['site_collectors', 'email'],
  ['assignment_rules', 'collector_email'],
  ['invoice_rejections', 'routed_to'],
  ['site_contacts', 'internal_email'],
  ['report_jobs', 'user_email'],
];

function tableHasColumn(table, col) {
  try { return d.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col); }
  catch (e) { return false; }
}

console.log(APPLY ? '=== MERGING ===' : '=== DRY RUN (pass --apply to write) ===');
console.log('duplicate addresses:', dupes.length);

for (const [lower, list] of dupes) {
  // Keeper = whichever row other rows already point at; else the oldest.
  const referenced = new Set();
  for (const [t, c] of REFS) {
    if (!tableHasColumn(t, c)) continue;
    for (const r of d.prepare(`SELECT DISTINCT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL`).all()) {
      if (r.v) referenced.add(String(r.v));
    }
  }
  const sorted = [...list].sort((a, b) => {
    const ra = referenced.has(a.email) ? 0 : 1, rb = referenced.has(b.email) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });
  const keep = sorted[0], drop = sorted.slice(1);

  console.log(`\n${lower}`);
  console.log(`  KEEP  id=${keep.id} "${keep.name}" ${keep.email} role=${keep.role} org=${keep.org_role || '-'}${referenced.has(keep.email) ? '  (already referenced elsewhere)' : ''}`);

  // Fill anything blank on the keeper from the row being dropped, so no data is
  // lost by picking one over the other.
  const FILLABLE = ['name', 'job_title', 'phone', 'photo_data_url', 'location_filter', 'customer_filter',
                    'permissions', 'org_role', 'reports_to', 'invited_at', 'invited_by'];
  const ROLE_RANK = { viewer: 0, ar_specialist: 1, manager: 2, admin: 3 };
  const fills = {};
  for (const dr of drop) {
    console.log(`  DROP  id=${dr.id} "${dr.name}" ${dr.email} role=${dr.role} org=${dr.org_role || '-'}`);
    for (const f of FILLABLE) {
      const cur = fills[f] !== undefined ? fills[f] : keep[f];
      if ((cur === null || cur === undefined || cur === '') && dr[f] !== null && dr[f] !== undefined && dr[f] !== '') {
        fills[f] = dr[f];
      }
    }
    // An accented spelling is the deliberate one; plain ASCII is the typo.
    if (dr.name && /[^\x00-\x7F]/.test(dr.name) && !/[^\x00-\x7F]/.test(keep.name || '')) fills.name = dr.name;
    // Never silently DOWNGRADE access, and never silently upgrade it either:
    // take the higher of the two and say so.
    if ((ROLE_RANK[dr.role] ?? -1) > (ROLE_RANK[fills.role ?? keep.role] ?? -1)) fills.role = dr.role;
  }
  if (Object.keys(fills).length) {
    console.log('  fills:', Object.entries(fills).map(([k, v]) =>
      `${k}=${k === 'photo_data_url' ? '(photo ' + String(v).length + ' bytes)' : JSON.stringify(String(v).slice(0, 40))}`).join(', '));
  }

  // Anything pointing at a dropped address has to be repointed.
  for (const dr of drop) {
    for (const [t, c] of REFS) {
      if (!tableHasColumn(t, c)) continue;
      const n = d.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c}=?`).get(dr.email).n;
      if (n) {
        console.log(`  repoint ${t}.${c}: ${n} row(s) ${dr.email} -> ${keep.email}`);
        if (APPLY) d.prepare(`UPDATE ${t} SET ${c}=? WHERE ${c}=?`).run(keep.email, dr.email);
      }
    }
  }

  if (APPLY) {
    if (Object.keys(fills).length) {
      const sets = Object.keys(fills).map(k => k + '=?');
      d.prepare(`UPDATE user_roles SET ${sets.join(',')} WHERE id=?`).run(...Object.values(fills), keep.id);
    }
    for (const dr of drop) d.prepare('DELETE FROM user_roles WHERE id=?').run(dr.id);
    db.auditLog('system', 'user_merge_duplicate', keep.email,
      `merged ${drop.map(x => x.email + ' (id ' + x.id + ')').join(', ')} into ${keep.email}`);
  }
}

if (APPLY) {
  // Stop it happening again: one row per address, whatever the capitalisation.
  try {
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_email_nocase ON user_roles(email COLLATE NOCASE)');
    console.log('\ncase-insensitive unique index on user_roles(email): created');
  } catch (e) {
    console.log('\ncould not create the unique index:', e.message);
  }
  console.log('users now:', d.prepare('SELECT COUNT(*) n FROM user_roles').get().n);
}
