'use strict';
// Drop this on spark to debug sage.js query response
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

function escXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const cfg = {
  senderId:       process.env.SAGE_SENDER_ID,
  senderPassword: process.env.SAGE_SENDER_PASSWORD,
  companyId:      process.env.SAGE_COMPANY_ID,
  userId:         process.env.SAGE_USER_ID,
  userPassword:   process.env.SAGE_USER_PASSWORD,
};

console.log('Passwords:', cfg.senderPassword.length, 'chars /', cfg.userPassword.length, 'chars');

const controlId = 'ar-debug-' + Date.now();
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <control>
    <senderid>${escXml(cfg.senderId)}</senderid>
    <password>${escXml(cfg.senderPassword)}</password>
    <controlid>${controlId}</controlid>
    <uniqueid>false</uniqueid>
    <dtdversion>3.0</dtdversion>
    <includewhitespace>false</includewhitespace>
  </control>
  <operation>
    <authentication>
      <login>
        <userid>${escXml(cfg.userId)}</userid>
        <companyid>${escXml(cfg.companyId)}</companyid>
        <password>${escXml(cfg.userPassword)}</password>
        <locationid>E-ECF</locationid>
      </login>
    </authentication>
    <content>
      <function controlid="${controlId}">
        <query>
          <object>ARINVOICE</object>
          <select>
            <field>RECORDNO</field>
            <field>RECORDID</field>
            <field>CUSTOMERNAME</field>
            <field>TOTALDUE</field>
            <field>WHENDUE</field>
          </select>
          <filter>
            <greaterthan>
              <field>TOTALDUE</field>
              <value>0</value>
            </greaterthan>
          </filter>
          <pagesize>3</pagesize>
        </query>
      </function>
    </content>
  </operation>
</request>`;

const body = 'xmlrequest=' + encodeURIComponent(xml);
const buf = Buffer.from(body);

https.request({
  hostname: 'api.intacct.com',
  path: '/ia/xml/xmlgw.phtml',
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.length, 'User-Agent': 'ECF-AR-Portal/1.0' }
}, res => {
  const c = [];
  res.on('data', d => c.push(d));
  res.on('end', () => {
    const r = Buffer.concat(c).toString();
    console.log('RAW RESPONSE (1200 chars):');
    console.log(r.substring(0, 1200));
    // Count ARINVOICE blocks
    const blocks = (r.match(/<ARINVOICE>/gi) || []).length;
    console.log('\nARINVOICE blocks found:', blocks);
  });
}).on('error', e => console.error(e)).end(buf);
