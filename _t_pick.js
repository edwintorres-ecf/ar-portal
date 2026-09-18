// Prove the new rule on the real file list, without re-downloading anything.
const fs = require('fs');
const docs = JSON.parse(fs.readFileSync('po-docs.json', 'utf8'));

const oldPick = files => { let best = null, bv = 0;
  for (const f of files) { const v = f.version || 0;
    if (v > bv || (v === bv && (!best || (f.docDate || '') >= (best.docDate || '')))) { bv = v; best = f; } }
  return best; };
const newPick = files => { let best = null;
  for (const f of files) {
    const better = !best || (f.docDate || '') > (best.docDate || '')
      || ((f.docDate || '') === (best.docDate || '') && (f.version || 0) > (best.version || 0));
    if (better) best = f; }
  return best; };

let changed = [];
for (const [po, rec] of Object.entries(docs.byPo || {})) {
  if (!rec.files || rec.files.length < 2) continue;
  const o = oldPick(rec.files), n = newPick(rec.files);
  if (o && n && o.name !== n.name) changed.push({ po, from: o, to: n, amt: rec.docAmount });
}
changed.sort((a, b) => String(b.to.docDate).localeCompare(String(a.to.docDate)));
console.log(`POs with >1 document      : ${Object.values(docs.byPo).filter(r => (r.files || []).length > 1).length}`);
console.log(`POs whose file CHANGES    : ${changed.length}`);
console.log(`  …to a genuinely LATER doc: ${changed.filter(c => c.to.docDate > c.from.docDate).length}`);
console.log(`  …same date, higher v     : ${changed.filter(c => c.to.docDate === c.from.docDate).length}`);
console.log(`  …to an EARLIER doc (bad) : ${changed.filter(c => c.to.docDate < c.from.docDate).length}\n`);
for (const c of changed.slice(0, 12)) {
  console.log(`${c.po.padEnd(15)} ${c.from.name} (${c.from.docDate}) -> ${c.to.name} (${c.to.docDate})`);
}
if (changed.length > 12) console.log(`… and ${changed.length - 12} more`);
