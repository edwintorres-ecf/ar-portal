'use strict';

// Live Sage AR vs what the portal is serving.
//
// Queries ARINVOICE directly (TOTALDUE > 0, no prefix filter — the same filter
// sage.js uses) and prints it next to the portal's cached set, broken down by
// prefix so an ECI-/Omnia split is visible.
//
// Two things this script used to get wrong, both silent:
//   1. It read SAGE_SENDER_PW / SAGE_USER_PW. Those names are not in .env, so it
//      authenticated with blank passwords, the gateway returned an auth failure,
//      and the regex below produced "?" instead of an error.
//   2. SAGE_ENTITY_ID defaulted to '', which is a TOP-LEVEL login. Top level
//      returns a different view of the data, so this diagnostic could disagree
//      with the portal precisely when someone was running it to find out why
//      they disagreed.
// Both are now fixed by taking the credentials AND the entity from sage.js
// rather than re-reading the environment. (Edwin 2026-09-11)

const https = require('https');
const sage = require('/home/ecf-admin/ar-portal/sage');

const cfg = sage.getSageConfig();
const ENTITY = sage.SAGE_ENTITY;

if (!cfg.companyId || !cfg.senderPassword || !cfg.userPassword) {
  console.error('Sage credentials incomplete — check .env (SAGE_SENDER_PASSWORD / SAGE_USER_PASSWORD)');
  process.exit(1);
}

function buildXml(funcBody) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <control>
    <senderid>${cfg.senderId}</senderid>
    <password>${cfg.senderPassword}</password>
    <controlid>req-${Date.now()}</controlid>
    <uniqueid>false</uniqueid>
    <dtdversion>3.0</dtdversion>
    <includewhitespace>false</includewhitespace>
  </control>
  <operation>
    <authentication>
      <login>
        <userid>${cfg.userId}</userid>
        <companyid>${cfg.companyId}</companyid>
        <password>${cfg.userPassword}</password>
        <locationid>${ENTITY}</locationid>
      </login>
    </authentication>
    <content>
      <function controlid="fn1">
        ${funcBody}
      </function>
    </content>
  </operation>
