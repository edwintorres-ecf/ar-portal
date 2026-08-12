// ─── Local AI (Ollama on the DGX GB10) ──────────────────────────────────────
// All inference runs on-box via Ollama at 127.0.0.1:11434 — no external calls,
// no per-token cost, no data leaves spark. Two models:
//   SMART (qwen3:32b) — drafting, summaries, prioritization (quality-sensitive)
//   FAST  (qwen3:8b)  — NL→filter and other fast structured tasks
// Benchmarked on the GB10: 32b ≈ 10 tok/s fully-grounded email in ~20s warm;
// 8b ≈ 40 tok/s valid JSON. 70B models gave no quality gain at 3× the latency.
//
// Guardrails: AI only drafts/summarizes/ranks from context passed in. It never
// computes balances or writes to the ledger. Callers ground every prompt in
// real DB/Sage data and keep a human in the loop.

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL_SMART = process.env.AI_MODEL_SMART || 'qwen3:32b';
const MODEL_FAST  = process.env.AI_MODEL_FAST  || 'qwen3:8b';
const KEEP_ALIVE  = process.env.AI_KEEP_ALIVE  || '2h';    // keep models warm in GPU

// Strip qwen3 <think>…</think> reasoning traces and ```json fences.
function cleanText(s) {
  if (!s) return '';
  let t = String(s).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // drop an unterminated leading <think> block if the model didn't close it
  t = t.replace(/^<think>[\s\S]*$/i, '').trim();
  return t;
}
function stripFences(s) {
  return cleanText(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function ollama(path, payload, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(OLLAMA_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// Is the local model server reachable and are our models present?
async function available() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const resp = await fetch(OLLAMA_URL + '/api/tags', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return false;
    const data = await resp.json();
    const names = (data.models || []).map(m => m.name);
    return names.some(n => n === MODEL_SMART || n.startsWith(MODEL_SMART.split(':')[0]));
  } catch (e) { return false; }
}

// Core text generation.
async function generate({ model, system, prompt, format, temperature = 0.3, num_predict = 512, timeoutMs }) {
  const payload = {
    model: model || MODEL_SMART,
    prompt,
    system,
    stream: false,
    think: false,
    keep_alive: KEEP_ALIVE,
    options: { temperature, num_predict },
  };
  if (format) payload.format = format;
  const data = await ollama('/api/generate', payload, timeoutMs);
  return { text: cleanText(data.response), raw: data };
}

// Generate a value validated against a JSON schema (Ollama enforces the shape).
async function generateJson({ model, system, prompt, schema, temperature = 0.1, num_predict = 400, timeoutMs }) {
  const data = await ollama('/api/generate', {
    model: model || MODEL_FAST,
    prompt, system, stream: false, think: false, keep_alive: KEEP_ALIVE,
    format: schema, options: { temperature, num_predict },
  }, timeoutMs);
  const txt = stripFences(data.response);
  try { return JSON.parse(txt); }
  catch (e) { throw new Error('Model returned non-JSON: ' + txt.slice(0, 160)); }
}

// ─── Feature helpers ─────────────────────────────────────────────────────────

// NL search → deterministic filter criteria. The frontend applies these to the
// real invoice array, so the resulting numbers are never model-generated.
const FILTER_SCHEMA = {
  type: 'object',
  properties: {
    customer:       { type: 'string' },
    locationText:   { type: 'string' },
    minDaysOverdue: { type: 'integer' },
    maxDaysOverdue: { type: 'integer' },
    hasPTP:         { type: 'boolean' },
    stopService:    { type: 'boolean' },
    onHold:         { type: 'boolean' },
    minBalance:     { type: 'number' },
    amazonOnly:     { type: 'boolean' },
  },
};
async function parseFilterQuery(text) {
  const system = 'You convert a collections analyst\'s natural-language request into filter criteria. ' +
    'Only include keys the request actually implies; omit everything else. ' +
    '"past due"/"overdue N days" maps to minDaysOverdue. "no promise"/"no PTP"/"no promise to pay" → hasPTP=false. ' +
    '"promised"/"has a promise" → hasPTP=true. "on hold"/"held" → onHold=true. ' +
    '"stopped"/"stop service" → stopService=true. "Amazon" → amazonOnly=true. ' +
    'A number followed by "days" ALWAYS maps to minDaysOverdue, never minBalance. ' +
    'minBalance is only for money amounts ($, "dollars", or "k"): "over $5,000" → minBalance=5000, "10k" → 10000.';
  const examples =
    'Request: "Amazon invoices over 60 days past due with no promise to pay"\n' +
    '{"minDaysOverdue":60,"hasPTP":false,"amazonOnly":true}\n' +
    'Request: "held invoices for Walmart above $10k"\n' +
    '{"customer":"Walmart","onHold":true,"minBalance":10000}\n' +
    'Request: "invoices on hold more than 90 days"\n' +
    '{"onHold":true,"minDaysOverdue":90}\n' +
    'Request: "accounts on stop service"\n' +
    '{"stopService":true}\n';
  const result = await generateJson({
    model: MODEL_SMART,   // 32b: filter correctness matters more than the ~2s latency
    system,
    prompt: `${examples}Request: "${text}"\nJSON:`,
    schema: FILTER_SCHEMA,
    num_predict: 200,
    timeoutMs: 45000,
  });
  // Deterministic numeric routing — small models conflate "90 days" with a
  // dollar amount, so we extract days and money with regex and override the
  // model, which handles only the fuzzy intent (customer, boolean flags).
  const daysM  = text.match(/(\d[\d,]*)\s*\+?\s*days?\b/i);
  const moneyM = text.match(/\$\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*k\b|([\d,]+(?:\.\d+)?)\s*(?:dollars|usd)\b/i);
  const daysVal = daysM ? parseInt(daysM[1].replace(/,/g, ''), 10) : null;
  if (daysVal != null) result.minDaysOverdue = daysVal;
  if (moneyM) {
    let amt = parseFloat((moneyM[1] || moneyM[2] || moneyM[3]).replace(/,/g, ''));
    if (/k\b/i.test(moneyM[0])) amt *= 1000;
    result.minBalance = amt;
  } else if (result.minBalance != null && (result.minBalance === 0 || result.minBalance === daysVal)) {
    delete result.minBalance;   // strip spurious balance the model invented from a day count
  }
  return result;
}

// "Catch me up on this account" — grounded synthesis, read-only.
async function summarizeAccount(ctx) {
  const system = 'You are an accounts-receivable analyst at East Coast Facilities. ' +
    'Summarize the state of this invoice for a collector in 3-5 sentences. ' +
    'Use ONLY the facts provided — do not invent amounts, dates, or commitments. ' +
    'Note aging, any promises to pay (kept or broken), holds/stop-service, and the most relevant recent notes. ' +
    'End with a one-line recommended next action. Plain text, no preamble.';
  const { text } = await generate({
    model: MODEL_SMART, system, prompt: ctx, temperature: 0.2, num_predict: 400, timeoutMs: 90000,
  });
  return text;
}

// Rank a collector's My Work queue. Advisory only; frontend shows the order.
const PRIORITY_SCHEMA = {
  type: 'object',
  properties: {
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          recordNo: { type: 'string' },
          reason:   { type: 'string' },
        },
        required: ['recordNo', 'reason'],
      },
    },
  },
  required: ['ranking'],
};
async function prioritizeWork(ctx) {
  const system = 'You are an AR collections lead. Given a list of invoices assigned to one collector, ' +
    'rank them by who to chase first, weighing balance, days overdue, broken promises, and holds. ' +
    'Return every recordNo exactly once with a short (max 12-word) reason. Use only the data given.';
  return generateJson({
    model: MODEL_SMART, system, prompt: ctx, schema: PRIORITY_SCHEMA,
    temperature: 0.2, num_predict: 900, timeoutMs: 120000,
  });
}

