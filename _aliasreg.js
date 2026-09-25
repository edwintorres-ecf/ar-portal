const sage = require('./sage');
const sa = require('./site-alias');
const ok = (l, c, x) => console.log(`${c ? '  ✓' : '  ✗'} ${l}${x !== undefined ? ' : ' + x : ''}`);
const $ = n => '$' + Math.round(n || 0).toLocaleString('en-US');
const before = JSON.parse(require('fs').readFileSync('/tmp/alias-before.json', 'utf8'));

require('./po-ledger').invalidateSiteMeta();
delete require.cache[require.resolve('./po-ledger')];
const led = require('./po-ledger').getPoLedger(sage.getCachedInvoices());
const after = {};
for (const p of led) after[p.poNumber] = p.siteCode || null;

const moved = [], lost = [];
for (const po of Object.keys(before)) {
  if (!(po in after)) { lost.push(po); continue; }
  if (before[po] !== after[po]) moved.push([po, before[po], after[po]]);
}
console.log('=== site attribution across every PO ===');
ok('no PO disappeared', lost.length === 0, `${lost.length} lost`);
ok('ONLY confirmed aliases moved', moved.every(m => sa.map()[m[1]] === m[2]),
  `${moved.length} POs moved`);
for (const m of moved) console.log(`     ${m[0].padEnd(15)} ${m[1]} -> ${m[2]}`);

console.log('\n=== proposals stay inert ===');
const proposed = sa.list('proposed').map(r => r.alias);
ok('no proposed alias resolved', proposed.every(a => sa.resolve(a) === a),
  proposed.map(a => `${a}->${sa.resolve(a)}`).join(', '));
ok('confirmed pairs DO resolve', sa.resolve('MDT2') === 'KRB5' && sa.resolve('MDT9') === 'QYY4',
  `MDT2->${sa.resolve('MDT2')}, MDT9->${sa.resolve('MDT9')}`);
ok('unknown codes pass through', sa.resolve('BDL4') === 'BDL4');
ok('codesFor unions both', sa.codesFor('KRB5').join('+'), sa.codesFor('KRB5').join('+'));

console.log('\n=== the merge actually happened ===');
const krb5 = led.filter(p => p.siteCode === 'KRB5');
const mdt2 = led.filter(p => p.siteCode === 'MDT2');
ok('MDT2 no longer a separate site', mdt2.length === 0, `${mdt2.length} POs still under MDT2`);
ok('its history sits under KRB5', krb5.length > 0,
  `${krb5.length} POs, ${$(krb5.reduce((t, p) => t + (p.ceilingAmount || 0), 0))}`);
