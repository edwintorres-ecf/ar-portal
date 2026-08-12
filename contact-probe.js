'use strict';
// ─── contact-probe.js — read-only test of Intacct customer-contact fields ────
// Verifies which query shape returns DISPLAYCONTACT email/phone data before
// Deploy 2 builds on it. Queries only; writes nothing. Run from the app dir.

const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function buildXml(functionXml) {
  const controlId = 'contact-probe-' + Date.now();
  return `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <control>
    <senderid>${process.env.SAGE_SENDER_ID}</senderid>
    <password>${esc(process.env.SAGE_SENDER_PASSWORD)}</password>
    <controlid>${controlId}</controlid>
    <uniqueid>false</uniqueid>
    <dtdversion>3.0</dtdversion>
    <includewhitespace>false</includewhitespace>
  </control>
  <operation>
    <authentication>
      <login>
        <userid>${esc(process.env.SAGE_USER_ID)}</userid>
        <companyid>${esc(process.env.SAGE_COMPANY_ID)}</companyid>
        <password>${esc(process.env.SAGE_USER_PASSWORD)}</password>
        <locationid>E-ECF</locationid>
      </login>
    </authentication>
    <content>
      <function controlid="${controlId}">
        ${functionXml}
      </function>
    </content>
  </operation>
</request>`;
}

function sagePost(xml) {
  return new Promise((resolve, reject) => {
    const body = 'xmlrequest=' + encodeURIComponent(xml);
    const buf = Buffer.from(body);
    const req = https.request({
      hostname: 'api.intacct.com', path: '/ia/xml/xmlgw.phtml', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.byteLength },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.write(buf); req.end();
  });
}

async function main() {
  // Shape A: legacy readByQuery with dotted DISPLAYCONTACT fields
  console.log('===== A: readByQuery + dotted fields =====');
  const a = await sagePost(buildXml(`
    <readByQuery>
      <object>CUSTOMER</object>
      <fields>CUSTOMERID,NAME,STATUS,DISPLAYCONTACT.CONTACTNAME,DISPLAYCONTACT.EMAIL1,DISPLAYCONTACT.EMAIL2,DISPLAYCONTACT.PHONE1</fields>
      <query>STATUS = 'active'</query>
      <pagesize>5</pagesize>
    </readByQuery>
  `));
  const aStatus = (a.match(/<status>([^<]+)<\/status>/i) || [])[1];
  console.log('status:', aStatus);
  if (aStatus === 'success') {
    const first = (a.match(/<customer>([\s\S]*?)<\/customer>/i) || [])[1] || '';
    console.log(first.slice(0, 1200));
  } else {
    console.log((a.match(/<description2>([^<]*)<\/description2>/i) || [])[1] || a.slice(0, 600));
  }

  // Shape B: modern query with select fields
  console.log('\n===== B: query + select =====');
  const b = await sagePost(buildXml(`
    <query>
      <object>CUSTOMER</object>
      <select>
        <field>CUSTOMERID</field>
        <field>NAME</field>
        <field>STATUS</field>
        <field>DISPLAYCONTACT.CONTACTNAME</field>
        <field>DISPLAYCONTACT.EMAIL1</field>
        <field>DISPLAYCONTACT.EMAIL2</field>
        <field>DISPLAYCONTACT.PHONE1</field>
      </select>
      <filter><equalto><field>STATUS</field><value>active</value></equalto></filter>
      <pagesize>5</pagesize>
    </query>
  `));
  const bStatus = (b.match(/<status>([^<]+)<\/status>/i) || [])[1];
  console.log('status:', bStatus);
  if (bStatus === 'success') {
    const first = (b.match(/<CUSTOMER>([\s\S]*?)<\/CUSTOMER>/i) || [])[1] || '';
    console.log(first.slice(0, 1200));
  } else {
    console.log((b.match(/<description2>([^<]*)<\/description2>/i) || [])[1] || b.slice(0, 600));
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