// Draft a dunning email. Human edits and sends — never auto-sent.
async function draftCollectionsEmail(ctx, tone = 'firm but professional') {
  const system = `You are an accounts-receivable collections specialist at East Coast Facilities. ` +
    `Write a ${tone} payment-reminder email. Use ONLY the facts provided; never invent PO numbers, ` +
    `dates, or amounts. Keep it under 170 words. Reference the invoice, amount, and how far past due it is, ` +
    `and any broken promise to pay. Do not include a signature block, sign-off name, or contact details; ` +
    `a signature is appended automatically when the email is sent. Do not use em dashes. ` +
    `No filler phrases. Output the email only, starting with a "Subject:" line.`;
  const { text } = await generate({
    model: MODEL_SMART, system, prompt: ctx, temperature: 0.3, num_predict: 420, timeoutMs: 90000,
  });
  return text;
}

// Keep the models resident in GPU so interactive calls don't pay a cold-load
// penalty (~20s on the GB10). Called on boot and on a timer from app.js.
async function warmup() {
  const ping = (model) => ollama('/api/generate', {
    model, prompt: 'ready', stream: false, think: false, keep_alive: KEEP_ALIVE, options: { num_predict: 1 },
  }, 60000).then(() => true).catch(() => false);
  const [a, b] = await Promise.all([ping(MODEL_SMART), ping(MODEL_FAST)]);
  return a || b;
}

module.exports = {
  available,
  warmup,
  generate,
  generateJson,
  parseFilterQuery,
  summarizeAccount,
  prioritizeWork,
  draftCollectionsEmail,
  MODEL_SMART,
  MODEL_FAST,
};
