// Search the whole Accounting site for any file naming this PO, not just the
// three Purchase Orders folders po-doc-watcher scans.
const w = require('./po-doc-watcher');
const fs = require('fs');
const src = fs.readFileSync('po-doc-watcher.js', 'utf8');
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SITE_ID = (src.match(/SITE_ID\s*=\s*['"`]([^'"`]+)/) || [])[1]
  || process.env.SP_SITE_ID || (src.match(/SITE_ID\s*=\s*process\.env\.(\w+)/) && process.env[src.match(/SITE_ID\s*=\s*process\.env\.(\w+)/)[1]]);
(async () => {
  // reuse the watcher's token plumbing by calling its internals through a fetch
  const tok = await (async () => {
    const m = src.match(/async function getToken\(\)[\s\S]*?\n}/);
    const fn = new Function('require', 'process', 'fetch', `${m[0]}; return getToken;`)(require, process, fetch);
    return fn();
  })();
  const q = '20599848';
  const url = `${GRAPH}/sites/${SITE_ID}/drive/root/search(q='${q}')?$top=50&$select=name,webUrl,lastModifiedDateTime,parentReference`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
  const j = await res.json();
  if (!res.ok) { console.log('search failed', res.status, JSON.stringify(j).slice(0, 300)); return; }
  console.log(`files anywhere on the site matching "${q}": ${(j.value || []).length}`);
  for (const f of j.value || []) {
    console.log(`  ${f.lastModifiedDateTime}  ${f.name}`);
    console.log(`     folder: ${(f.parentReference && f.parentReference.path) || ''}`);
  }
})();
