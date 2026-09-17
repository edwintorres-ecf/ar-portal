// Email the intake-health worklist to Vincenzo, cc Edwin and Eliana.
// Authorised by Edwin, 2026-09-17. One send, internal recipients only.
'use strict';
require('dotenv').config();
const fs = require('fs');
const g = require('./graph');
const sage = require('./sage');

const TO = ['vincenzo.carnemolla@eastcoastfacilities.com'];
const CC = ['edwin.torres@eastcoastfacilities.com', 'E.Torres@eastcoastfacilities.com'];
const FILE = '/tmp/ECF-PO-intake-health.xlsx';

(async () => {
  const inv = sage.getCachedInvoices().length ? sage.getCachedInvoices() : await sage.getInvoices();
  const { analysis: a } = require('./po-intake-workbook').build(inv);
  const money = n => '$' + Math.round(n || 0).toLocaleString('en-US');

  // Everyone is internal; the allowlist permits the domain, but check anyway
  // rather than discovering a block after the fact.
  const allow = (process.env.COMMS_ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const permitted = e => !allow.length || allow.some(a2 => a2.startsWith('@') ? e.toLowerCase().endsWith(a2) : e.toLowerCase() === a2);
  const blocked = [...TO, ...CC].filter(e => !permitted(e));
  if (blocked.length) { console.error('BLOCKED by allowlist:', blocked.join(', ')); process.exit(1); }

  const top = a.pos.filter(p => p.blocking).slice(0, 5);
  const rows = top.map(p => `<tr>
      <td style="padding:4px 10px 4px 0"><strong>${p.poNumber}</strong></td>
      <td style="padding:4px 10px 4px 0">${p.siteCode || '—'}</td>
      <td style="padding:4px 10px 4px 0;text-align:right">${money(p.pendingUpload)}</td>
      <td style="padding:4px 0">${p.defects.map(d => (a.checks.find(c => c.key === d) || {}).label || d).join('; ')}</td>
    </tr>`).join('');

  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1a1814;line-height:1.55">
    <p>Vincenzo,</p>
    <p>Attached is the current Amazon PO intake list to work through, straight from the AR Portal
       (<em>PO Manager &rsaquo; Intake health</em>).</p>
    <p><strong>${a.totals.posWithDefects} POs need attention.</strong> ${a.totals.blocking} of them cannot be
       billed against at all, and <strong>${money(a.totals.atRisk)} of finished work is already waiting behind
       them.</strong> The rest of the book is fine: ${a.totals.readyPct}% of ${a.totals.posChecked.toLocaleString('en-US')} POs
       are ready to bill.</p>
    <p>The workbook has three tabs:</p>
    <ul>
      <li><strong>Fix these</strong> — one row per PO, sorted so the POs blocking the most money come first.
          Each row says what is wrong and what to do about it. The PO number links to the PO document where we have one.</li>
      <li><strong>By problem</strong> — the same POs grouped by cause, since one trip to Amazon often clears a whole group.</li>
      <li><strong>Summary</strong> — where intake stands overall.</li>
    </ul>
    <p>The five holding up the most money:</p>
    <table style="border-collapse:collapse;font-size:13px;margin:8px 0 14px">
      <tr style="text-align:left;color:#6b6458;font-size:11px;text-transform:uppercase">
        <th style="padding:0 10px 4px 0">PO</th><th style="padding:0 10px 4px 0">Site</th>
        <th style="padding:0 10px 4px 0;text-align:right">Waiting</th><th style="padding:0 0 4px">Problem</th>
      </tr>
      ${rows}
    </table>
    <p>The biggest single category is <strong>POs with no value recorded</strong>
       (${(a.checks.find(c => c.key === 'no-ceiling') || {}).count || 0} of them). Without the order value we cannot tell
       whether an invoice fits, so we submit blind and Amazon puts it on Insufficient PO Funds Hold. Clearing those
       has the most effect per hour spent.</p>
    <p>Worth doing before the October snow POs land, since that is when the volume arrives.</p>
    <p>The portal recalculates this hourly, so the live version is always on the Intake health screen.
       This file is a point-in-time copy from ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} ET.</p>
    <p>Edwin</p>
  </div>`;

  const msg = {
    message: {
      subject: `Amazon PO intake — ${a.totals.posWithDefects} POs to fix, ${money(a.totals.atRisk)} of billing held up`,
      body: { contentType: 'HTML', content: html },
      toRecipients: TO.map(e => ({ emailAddress: { address: e } })),
      ccRecipients: CC.map(e => ({ emailAddress: { address: e } })),
      attachments: [{
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'ECF-PO-intake-health.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        contentBytes: fs.readFileSync(FILE).toString('base64'),
      }],
    },
    saveToSentItems: true,
  };

  console.log('from :', g.mailbox());
  console.log('to   :', TO.join(', '));
  console.log('cc   :', CC.join(', '));
  console.log('subj :', msg.message.subject);
  console.log('file :', fs.statSync(FILE).size, 'bytes');

  await g.gPost(`/users/${g.mailbox()}/sendMail`, msg);
  console.log('\nSENT');

  // Confirm from Sent Items rather than trusting the 202.
  await new Promise(r => setTimeout(r, 5000));
  const sent = await g.gGet(`/users/${g.mailbox()}/mailFolders/sentitems/messages`
    + `?$top=1&$select=subject,sentDateTime,hasAttachments,toRecipients,ccRecipients`);
  const m = (sent.value || [])[0];
  console.log('sent item :', m && m.subject);
  console.log('  at      :', m && m.sentDateTime);
  console.log('  to      :', m && m.toRecipients.map(r => r.emailAddress.address).join(', '));
  console.log('  cc      :', m && m.ccRecipients.map(r => r.emailAddress.address).join(', '));
  console.log('  attached:', m && m.hasAttachments);
})();
