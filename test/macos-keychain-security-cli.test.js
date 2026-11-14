import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSecurityPasswordLine, escapeSecurityArg } from '../src/security/macos-keychain-security-cli.js';

// Pure parser/escape unit tests: run on every OS, never spawn `security`.
const STDERR_PREFIX = 'keychain: "/Users/x/Library/Keychains/login.keychain-db"\nclass: "genp"\n';

test('parseSecurityPasswordLine: plain quoted password', () => {
  assert.equal(parseSecurityPasswordLine(`${STDERR_PREFIX}password: "abc"\n`), 'abc');
});

test('parseSecurityPasswordLine: embedded quote strips only the outer pair', () => {
  assert.equal(parseSecurityPasswordLine(`password: "p"q'r s$t;u"\n`), `p"q'r s$t;u`);
});

test('parseSecurityPasswordLine: hex form decodes UTF-8 and ignores trailing text', () => {
  assert.equal(parseSecurityPasswordLine('password: 0x74C3A9  "t\\303\\251"\n'), 'té');
  assert.equal(parseSecurityPasswordLine('password: 0x615C62  "a\\\\b"'), 'a\\b');
});

test('parseSecurityPasswordLine: empty password', () => {
  assert.equal(parseSecurityPasswordLine('password: \n'), '');
});

test('parseSecurityPasswordLine: no password line throws', () => {
  assert.throws(() => parseSecurityPasswordLine(STDERR_PREFIX), /no password line/);
  assert.throws(() => parseSecurityPasswordLine(''), /no password line/);
});

test('parseSecurityPasswordLine: unrecognised format throws', () => {
  assert.throws(() => parseSecurityPasswordLine('password: weird'), /unrecognised password format/);
});

test('escapeSecurityArg escapes only backslash and double quote', () => {
  assert.equal(escapeSecurityArg('abc'), '"abc"');
  assert.equal(escapeSecurityArg('a"b\\c d'), '"a\\"b\\\\c d"');
  assert.equal(escapeSecurityArg("semi;colon t-é'x $`"), "\"semi;colon t-é'x $`\"");
});
