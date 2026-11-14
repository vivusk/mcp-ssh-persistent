import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { verify, fingerprintOf } from '../src/config/known-hosts-fingerprint-store.js';

const dir = mkdtempSync(join(tmpdir(), 'mcp-ssh-kh-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const keyA = Buffer.from('host-key-A');
const keyB = Buffer.from('host-key-B');

test('fingerprintOf is OpenSSH SHA256 base64 without padding', () => {
  const b64 = createHash('sha256').update(keyA).digest('base64');
  assert.equal(fingerprintOf(keyA), 'SHA256:' + b64.replace(/=+$/, ''));
  assert.ok(!fingerprintOf(keyA).endsWith('='));
});

test('TOFU: first key stored (isNew), same key ok, other key mismatch', () => {
  const store = join(dir, 'tofu.json');
  const first = verify('192.0.2.10', 22, keyA, undefined, store);
  assert.deepEqual([first.ok, first.isNew], [true, true]);
  const saved = JSON.parse(readFileSync(store, 'utf8'));
  assert.equal(saved['192.0.2.10:22'].fingerprint, fingerprintOf(keyA));
  assert.ok(saved['192.0.2.10:22'].addedAt);

  const again = verify('192.0.2.10', 22, keyA, undefined, store);
  assert.deepEqual([again.ok, again.isNew], [true, false]);

  const bad = verify('192.0.2.10', 22, keyB, undefined, store);
  assert.equal(bad.ok, false);
  assert.equal(bad.expected, fingerprintOf(keyA));
  assert.equal(bad.fingerprint, fingerprintOf(keyB));
  // store unchanged after mismatch
  assert.equal(JSON.parse(readFileSync(store, 'utf8'))['192.0.2.10:22'].fingerprint, fingerprintOf(keyA));
});

test('port is part of the identity', () => {
  const store = join(dir, 'ports.json');
  verify('192.0.2.11', 22, keyA, undefined, store);
  const other = verify('192.0.2.11', 2222, keyB, undefined, store);
  assert.deepEqual([other.ok, other.isNew], [true, true]);
});

test('config pin wins over store (with or without prefix/padding)', () => {
  const store = join(dir, 'pin.json');
  verify('192.0.2.12', 22, keyA, undefined, store); // store pins A
  const fpB = fingerprintOf(keyB);
  const viaConfig = verify('192.0.2.12', 22, keyB, fpB, store);
  assert.deepEqual([viaConfig.ok, viaConfig.source], [true, 'config']);
  const bare = verify('192.0.2.12', 22, keyB, fpB.slice(7) + '=', store);
  assert.equal(bare.ok, true);
  const wrong = verify('192.0.2.12', 22, keyA, fpB, store);
  assert.equal(wrong.ok, false);
});

test('config pin does not write the store', () => {
  const store = join(dir, 'pin-only.json');
  verify('192.0.2.13', 22, keyA, fingerprintOf(keyA), store);
  assert.equal(existsSync(store), false);
});

test('corrupt store throws instead of re-trusting', () => {
  const store = join(dir, 'corrupt.json');
  writeFileSync(store, '{not json');
  assert.throws(() => verify('192.0.2.14', 22, keyA, undefined, store), /not a valid JSON/);
});
