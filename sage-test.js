'use strict';
const https = require('https');
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });

const cfg = {
  senderId:       process.env.SAGE_SENDER_ID,
  senderPassword: process.env.SAGE_SENDER_PASSWORD,
  companyId:      process.env.SAGE_COMPANY_ID,
  userId:         process.env.SAGE_USER_ID,
  userPassword:   process.env.SAGE_USER_PASSWORD,
};
console.log('Config loaded:', cfg.senderId, cfg.userId, 'pw_len:', cfg.userPassword.length);

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <control>
    <senderid>${cfg.senderId}</senderid>
    <password>${cfg.senderPassword}</password>
    <controlid>test-${Date.now()}</controlid>
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
        <locationid>E-ECF</locationid>
      </login>
    </authentication>
    <content>
      <function controlid="q1">
        <query>
          <object>ARINVOICE</object>
          <select>
            <field>RECORDNO</field>
            <field>RECORDID</field>
            <field>CUSTOMERNAME</field>
            <field>TOTALDUE</field>
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
const req = https.request({
  hostname: 'api.intacct.com',
  path: '/ia/xml/xmlgw.phtml',
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.length }
}, res => {
  const c = [];
  res.on('data', d => c.push(d));
  res.on('end', () => {
    const r = Buffer.concat(c).toString();
    console.log('Response (800 chars):', r.substring(0, 800));
  });
});
req.write(buf);
req.end();
