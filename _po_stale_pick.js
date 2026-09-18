// How many POs is the portal reading an OUT-OF-DATE document for?
//
// po-doc-watcher picks `latestFile` by the "v" number in the FILENAME. Amazon's
// naming is not a monotonic revision counter: 2D-20300544 has a v1 dated
// 2026-05-08 that is newer than the v2 dated 2026-02-06, and the v1 file's own
// internal version is 3. Anywhere that happens we are reading an old value.
'use strict';
const fs = require('fs');

const docs = JSON.parse(fs.readFileSync('po-docs.json', 'utf8'));
const newer = [];

for (const [po, rec] of Object.entries(docs.byPo || {})) {
  if (!rec.files || rec.files.length < 2 || !rec.latestFile) continue;
  const used = rec.latestFile;
  const key = f => `${f.docDate || ''}|${f.modified || ''}`;
  // The newest document we hold, by the date in its name, then by modified.
  const newest = rec.files.slice().sort((a, b) => key(b).localeCompare(key(a)))[0];
  if (newest.name !== used.name) {
    newer.push({
      po,
      using: used.name, usingDate: used.docDate, usingAmount: rec.docAmount,
      newest: newest.name, newestDate: newest.docDate,
      discrepancy: !!rec.discrepancyFlag,
    });
  }
}

newer.sort((a, b) => String(b.newestDate).localeCompare(String(a.newestDate)));
console.log(`POs with more than one document : ${Object.values(docs.byPo).filter(r => (r.files || []).length > 1).length}`);
console.log(`POs reading a STALE document    : ${newer.length}\n`);
for (const n of newer.slice(0, 40)) {
  console.log(`${n.po.padEnd(15)} using ${String(n.usingDate).padEnd(11)} $${String(n.usingAmount ?? '?').padEnd(11)}`
    + ` but newest is ${n.newestDate}   ${n.newest}`);
}
if (newer.length > 40) console.log(`… and ${newer.length - 40} more`);
fs.writeFileSync('/tmp/stale-po-docs.json', JSON.stringify(newer, null, 1));
console.log('\nfull list -> /tmp/stale-po-docs.json');
