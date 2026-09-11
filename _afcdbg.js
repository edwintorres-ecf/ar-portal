// Show the RAW gateway response for the ar-full-check query, at E-ECF.
require("dotenv").config({ path: "/home/ecf-admin/ar-portal/.env" });
const https = require("https");
const C = {
  companyid: process.env.SAGE_COMPANY_ID, userid: process.env.SAGE_USER_ID,
  pw: process.env.SAGE_USER_PW, sid: process.env.SAGE_SENDER_ID, spw: process.env.SAGE_SENDER_PW,
};
function xml(entity, body) {
  const tag = entity ? `<locationid>${entity}</locationid>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<request><control><senderid>${C.sid}</senderid><password>${C.spw}</password><controlid>dbg-${Date.now()}</controlid><uniqueid>false</uniqueid><dtdversion>3.0</dtdversion><includewhitespace>false</includewhitespace></control>
<operation><authentication><login><userid>${C.userid}</userid><companyid>${C.companyid}</companyid><password>${C.pw}</password>${tag}</login></authentication>
<content><function controlid="fn1">${body}</function></content></operation></request>`;
}
function post(x) { return new Promise((res, rej) => {
  const b = "xmlrequest=" + encodeURIComponent(x);
  const r = https.request({ hostname: "api.intacct.com", path: "/ia/xml/xmlgw.phtml", method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(b) } },
    s => { let d = ""; s.on("data", c => d += c); s.on("end", () => res(d)); });
  r.on("error", rej); r.write(b); r.end();
}); }
(async () => {
  const q = `<query><object>ARINVOICE</object><select><field>RECORDNO</field><field>RECORDID</field></select><filter><greaterthan><field>TOTALDUE</field><value>0</value></greaterthan></filter><pagesize>1</pagesize><offset>0</offset></query>`;
  const out = await post(xml("E-ECF", q));
  console.log(out.slice(0, 2500));
})();
