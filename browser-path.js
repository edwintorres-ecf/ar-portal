'use strict';

// Where is Chromium? The answer differs by host, and getting it wrong is not a
// crash at startup — it is a 500 on a button, months later, on the host you only
// use in an emergency.
//
// Three modules hard-coded '/usr/bin/chromium-browser', which is correct on
// spark and does not exist on macOS. During the 2026-09-08 failover to the iMac
// that took out invoice PDFs (6 straight 500s to Vincenzo and Edwin), Payee
// Central refresh, PO detail scraping, rejection-reason extraction, Omnia, and
// statement PDFs — all from one missing path (Edwin 2026-09-11).
//
// Resolved once, lazily, and cached: the answer cannot change while the process
// is alive, and resolving at require-time would make an unrelated module fail to
// load on a host with no browser at all.

const fs = require('fs');

const CANDIDATES = [
  // An explicit override always wins, so a host with a browser somewhere unusual
  // needs no code change.
  process.env.CHROMIUM_PATH,
  // Linux (spark).
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  // macOS (the iMac standby). Chrome is installed there; Chromium generally is
  // not, but check both.
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

let _resolved;          // undefined = not looked up yet, null = looked and found none

function find() {
  if (_resolved !== undefined) return _resolved;
  _resolved = null;
  for (const p of CANDIDATES) {
    if (!p) continue;
    try {
      // X_OK as well as existence: a path we cannot execute is not an answer.
      fs.accessSync(p, fs.constants.X_OK);
      _resolved = p;
      break;
    } catch (e) { /* try the next one */ }
  }
  if (_resolved) console.log('[browser] using ' + _resolved);
  else console.warn('[browser] no Chromium or Chrome found — browser features are unavailable on this host');
  return _resolved;
}

/**
 * Path to a usable Chromium/Chrome binary.
 * Throws with the list it tried, so the log says what to install or set,
 * rather than surfacing playwright's "Executable doesn't exist" at a
 * hard-coded path the reader has no reason to doubt.
 */
function chromiumPath() {
  const p = find();
  if (p) return p;
  throw new Error('No Chromium/Chrome executable found. Set CHROMIUM_PATH, or install one at: '
    + CANDIDATES.filter(Boolean).slice(1).join(', '));
}

/** Is a browser available at all? For callers that would rather skip than throw. */
function hasBrowser() { return !!find(); }

/** Standard launch options. `--no-sandbox` is needed on spark; harmless on macOS. */
function launchOptions(extra = {}) {
  const { args = [], ...rest } = extra;
  return {
    executablePath: chromiumPath(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...args],
    ...rest,
  };
}

module.exports = { chromiumPath, hasBrowser, launchOptions, CANDIDATES };
