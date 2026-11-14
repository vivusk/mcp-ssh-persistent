import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CappedOutputCollector } from '../src/utils/capped-output-collector.js';

test('multibyte char split across chunks is decoded intact', () => {
  const buf = Buffer.from('Việt', 'utf8'); // "ệ" is 3 bytes at offset 2..4
  const c = new CappedOutputCollector(1024);
  c.push(buf.subarray(0, 3)); // ends mid "ệ"
  c.push(buf.subarray(3));
  assert.equal(c.toString(), 'Việt');
  assert.equal(c.truncated, false);
});

test('3-byte char split byte-by-byte across chunks', () => {
  const buf = Buffer.from('ệ', 'utf8');
  assert.equal(buf.length, 3);
  const c = new CappedOutputCollector(1024);
  for (const b of buf) c.push(Buffer.from([b]));
  assert.equal(c.toString(), 'ệ');
});

test('300 KB input with 100 KB cap keeps head+tail and reports dropped bytes', () => {
  const cap = 100 * 1024;
  const c = new CappedOutputCollector(cap);
  const line = Buffer.from('0123456789abcdef'.repeat(64)); // 1 KB
  for (let i = 0; i < 300; i++) c.push(line);
  const out = c.toString();
  const dropped = 300 * 1024 - cap;
  const marker = `\n[... truncated ${dropped} bytes ...]\n`;
  assert.equal(c.droppedBytes, dropped);
  assert.ok(out.includes(marker));
  assert.equal(Buffer.byteLength(out), cap + Buffer.byteLength(marker));
  const [head, tail] = out.split(marker);
  assert.equal(Buffer.byteLength(head), Math.floor(cap * 0.2));
  assert.equal(Buffer.byteLength(tail), cap - Math.floor(cap * 0.2));
  assert.ok(out.startsWith('0123456789abcdef'));
  assert.ok(out.endsWith('0123456789abcdef'));
});

test('truncation never splits multibyte chars (Vietnamese text)', () => {
  const c = new CappedOutputCollector(1000);
  const text = 'Tiếng Việt có dấu ệ ữ ỡ ẫ. '.repeat(500);
  const buf = Buffer.from(text);
  // Odd chunk size to force splits everywhere.
  for (let i = 0; i < buf.length; i += 7) c.push(buf.subarray(i, i + 7));
  const out = c.toString();
  assert.ok(!out.includes('�'), 'no replacement chars');
  assert.ok(c.truncated);
  const m = out.match(/\[\.\.\. truncated (\d+) bytes \.\.\.\]/);
  assert.ok(m);
  const kept = Buffer.byteLength(out.replace(`\n${m[0]}\n`, ''));
  assert.equal(Number(m[1]) + kept, buf.length);
});

test('under cap returns input unchanged, accepts strings', () => {
  const c = new CappedOutputCollector(1024);
  c.push('hello ');
  c.push(Buffer.from('world'));
  assert.equal(c.toString(), 'hello world');
  assert.equal(c.totalBytes, 11);
});
