'use strict';
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });

const https = require('https');
const SAGE_COMPANY_ID = process.env.SAGE_COMPANY_ID;
const SAGE_USER_ID    = process.env.SAGE_USER_ID;
const SAGE_USER_PW    = process.env.SAGE_USER_PW;
const SAGE_SENDER_ID  = process.env.SAGE_SENDER_ID;
const SAGE_SENDER_PW  = process.env.SAGE_SENDER_PW;

function escXml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildXml(entityId, funcBody) {
  const entityTag = entityId ? `<locationid>${entityId}</locationid>` : '';
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
  const invoiceId = 'ECI-021455';

  // Test with E-ECF entity
  for (const entityId of ['E-ECF', '']) {
    const q = buildXml(entityId, `
      <query>
        <object>ARINVOICE</object>
        <select>
          <field>RECORDNO</field>
          <field>RECORDID</field>
          <field>SUPDOCID</field>
          <field>STATE</field>
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
    const r = await sagePost(q);
    const status = (r.match(/<status>(.*?)<\/status>/i) || [])[1];
    const errDesc = (r.match(/<description2>(.*?)<\/description2>/i) || (r.match(/<description>(.*?)<\/description>/i)) || [])[1] || '';
    const errNo = (r.match(/<errorno>(.*?)<\/errorno>/i) || [])[1] || '';
    const totalcount = (r.match(/totalcount="(\d+)"/i) || [])[1];
    console.log(`Entity [${entityId||'(root)'}] ARINVOICE by RECORDID: status=${status} count=${totalcount} err=[${errNo}] ${errDesc}`);

    // Also try SODOCUMENT
    const q2 = buildXml(entityId, `
      <query>
        <object>SODOCUMENT</object>
        <select>
          <field>RECORDNO</field>
          <field>DOCNO</field>
          <field>DOCPARID</field>
          <field>SUPDOCID</field>
        </select>
        <filter>
          <equalto>
            <field>DOCNO</field>
            <value>${escXml(invoiceId)}</value>
          </equalto>
        </filter>
        <pagesize>3</pagesize>
        <offset>0</offset>
      </query>
    `);
    const r2 = await sagePost(q2);
    const status2 = (r2.match(/<status>(.*?)<\/status>/i) || [])[1];
    const errDesc2 = (r2.match(/<description2>(.*?)<\/description2>/i) || (r2.match(/<description>(.*?)<\/description>/i)) || [])[1] || '';
    const errNo2 = (r2.match(/<errorno>(.*?)<\/errorno>/i) || [])[1] || '';
    const totalcount2 = (r2.match(/totalcount="(\d+)"/i) || [])[1];
    console.log(`Entity [${entityId||'(root)'}] SODOCUMENT by DOCNO: status=${status2} count=${totalcount2} err=[${errNo2}] ${errDesc2}`);
    if (status2 === 'success') {
      const re = /<SODOCUMENT>([\s\S]*?)<\/SODOCUMENT>/gi;
      let m;
      while ((m = re.exec(r2)) !== null) {
        const b = m[1];
        console.log('  DOCNO:', b.match(/<DOCNO>(.*?)<\/DOCNO>/i)?.[1], 'DOCPARID:', b.match(/<DOCPARID>(.*?)<\/DOCPARID>/i)?.[1], 'SUPDOCID:', b.match(/<SUPDOCID>(.*?)<\/SUPDOCID>/i)?.[1]);
      }
    }
    console.log('');
  }
}
run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
