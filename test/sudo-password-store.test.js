import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getSudoPassword, setSudoPassword, deleteSudoPassword, hasSudoPassword, credentialBackend, credentialTarget,
  credentialLocation, credentialStoreName,
} from '../src/security/sudo-password-store.js';
import { redact } from '../src/security/secret-redaction.js';
import { log } from '../src/utils/logger.js';

// Throwaway account only; never a real user's credential.
const USER = '__mcp_test__';
const LOG_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'mcp-ssh.log');
const isWin = process.platform === 'win32';
// Real keychain / Secret Service tests are opt-in (they write to the user's login store).
const keychainOptIn = process.env.MCP_SSH_TEST_KEYCHAIN === '1';
const isMacKeychain = process.platform === 'darwin' && keychainOptIn;
const isLinuxKeyring = process.platform === 'linux' && keychainOptIn;
const ENV_VARS = ['MCP_SSH_CRED_BACKEND', 'MCP_SSH_WCM_BACKEND'];
const prevEnv = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
const secrets = [];

/** Run fn with a given win32 backend forced via env (sets/clears both env names). */
async function withBackend(backend, fn) {
  for (const k of ENV_VARS) {
    if (backend === 'powershell') process.env[k] = 'powershell';
    else delete process.env[k];
  }
  try { return await fn(); } finally {
    for (const k of ENV_VARS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  }
}

/** Round trip set -> get -> delete -> missing for one secret on the current backend. */
async function roundTrip(secret) {
  secrets.push(secret);
  await setSudoPassword(USER, secret);
  assert.equal(await hasSudoPassword(USER), true);
  assert.equal(await getSudoPassword(USER, { alias: 'T' }), secret);
  assert.equal(redact(`x ${secret} y`), 'x *** y', 'retrieved password registered for redaction');
  log('info', 'credential test', { value: secret });
  assert.equal(await deleteSudoPassword(USER), true);
  assert.equal(await hasSudoPassword(USER), false);
  await assert.rejects(getSudoPassword(USER, { alias: 'T' }),
    new RegExp(`No sudo password in the OS credential store \\(${credentialStoreName()}\\) for alias T user '__mcp_test__'\\. Run: npm run set-sudo-password -- __mcp_test__`));
  assert.equal(await deleteSudoPassword(USER), false, 'nothing left to delete');
}

after(async () => {
  if (isWin) {
    for (const b of ['napi', 'powershell']) await withBackend(b, () => deleteSudoPassword(USER)).catch(() => {});
  } else if (keychainOptIn) {
    await deleteSudoPassword(USER).catch(() => {});
  }
  // Log must never contain a test secret.
  if (existsSync(LOG_FILE)) {
    const content = readFileSync(LOG_FILE, 'utf8');
    for (const s of secrets) assert.ok(!content.includes(s), 'test secret leaked into log');
  }
});

test('target name + username validation', () => {
  assert.equal(credentialTarget(USER), 'mcp-ssh-persistent:sudo:__mcp_test__');
  const expectedLocation = isWin ? 'mcp-ssh-persistent:sudo:__mcp_test__' : 'service mcp-ssh-persistent, account sudo:__mcp_test__';
  assert.equal(credentialLocation(USER), expectedLocation);
  assert.throws(() => credentialLocation('a b'), /invalid sudo username/);
  for (const bad of ['', 'a b', "x'y", 'a;b', '-x', undefined]) assert.throws(() => credentialTarget(bad), /invalid sudo username/);
});

for (const backend of ['napi', 'powershell']) {
  test(`WCM round trip via ${backend}: set -> get -> delete -> missing`, { skip: !isWin, timeout: 30000 }, async () => {
    await withBackend(backend, async () => {
      assert.equal(credentialBackend(), backend);
      await roundTrip(`t-${randomBytes(9).toString('base64')}-é'"$\``);
    });
  });
}

test('napi and PowerShell paths share the same target (cross-read)', { skip: !isWin, timeout: 30000 }, async () => {
  const secret = `x-${randomBytes(9).toString('hex')}`;
  secrets.push(secret);
  await withBackend('powershell', () => setSudoPassword(USER, secret));
  assert.equal(await withBackend('napi', () => getSudoPassword(USER)), secret);
  assert.equal(await withBackend('napi', () => deleteSudoPassword(USER)), true);
  assert.equal(await withBackend('powershell', () => hasSudoPassword(USER)), false);
});

test('macOS Keychain round trip via macos-security (opt-in)', { skip: !isMacKeychain, timeout: 30000 }, async () => {
  assert.equal(credentialBackend(), 'macos-security');
  assert.equal(credentialStoreName(), 'macOS Keychain');
  await roundTrip(`t-${randomBytes(9).toString('hex')}-é'"$\`\\ x`); // hex path (non-ASCII + backslash)
  await roundTrip('deadbeef01'); // ASCII that looks like hex, quoted path
  await roundTrip(`p"q'r s$t;u`); // ASCII-only quoted path with embedded quote (F4)
});

test('macOS Keychain rejects passwords with line breaks', { skip: !isMacKeychain }, async () => {
  await assert.rejects(setSudoPassword(USER, 'a\nb'), /line breaks/);
});

test('Linux Secret Service round trip via napi (opt-in)', { skip: !isLinuxKeyring, timeout: 30000 }, async () => {
  assert.equal(credentialBackend(), 'napi');
  await roundTrip(`t-${randomBytes(9).toString('base64')}-é'"$\`\\ x`);
});

test('setSudoPassword rejects empty password', async () => {
  await assert.rejects(setSudoPassword(USER, ''), /non-empty/);
});
