'use strict';
// ─── comms-probe.js — manual acceptance test for the AR comms mailbox ────────
// Usage: node comms-probe.js recipient@eastcoastfacilities.com
//
// Verifies the whole Deploy-1 prerequisite chain in one shot:
//   AR_MAILBOX set → app token works → Mail.ReadWrite grants draft creation in
//   invoices@ → draft carries id/internetMessageId/conversationId → send works.
// This is the draft-then-send pattern the comms service will use (sendMail
// alone returns an empty 202 and loses the message identifiers threading needs).
//
// Guard: recipient must be an @eastcoastfacilities.com address, and must be in
// COMMS_ALLOWLIST when that is set. The probe can never mail a customer.

const graph = require('./graph');

async function main() {
  const to = graph.normEmail(process.argv[2]);
  if (!to) { console.error('usage: node comms-probe.js <recipient@eastcoastfacilities.com>'); process.exit(2); }
  if (!to.endsWith('@eastcoastfacilities.com')) {
    console.error(`✗ refusing: ${to} is not an internal address`); process.exit(2);
  }
  const allow = (process.env.COMMS_ALLOWLIST || '').split(',').map(graph.normEmail).filter(Boolean);
  if (allow.length && !allow.includes(to)) {
    console.error(`✗ refusing: ${to} is not in COMMS_ALLOWLIST`); process.exit(2);
  }

  const mb = graph.mailbox();
  console.log(`[probe] mailbox: ${mb}`);

  const stamp = new Date().toISOString();
  const draft = await graph.gPost(`/users/${mb}/messages`, {
    subject: `[AR Portal] comms probe ${stamp}`,
    body: {
      contentType: 'Text',
      content: `AR Portal communications probe.\n\nSent ${stamp} via draft-then-send from ${mb}.\nIf you received this, the application access policy and Mail.ReadWrite grant are working.`,
    },
    toRecipients: [{ emailAddress: { address: to } }],
  });
  console.log(`[probe] draft created:`);
  console.log(`  graph id:            ${draft.id}`);
  console.log(`  internetMessageId:   ${draft.internetMessageId}`);
  console.log(`  conversationId:      ${draft.conversationId}`);

  await graph.gPost(`/users/${mb}/messages/${encodeURIComponent(draft.id)}/send`);
  console.log(`[probe] ✓ sent to ${to} — check the inbox and the ${mb} Sent Items folder`);
}

main().catch(e => { console.error('[probe] FAILED:', e.message); process.exit(1); });
