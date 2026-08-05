'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });

const https = require('https');
const fs = require('fs');
const cfg = {
  companyId:      process.env.SAGE_COMPANY_ID,
  userId:         process.env.SAGE_USER_ID,
  userPassword:   process.env.SAGE_USER_PW || process.env.SAGE_USER_PASSWORD,
  senderId:       process.env.SAGE_SENDER_ID       || 'eastcoast',
  senderPassword: process.env.SAGE_SENDER_PASSWORD || '',
  entityId:       'E-ECF',
};
try {
  const lines = fs.readFileSync('/home/ecf-admin/ar-portal/.env', 'utf8').split('\n');
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
    <senderid>${cfg.senderId}</senderid><password>${cfg.senderPassword}</password>
    <controlid>dbg-${Date.now()}</controlid><uniqueid>false</uniqueid><dtdversion>3.0</dtdversion>
    <includewhitespace>false</includewhitespace>
  </control>
  <operation>
    <authentication><login>
      <userid>${cfg.userId}</userid><companyid>${cfg.companyId}</companyid>
      <password>${cfg.userPassword}</password><locationid>${cfg.entityId}</locationid>
    </login></authentication>
    <content><function controlid="fn1">${funcBody}</function></content>
  </operation>
</request>`;
}

function sagePost(xml) {
  return new Promise((resolve, reject) => {
    const body = 'xmlrequest=' + encodeURIComponent(xml);
    const opts = { hostname: 'api.intacct.com', path: '/ia/xml/xmlgw.phtml', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function run() {
  const recordNo = '172862';

  // Test: query ARINVOICEITEM with minimal safe fields
  const q = buildXml(`
    <query>
      <object>ARINVOICEITEM</object>
      <select>
        <field>RECORDNO</field>
        <field>RECORDKEY</field>
        <field>LINE_NO</field>
        <field>ITEMID</field>
        <field>ITEMNAME</field>
        <field>AMOUNT</field>
        <field>LOCATIONID</field>
        <field>LOCATIONNAME</field>
        <field>DEPARTMENTID</field>
        <field>DEPARTMENTNAME</field>
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
  const r = await sagePost(q);
  const status = (r.match(/<status>(.*?)<\/status>/i) || [])[1];
  const count  = (r.match(/totalcount="(\d+)"/i) || [])[1];
  const err    = (r.match(/<description2>([\s\S]*?)<\/description2>/i) || (r.match(/<description>([\s\S]*?)<\/description>/i)) || [])[1] || '';
  const errNo  = (r.match(/<errorno>(.*?)<\/errorno>/i) || [])[1] || '';
  console.log('status:', status, 'count:', count, 'errNo:', errNo);
  if (err) console.log('err:', err.slice(0, 200));

  if (status === 'success') {
    // Show first 1200 chars of data section
    const dataStart = r.indexOf('<data');
    console.log('DATA:', r.slice(dataStart, dataStart + 1200));
  }
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
