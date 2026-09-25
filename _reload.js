const award = require('./amazon-award');
const rows = JSON.parse(require('fs').readFileSync('/tmp/award-xlsx.json', 'utf8'));
const n = award.load(rows, { season: '2026-27',
  source: 'Awarded_Sites_RFP_Results.xlsx (Amazon, received 2026-09-24)' });
const $ = v => '$' + Math.round(v || 0).toLocaleString('en-US');
console.log(`loaded ${n} award records from the spreadsheet`);
const list = award.list('2026-27');
console.log('total awarded :', $(list.reduce((t, a) => t + (a.amount || 0), 0)));
console.log('total we bid  :', $(list.reduce((t, a) => t + (a.bidPrice || 0), 0)));
console.log('paired rows   :', list.filter(a => a.covers.length).map(a => `${a.siteCode}+${a.covers.join('+')}`).join(', '));
console.log('sites covered :', list.reduce((t, a) => t + 1 + a.covers.length, 0));
const inc = {};
for (const a of list) inc[a.incumbency || '(blank)'] = (inc[a.incumbency || '(blank)'] || 0) + 1;
console.log('incumbency    :', JSON.stringify(inc));
console.log('flagged new   :', list.filter(a => a.isNew).length);
