'use strict';
/**
 * sage.js — Sage Intacct XML API integration for ECF AR Portal
 * Queries ARINVOICE, computes aging buckets, 15-minute in-memory cache.
 */

const https = require('https');
const fs   = require('fs');
const path = require('path');
const db = require('./db');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ─── Sage config from environment ─────────────────────────────────────────
function getSageConfig() {
  const cfg = {
    senderId:       process.env.SAGE_SENDER_ID       || 'eastcoast',
    senderPassword: process.env.SAGE_SENDER_PASSWORD || '',
    companyId:      process.env.SAGE_COMPANY_ID      || 'eastcoast',
    userId:         process.env.SAGE_USER_ID         || 'OpenClaw',
    userPassword:   process.env.SAGE_USER_PASSWORD   || '',
  };
  if (!cfg.senderPassword || !cfg.userPassword) {
    try {
      const envPath = require('path').join(__dirname, '.env');
      const lines = require('fs').readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.match(/^([^#=]+)="?([^"\n]*)"?/);
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
}

// ─── Cache ──────────────────────────────────────────────────────────────────
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ─── Disk cache ───────────────────────────────────────────────────────────────
const CACHE_DIR  = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'invoices.json');
const CACHE_TMP  = path.join(CACHE_DIR, '.invoices.json.tmp');
const DISK_CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

// Ensure cache dir exists
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* ignore */ }

// Pre-indexes (bucket / location / customer)
let _indexByBucket   = new Map();
let _indexByLocation = new Map();
let _indexByCustomer = new Map();

// ─── Startup: load disk cache if fresh ────────────────────────────────────────
(function loadDiskCache() {
  try {
    const raw  = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const age  = Date.now() - (data.ts || 0);
    if (age < DISK_CACHE_MAX_AGE_MS && Array.isArray(data.invoices) && data.invoices.length > 0) {
      _cache   = data.invoices;
      _cacheTs = data.ts;
      const ageMin = Math.round(age / 60000);
      console.log('[sage] Loaded disk cache: ' + _cache.length + ' invoices (age ' + ageMin + 'm)');
      // Build indexes from disk cache too
      buildIndexes(_cache);
    }
  } catch (e) {
    // No disk cache yet or parse error — normal on first run
  }
})();

// ─── XML Builder ────────────────────────────────────────────────────────────
function buildXml(functionXml) {
  const cfg = getSageConfig();
  const controlId = 'ar-portal-' + Date.now();
  return `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <control>
    <senderid>${cfg.senderId}</senderid>
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
        ${functionXml}
      </function>
    </content>
  </operation>
</request>`;
}

function escXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── HTTP POST to Sage ───────────────────────────────────────────────────────
function sagePost(xml) {
  return new Promise((resolve, reject) => {
    const body = 'xmlrequest=' + encodeURIComponent(xml);
    const buf  = Buffer.from(body);
    const req  = https.request({
      hostname: 'api.intacct.com',
      path:     '/ia/xml/xmlgw.phtml',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': buf.byteLength,
        'User-Agent':     'ECF-AR-Portal/1.0',
        'Connection':     'keep-alive',
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      res.on('end', () => {
        const full = Buffer.concat(chunks).toString('utf8');
        resolve(full);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy(new Error('Sage request timeout'));
    });
    req.write(buf);
    req.end();
  });
}

// ─── XML Parsing helpers ────────────────────────────────────────────────────
// Intacct's responses XML-escape text content (e.g. "Robins & Morton" comes
// back as "Robins &amp; Morton"). Without decoding here, that escaped text
// gets HTML-escaped again on render and shows up literally as "&amp;" on
// screen — decode once, at the single point everything is extracted from.
function decodeXmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

function parseFloat2(v) {
  const n = parseFloat(String(v || '0').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function computeAgingBucket(dueDateStr) {
  if (!dueDateStr) return { bucket: 'current', daysOverdue: 0 };
  const due = new Date(dueDateStr);
  const now = new Date();
  // Compare date-only (strip time)
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs = today - dueDay;
  const daysOverdue = Math.floor(diffMs / 86400000);

  let bucket;
  if (daysOverdue <= 0)       bucket = 'current';
  else if (daysOverdue <= 30) bucket = '1-30';
  else if (daysOverdue <= 60) bucket = '31-60';
  else if (daysOverdue <= 90) bucket = '61-90';
  else                        bucket = '91+';

  return { bucket, daysOverdue: Math.max(0, daysOverdue) };
}

// ─── Main query — paginate through all open invoices ──────────────────────
async function queryAllInvoices() {
  const pageSize = 1000;
  let offset = 0;
  let allInvoices = [];
  let hasMore = true;

  while (hasMore) {
    const functionXml = `
      <query>
        <object>ARINVOICE</object>
        <select>
          <field>RECORDNO</field>
          <field>RECORDID</field>
          <field>CUSTOMERID</field>
          <field>CUSTOMERNAME</field>
          <field>WHENCREATED</field>
          <field>WHENDUE</field>
          <field>TOTALENTERED</field>
          <field>TOTALDUE</field>
          <field>CURRENCY</field>
          <field>STATE</field>
          <field>DESCRIPTION</field>
          <field>SUPDOCID</field>
          <field>DOCNUMBER</field>
          <field>SHIPTO.CONTACTNAME</field>
        </select>
        <filter>
          <greaterthan>
            <field>TOTALDUE</field>
            <value>0</value>
          </greaterthan>
        </filter>
        <pagesize>${pageSize}</pagesize>
        <offset>${offset}</offset>
        <orderby>
          <order>
            <field>WHENDUE</field>
            <ascending/>
          </order>
        </orderby>
      </query>
    `;

    const xml = buildXml(functionXml);
const res = await sagePost(xml);

    const status = extractTag(res, 'status');
    if (status !== 'success') {
      const errMsg = extractTag(res, 'description2') || extractTag(res, 'description') || 'Unknown error';
      throw new Error('Sage query failed: ' + errMsg);
    }

    const batch = parseInvoices(res);
    allInvoices = allInvoices.concat(batch);

    // Check if there are more pages — numremaining is a <data> attribute
    const dataAttrMatch = res.match(/<data[^>]+numremaining="(\d+)"/i);
    const numRemaining = dataAttrMatch ? parseInt(dataAttrMatch[1]) : 0;
    const totalCountAttr = res.match(/<data[^>]+totalcount="(\d+)"/i);
    hasMore = numRemaining > 0;
    offset += pageSize;

    // Safety: stop if we've done many pages
    if (offset > 10000) break;
  }

  return allInvoices;
}

function parseInvoices(xml) {
  const blocks = [];
  const re = /<ARINVOICE>([\s\S]*?)<\/ARINVOICE>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const dueDate = extractTag(block, 'WHENDUE');
    const { bucket, daysOverdue } = computeAgingBucket(dueDate);

    const invoiceId  = extractTag(block, 'RECORDID')    || '';
    const recordNo   = extractTag(block, 'RECORDNO')     || '';
    const customerId = extractTag(block, 'CUSTOMERID')   || '';
    const custName   = extractTag(block, 'CUSTOMERNAME') || customerId;
    const locId      = extractTag(block, 'LOCATIONID') || '';
    const locName    = extractTag(block, 'LOCATIONNAME') || locId || '';
    const totalEntered = parseFloat2(extractTag(block, 'TOTALENTERED'));
    const totalDue     = parseFloat2(extractTag(block, 'TOTALDUE'));
    const recordUrl    = null; // RECORDURL not queryable via XML API

    blocks.push({
      recordNo,
      invoiceId,
      customerId,
      customerName: custName,
      locationId: locId,
      locationName: locName,
      whenCreated: extractTag(block, 'WHENCREATED') || null,
      whenDue: dueDate || null,
      totalEntered,
      totalDue,
      currency: extractTag(block, 'CURRENCY') || 'USD',
      state: extractTag(block, 'STATE') || '',
      poNumber: extractTag(block, 'DOCNUMBER') || '',
      siteCode: (extractTag(block, 'SHIPTO.CONTACTNAME') || '').replace(/^amazon\s+/i, '').trim(),
      description: extractTag(block, 'DESCRIPTION') || '',
      recordUrl,
      supdocId: extractTag(block, 'SUPDOCID') || '',
      bucket,
      daysOverdue,
    });
  }
  return blocks;
}

// ─── Cache management ───────────────────────────────────────────────────────
// ─── ECI- / SODOCUMENT query ────────────────────────────────────────────────
async function queryEciInvoices() {
  const pageSize = 1000;
  let offset = 0;
  let allInvoices = [];
  let hasMore = true;

  while (hasMore) {
    const functionXml = `
      <query>
        <object>SODOCUMENT</object>
        <select>
          <field>RECORDNO</field>
          <field>DOCNO</field>
          <field>CUSTOMERID</field>
          <field>CUSTOMERNAME</field>
          <field>WHENCREATED</field>
          <field>WHENDUE</field>
          <field>TOTALENTERED</field>
          <field>TOTALDUE</field>
          <field>CURRENCY</field>
          <field>STATE</field>
          <field>LOCATIONID</field>
          <field>LOCATIONNAME</field>
          <field>PONUMBER</field>
          <field>DESCRIPTION</field>
          <field>SUPDOCID</field>
        </select>
        <filter>
          <and>
            <equalto>
              <field>DOCPARID</field>
              <value>Sales Invoice</value>
            </equalto>
            <greaterthan>
              <field>TOTALDUE</field>
              <value>0</value>
            </greaterthan>
          </and>
        </filter>
        <pagesize>${pageSize}</pagesize>
        <offset>${offset}</offset>
        <orderby>
          <order>
            <field>WHENDUE</field>
            <ascending/>
          </order>
        </orderby>
      </query>
    `;

    const xml = buildXml(functionXml);
    const res = await sagePost(xml);

    const status = extractTag(res, 'status');
    if (status !== 'success') {
      const errMsg = extractTag(res, 'description2') || extractTag(res, 'description') || 'Unknown error';
      const errCode = extractTag(res, 'errorno') || '';
      // If SODOCUMENT is not available (permission or module issue), return empty gracefully
      console.warn(`[sage] ECI query failed [${errCode}]: ${errMsg} — returning empty`);
      return [];
    }

    const batch = parseEciInvoices(res);
    allInvoices = allInvoices.concat(batch);

    const dataAttrMatch = res.match(/<data[^>]+numremaining="(\d+)"/i);
    const numRemaining = dataAttrMatch ? parseInt(dataAttrMatch[1]) : 0;
    hasMore = numRemaining > 0;
    offset += pageSize;

    if (offset > 10000) break;
  }

  return allInvoices;
}

function parseEciInvoices(xml) {
  const blocks = [];
  const re = /<SODOCUMENT>([\s\S]*?)<\/SODOCUMENT>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const dueDate = extractTag(block, 'WHENDUE');
    const { bucket, daysOverdue } = computeAgingBucket(dueDate);

    const invoiceId   = extractTag(block, 'DOCNO')        || '';
    const recordNo    = extractTag(block, 'RECORDNO')      || '';
    const customerId  = extractTag(block, 'CUSTOMERID')    || '';
    const custName    = extractTag(block, 'CUSTOMERNAME')  || customerId;
    const locId       = extractTag(block, 'LOCATIONID')    || '';
    const locName     = extractTag(block, 'LOCATIONNAME')  || locId || '';
    const totalEntered = parseFloat2(extractTag(block, 'TOTALENTERED'));
    const totalDue     = parseFloat2(extractTag(block, 'TOTALDUE'));
    const supdocId     = extractTag(block, 'SUPDOCID')     || '';

    blocks.push({
      recordNo,
      invoiceId,
      customerId,
      customerName: custName,
      locationId: locId,
      locationName: locName,
      whenCreated: extractTag(block, 'WHENCREATED') || null,
      whenDue: dueDate || null,
      totalEntered,
      totalDue,
      currency: extractTag(block, 'CURRENCY') || 'USD',
      state: extractTag(block, 'STATE') || '',
      poNumber: extractTag(block, 'PONUMBER') || '',
      description: extractTag(block, 'DESCRIPTION') || '',
      recordUrl: null,
      supdocId,
      bucket,
      daysOverdue,
      source: 'oe',
    });
  }
  return blocks;
}

// ─── ECI PDF fetch via SUPDOC attachment ────────────────────────────────────
// invoiceId: ECI- invoice ID string (e.g. ECI-023752)
// supdocIdHint: optional SUPDOCID already known from ARINVOICE cache (avoids extra query)
async function fetchEciPdf(invoiceId, supdocIdHint) {
  try {
    let supdocId = supdocIdHint || '';

    if (!supdocId) {
      // Look up ARINVOICE by RECORDID to get SUPDOCID
      const queryXml = buildXml(`
        <query>
          <object>ARINVOICE</object>
          <select>
            <field>RECORDNO</field>
            <field>RECORDID</field>
            <field>SUPDOCID</field>
          </select>
          <filter>
            <equalto>
              <field>RECORDID</field>
              <value>${escXml(String(invoiceId))}</value>
            </equalto>
          </filter>
          <pagesize>1</pagesize>
          <offset>0</offset>
        </query>
      `);
      const queryRes = await sagePost(queryXml);
      supdocId = extractTag(queryRes, 'SUPDOCID') || '';
      if (!supdocId) {
        return { ok: false, error: 'No PDF attachment on invoice ' + invoiceId };
      }
    }

    // Read SUPDOC to get file attachment
    const supdocXml = buildXml(`
      <read>
        <object>SUPDOC</object>
        <keys>${escXml(supdocId)}</keys>
        <fields>RECORDNO,SUPDOCID,SUPDOCNAME,ATTACHMENTS</fields>
      </read>
    `);
    const supdocRes = await sagePost(supdocXml);

    // Try all known field names for base64 attachment data
    const fileData = extractTag(supdocRes, 'DATA')
      || extractTag(supdocRes, 'FILEDATA')
      || extractTag(supdocRes, 'ATTACHMENTDATA')
      || '';

    if (fileData) {
      const buffer = Buffer.from(fileData, 'base64');
      return { ok: true, buffer, mimeType: 'application/pdf' };
    }

    // SUPDOC found but no inline file data — log for debugging
    console.warn('[sage] fetchEciPdf: SUPDOC', supdocId, 'found but no file data. Snippet:', supdocRes.slice(0, 500));
    return { ok: false, error: 'PDF attachment record exists but contains no file data' };

  } catch (e) {
    console.error('[sage] fetchEciPdf error:', e.message);
    return { ok: false, error: e.message };
  }
}

function buildIndexes(invoices) {
  _indexByBucket   = new Map();
  _indexByLocation = new Map();
  _indexByCustomer = new Map();
  for (const inv of invoices) {
    // bucket
    if (!_indexByBucket.has(inv.bucket)) _indexByBucket.set(inv.bucket, []);
    _indexByBucket.get(inv.bucket).push(inv);
    // location
    const loc = inv.locationId || '';
    if (!_indexByLocation.has(loc)) _indexByLocation.set(loc, []);
    _indexByLocation.get(loc).push(inv);
    // customer
    const cust = inv.customerId || '';
    if (!_indexByCustomer.has(cust)) _indexByCustomer.set(cust, []);
    _indexByCustomer.get(cust).push(inv);
  }
}

function getByBucket(bucket)       { return _indexByBucket.get(bucket)      || []; }
function getByLocation(locationId) { return _indexByLocation.get(locationId) || []; }
function getByCustomer(customerId) { return _indexByCustomer.get(customerId) || []; }

async function getInvoices(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cache && (now - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  console.log('[sage] Fetching invoices: ARINVOICE (Omnia-prefix open) + SODOCUMENT (ECI-)...');

  // Run in parallel — both are Sage XML API calls, no Chromium needed
  const [arInvoices, eciInvoices] = await Promise.all([
    queryAllInvoices().catch(e => { console.warn('[sage] ARINVOICE query error:', e.message); return []; }),
    queryEciInvoices().catch(e => { console.warn('[sage] ECI/OE query error:', e.message); return []; }),
  ]);

  // Tag all ARINVOICE results by source prefix
  const omniaInvoices = arInvoices
    .filter(i => /^(S|SPI|AST|ASTM|SS|STM)-/i.test(i.invoiceId || ''))
    .map(i => ({ ...i, source: 'omnia' }));
  const eciArInvoices = arInvoices
    .filter(i => /^ECI-/i.test(i.invoiceId || ''))
    .map(i => ({ ...i, source: 'eci-ar' }));
  const otherArInvoices = arInvoices
    .filter(i => !/^(S|SPI|AST|ASTM|SS|STM|ECI)-/i.test(i.invoiceId || ''))
    .map(i => ({ ...i, source: 'ar' }));

  console.log('[sage] ARINVOICE open — Omnia-prefix: ' + omniaInvoices.length + ', ECI-: ' + eciArInvoices.length + ', other: ' + otherArInvoices.length + ', SODOCUMENT ECI: ' + eciInvoices.length);

  // Merge — all ARINVOICE records first, then SODOCUMENT ECI- fills gaps
  // SODOCUMENT ECI- wins over ARINVOICE ECI- for richer OE data (location, PO, etc.)
  const seen = new Map();
  // Load ARINVOICE records (Omnia + ECI + other)
  for (const inv of [...omniaInvoices, ...eciArInvoices, ...otherArInvoices]) {
    if (inv.invoiceId) seen.set(inv.invoiceId, inv);
    else seen.set(inv.recordNo, inv);
  }
  // SODOCUMENT ECI- overwrites if present (has richer location/PO data)
  for (const inv of eciInvoices) {
    seen.set(inv.invoiceId || inv.recordNo, { ...inv, source: 'eci-oe' });
  }

  let invoices = [...seen.values()];

  // Enrich locations for AR-sourced invoices
  const needsEnrich = invoices.filter(i => i.source === 'omnia' || i.source === 'eci-ar' || i.source === 'ar');
  if (needsEnrich.length > 0) {
    invoices = await enrichLocations(invoices);
  }

  // Sort by whenDue ascending
  invoices.sort((a, b) => {
    const da = a.whenDue || '9999';
    const db2 = b.whenDue || '9999';
    return da.localeCompare(db2);
  });

  _cache = invoices;
  _cacheTs = now;
  console.log('[sage] Cached ' + invoices.length + ' total open invoices at ' + new Date().toISOString());

  // Build in-memory indexes
  buildIndexes(invoices);

  // Write disk cache (best-effort, atomic)
  try {
    const payload = JSON.stringify({ ts: now, invoices });
    fs.writeFileSync(CACHE_TMP, payload, 'utf8');
    fs.renameSync(CACHE_TMP, CACHE_FILE);
    console.log('[sage] Disk cache written: ' + invoices.length + ' invoices');
  } catch (e) {
    console.warn('[sage] Disk cache write failed (non-fatal):', e.message);
  }

  return _cache;
}

function getCacheAge() {
  if (!_cacheTs) return null;
  return {
    fetchedAt: new Date(_cacheTs).toISOString(),
    ageMs: Date.now() - _cacheTs,
    nextRefreshMs: Math.max(0, CACHE_TTL_MS - (Date.now() - _cacheTs)),
  };
}

function getCachedInvoices() {
  return _cache || [];
}


// ─── Location Enrichment via ARINVOICEITEM ──────────────────────────────────
// Batches 50 invoice RECORDNO values per readByQuery call on ARINVOICEITEM.
// Results stored in SQLite invoice_location table — never re-fetched.
// First line item's location is used as the invoice location.

const LOCATION_BATCH = 50;

async function fetchAndCacheLocations(recordNos) {
  const batches = [];
  for (let i = 0; i < recordNos.length; i += LOCATION_BATCH) {
    batches.push(recordNos.slice(i, i + LOCATION_BATCH));
  }

  for (const batch of batches) {
    const query = batch.map(rn => `RECORDKEY = ${rn}`).join(' OR ');
    const functionXml = `
      <readByQuery>
        <object>ARINVOICEITEM</object>
        <fields>RECORDNO,RECORDKEY,LOCATIONID,LOCATIONNAME</fields>
        <query>${query}</query>
        <pagesize>1000</pagesize>
      </readByQuery>
    `;
    const xml = buildXml(functionXml);
    try {
      const res = await sagePost(xml);
      const status = extractTag(res, 'status');
      if (status !== 'success') continue;

      // Parse all line items; keep first location seen per RECORDKEY
      const seen = {};
      const re = /<arinvoiceitem>([\s\S]*?)<\/arinvoiceitem>/gi;
      let m;
      while ((m = re.exec(res)) !== null) {
        const block  = m[1];
        const recKey = extractTag(block, 'RECORDKEY') || '';
        if (!recKey || seen[recKey]) continue;
        seen[recKey] = {
          locationId:   extractTag(block, 'LOCATIONID')   || '',
          locationName: extractTag(block, 'LOCATIONNAME') || '',
        };
      }

      // Store in SQLite
      for (const [recKey, loc] of Object.entries(seen)) {
        db.setLocation(recKey, loc.locationId, loc.locationName);
      }

      // Mark any in this batch that had no items (no line items = blank location)
      for (const rn of batch) {
        if (!seen[rn]) db.setLocation(String(rn), '', '');
      }
    } catch (e) {
      // On error, mark the batch as blank so we don't retry forever
      for (const rn of batch) db.setLocation(String(rn), '', '');
    }

    // Small delay between batches
    await new Promise(r => setTimeout(r, 100));
  }
}

async function enrichLocations(invoices) {
  const allRecordNos = invoices.map(i => i.recordNo).filter(Boolean);
  const missing = db.getMissingLocationRecordNos(allRecordNos);

  if (missing.length > 0) {
    console.log(`[sage] Fetching locations for ${missing.length} invoices (${Math.ceil(missing.length / LOCATION_BATCH)} API calls)...`);
    await fetchAndCacheLocations(missing);
    console.log('[sage] Location enrichment complete');
  } else {
    console.log('[sage] All locations cached');
  }

  return invoices.map(inv => {
    const loc = db.getLocation(inv.recordNo);
    return {
      ...inv,
      locationId:   loc ? loc.location_id   : '',
      locationName: loc ? loc.location_name : '',
    };
  });
}

// ─── Customer lookup ─────────────────────────────────────────────────────────
async function getCustomers() {
  const allCustomers = [];
  let offset = 0;
  while (true) {
    const xml = buildXml(`
      <readByQuery>
        <object>CUSTOMER</object>
        <fields>CUSTOMERID,NAME,STATUS</fields>
        <query>STATUS = 'active'</query>
        <pagesize>100</pagesize>
        <offset>${offset}</offset>
      </readByQuery>
    `);
    const resp = await sagePost(xml);
    const matches = [...resp.matchAll(/<customer>([\s\S]*?)<\/customer>/gi)];
    if (!matches.length) break;
    for (const m of matches) {
      const b = m[1];
      const id   = extractTag(b, 'CUSTOMERID') || '';
      const name = extractTag(b, 'NAME') || '';
      if (id) allCustomers.push({ id, name });
    }
    if (matches.length < 100) break;
    offset += 100;
  }
  return allCustomers.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Customer contact lookup (comms platform) ───────────────────────────────
// DISPLAYCONTACT fields only come back via the modern <query>/<select> shape;
// the legacy readByQuery above returns empty rows for dotted fields (verified
// live 2026-08-11). Returns [{id, name, contactName, email1, email2, phone1}]
// for every active customer. Read-only; used by the customer_contacts sync.
async function getCustomerContacts() {
  const pageSize = 1000;
  let offset = 0;
  const rows = [];
  while (true) {
    const xml = buildXml(`
      <query>
        <object>CUSTOMER</object>
        <select>
          <field>CUSTOMERID</field>
          <field>NAME</field>
          <field>STATUS</field>
          <field>DISPLAYCONTACT.CONTACTNAME</field>
          <field>DISPLAYCONTACT.EMAIL1</field>
          <field>DISPLAYCONTACT.EMAIL2</field>
          <field>DISPLAYCONTACT.PHONE1</field>
        </select>
        <filter><equalto><field>STATUS</field><value>active</value></equalto></filter>
        <pagesize>${pageSize}</pagesize>
        <offset>${offset}</offset>
      </query>
    `);
    const resp = await sagePost(xml);
    const status = extractTag(resp, 'status');
    if (status !== 'success') {
      const errMsg = extractTag(resp, 'description2') || extractTag(resp, 'description') || 'Unknown error';
      throw new Error('Sage customer-contact query failed: ' + errMsg);
    }
    const matches = [...resp.matchAll(/<CUSTOMER>([\s\S]*?)<\/CUSTOMER>/g)];
    for (const m of matches) {
      const b = m[1];
      const id = extractTag(b, 'CUSTOMERID') || '';
      if (!id) continue;
      rows.push({
        id,
        name: extractTag(b, 'NAME') || '',
        contactName: extractTag(b, 'DISPLAYCONTACT.CONTACTNAME') || '',
        email1: extractTag(b, 'DISPLAYCONTACT.EMAIL1') || '',
        email2: extractTag(b, 'DISPLAYCONTACT.EMAIL2') || '',
        phone1: extractTag(b, 'DISPLAYCONTACT.PHONE1') || '',
      });
    }
    const numRemaining = parseInt((resp.match(/<data[^>]+numremaining="(\d+)"/i) || [])[1] || '0', 10);
    if (!matches.length || numRemaining <= 0) break;
    offset += pageSize;
  }
  return rows;
}

// ─── RECORDNO lookup for invoices outside the open cache (paid/closed) ──────
async function getRecordNosForInvoiceIds(invoiceIds) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < invoiceIds.length; i += 40) chunks.push(invoiceIds.slice(i, i + 40));
  for (const chunk of chunks) {
    const values = chunk.map(r => `<value>${escXml(String(r))}</value>`).join('');
    const xml = buildXml(`
      <query>
        <object>ARINVOICE</object>
        <select><field>RECORDNO</field><field>RECORDID</field></select>
        <filter><in><field>RECORDID</field>${values}</in></filter>
        <pagesize>1000</pagesize>
      </query>
    `);
    const resp = await sagePost(xml);
    if (extractTag(resp, 'status') !== 'success') continue;
    for (const m of resp.matchAll(/<ARINVOICE>([\s\S]*?)<\/ARINVOICE>/gi)) {
      const id = extractTag(m[1], 'RECORDID');
      const no = extractTag(m[1], 'RECORDNO');
      if (id && no) out[id] = no;
    }
  }
  return out;
}

// ─── Full invoice lookup by RECORDID, any state (incl. paid/closed) ─────────
async function getInvoicesByIds(invoiceIds) {
  const out = [];
  for (let i = 0; i < invoiceIds.length; i += 40) {
    const chunk = invoiceIds.slice(i, i + 40);
    const values = chunk.map(r => `<value>${escXml(String(r))}</value>`).join('');
    const xml = buildXml(`
      <query>
        <object>ARINVOICE</object>
        <select><field>RECORDNO</field><field>RECORDID</field><field>CUSTOMERID</field><field>CUSTOMERNAME</field>
          <field>WHENCREATED</field><field>WHENDUE</field><field>TOTALENTERED</field><field>TOTALDUE</field><field>STATE</field></select>
        <filter><in><field>RECORDID</field>${values}</in></filter>
        <pagesize>1000</pagesize>
      </query>
    `);
    const resp = await sagePost(xml);
    if (extractTag(resp, 'status') !== 'success') continue;
    for (const m of resp.matchAll(/<ARINVOICE>([\s\S]*?)<\/ARINVOICE>/gi)) {
      const b = m[1];
      out.push({
        recordNo: extractTag(b, 'RECORDNO'), invoiceId: extractTag(b, 'RECORDID'),
        customerId: extractTag(b, 'CUSTOMERID'), customerName: extractTag(b, 'CUSTOMERNAME'),
        whenCreated: extractTag(b, 'WHENCREATED'), whenDue: extractTag(b, 'WHENDUE'),
        totalEntered: parseFloat2(extractTag(b, 'TOTALENTERED')), totalDue: parseFloat2(extractTag(b, 'TOTALDUE')),
        state: extractTag(b, 'STATE'),
      });
    }
  }
  return out;
}

// ─── Payment detail (ARPYMTDETAIL) ──────────────────────────────────────────
// Real payment dates/amounts per invoice RECORDNO, with adjustments and
// credit-style amounts separated (feeds the Velocity payment worklist).
async function getPaymentsForRecordNos(recordNos) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < recordNos.length; i += 40) chunks.push(recordNos.slice(i, i + 40));
  for (const chunk of chunks) {
    const values = chunk.map(r => `<value>${escXml(String(r))}</value>`).join('');
    const xml = buildXml(`
      <query>
        <object>ARPYMTDETAIL</object>
        <select>
          <field>RECORDKEY</field>
          <field>PAYMENTDATE</field>
          <field>PAYMENTAMOUNT</field>
          <field>ADJUSTMENTAMOUNT</field>
          <field>NEGATIVEINVOICEAMOUNT</field>
          <field>STATE</field>
        </select>
        <filter><in><field>RECORDKEY</field>${values}</in></filter>
        <pagesize>1000</pagesize>
      </query>
    `);
    const resp = await sagePost(xml);
    if (extractTag(resp, 'status') !== 'success') continue;
    for (const m of resp.matchAll(/<ARPYMTDETAIL>([\s\S]*?)<\/ARPYMTDETAIL>/gi)) {
      const b = m[1];
      const key = extractTag(b, 'RECORDKEY');
      if (!key) continue;
      (out[key] = out[key] || []).push({
        date: extractTag(b, 'PAYMENTDATE'),
        amount: parseFloat2(extractTag(b, 'PAYMENTAMOUNT')),
        adjustment: parseFloat2(extractTag(b, 'ADJUSTMENTAMOUNT')),
        negativeInvoice: parseFloat2(extractTag(b, 'NEGATIVEINVOICEAMOUNT')),
        state: extractTag(b, 'STATE'),
      });
    }
  }
  return out;
}

// ─── Item lookup ─────────────────────────────────────────────────────────────
async function getItems() {
  const allItems = [];
  const xml = buildXml(`
    <readByQuery>
      <object>ITEM</object>
      <fields>ITEMID,NAME,ITEMTYPE,STATUS</fields>
      <query>STATUS = 'active'</query>
      <pagesize>100</pagesize>
    </readByQuery>
  `);
  const resp = await sagePost(xml);
  const resultId = (resp.match(/resultId="([^"]+)"/) || [])[1];
  const first = [...resp.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  for (const m of first) {
    const b = m[1];
    const id   = extractTag(b, 'ITEMID') || '';
    const name = extractTag(b, 'NAME') || '';
    if (id) allItems.push({ id, name });
  }
  // Paginate via readMore if needed
  if (resultId && first.length === 100) {
    let more = true;
    while (more) {
      const xml2 = buildXml(`<readMore><resultId>${resultId}</resultId></readMore>`);
      const resp2 = await sagePost(xml2);
      const m2 = [...resp2.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
      if (!m2.length) break;
      for (const m of m2) {
        const b = m[1];
        const id   = extractTag(b, 'ITEMID') || '';
        const name = extractTag(b, 'NAME') || '';
        if (id) allItems.push({ id, name });
      }
      if (m2.length < 100) more = false;
    }
  }
  return allItems.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

// ─── Location lookup ─────────────────────────────────────────────────────────
async function getLocations() {
  const xml = buildXml(`
    <readByQuery>
      <object>LOCATION</object>
      <fields>LOCATIONID,NAME,STATUS</fields>
      <query>STATUS = 'active'</query>
      <pagesize>100</pagesize>
    </readByQuery>
  `);
  const resp = await sagePost(xml);
  const matches = [...resp.matchAll(/<location>([\s\S]*?)<\/location>/gi)];
  const locs = [];
  for (const m of matches) {
    const b = m[1];
    const id   = extractTag(b, 'LOCATIONID') || '';
    const name = extractTag(b, 'NAME') || '';
    if (id) locs.push({ id, name });
  }
  return locs.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Create AR Invoice (ECI- prefix, OE-style via create_invoice) ─────────────
// invoiceData = {
//   customerId,   invoiceId,   invoiceDate (MM/DD/YYYY),  dueDate (MM/DD/YYYY),
//   locationId,   description, poNumber (optional),
//   lines: [{ itemId, description, amount, locationId?, departmentId? }]
// }
async function createInvoice(invoiceData) {
  const { customerId, invoiceId, invoiceDate, dueDate, locationId, description, poNumber, lines } = invoiceData;

  if (!customerId || !invoiceId || !invoiceDate || !dueDate || !locationId || !lines || !lines.length) {
    throw new Error('Missing required invoice fields');
  }

  const parseDateParts = (d) => {
    const parts = d.split('/');
    return { year: parts[2], month: parts[0], day: parts[1] };
  };

  const created = parseDateParts(invoiceDate);
  const due     = parseDateParts(dueDate);

  const lineXml = lines.map(l => `
    <invoiceitems>
      <lineitem>
        <accountlabel>${escXml(l.itemId || '')}</accountlabel>
        <description>${escXml(l.description || '')}</description>
        <amount>${parseFloat(l.amount || 0).toFixed(2)}</amount>
        <locationid>${escXml(l.locationId || locationId)}</locationid>
        ${l.departmentId ? `<departmentid>${escXml(l.departmentId)}</departmentid>` : ''}
      </lineitem>
    </invoiceitems>
  `).join('');

  const functionXml = `
    <create_invoice>
      <customerid>${escXml(customerId)}</customerid>
      <datecreated>
        <year>${created.year}</year>
        <month>${created.month}</month>
        <day>${created.day}</day>
      </datecreated>
      <datedue>
        <year>${due.year}</year>
        <month>${due.month}</month>
        <day>${due.day}</day>
      </datedue>
      <recordid>${escXml(invoiceId)}</recordid>
      <description>${escXml(description || '')}</description>
      ${poNumber ? `<ponumber>${escXml(poNumber)}</ponumber>` : ''}
      <locationid>${escXml(locationId)}</locationid>
      ${lineXml}
    </create_invoice>
  `;

  const xml = buildXml(functionXml);
  const resp = await sagePost(xml);

  const status = extractTag(resp, 'status');
  if (status !== 'success') {
    const errDesc = extractTag(resp, 'description2') || extractTag(resp, 'description') || 'Unknown error';
    const errCode = extractTag(resp, 'errorno') || '';
    throw new Error(`Sage create_invoice failed [${errCode}]: ${errDesc}`);
  }

  const key = extractTag(resp, 'key');
  return { ok: true, recordNo: key, invoiceId };
}


// ─── OE Line Detail — fetch SODOCUMENTENTRY on demand per invoice ─────────────
// Returns lines for a given invoiceId (e.g. 'ECI-000011')
async function getInvoiceLines(invoiceId) {
  if (!invoiceId) throw new Error('invoiceId required');

  // ECI- invoices: use ARINVOICEITEM (queried by RECORDKEY = ARINVOICE.RECORDNO)
  // For ECI- we need the ARINVOICE RECORDNO, which we'll find by querying ARINVOICE by RECORDID
  if (/^ECI-/i.test(invoiceId)) {
    return getEciInvoiceLines(invoiceId);
  }

  const xml = buildXml(`
    <readByQuery>
      <object>SODOCUMENTENTRY</object>
      <fields>RECORDNO,DOCNO,LINE_NO,ITEMID,ITEMNAME,ITEMDESC,MEMO,QUANTITY,PRICE,TOTAL,LOCATIONID,LOCATIONNAME,DEPARTMENTID,DEPARTMENTNAME,UNIT,WHENCREATED</fields>
      <query>DOCNO = '${escXml(invoiceId)}'</query>
      <pagesize>100</pagesize>
    </readByQuery>
  `);

  const resp = await sagePost(xml);

  const status = extractTag(resp, 'status');
  if (status !== 'success') {
    const errDesc = extractTag(resp, 'description2') || extractTag(resp, 'description') || 'Unknown error';
    const errCode = extractTag(resp, 'errorno') || '';
    throw new Error(`OE line fetch failed [${errCode}]: ${errDesc}`);
  }

  const matches = [...resp.matchAll(/<sodocumententry>([\s\S]*?)<\/sodocumententry>/gi)];
  return matches.map(m => {
    const b = m[1];
    return {
      lineNo:     extractTag(b, 'LINE_NO')       || '',
      itemId:     extractTag(b, 'ITEMID')         || '',
      itemName:   extractTag(b, 'ITEMNAME')       || extractTag(b, 'ITEMDESC') || '',
      description:extractTag(b, 'MEMO')           || extractTag(b, 'ITEMDESC') || '',
      quantity:   parseFloat(extractTag(b, 'QUANTITY') || '0'),
      price:      parseFloat(extractTag(b, 'PRICE')    || '0'),
      total:      parseFloat(extractTag(b, 'TOTAL')    || '0'),
      unit:       extractTag(b, 'UNIT')           || '',
      locationId: extractTag(b, 'LOCATIONID')     || '',
      locationName:extractTag(b, 'LOCATIONNAME')  || '',
      deptId:     extractTag(b, 'DEPARTMENTID')   || '',
      deptName:   extractTag(b, 'DEPARTMENTNAME') || '',
      whenCreated:extractTag(b, 'WHENCREATED')    || '',
    };
  });
}

// ─── ECI- line items from ARINVOICEITEM ─────────────────────────────────────
async function getEciInvoiceLines(invoiceId) {
  // Step 1: get ARINVOICE RECORDNO for this invoice ID
  const arXml = buildXml(`
    <query>
      <object>ARINVOICE</object>
      <select>
        <field>RECORDNO</field>
        <field>RECORDID</field>
      </select>
      <filter>
        <equalto>
          <field>RECORDID</field>
          <value>${escXml(invoiceId)}</value>
        </equalto>
      </filter>
      <pagesize>1</pagesize>
      <offset>0</offset>
    </query>
  `);
  const arRes = await sagePost(arXml);
  const arStatus = extractTag(arRes, 'status');
  if (arStatus !== 'success') {
    const e = extractTag(arRes, 'description2') || extractTag(arRes, 'description') || 'unknown';
    throw new Error(`ARINVOICE lookup failed for ${invoiceId}: ${e}`);
  }
  const recordNo = extractTag(arRes, 'RECORDNO') || '';
  if (!recordNo) throw new Error(`No ARINVOICE record found for ${invoiceId}`);

  // Step 2: fetch line items from ARINVOICEITEM by RECORDKEY
  // Note: ARINVOICEITEM supports: RECORDNO,RECORDKEY,LINE_NO,ITEMID,ITEMNAME,AMOUNT,LOCATIONID,LOCATIONNAME,DEPARTMENTID,DEPARTMENTNAME
  // It does NOT support: MEMO, QUANTITY, PRICE, UNIT (those are SODOCUMENTENTRY fields)
  const itemXml = buildXml(`
    <query>
      <object>ARINVOICEITEM</object>
      <select>
        <field>RECORDNO</field>
        <field>RECORDKEY</field>
        <field>LINE_NO</field>
        <field>ITEMID</field>
        <field>ITEMNAME</field>
        <field>AMOUNT</field>
        <field>LOCATIONID</field>
        <field>LOCATIONNAME</field>
        <field>DEPARTMENTID</field>
        <field>DEPARTMENTNAME</field>
      </select>
      <filter>
        <equalto>
          <field>RECORDKEY</field>
          <value>${escXml(recordNo)}</value>
        </equalto>
      </filter>
      <pagesize>100</pagesize>
      <offset>0</offset>
    </query>
  `);
  const itemRes = await sagePost(itemXml);
  const itemStatus = extractTag(itemRes, 'status');
  if (itemStatus !== 'success') {
    const e = extractTag(itemRes, 'description2') || extractTag(itemRes, 'description') || 'unknown';
    throw new Error(`ARINVOICEITEM fetch failed for ${invoiceId}: ${e}`);
  }

  const matches = [...itemRes.matchAll(/<arinvoiceitem>([\s\S]*?)<\/arinvoiceitem>/gi)];
  return matches.map(m => {
    const b = m[1];
    return {
      lineNo:      extractTag(b, 'LINE_NO')        || '',
      itemId:      extractTag(b, 'ITEMID')          || '',
      itemName:    extractTag(b, 'ITEMNAME')        || '',
      description: extractTag(b, 'ITEMNAME')        || '',  // ARINVOICEITEM has no separate memo/desc
      quantity:    1,                                        // ARINVOICEITEM doesn't store qty separately
      price:       parseFloat(extractTag(b, 'AMOUNT') || '0'),
      total:       parseFloat(extractTag(b, 'AMOUNT') || '0'),
      unit:        '',
      locationId:  extractTag(b, 'LOCATIONID')      || '',
      locationName:extractTag(b, 'LOCATIONNAME')    || '',
      deptId:      extractTag(b, 'DEPARTMENTID')    || '',
      deptName:    extractTag(b, 'DEPARTMENTNAME')  || '',
      whenCreated: '',
    };
  });
}

module.exports = {
  getInvoices,
  enrichLocations,
  getCachedInvoices,
  getCacheAge,
  computeAgingBucket,
  getCustomers,
  getCustomerContacts,
  getPaymentsForRecordNos,
  getRecordNosForInvoiceIds,
  getInvoicesByIds,
  getItems,
  getLocations,
  createInvoice,
  getInvoiceLines,
  queryEciInvoices,
  fetchEciPdf,
  getByBucket,
  getByLocation,
  getByCustomer,
};
