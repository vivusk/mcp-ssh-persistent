/**
 * Known-hosts fingerprint store (D4: TOFU host-key pinning)
 * File `known-hosts.json` beside the config file:
 *   { "<host>:<port>": { "fingerprint": "SHA256:...", "addedAt": "<iso>" } }
 * A fingerprint pinned in config wins over the store; otherwise the stored one
 * is enforced; otherwise the first seen key is stored (trust on first use).
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { getConfigPath } from './load-config-and-server-aliases.js';

/** @returns {string} absolute path of known-hosts.json (beside the config file) */
export function getKnownHostsPath() {
  return join(dirname(getConfigPath()), 'known-hosts.json');
}

/**
 * OpenSSH-style fingerprint of a raw host key blob.
 * @param {Buffer} keyBuffer - Raw public host key
 * @returns {string} `SHA256:<base64 without padding>`
 */
export function fingerprintOf(keyBuffer) {
  return 'SHA256:' + createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
}

/** Normalise a user-supplied fingerprint (optional prefix, padding) for comparison. */
function normalize(fp) {
  const body = String(fp).trim().replace(/^SHA256:/i, '').replace(/=+$/, '');
  return `SHA256:${body}`;
}

/** Read the store; missing file -> empty. Corrupt JSON throws (never silently re-trust). */
function readStore(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch { /* fall through */ }
  throw new Error(`${path} is not a valid JSON object; fix or delete it`);
}

/** Atomic write: temp file in the same dir, then rename over the target. */
function writeStore(path, data) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Verify a host key against config pin / stored pin, storing it on first use.
 * @param {string} host
 * @param {number} port
 * @param {Buffer} keyBuffer - Raw host key from ssh2 hostVerifier
 * @param {string} [pinnedFromConfig] - Fingerprint from config (wins)
 * @param {string} [storePath] - Override store path (tests)
 * @returns {{ ok: boolean, fingerprint: string, expected?: string, isNew: boolean, source: string }}
 */
export function verify(host, port, keyBuffer, pinnedFromConfig, storePath = getKnownHostsPath()) {
  const fingerprint = fingerprintOf(keyBuffer);
  if (pinnedFromConfig) {
    const expected = normalize(pinnedFromConfig);
    return { ok: expected === fingerprint, fingerprint, expected, isNew: false, source: 'config' };
  }
  const id = `${host}:${port}`;
  const store = readStore(storePath);
  const entry = store[id];
  if (entry && entry.fingerprint) {
    const expected = normalize(entry.fingerprint);
    return { ok: expected === fingerprint, fingerprint, expected, isNew: false, source: 'store' };
  }
  store[id] = { fingerprint, addedAt: new Date().toISOString() };
  writeStore(storePath, store);
  return { ok: true, fingerprint, isNew: true, source: 'store' };
}
