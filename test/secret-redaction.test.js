import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSecret, redact } from '../src/security/secret-redaction.js';

test('registered secrets are masked everywhere', () => {
  registerSecret('s3cr3t-Value');
  assert.equal(redact('a s3cr3t-Value b s3cr3t-Value'), 'a *** b ***');
});

test('short secrets (< 4 chars) are ignored', () => {
  registerSecret('abc');
  assert.equal(redact('abc abc'), 'abc abc');
});

test('longer secret containing a shorter one is fully masked', () => {
  registerSecret('pass');
  registerSecret('password123');
  assert.equal(redact('x password123 y pass'), 'x *** y ***');
});

test('PEM private key blocks are masked', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAbase64\nmore\n-----END OPENSSH PRIVATE KEY-----';
  assert.equal(redact(`key:\n${pem}\nend`), 'key:\n***\nend');
  const rsa = '-----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----';
  assert.equal(redact(rsa), '***');
});

test('non-string input is handled', () => {
  assert.equal(redact(undefined), '');
  assert.equal(redact(null), '');
  assert.equal(redact(42), '42');
});

test('secrets with quotes/backslashes are masked in jsonResponse and log meta', async () => {
  const { jsonResponse } = await import('../src/utils/response.js');
  const { readFileSync } = await import('node:fs');
  const { log, getLogPath } = await import('../src/utils/logger.js');
  const secret = `pa"ss${String.fromCharCode(92)}word`; // contains " and a backslash
  registerSecret(secret);
  const text = jsonResponse({ out: `x ${secret} y`, nested: [secret] }).content[0].text;
  assert.equal(text, '{"out":"x *** y","nested":["***"]}');
  log('debug', 'redaction-test', { error: `bad ${secret}`, err: new Error(`boom ${secret}`) });
  // Other test files log concurrently to the same file: find our line, not the last one.
  const last = readFileSync(getLogPath(), 'utf8').trim().split('\n').findLast((l) => l.includes('redaction-test'));
  assert.ok(last);
  assert.ok(!last.includes(JSON.stringify(secret).slice(1, -1)));
  assert.ok(last.includes('bad ***'));
});
