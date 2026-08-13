'use strict';
// Read-only probe: Sage payment-detail object shape for real paid dates/amounts.
const path = require('path');
process.chdir('/home/ecf-admin/ar-portal');
const https = require('https');
require('dotenv').config({ path: '/home/ecf-admin/ar-portal/.env' });
function esc(x){return String(x||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function buildXml(fn){return `<?xml version="1.0" encoding="UTF-8"?><request><control><senderid>${process.env.SAGE_SENDER_ID}</senderid><password>${esc(process.env.SAGE_SENDER_PASSWORD)}</password><controlid>p${Date.now()}</controlid><uniqueid>false</uniqueid><dtdversion>3.0</dtdversion></control><operation><authentication><login><userid>${esc(process.env.SAGE_USER_ID)}</userid><companyid>${esc(process.env.SAGE_COMPANY_ID)}</companyid><password>${esc(process.env.SAGE_USER_PASSWORD)}</password><locationid>E-ECF</locationid></login></authentication><content><function controlid="p${Date.now()}">${fn}</function></content></operation></request>`;}
function post(xml){return new Promise((res,rej)=>{const b='xmlrequest='+encodeURIComponent(xml);const q=https.request({hostname:'api.intacct.com',path:'/ia/xml/xmlgw.phtml',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(b)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d));});q.on('error',rej);q.write(b);q.end();});}
(async () => {
  const r = await post(buildXml('<inspect><object>ARPYMTDETAIL</object></inspect>'));
  const fields = [...r.matchAll(/<Field>([^<]+)<\/Field>/gi)].map(m => m[1]);
  console.log('ARPYMTDETAIL fields:', fields.join(', ') || r.slice(0, 400));
  // sample rows
  const q = await post(buildXml('<query><object>ARPYMTDETAIL</object><select><field>RECORDNO</field><field>RECORDKEY</field><field>PAYMENTDATE</field><field>TRX_PAYMENTAMOUNT</field></select><pagesize>3</pagesize></query>'));
  console.log('sample:', (q.match(/<ARPYMTDETAIL>[\s\S]*?<\/ARPYMTDETAIL>/i) || [q.slice(0, 500)])[0].slice(0, 400));
})().catch(e => console.error('ERR', e.message));
