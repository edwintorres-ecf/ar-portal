const db = require('/home/ecf-admin/ar-portal/db'); db.getDb();
const sage = require('/home/ecf-admin/ar-portal/sage');
const fr = require('/home/ecf-admin/ar-portal/amazon-funds-report');
const fs = require('fs');
const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const OUT = '/tmp/ecf-decks'; fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const invs = sage.getCachedInvoices();
const write = (a, name) => new Promise((res, rej) => {
  const doc = fr.buildDeck(a); const f = `${OUT}/${name}`;
  const o = fs.createWriteStream(f); doc.pipe(o);
  o.on('finish', () => res()); o.on('error', rej);
});
(async () => {
  const combined = fr.analyse(invs, { snowOnly: true });
  const U = combined.unblock;
  console.log('COMBINED — snow work we cannot bill: ' + M(U.total) + ' · ' + U.count + ' invoices');
  for (const [k, l] of [['release', '1 lift the hold'], ['sameSite', '2 same site, other PO'], ['sameBu', '3 same BU, other site'], ['newMoney', '4 new money']]) {
    console.log('   ' + l.padEnd(26) + M(U[k].amount).padStart(13) + String(U[k].count).padStart(5) + ' inv  ' + (U.total ? Math.round(U[k].amount / U.total * 100) : 0) + '%');
  }
  console.log('   release sites:', U.releaseSites.map(x => `${x.site} ${M(x.amount)} on ${x.po} (PO has ${M(x.poAvailable)})`).join(' · ') || 'none');
  await write(combined, `ecf-amazon-case-study-snow-${stamp}.pdf`);

  console.log('\nBU'.padEnd(14) + 'release'.padStart(11) + 'same site'.padStart(12) + 'same BU'.padStart(13) + 'new money'.padStart(13));
  for (const b of combined.buList) {
    const a = fr.analyse(invs, { snowOnly: true, bu: b.bu });
    if (!a.sites.length) continue;
    const u = a.unblock;
    await write(a, `ecf-amazon-case-study-${String(b.bu).replace(/[^A-Za-z0-9]+/g, '-')}-snow-${stamp}.pdf`);
    console.log(String(b.bu).padEnd(14) + M(u.release.amount).padStart(11) + M(u.sameSite.amount).padStart(12) + M(u.sameBu.amount).padStart(13) + M(u.newMoney.amount).padStart(13));
  }
  console.log('\nfiles:', fs.readdirSync(OUT).length);
})().catch(e => { console.error('FAILED', e.message, (e.stack || '').split('\n')[1]); process.exit(1); });
