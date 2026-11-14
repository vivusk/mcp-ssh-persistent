import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, cleanOutput } from '../src/utils/ansi.js';

test('strips CSI color and cursor sequences', () => {
  assert.equal(stripAnsi('\x1b[1;32mgreen\x1b[0m \x1b[2K\x1b[?2004hx'), 'green x');
});

test('strips OSC terminated by BEL', () => {
  assert.equal(stripAnsi('\x1b]0;user@host: ~\x07$ '), '$ ');
});

test('strips OSC terminated by ST (ESC \\)', () => {
  assert.equal(stripAnsi('\x1b]0;title\x1b\\ok'), 'ok');
  assert.equal(stripAnsi('\x1b]7;file://host/tmp\x1b\\a\x1b]0;t\x07b'), 'ab');
});

test('normalises CRLF and CR+CRLF to LF', () => {
  assert.equal(stripAnsi('a\r\nb\r\r\nc'), 'a\nb\nc');
});

test('cleanOutput trims', () => {
  assert.equal(cleanOutput('  \x1b[31mred\x1b[0m\r\n'), 'red');
});

test('unterminated OSC does not swallow following lines up to a later BEL', () => {
  const out = stripAnsi('\x1b]0;title\nline1\nline2\x07');
  assert.ok(out.includes('line1') && out.includes('line2'));
});
