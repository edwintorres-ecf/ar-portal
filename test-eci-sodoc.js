'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });

// Directly call internal sage functions to inspect SODOCUMENT for a known ECI- invoice
// We'll load sage and monkey into its internals via a test shim

const https = require('https');
const SAGE_COMPANY_ID = process.env.SAGE_COMPANY_ID;
const SAGE_USER_ID    = process.env.SAGE_USER_ID;
const SAGE_USER_PW    = process.env.SAGE_USER_PW;
const SAGE_SENDER_ID  = process.env.SAGE_SENDER_ID;
const SAGE_SENDER_PW  = process.env.SAGE_SENDER_PW;
const ENTITY_ID       = 'E-ECF';

function escXml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildXml(funcBody) {
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
        <locationid>${ENTITY_ID}</locationid>
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
  const invoiceId = 'ECI-021455';

  // Try 1: query SODOCUMENT by DOCNO (no DOCPARID filter)
  const q1 = buildXml(`
    <query>
      <object>SODOCUMENT</object>
      <select>
        <field>RECORDNO</field>
        <field>DOCNO</field>
        <field>DOCPARID</field>
        <field>SUPDOCID</field>
        <field>STATE</field>
        <field>TOTALDUE</field>
      </select>
      <filter>
        <equalto>
          <field>DOCNO</field>
          <value>${escXml(invoiceId)}</value>
        </equalto>
      </filter>
      <pagesize>5</pagesize>
      <offset>0</offset>
    </query>
  `);
  const r1 = await sagePost(q1);
  const status1 = (r1.match(/<status>(.*?)<\/status>/i) || [])[1];
  const totalcount1 = (r1.match(/totalcount="(\d+)"/i) || [])[1];
  console.log('Query by DOCNO:', invoiceId, '-> status:', status1, 'totalcount:', totalcount1);

  // Extract any SODOCUMENT blocks
  const re = /<SODOCUMENT>([\s\S]*?)<\/SODOCUMENT>/gi;
  let m;
  while ((m = re.exec(r1)) !== null) {
    const block = m[1];
    console.log('  RECORDNO:', block.match(/<RECORDNO>(.*?)<\/RECORDNO>/i)?.[1]);
    console.log('  DOCNO:', block.match(/<DOCNO>(.*?)<\/DOCNO>/i)?.[1]);
    console.log('  DOCPARID:', block.match(/<DOCPARID>(.*?)<\/DOCPARID>/i)?.[1]);
    console.log('  SUPDOCID:', block.match(/<SUPDOCID>(.*?)<\/SUPDOCID>/i)?.[1]);
    console.log('  STATE:', block.match(/<STATE>(.*?)<\/STATE>/i)?.[1]);
  }

  // Try 2: read ARINVOICE by RECORDID to get any attachment field
  const q2 = buildXml(`
    <query>
      <object>ARINVOICE</object>
      <select>
        <field>RECORDNO</field>
        <field>RECORDID</field>
        <field>SUPDOCID</field>
        <field>STATE</field>
        <field>TOTALDUE</field>
      </select>
      <filter>
        <equalto>
          <field>RECORDID</field>
          <value>${escXml(invoiceId)}</value>
        </equalto>
      </filter>
      <pagesize>3</pagesize>
      <offset>0</offset>
    </query>
  `);
  const r2 = await sagePost(q2);
  const status2 = (r2.match(/<status>(.*?)<\/status>/i) || [])[1];
  const totalcount2 = (r2.match(/totalcount="(\d+)"/i) || [])[1];
  console.log('\nARINVOICE query by RECORDID:', invoiceId, '-> status:', status2, 'totalcount:', totalcount2);

  const re2 = /<ARINVOICE>([\s\S]*?)<\/ARINVOICE>/gi;
  while ((m = re2.exec(r2)) !== null) {
    const block = m[1];
    console.log('  RECORDNO:', block.match(/<RECORDNO>(.*?)<\/RECORDNO>/i)?.[1]);
    console.log('  RECORDID:', block.match(/<RECORDID>(.*?)<\/RECORDID>/i)?.[1]);
    console.log('  SUPDOCID:', block.match(/<SUPDOCID>(.*?)<\/SUPDOCID>/i)?.[1]);
    console.log('  STATE:', block.match(/<STATE>(.*?)<\/STATE>/i)?.[1]);
  }
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
