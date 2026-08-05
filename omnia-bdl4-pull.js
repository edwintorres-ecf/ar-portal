'use strict';
/**
 * omnia-bdl4-pull.js — Download BDL4 invoice PDFs from Omnia
 * Runs on ecf-spark. Uses existing omnia.js login/fetch logic.
 * Must be run from /home/ecf-admin/ar-portal/ directory.
 */

const fs   = require('fs');
const path = require('path');

// Load .env
const envPath = '/home/ecf-admin/ar-portal/.env';
const envText = fs.readFileSync(envPath, 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) {
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    process.env[m[1]] = val;
  }
}

// omnia.js uses relative require for playwright-core, so must run from ar-portal
const { fetchInvoicePdf } = require('./omnia.js');

const OUT_DIR = '/home/ecf-admin/omnia-bdl4';
fs.mkdirSync(OUT_DIR, { recursive: true });

const INVOICES = [
  // AST prefixes (54)
  'AST-002757','AST-002755','AST-002746','AST-002744','AST-002402','AST-002403',
  'AST-002422','AST-002424','AST-002540','AST-002542','AST-002455','AST-002457',
  'AST-002527','AST-002529','AST-002496','AST-002498','AST-002558','AST-002560',
  'AST-002515','AST-002517','AST-002471','AST-002473','AST-002442','AST-002444',
  'AST-002390','AST-002391','AST-002248','AST-002230','AST-002228','AST-002296',
  'AST-002297','AST-002284','AST-002285','AST-002218','AST-002219','AST-002244',
  'AST-002242','AST-002269','AST-002268','AST-002345','AST-002346','AST-002328',
  'AST-002333','AST-002097','AST-002099','AST-002109','AST-002108','AST-001984',
  'AST-001974','AST-002008','AST-002015','AST-002039','AST-001666','AST-001665',
  // S- prefixes (32)
  'S-8889','S-8916','S-8966','S-8947','S-8992','S-7815','S-7888','S-7885',
  'S-7876','S-7708','S-7709','S-7455','S-7180','S-7154','S-7476','S-7481',
  'S-7112','S-6595','S-6601','S-6599','S-6608','S-6607','S-6618','S-6615',
  'S-6564','S-6558','S-6568','S-6567','S-6578','S-6586','S-6577','S-6585',
];

const summary = {
  total:      INVOICES.length,
  downloaded: [],
  failed:     [],
  notFound:   [],
};

async function main() {
  console.log(`[bdl4] Starting BDL4 pull — ${INVOICES.length} invoices`);

  for (let i = 0; i < INVOICES.length; i++) {
    const inv = INVOICES[i];
    console.log(`[bdl4] [${i+1}/${INVOICES.length}] Fetching ${inv}...`);

    try {
      const result = await fetchInvoicePdf(inv);

      if (result.found) {
        const outPath = path.join(OUT_DIR, `${inv}.pdf`);
        fs.writeFileSync(outPath, result.buf);
        const kb = Math.round(result.buf.length / 1024);
        console.log(`[bdl4]   ✓ ${inv} → ${kb} KB`);
        summary.downloaded.push({ inv, kb, path: outPath });
      } else if (result.error && result.error.includes('not found')) {
        console.log(`[bdl4]   404 ${inv}: ${result.error}`);
        summary.notFound.push({ inv, error: result.error });
      } else {
        console.log(`[bdl4]   FAIL ${inv}: ${result.error}`);
        summary.failed.push({ inv, error: result.error });
      }
    } catch (e) {
      console.log(`[bdl4]   ERROR ${inv}: ${e.message}`);
      summary.failed.push({ inv, error: e.message });
    }

    // Small delay to avoid hammering the API
    await new Promise(r => setTimeout(r, 300));
  }

  // Write summary
  const summaryPath = path.join(OUT_DIR, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log('\n[bdl4] ═══════════ SUMMARY ═══════════');
  console.log(`[bdl4] Total attempted: ${summary.total}`);
  console.log(`[bdl4] Downloaded:      ${summary.downloaded.length}`);
  console.log(`[bdl4] Not found (404): ${summary.notFound.length}`);
  console.log(`[bdl4] Failed:          ${summary.failed.length}`);
  if (summary.notFound.length) {
    console.log(`[bdl4] 404s: ${summary.notFound.map(x=>x.inv).join(', ')}`);
  }
  if (summary.failed.length) {
    console.log(`[bdl4] Failures:`);
    for (const f of summary.failed) {
      console.log(`[bdl4]   ${f.inv}: ${f.error}`);
    }
  }
  console.log(`[bdl4] Summary written to ${summaryPath}`);

  process.exit(0);
}

main().catch(e => {
  console.error('[bdl4] Fatal:', e);
  process.exit(1);
});