</request>`;
}

function sagePost(xml) {
  return new Promise((resolve, reject) => {
    const body = 'xmlrequest=' + encodeURIComponent(xml);
    const opts = {
      hostname: 'api.intacct.com', path: '/ia/xml/xmlgw.phtml',
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// A gateway failure must stop the run, not turn into a "0" that reads like a
// real answer. That is how an empty pull once zeroed the portal's cache.
function assertOk(resp, what) {
  if (/<status>failure<\/status>/i.test(resp)) {
    const desc = (resp.match(/<description2>([\s\S]*?)<\/description2>/i) || [])[1] || '(no description)';
    const no = (resp.match(/<errorno>([\s\S]*?)<\/errorno>/i) || [])[1] || '';
    throw new Error(`${what}: Sage returned failure ${no} — ${desc}`);
  }
}

const M = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const prefixOf = (id) => String(id || '').split('-')[0] || '(blank)';

async function fetchAll() {
  const PAGE = 1000;
  const rows = [];
  let offset = 0, total = null;
  while (true) {
    const resp = await sagePost(buildXml(`
      <query>
        <object>ARINVOICE</object>
        <select><field>RECORDNO</field><field>RECORDID</field><field>STATE</field><field>TOTALDUE</field></select>
        <filter>
          <greaterthan><field>TOTALDUE</field><value>0</value></greaterthan>
        </filter>
        <pagesize>${PAGE}</pagesize>
        <offset>${offset}</offset>
      </query>
    `));
    assertOk(resp, 'ARINVOICE query');
    if (total === null) {
      const t = (resp.match(/totalcount="(\d+)"/i) || [])[1];
      if (t === undefined) throw new Error('ARINVOICE query: no totalcount in response');
      total = parseInt(t, 10);
    }
    let n = 0;
    for (const m of resp.matchAll(/<ARINVOICE>([\s\S]*?)<\/ARINVOICE>/gi)) {
      const b = m[1];
      rows.push({
        id: (b.match(/<RECORDID>([\s\S]*?)<\/RECORDID>/i) || [])[1] || '',
        state: (b.match(/<STATE>([\s\S]*?)<\/STATE>/i) || [])[1] || '',
        due: parseFloat((b.match(/<TOTALDUE>([\s\S]*?)<\/TOTALDUE>/i) || [])[1] || '0') || 0,
      });
      n++;
    }
    offset += PAGE;
    if (n === 0 || rows.length >= total) break;
  }
  return { rows, total };
}

function tally(list, idKey, amtKey) {
  const byPrefix = {};
  let amt = 0;
  for (const r of list) {
    const p = prefixOf(r[idKey]);
    const v = r[amtKey] || 0;
    byPrefix[p] = byPrefix[p] || { n: 0, amt: 0 };
    byPrefix[p].n++; byPrefix[p].amt += v;
    amt += v;
  }
  return { byPrefix, n: list.length, amt };
}

async function run() {
  console.log(`Sage entity: ${ENTITY}  ·  company: ${cfg.companyId}  ·  user: ${cfg.userId}\n`);

  const live = await fetchAll();
  const sageT = tally(live.rows, 'id', 'due');
  console.log(`SAGE  (live ARINVOICE, TOTALDUE > 0) : ${sageT.n} invoices  ${M(sageT.amt)}`);
  if (sageT.n !== live.total) console.log(`   WARNING: gateway reported totalcount=${live.total} but ${sageT.n} rows came back`);

  const cached = sage.getCachedInvoices() || [];
  const age = sage.getCacheAge ? sage.getCacheAge() : null;
  const portalT = tally(cached, 'invoiceId', 'totalDue');
  const ageTxt = age && age.ageMs != null ? Math.round(age.ageMs / 60000) + ' min old' : 'age unknown';
  console.log(`PORTAL (cached set, ${ageTxt})   : ${portalT.n} invoices  ${M(portalT.amt)}`);

  const states = {};
  for (const r of live.rows) states[r.state || '(blank)'] = (states[r.state || '(blank)'] || 0) + 1;
  console.log('\nSage states:', JSON.stringify(states));

  // Prefix-by-prefix. The portal merges SODOCUMENT ECI- records on top of
  // ARINVOICE, so an ECI- surplus on the portal side is expected, not a fault.
  const prefixes = [...new Set([...Object.keys(sageT.byPrefix), ...Object.keys(portalT.byPrefix)])].sort();
  console.log('\nprefix'.padEnd(12) + 'sage n'.padStart(9) + 'portal n'.padStart(10) + 'diff'.padStart(8)
    + 'sage $'.padStart(16) + 'portal $'.padStart(16) + 'diff $'.padStart(16));
  for (const p of prefixes) {
    const s = sageT.byPrefix[p] || { n: 0, amt: 0 };
    const q = portalT.byPrefix[p] || { n: 0, amt: 0 };
    const dn = q.n - s.n, da = q.amt - s.amt;
    console.log(p.padEnd(12) + String(s.n).padStart(9) + String(q.n).padStart(10)
      + (dn === 0 ? '-' : (dn > 0 ? '+' : '') + dn).padStart(8)
      + M(s.amt).padStart(16) + M(q.amt).padStart(16)
      + (Math.abs(da) < 0.5 ? '-' : (da > 0 ? '+' : '-') + M(Math.abs(da))).padStart(16));
  }

  // Which specific invoices are on one side only?
  const sageIds = new Set(live.rows.map(r => r.id));
  const portalIds = new Set(cached.map(r => r.invoiceId));
  const missingFromPortal = [...sageIds].filter(id => !portalIds.has(id));
  const extraOnPortal = [...portalIds].filter(id => !sageIds.has(id));
  console.log(`\nin Sage but NOT on the portal : ${missingFromPortal.length}`);
  if (missingFromPortal.length) console.log('   ' + missingFromPortal.slice(0, 20).join(', ') + (missingFromPortal.length > 20 ? ' ...' : ''));
  console.log(`on the portal but NOT in Sage : ${extraOnPortal.length}   (ECI- here are SODOCUMENT records, expected)`);
  if (extraOnPortal.length) console.log('   ' + extraOnPortal.slice(0, 20).join(', ') + (extraOnPortal.length > 20 ? ' ...' : ''));
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
