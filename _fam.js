const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const fam = require('/home/ecf-admin/ar-portal/customer-family');
(async () => {
  const t = Date.now();
  const r = await fam.refresh();
  console.log(`refreshed ${r.count} customers (${r.parents} with a parent) in ${Date.now() - t}ms`);
  for (const id of ['C-00403', 'C-00002', 'C-00147']) {
    const f = fam.family(id);
    console.log(`\n${id} ${f.self ? f.self.name : '(unknown)'}`);
    console.log('   parent  :', f.parent ? `${f.parent.customer_id} ${f.parent.name}` : '—');
    console.log('   children:', f.children.length, f.children.slice(0, 3).map(c => c.customer_id).join(' '));
    console.log('   siblings:', f.siblings.length, f.siblings.slice(0, 4).map(c => c.customer_id).join(' '));
    console.log('   family  :', f.all.length, 'records');
    const cs = fam.familyContacts(id);
    console.log('   contacts:', cs.length, cs.slice(0, 4).map(c => `${c.email}(${c.relationship})`).join(' · '));
  }
})().catch(e => console.log('ERR', e.message));
