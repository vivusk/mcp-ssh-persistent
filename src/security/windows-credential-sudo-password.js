/**
 * Sudo password store backed by Windows Credential Manager (D2).
 * Target `mcp-ssh-persistent:sudo:<username>` via @napi-rs/keyring
 * `Entry.withTarget`; PowerShell CredRead/CredWrite/CredDelete fallback when
 * the native binary cannot load (or MCP_SSH_WCM_BACKEND=powershell, for tests).
 * Every retrieved password is registered for redaction before it is returned.
 * `username` is always the configured server user, never a tool argument.
 */
import { createRequire } from 'module';
import { registerSecret } from './secret-redaction.js';
import { log } from '../utils/logger.js';
import { psReadCredential, psWriteCredential, psDeleteCredential } from './windows-credential-powershell-fallback.js';

const SERVICE = 'mcp-ssh-persistent';
const USERNAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;

let napi; // undefined = not tried, null = unavailable, else module

/** Lazily load @napi-rs/keyring; null when it cannot load. */
function loadNapi() {
  if (napi !== undefined) return napi;
  try {
    napi = createRequire(import.meta.url)('@napi-rs/keyring');
  } catch (err) {
    napi = null;
    log('warn', 'napi keyring unavailable, using PowerShell fallback', { error: err?.message });
  }
  return napi;
}

/** @returns {'napi'|'powershell'} backend used for the next call */
export function credentialBackend() {
  if (process.env.MCP_SSH_WCM_BACKEND === 'powershell') return 'powershell';
  return loadNapi() ? 'napi' : 'powershell';
}

/** Validate a Unix username and return its WCM target name. */
export function credentialTarget(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new Error(`invalid sudo username '${username}'`);
  }
  return `${SERVICE}:sudo:${username}`;
}

/** napi Entry bound to the explicit target (never `new Entry(service, user)`, see D2). Write/delete only. */
function napiEntry(username) {
  return loadNapi().Entry.withTarget(credentialTarget(username), SERVICE, `sudo:${username}`);
}

/**
 * Raw read; null when missing or empty.
 * napi read uses `findCredentials(service, target)` (exact target, CredEnumerate)
 * instead of `Entry.withTarget(...).getPassword()`: on Windows, @napi-rs/keyring
 * 1.x/2.x `withTarget` overwrites an existing credential with an empty one
 * (verified 261114), so constructing it for a read would wipe the password.
 * @returns {Promise<string|null>}
 */
async function readRaw(username) {
  const target = credentialTarget(username);
  if (credentialBackend() === 'powershell') return (await psReadCredential(target)) || null;
  const found = loadNapi().findCredentials(SERVICE, target) || [];
  const hit = found.find((c) => c.account === `sudo:${username}` && c.password);
  return hit ? hit.password : null;
}

/**
 * Fetch the sudo password for a server user. Registered as a secret.
 * @param {string} username - session.server.username of the alias in use
 * @param {object} [opts] - { alias } for the error message
 * @returns {Promise<string>}
 */
export async function getSudoPassword(username, { alias = '?' } = {}) {
  const pw = await readRaw(username);
  if (!pw) {
    throw new Error(`No sudo password in Windows Credential Manager for alias ${alias} user '${username}'. Run: npm run set-sudo-password -- ${username}`);
  }
  registerSecret(pw);
  return pw;
}

/** @returns {Promise<boolean>} true when a password is stored (value not returned) */
export async function hasSudoPassword(username) {
  return Boolean(await readRaw(username));
}

/**
 * Store (overwrite) the sudo password for a user.
 * @param {string} username
 * @param {string} password - non-empty
 */
export async function setSudoPassword(username, password) {
  if (typeof password !== 'string' || password === '') throw new Error('password must be a non-empty string');
  registerSecret(password);
  const target = credentialTarget(username);
  if (credentialBackend() === 'powershell') return psWriteCredential(target, `sudo:${username}`, password);
  napiEntry(username).setPassword(password);
}

/**
 * Delete the stored password for a user.
 * @returns {Promise<boolean>} true when something was deleted
 */
export async function deleteSudoPassword(username) {
  const target = credentialTarget(username);
  if (credentialBackend() === 'powershell') return psDeleteCredential(target);
  // withTarget creates the credential if absent, so check first to report "missing" as false.
  if (!(await readRaw(username))) return false;
  return Boolean(napiEntry(username).deletePassword());
}
