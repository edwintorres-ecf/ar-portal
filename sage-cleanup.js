'use strict';
const fs = require('fs');
let src = fs.readFileSync('/home/ecf-admin/ar-portal/sage.js', 'utf8');

// Remove all debug log lines
src = src.replace(/\n    if \(res\.length < 2000\) console\.log\("\[sage-debug\] FULL RESPONSE:", res\);/g, '');
src = src.replace(/\n    const arinvCount = .*ARINVOICE_blocks.*\n/g, '\n');
src = src.replace(/\n    const dataLine = .*\n/g, '\n');
src = src.replace(/console\.log\('\[sage\] data tag:'.*\);\s*/g, '');
src = src.replace(/console\.log\('\[sage\] numremaining:'.*\);\s*/g, '');
src = src.replace(/\n    const cfg = getSageConfig\(\); console\.log.*\n/g, '\n');

// Simplify getSageConfig debug log
src = src.replace(
  /\s*if \(!cfg\.senderPassword[\s\S]*?try \{[\s\S]*?catch \(e\) \{ \/\* ignore \*\/ \}\s*\}\s*return cfg;/,
  `
  if (!cfg.senderPassword || !cfg.userPassword) {
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
  return cfg;`
);

fs.writeFileSync('/home/ecf-admin/ar-portal/sage.js', src);
console.log('Cleanup done. Line count:', src.split('\n').length);
