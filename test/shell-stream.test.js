import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShellStream, INIT_COMMAND, MARKER_WARNING } from '../src/ssh/shell-stream.js';
import { createFakeShellChannel, createFakeShellClient, PROMPT } from './fake-shell-channel.js';

const opts = { streamId: 't1', alias: 'S', username: 'deploy', bufferBytes: 4096 };

async function openStream(channelOpts, extra = {}) {
  const ch = createFakeShellChannel(channelOpts);
  const s = new ShellStream(ch, { ...opts, ...extra });
  await s.init(extra.initTimeoutMs ?? 500);
  return { ch, s };
}

test('open: shell window, init line first, init output discarded, marker mode', async () => {
  const client = createFakeShellClient();
  const s = await ShellStream.open(client, { ...opts, initTimeoutMs: 500 });
  assert.equal(client.channels[0].writes[0], INIT_COMMAND);
  assert.ok(INIT_COMMAND.startsWith(' unset HISTFILE; set +o history +o emacs +o vi;'));
  assert.equal(s.markerMode, true);
  assert.equal(s.initWarning, null);
  const r = await s.read();
  assert.equal(r.output, '');
});

test('write: returns on marker prompt quickly with marker stripped', async () => {
  const { s } = await openStream();
  const t0 = Date.now();
  const r = await s.write('pwd\n');
  assert.ok(Date.now() - t0 < 200, 'event-driven, no 5 s wait');
  assert.equal(r.output, 'out:pwd\n');
  assert.equal(r.state, 'prompt');
  assert.equal(r.unreadDiscardedBytes, 0);
  assert.equal(r.droppedBytes, 0);
});

test('write: data sent verbatim (no escape translation)', async () => {
  const { ch, s } = await openStream();
  await s.write("printf 'a\\nb\\n'\n");
  assert.equal(ch.writes[1], "printf 'a\\nb\\n'\n");
});

test('write: running past waitMs -> state timeout', async () => {
  const { s } = await openStream({ respond: () => [[5, 'line1\r\n']] });
  const r = await s.write('tail -f x\n', { waitMs: 150 });
  assert.equal(r.state, 'timeout');
  assert.equal(r.output, 'line1\n');
});

test('write: sudo prompt -> awaiting_input(sudo); other user -> password', async () => {
  const { s } = await openStream({ respond: (d) => [[5, d.includes('other') ? '[sudo] password for other: ' : '[sudo] password for deploy: ']] });
  assert.deepEqual([(await s.write('sudo ls\n')).state, s.lastDetection.kind], ['awaiting_input', 'sudo']);
  const r = await s.write('sudo -u other ls\n');
  assert.deepEqual([r.state, r.kind], ['awaiting_input', 'password']);
});

test('write: generic prompt (sudo -s root shell) -> prompt after ~300 ms quiet', async () => {
  const { s } = await openStream({ respond: () => [[5, 'root@host:/home/deploy# ']] });
  const t0 = Date.now();
  const r = await s.write('sudo -s\n', { waitMs: 3000 });
  const ms = Date.now() - t0;
  assert.equal(r.state, 'prompt');
  assert.ok(ms >= 290 && ms < 800, `${ms} ms`);
});

test('unread output before a write is reported with its tail, not dropped silently', async () => {
  const { ch, s } = await openStream();
  ch.emit('data', Buffer.from('background noise\r\n'));
  const r = await s.write('echo hi\n');
  assert.equal(r.unreadDiscardedBytes, 18);
  assert.match(r.output, /^\[unread before write: 18 bytes, tail shown\]\nbackground noise\n\nout:echo hi\n$/);
});

test('mutex: concurrent writes are serialized, outputs do not mix', async () => {
  const { ch, s } = await openStream({ respond: (d) => [[30, `A-${d.trim()}\r\n`], [40, `B-${d.trim()}\r\n${PROMPT}`]] });
  const [r1, r2] = await Promise.all([s.write('one\n'), s.write('two\n')]);
  assert.equal(r1.output, 'A-one\nB-one\n');
  assert.equal(r2.output, 'A-two\nB-two\n');
  assert.deepEqual(ch.writes.slice(1), ['one\n', 'two\n']);
});

test('read: waitMs waits for data then 500 ms quiet; clear=false keeps buffer', async () => {
  const { ch, s } = await openStream();
  setTimeout(() => ch.emit('data', Buffer.from('late\r\n')), 50);
  const t0 = Date.now();
  const r = await s.read({ waitMs: 2000, clear: false });
  assert.ok(Date.now() - t0 >= 500 && Date.now() - t0 < 1000);
  assert.equal(r.output, 'late\n');
  assert.equal(r.state, 'running');
  assert.equal((await s.read()).output, 'late\n');
  assert.equal((await s.read()).output, '');
});

test('buffer cap: droppedBytes reported, UTF-8 intact', async () => {
  const { ch, s } = await openStream();
  ch.emit('data', Buffer.from('ệ'.repeat(3000)));
  const r = await s.read();
  assert.ok(r.droppedBytes > 0);
  assert.ok(!r.output.includes('�'));
});

test('marker missing at init (non-bash shell) -> fallback mode, warning, no throw', async () => {
  const { s } = await openStream({ markerOnInit: false }, { initTimeoutMs: 200 });
  assert.equal(s.markerMode, false);
  assert.equal(s.initWarning, MARKER_WARNING);
  assert.equal((await s.read()).output, '', 'init output discarded');
});

test('interrupt writes Ctrl+C; close -> further calls error "closed"', async () => {
  const { ch, s } = await openStream({ respond: () => [] });
  const pending = s.write('sleep 100\n', { waitMs: 5000 });
  setTimeout(() => s.close(), 30);
  const r = await pending;
  assert.equal(r.state, 'closed');
  s.interrupt();
  assert.ok(!ch.writes.includes('\x03'), 'no write after close');
  await assert.rejects(s.write('x\n'), /stream t1 closed/);
});

test('channel close from remote marks stream inactive and runs onClose callbacks', async () => {
  const { ch, s } = await openStream();
  let closed = false;
  s.onClose(() => { closed = true; });
  ch.emit('close');
  assert.equal(s.active, false);
  assert.equal(closed, true);
});
