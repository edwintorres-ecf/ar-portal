'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
const { sagePost, buildXml } = require('/home/ecf-admin/ar-portal/sage');

async function run() {
  // 1. Count ALL ARINVOICE with TOTALDUE > 0 (no prefix filter)
  const xmlAll = buildXml(`
    <query>
      <object>ARINVOICE</object>
      <select><field>RECORDNO</field></select>
      <filter>
        <greaterthan><field>TOTALDUE</field><value>0</value></greaterthan>
      </filter>
      <pagesize>1</pagesize>
      <offset>0</offset>
    </query>
  `);
  const resAll = await sagePost(xmlAll);
  const totalAll = (resAll.match(/<data[^>]+totalcount="(\d+)"/i) || [])[1] || '?';
  console.log('ARINVOICE total open (all prefixes, TOTALDUE>0):', totalAll);

  // 2. Count by state breakdown — get first 1000 and tally
  const xmlSample = buildXml(`
    <query>
      <object>ARINVOICE</object>
      <select><field>RECORDNO</field><field>RECORDID</field><field>STATE</field><field>TOTALDUE</field></select>
      <filter>
        <greaterthan><field>TOTALDUE</field><value>0</value></greaterthan>
      </filter>
      <pagesize>1000</pagesize>
      <offset>0</offset>
    </query>
  `);
  const resSample = await sagePost(xmlSample);
  const states = {};
  const prefixes = {};
  let matched = 0;
  const re = /<ARINVOICE>([\s\S]*?)<\/ARINVOICE>/gi;
  let m;
  while ((m = re.exec(resSample)) !== null) {
    const block = m[1];
    const state = block.match(/<STATE>(.*?)<\/STATE>/i)?.[1] || 'unknown';
    const rid = block.match(/<RECORDID>(.*?)<\/RECORDID>/i)?.[1] || '';
    const prefix = rid.split('-')[0] || 'unknown';
    states[state] = (states[state] || 0) + 1;
    prefixes[prefix] = (prefixes[prefix] || 0) + 1;
    matched++;
  }
  console.log('First 1000 sample — states:', JSON.stringify(states));
  console.log('First 1000 sample — prefixes:', JSON.stringify(prefixes));
  console.log('Records parsed from sample:', matched);
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
