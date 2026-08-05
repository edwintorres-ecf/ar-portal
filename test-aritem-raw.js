'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });

// Directly call sage internals to debug ARINVOICEITEM query
// Load sage module and intercept via inline test
const sage = require('/home/ecf-admin/ar-portal/sage');

// We need access to sagePost/buildXml — they're private. Use a workaround:
// Modify sage to export them for debug, or just use the test approach.
// Easiest: create a minimal shim inline using sage's env vars

const https = require('https');
const cfg = {
  companyId:      process.env.SAGE_COMPANY_ID,
  userId:         process.env.SAGE_USER_ID,
  userPassword:   process.env.SAGE_USER_PW || process.env.SAGE_USER_PASSWORD,
  senderId:       process.env.SAGE_SENDER_ID       || 'eastcoast',
  senderPassword: process.env.SAGE_SENDER_PASSWORD || '',
  entityId:       'E-ECF',
};

// Load sage's actual credentials from its config reader
const fs = require('fs');
try {
  const envPath = '/home/ecf-admin/ar-portal/.env';
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const [k, ...vParts] = line.split('=');
    const v = vParts.join('=').trim().replace(/^["']|["']$/g, '');
    if (k === 'SAGE_SENDER_PASSWORD' && !cfg.senderPassword) cfg.senderPassword = v;
    if (k === 'SAGE_USER_PASSWORD'   && !cfg.userPassword)   cfg.userPassword   = v;
    if (k === 'SAGE_USER_PW'         && !cfg.userPassword)   cfg.userPassword   = v;
  }
} catch(e) {}

function buildXml(funcBody) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <control>
    <senderid>${cfg.senderId}</senderid>
    <password>${cfg.senderPassword}</password>
    <controlid>dbg-${Date.now()}</controlid>
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
        <locationid>${cfg.entityId}</locationid>
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
  const recordNo = '172862'; // ARINVOICE recordNo for ECI-021455
  const invoiceId = 'ECI-021455';

  console.log('Config check — companyId:', cfg.companyId ? 'SET' : 'MISSING', 'userId:', cfg.userId ? 'SET' : 'MISSING', 'senderPassword:', cfg.senderPassword ? 'SET' : 'MISSING');

  // Test 1: query ARINVOICEITEM by RECORDKEY
  const q1 = buildXml(`
    <readByQuery>
      <object>ARINVOICEITEM</object>
      <fields>RECORDNO,RECORDKEY,LINE_NO,ITEMID,ITEMNAME,MEMO,AMOUNT</fields>
      <query>RECORDKEY = '${recordNo}'</query>
      <pagesize>10</pagesize>
    </readByQuery>
  `);
  const r1 = await sagePost(q1);
  const status1 = (r1.match(/<status>(.*?)<\/status>/i) || [])[1];
  const count1  = (r1.match(/totalcount="(\d+)"/i) || [])[1];
  const err1    = (r1.match(/<description2>([\s\S]*?)<\/description2>/i) || (r1.match(/<description>([\s\S]*?)<\/description>/i)) || [])[1] || '';
  const errNo1  = (r1.match(/<errorno>(.*?)<\/errorno>/i) || [])[1] || '';
  console.log('ARINVOICEITEM RECORDKEY query:', invoiceId, '/', recordNo, '-> status:', status1, 'count:', count1, 'err:', errNo1, err1.slice(0,100));

  // Test 2: try with integer RECORDKEY (no quotes)
  const q2 = buildXml(`
    <readByQuery>
      <object>ARINVOICEITEM</object>
      <fields>RECORDNO,RECORDKEY,LINE_NO,ITEMID,ITEMNAME,MEMO,AMOUNT</fields>
      <query>RECORDKEY = ${recordNo}</query>
      <pagesize>10</pagesize>
    </readByQuery>
  `);
  const r2 = await sagePost(q2);
  const status2 = (r2.match(/<status>(.*?)<\/status>/i) || [])[1];
  const count2  = (r2.match(/totalcount="(\d+)"/i) || [])[1];
  const err2    = (r2.match(/<description2>([\s\S]*?)<\/description2>/i) || (r2.match(/<description>([\s\S]*?)<\/description>/i)) || [])[1] || '';
  console.log('ARINVOICEITEM RECORDKEY (no quotes):', '-> status:', status2, 'count:', count2, 'err:', err2.slice(0,100));

  // Test 3: use new-style <query> object
  const q3 = buildXml(`
    <query>
      <object>ARINVOICEITEM</object>
      <select>
        <field>RECORDNO</field>
        <field>RECORDKEY</field>
        <field>LINE_NO</field>
        <field>ITEMID</field>
        <field>ITEMNAME</field>
        <field>MEMO</field>
        <field>AMOUNT</field>
        <field>QUANTITY</field>
        <field>UNIT_PRICE</field>
      </select>
      <filter>
        <equalto>
          <field>RECORDKEY</field>
          <value>${recordNo}</value>
        </equalto>
      </filter>
      <pagesize>10</pagesize>
      <offset>0</offset>
    </query>
  `);
  const r3 = await sagePost(q3);
  const status3 = (r3.match(/<status>(.*?)<\/status>/i) || [])[1];
  const count3  = (r3.match(/totalcount="(\d+)"/i) || [])[1];
  const err3    = (r3.match(/<description2>([\s\S]*?)<\/description2>/i) || (r3.match(/<description>([\s\S]*?)<\/description>/i)) || [])[1] || '';
  const errNo3  = (r3.match(/<errorno>(.*?)<\/errorno>/i) || [])[1] || '';
  console.log('ARINVOICEITEM <query> RECORDKEY:', '-> status:', status3, 'count:', count3, 'err:', errNo3, err3.slice(0,100));

  if (status3 === 'success' && count3 && parseInt(count3) > 0) {
    console.log('RAW (first 800):', r3.slice(0, 800));
  }
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
