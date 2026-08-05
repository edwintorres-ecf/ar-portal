'use strict';
const fs = require('fs');
let src = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');

// Fix 1: INVOICEID → RECORDID (Sage uses RECORDID for the invoice number string)
src = src.replace(/<field>INVOICEID<\/field>/g, '<field>RECORDID</field>');
src = src.replace(/extractTag\(block, 'INVOICEID'\)/g, "extractTag(block, 'RECORDID')");
src = src.replace(/invoiceId\s*=\s*extractTag\(block, 'INVOICEID'\)/g, "invoiceId = extractTag(block, 'RECORDID')");

// Fix 2: add a raw console.log to show what getSageConfig returns, and what response comes back (debug)
// Actually just ensure env is read correctly — replace getSageConfig to log
const oldGetConfig = `function getSageConfig() {
  return {
    senderId:       process.env.SAGE_SENDER_ID       || 'eastcoast',
    senderPassword: process.env.SAGE_SENDER_PASSWORD || '',
    companyId:      process.env.SAGE_COMPANY_ID      || 'eastcoast',
    userId:         process.env.SAGE_USER_ID         || 'OpenClaw',
    userPassword:   process.env.SAGE_USER_PASSWORD   || '',
  };
}`;
const newGetConfig = `function getSageConfig() {
  const cfg = {
    senderId:       process.env.SAGE_SENDER_ID       || 'eastcoast',
    senderPassword: process.env.SAGE_SENDER_PASSWORD || '',
    companyId:      process.env.SAGE_COMPANY_ID      || 'eastcoast',
    userId:         process.env.SAGE_USER_ID         || 'OpenClaw',
    userPassword:   process.env.SAGE_USER_PASSWORD   || '',
  };
  if (!cfg.senderPassword || !cfg.userPassword) {
    // Fallback: load directly from .env file if dotenv didn't populate
    try {
      const envPath = require('path').join(__dirname, '.env');
      const lines = require('fs').readFileSync(envPath, 'utf8').split('\\n');
      for (const line of lines) {
        const m = line.match(/^([^#=]+)="?([^"\\n]*)"?/);
        if (!m) continue;
        const k = m[1].trim(), v = m[2].trim();
        if (k === 'SAGE_SENDER_PASSWORD' && !cfg.senderPassword) cfg.senderPassword = v;
        if (k === 'SAGE_USER_PASSWORD'   && !cfg.userPassword)   cfg.userPassword   = v;
        if (k === 'SAGE_SENDER_ID'       && !cfg.senderId)       cfg.senderId       = v;
        if (k === 'SAGE_COMPANY_ID'      && !cfg.companyId)      cfg.companyId      = v;
        if (k === 'SAGE_USER_ID'         && !cfg.userId)         cfg.userId         = v;
      }
    } catch (e) { /* ignore */ }
  }
  return cfg;
}`;

if (src.includes(oldGetConfig)) {
  src = src.replace(oldGetConfig, newGetConfig);
  console.log('getSageConfig patched');
} else {
  console.log('WARNING: getSageConfig not found verbatim — patching manually');
  src = src.replace(/function getSageConfig\(\) \{[\s\S]*?\n\}/m, newGetConfig);
}

// Also add a log line in queryAllInvoices to show cfg values (password length only)
src = src.replace(
  "const pageSize = 1000;",
  "const cfg = getSageConfig(); console.log('[sage-debug] sender:', cfg.senderId, 'pw_len:', cfg.senderPassword.length, 'upw_len:', cfg.userPassword.length);\n  const pageSize = 1000;"
);

fs.writeFileSync('/home/ecf-admin/ar-portal/sage.js', src);
console.log('Done. Checking INVOICEID refs remaining:', (src.match(/INVOICEID/g) || []).length);
