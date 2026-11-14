import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linuxReadPassword, linuxWritePassword, linuxDeletePassword,
} from '../src/security/linux-secret-service-keyring.js';

// Unit tests with an injected fake napi `{ Entry }` (F3): run on every OS.
const SVC = 'mcp-ssh-persistent';
const ACCT = 'sudo:__mcp_test__';
const noEntry = () => Object.assign(new Error('No matching entry found in secure storage'), { code: 'NoEntry' });

/** Fake napi module backed by a Map; `behaviour` overrides individual methods. */
function fakeNapi(behaviour = {}) {
  const store = new Map();
  class Entry {
    constructor(service, account) { this.key = `${service}/${account}`; }
    getPassword() { return behaviour.get ? behaviour.get() : (store.get(this.key) ?? null); }
    setPassword(pw) { if (behaviour.set) return behaviour.set(pw); store.set(this.key, pw); }
    deletePassword() {
      if (behaviour.del) return behaviour.del();
      if (!store.has(this.key)) throw noEntry();
      return store.delete(this.key);
    }
  }
  return { Entry, store };
}

test('linux adapter: getPassword null → read null', () => {
  assert.equal(linuxReadPassword(fakeNapi(), SVC, ACCT), null);
});

test('linux adapter: getPassword throws NoEntry → read null', () => {
  assert.equal(linuxReadPassword(fakeNapi({ get: () => { throw noEntry(); } }), SVC, ACCT), null);
});

test('linux adapter: write → read → delete → delete missing', () => {
  const napi = fakeNapi();
  linuxWritePassword(napi, SVC, ACCT, 's3cret');
  assert.equal(napi.store.get(`${SVC}/${ACCT}`), 's3cret');
  assert.equal(linuxReadPassword(napi, SVC, ACCT), 's3cret');
  assert.equal(linuxDeletePassword(napi, SVC, ACCT), true);
  assert.equal(linuxDeletePassword(napi, SVC, ACCT), false, 'NoEntry → false');
});

test('linux adapter: deletePassword returning false/null → false', () => {
  assert.equal(linuxDeletePassword(fakeNapi({ del: () => false }), SVC, ACCT), false);
  assert.equal(linuxDeletePassword(fakeNapi({ del: () => null }), SVC, ACCT), false);
});

test('linux adapter: other errors rethrown with Secret Service hint', () => {
  const boom = () => { throw new Error('org.freedesktop.DBus.Error.ServiceUnknown'); };
  const re = /Secret Service (read|write|delete) failed: org\.freedesktop\.DBus\.Error\.ServiceUnknown \(install\/unlock a Secret Service keyring/;
  assert.throws(() => linuxReadPassword(fakeNapi({ get: boom }), SVC, ACCT), re);
  assert.throws(() => linuxDeletePassword(fakeNapi({ del: boom }), SVC, ACCT), re);
  assert.throws(() => linuxWritePassword(fakeNapi({ set: boom }), SVC, ACCT, 'x'), re);
});

test('linux adapter: write read-back mismatch throws', () => {
  const napi = fakeNapi({ set: () => {} }); // silently drops the write
  assert.throws(() => linuxWritePassword(napi, SVC, ACCT, 'x'), /read-back mismatch/);
});
