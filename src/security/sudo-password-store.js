/**
 * Cross-platform sudo password store (D2, D-M1..D-M5).
 * - win32  → Windows Credential Manager, target `mcp-ssh-persistent:sudo:<user>` via
 *            @napi-rs/keyring `Entry.withTarget`/`findCredentials`; PowerShell
 *            CredRead/CredWrite/CredDelete fallback when the native binary cannot
 *            load (or MCP_SSH_CRED_BACKEND=powershell, legacy MCP_SSH_WCM_BACKEND).
 * - darwin → macOS Keychain via `/usr/bin/security` (service + account `sudo:<user>`).
 * - linux  → Secret Service via @napi-rs/keyring `new Entry(service, account)`.
 * Every retrieved password is registered for redaction before it is returned.
 * `username` is always the configured server user, never a tool argument.
 */
import { createRequire } from 'module';
import { registerSecret } from './secret-redaction.js';
import { log } from '../utils/logger.js';
import { psReadCredential, psWriteCredential, psDeleteCredential } from './windows-credential-powershell-fallback.js';
import { macReadPassword, macWritePassword, macDeletePassword } from './macos-keychain-security-cli.js';
import { linuxReadPassword, linuxWritePassword, linuxDeletePassword } from './linux-secret-service-keyring.js';

const SERVICE = 'mcp-ssh-persistent';
const USERNAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const STORE_NAMES = { win32: 'Windows Credential Manager', darwin: 'macOS Keychain', linux: 'Secret Service' };

let napi; // undefined = not tried, null = unavailable, else module
let napiError = '';

/** Lazily load @napi-rs/keyring; null when it cannot load. */
function loadNapi() {
  if (napi !== undefined) return napi;
  try {
    napi = createRequire(import.meta.url)('@napi-rs/keyring');
  } catch (err) {
    napi = null;
    napiError = err?.message || String(err);
    const note = process.platform === 'win32' ? ', using PowerShell fallback' : '';
    log('warn', `napi keyring unavailable${note}`, { error: napiError });
  }
  return napi;
}

/** Human name of this OS's credential store; throws on unsupported platforms. */
export function credentialStoreName() {
  const name = STORE_NAMES[process.platform];
  if (!name) throw new Error(`sudo password store is not supported on platform '${process.platform}' (win32, darwin, linux only)`);
  return name;
}

/** @returns {'napi'|'powershell'|'macos-security'} backend used for the next call */
export function credentialBackend() {
  credentialStoreName(); // platform check
  if (process.platform === 'darwin') return 'macos-security';
  if (process.platform === 'linux') {
    if (!loadNapi()) throw new Error(`Linux Secret Service backend unavailable (@napi-rs/keyring failed to load: ${napiError})`);
    return 'napi';
  }
  const env = process.env.MCP_SSH_CRED_BACKEND ?? process.env.MCP_SSH_WCM_BACKEND;
  if (env === 'powershell') return 'powershell';
  return loadNapi() ? 'napi' : 'powershell';
}

/** Validate a Unix username and return its WCM target name. */
export function credentialTarget(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new Error(`invalid sudo username '${username}'`);
  }
  return `${SERVICE}:sudo:${username}`;
}

/** Where the password lives, for user-facing messages (validates username). */
export function credentialLocation(username) {
  const target = credentialTarget(username);
  return process.platform === 'win32' ? target : `service ${SERVICE}, account sudo:${username}`;
}

/** napi Entry bound to the explicit WCM target (never `new Entry(service, user)` on win32, see D2). Write/delete only. */
function napiEntry(username) {
  return loadNapi().Entry.withTarget(credentialTarget(username), SERVICE, `sudo:${username}`);
}

/**
 * Raw read; null when missing or empty.
 * win32 napi read uses `findCredentials(service, target)` (exact target, CredEnumerate)
 * instead of `Entry.withTarget(...).getPassword()`: on Windows, @napi-rs/keyring
 * 1.x/2.x `withTarget` overwrites an existing credential with an empty one
 * (verified 261114), so constructing it for a read would wipe the password.
 * @returns {Promise<string|null>}
 */
async function readRaw(username) {
  const target = credentialTarget(username);
  const account = `sudo:${username}`;
  const backend = credentialBackend();
  if (backend === 'macos-security') return (await macReadPassword(SERVICE, account)) || null;
  if (process.platform === 'linux') return linuxReadPassword(loadNapi(), SERVICE, account) || null;
  if (backend === 'powershell') return (await psReadCredential(target)) || null;
  const found = loadNapi().findCredentials(SERVICE, target) || [];
  const hit = found.find((c) => c.account === account && c.password);
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
    throw new Error(`No sudo password in the OS credential store (${credentialStoreName()}) for alias ${alias} user '${username}'. Run: npm run set-sudo-password -- ${username} (npm/npx install: npx -p mcp-ssh-persistent mcp-ssh-persistent-set-sudo-password ${username})`);
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
  const account = `sudo:${username}`;
  const backend = credentialBackend();
  if (backend === 'macos-security') return macWritePassword(SERVICE, account, password);
  if (process.platform === 'linux') return linuxWritePassword(loadNapi(), SERVICE, account, password);
  if (backend === 'powershell') return psWriteCredential(target, account, password);
  napiEntry(username).setPassword(password);
}

/**
 * Delete the stored password for a user.
 * @returns {Promise<boolean>} true when something was deleted
 */
export async function deleteSudoPassword(username) {
  const target = credentialTarget(username);
  const account = `sudo:${username}`;
  const backend = credentialBackend();
  if (backend === 'macos-security') return macDeletePassword(SERVICE, account);
  if (process.platform === 'linux') return linuxDeletePassword(loadNapi(), SERVICE, account);
  if (backend === 'powershell') return psDeleteCredential(target);
  // withTarget creates the credential if absent, so check first to report "missing" as false.
  if (!(await readRaw(username))) return false;
  return Boolean(napiEntry(username).deletePassword());
}
