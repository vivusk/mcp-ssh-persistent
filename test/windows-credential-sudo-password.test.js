import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getSudoPassword, setSudoPassword, deleteSudoPassword, hasSudoPassword, credentialBackend, credentialTarget,
} from '../src/security/windows-credential-sudo-password.js';
import { redact } from '../src/security/secret-redaction.js';
import { log } from '../src/utils/logger.js';

// Throwaway account only; never a real user's credential.
const USER = '__mcp_test__';
const LOG_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'mcp-ssh.log');
const isWin = process.platform === 'win32';
const prevBackend = process.env.MCP_SSH_WCM_BACKEND;
const secrets = [];

/** Run fn with a given backend forced via env. */
async function withBackend(backend, fn) {
  if (backend === 'powershell') process.env.MCP_SSH_WCM_BACKEND = 'powershell';
  else delete process.env.MCP_SSH_WCM_BACKEND;
  try { return await fn(); } finally {
    if (prevBackend === undefined) delete process.env.MCP_SSH_WCM_BACKEND;
    else process.env.MCP_SSH_WCM_BACKEND = prevBackend;
  }
}

after(async () => {
  for (const b of ['napi', 'powershell']) await withBackend(b, () => deleteSudoPassword(USER)).catch(() => {});
  // Log must never contain a test secret.
  if (existsSync(LOG_FILE)) {
    const content = readFileSync(LOG_FILE, 'utf8');
    for (const s of secrets) assert.ok(!content.includes(s), 'test secret leaked into log');
  }
});

test('target name + username validation', () => {
  assert.equal(credentialTarget(USER), 'mcp-ssh-persistent:sudo:__mcp_test__');
  for (const bad of ['', 'a b', "x'y", 'a;b', '-x', undefined]) assert.throws(() => credentialTarget(bad), /invalid sudo username/);
});

for (const backend of ['napi', 'powershell']) {
  test(`WCM round trip via ${backend}: set -> get -> delete -> missing`, { skip: !isWin, timeout: 30000 }, async () => {
    await withBackend(backend, async () => {
      assert.equal(credentialBackend(), backend);
      const secret = `t-${randomBytes(9).toString('base64')}-é'"$\``;
      secrets.push(secret);
      await setSudoPassword(USER, secret);
      assert.equal(await hasSudoPassword(USER), true);
      assert.equal(await getSudoPassword(USER, { alias: 'T' }), secret);
      assert.equal(redact(`x ${secret} y`), 'x *** y', 'retrieved password registered for redaction');
      log('info', 'credential test', { value: secret });
      assert.equal(await deleteSudoPassword(USER), true);
      await assert.rejects(getSudoPassword(USER, { alias: 'T' }),
        /No sudo password in Windows Credential Manager for alias T user '__mcp_test__'\. Run: npm run set-sudo-password -- __mcp_test__/);
      assert.equal(await deleteSudoPassword(USER), false, 'nothing left to delete');
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

test('setSudoPassword rejects empty password', async () => {
  await assert.rejects(setSudoPassword(USER, ''), /non-empty/);
});
