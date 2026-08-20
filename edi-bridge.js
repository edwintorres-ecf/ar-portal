'use strict';
/**
 * edi-bridge.js — bridge from the AR Portal (spark) to the existing EDI
 * transmitter that lives on the iMac (Hermes: ~/.openclaw/workspace-hermes/
 * finance/edi-transmitter.js).
 *
 * We do NOT reimplement EDI here. The transmitter already builds/sends X12 810
 * invoices to Amazon over SFTP, with --po override, --force, --dry-run and a
 * duplicate guard. This module just invokes it over SSH (the same authenticated
 * path dispatch uses) and parses its output.
 *
 * Connectivity: spark reaches the iMac as user `openclaw` via a dedicated key.
 * The AR Portal runs as ecf-admin, which owns that key. spark→iMac only — the
 * iMac never needs to reach spark for this.
 */

const { execFile } = require('child_process');

const SSH_KEY   = process.env.IMAC_SSH_KEY  || '/home/ecf-admin/.ssh/id_ed25519_dispatch';
const IMAC_HOST = process.env.IMAC_HOST     || 'openclaw@easts-imac-pro.taildac2b4.ts.net';
const NODE_BIN  = process.env.IMAC_NODE      || '/usr/local/bin/node';
const TRANSMITTER = process.env.IMAC_TRANSMITTER || '/Users/openclaw/.openclaw/workspace-hermes/finance/edi-transmitter.js';
const SSH_OPTS  = ['-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=12'];

function runTransmitter(transmitterArgs, timeoutMs = 120000) {
  // Build the remote command as a single string for the login shell.
  const remote = [NODE_BIN, TRANSMITTER, ...transmitterArgs].join(' ');
  const args = [...SSH_OPTS, IMAC_HOST, remote];
  return new Promise((resolve) => {
    execFile('ssh', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// The transmitter echoes a lot of Sage API chatter; the actual X12 810 starts
// at the ISA segment and ends at the IEA/SE segment. Pull just that.
function extractX12(output) {
  const start = output.indexOf('ISA*');
  if (start === -1) return null;
  // 810 envelope ends at IEA (interchange trailer); fall back to SE if absent.
  let end = output.indexOf('IEA*', start);
  if (end === -1) end = output.indexOf('SE*', start);
  if (end === -1) return output.slice(start).trim();
  const lineEnd = output.indexOf('\n', end);
  return output.slice(start, lineEnd === -1 ? undefined : lineEnd).trim();
}

/**
 * Dry-run: generate the 810 for an invoice without transmitting. SAFE — the
 * transmitter's --dry-run path builds and prints the EDI but never SFTPs it.
 * @param {string} invoiceNumber  Sage RECORDID, e.g. "ECI-021128" or "S-6084"
 * @param {{po?: string}} opts     Optional PO override
 * @returns {Promise<{ok, x12, raw, error}>}
 */
async function dryRun(invoiceNumber, opts = {}) {
  const args = ['transmit', invoiceNumber, '--dry-run'];
  if (opts.po) args.push('--po=' + opts.po);
  if (opts.as) args.push('--as=' + opts.as); // resubmission: emit suffixed invoice #
  const { err, stdout, stderr } = await runTransmitter(args);
  const combined = stdout + '\n' + stderr;
  if (err && !/DRY RUN/.test(combined)) {
    return { ok: false, error: (stderr || err.message || 'ssh/transmitter error').slice(0, 500) };
  }
  const x12 = extractX12(combined);
  if (!x12) {
    // Surface the transmitter's own skip/error message if there's no 810.
    const skip = (combined.match(/⚠️[^\n]*/) || combined.match(/EDI skip[^\n]*/) || [])[0];
    return { ok: false, error: skip || 'No 810 produced (invoice may lack a PO or was not found)', raw: combined.slice(-800) };
  }
  return { ok: true, x12, raw: combined.slice(-2000) };
}

/**
 * Live transmit via SFTP to Amazon. This DOES send. Callers must gate this
 * behind explicit human approval per the agreed safety posture.
 * @param {string} invoiceNumber
 * @param {{po?: string, force?: boolean}} opts
 * @returns {Promise<{ok, transmitted, remotePath, raw, error}>}
 */
async function transmit(invoiceNumber, opts = {}) {
  const args = ['transmit', invoiceNumber];
  if (opts.po) args.push('--po=' + opts.po);
  if (opts.as) args.push('--as=' + opts.as); // resubmission: emit suffixed invoice #
  if (opts.force) args.push('--force');
  const { err, stdout, stderr } = await runTransmitter(args, 180000);
  const combined = stdout + '\n' + stderr;
  if (err && !/✅|transmitted/i.test(combined)) {
    return { ok: false, transmitted: false, error: (stderr || err.message || 'ssh/transmitter error').slice(0, 500), raw: combined.slice(-800) };
  }
  const success = /✅/.test(combined) || /transmitted/i.test(combined);
  const failed  = /❌|transmit failed|EDI skip/i.test(combined);
  const remoteMatch = combined.match(/→\s*([^\s\n]+\.edi)/) || combined.match(/remotePath[":\s]+([^\s",\n]+)/);
  return {
    ok: success && !failed,
    transmitted: success && !failed,
    remotePath: remoteMatch ? remoteMatch[1] : null,
    raw: combined.slice(-1200),
    error: (success && !failed) ? null : ((combined.match(/❌[^\n]*/) || combined.match(/EDI skip[^\n]*/) || [])[0] || 'transmit did not confirm success'),
  };
}

/** Quick connectivity/health check to the transmitter host. */
async function testConnection() {
  const { err, stdout, stderr } = await runTransmitter(['test-connection'], 30000);
  const combined = stdout + '\n' + stderr;
  return { ok: !err, output: combined.slice(-600) };
}

module.exports = { dryRun, transmit, testConnection };
