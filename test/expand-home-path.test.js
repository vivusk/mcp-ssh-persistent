import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'os';
import { join } from 'path';
import { expandHome } from '../src/utils/expand-home-path.js';

test('bare ~ and ~/ expand to home', () => {
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('~/'), join(homedir(), ''));
  assert.equal(expandHome('~/a'), join(homedir(), 'a'));
  assert.equal(expandHome('~/.ssh/id_ed25519'), join(homedir(), '.ssh', 'id_ed25519'));
});

test('~\\ expands only on win32', () => {
  const expected = process.platform === 'win32' ? join(homedir(), 'a') : '~\\a';
  assert.equal(expandHome('~\\a'), expected);
});

test('absolute, relative and ~user paths are unchanged', () => {
  assert.equal(expandHome('/abs/k'), '/abs/k');
  assert.equal(expandHome('rel/k'), 'rel/k');
  assert.equal(expandHome('~user/x'), '~user/x');
  assert.equal(expandHome('a/~/b'), 'a/~/b');
});

test('non-strings pass through', () => {
  assert.equal(expandHome(undefined), undefined);
  assert.equal(expandHome(null), null);
  assert.equal(expandHome(42), 42);
});
