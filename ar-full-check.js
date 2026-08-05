'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });

// Read sage internals via a direct XML query to count ALL open ARINVOICE records
// including any ECI- records that may live in AR (vs OE)
const https = require('https');
const fs = require('fs');

// Load Sage credentials from env
const SAGE_COMPANY_ID = process.env.SAGE_COMPANY_ID;
const SAGE_USER_ID    = process.env.SAGE_USER_ID;
const SAGE_USER_PW    = process.env.SAGE_USER_PW;
const SAGE_SENDER_ID  = process.env.SAGE_SENDER_ID;
const SAGE_SENDER_PW  = process.env.SAGE_SENDER_PW;
const SAGE_ENTITY_ID  = process.env.SAGE_ENTITY_ID || '';

if (!SAGE_COMPANY_ID) { console.error('No SAGE_COMPANY_ID in env'); process.exit(1); }

function buildXml(funcBody) {
  const entityTag = SAGE_ENTITY_ID ? `<locationid>${SAGE_ENTITY_ID}</locationid>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <control>
    <senderid>${SAGE_SENDER_ID}</senderid>
    <password>${SAGE_SENDER_PW}</password>
    <controlid>req-${Date.now()}</controlid>
    <uniqueid>false</uniqueid>
    <dtdversion>3.0</dtdversion>
    <includewhitespace>false</includewhitespace>
  </control>
  <operation>
    <authentication>
      <login>
        <userid>${SAGE_USER_ID}</userid>
        <companyid>${SAGE_COMPANY_ID}</companyid>
        <password>${SAGE_USER_PW}</password>
        ${entityTag}
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

async function run() {
  // 1. Count ALL open invoices (no prefix filter) — single page to get totalcount
  const xmlCount = buildXml(`
    <query>
      <object>ARINVOICE</object>
      <select><field>RECORDNO</field><field>RECORDID</field></select>
      <filter>
        <greaterthan><field>TOTALDUE</field><value>0</value></greaterthan>
      </filter>
      <pagesize>1</pagesize>
      <offset>0</offset>
    </query>
  `);
  const resCount = await sagePost(xmlCount);
  const totalAll = (resCount.match(/totalcount="(\d+)"/i) || [])[1] || '?';
  console.log('ARINVOICE total open (ALL prefixes, TOTALDUE>0):', totalAll);

  // 2. Sample 1000 to see prefix distribution
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
  const prefixes = {};
  const states = {};
  const re = /<ARINVOICE>([\s\S]*?)<\/ARINVOICE>/gi;
  let m;
  while ((m = re.exec(resSample)) !== null) {
    const block = m[1];
    const rid = (block.match(/<RECORDID>(.*?)<\/RECORDID>/i) || [])[1] || '';
    const state = (block.match(/<STATE>(.*?)<\/STATE>/i) || [])[1] || '';
    const prefix = rid.split('-')[0] || '(blank)';
    prefixes[prefix] = (prefixes[prefix] || 0) + 1;
    states[state] = (states[state] || 0) + 1;
  }
  console.log('\nFirst 1000 by prefix:', JSON.stringify(prefixes));
  console.log('First 1000 by state:', JSON.stringify(states));
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
