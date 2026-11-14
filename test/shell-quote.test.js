import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { shellSingleQuote } from '../src/utils/shell-quote.js';

test('plain, empty and quote handling', () => {
  assert.equal(shellSingleQuote('ls -la'), "'ls -la'");
  assert.equal(shellSingleQuote(''), "''");
  assert.equal(shellSingleQuote("it's"), "'it'\\''s'");
  assert.equal(shellSingleQuote("''"), "''\\'''\\'''");
});

test('$, backticks, backslash, newlines stay literal inside quotes', () => {
  assert.equal(shellSingleQuote('echo $HOME `id` \\n'), "'echo $HOME `id` \\n'");
  assert.equal(shellSingleQuote('a\nb'), "'a\nb'");
});

// Round trip through a real POSIX shell when one is available (Git Bash on Windows).
test('round trip through sh printf', { skip: !hasSh() }, () => {
  for (const s of ["it's", 'a $HOME `id` "q"', 'line1\nline2', "x'\\'y", '*?[a]{b,c}']) {
    const out = execFileSync('sh', ['-c', `printf %s ${shellSingleQuote(s)}`], { encoding: 'utf8' });
    assert.equal(out, s);
  }
});

function hasSh() {
  try { execFileSync('sh', ['-c', 'true']); return true; } catch { return false; }
}
