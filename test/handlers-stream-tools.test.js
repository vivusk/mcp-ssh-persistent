import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from '../src/tools/handlers.js';
import { formatStreamResult } from '../src/tools/format-stream-result.js';
import { createSessionPool } from '../src/ssh/session-pool.js';
import { ShellStream } from '../src/ssh/shell-stream.js';
import { createFakeShellClient, PROMPT } from './fake-shell-channel.js';

const SERVERS = {
  s: { alias: 'S', host: '192.0.2.10', username: 'root' },
  rr: { alias: 'RR', host: '192.0.2.11', username: 'deploy' },
};
const resolveServer = (a) => {
  const s = SERVERS[String(a).toLowerCase()];
  if (!s) throw new Error(`unknown server alias "${a}"`);
  return { ...s };
};
const text = (r) => r.content[0].text;

/** Real pool + real ShellStream over fake connections / fake shell channels. */
function setup({ maxStreams = 2, respond } = {}) {
  const clients = [];
  const pool = createSessionPool({
    resolveServer,
    getLimits: () => ({ maxConcurrentExec: 4, maxOutputBytes: 102400, maxStreams, streamBufferBytes: 4096 }),
    createConnection: (server) => {
      const client = createFakeShellClient(respond ? { respond } : {});
      clients.push(client);
      let connected = false;
      return {
        server, fingerprintInfo: null,
        async connect() { connected = true; },
        onClose() {}, isConnected: () => connected, getClient: () => client,
        disconnect() { connected = false; },
      };
    },
    openShell: (client, opts) => ShellStream.open(client, { ...opts, initTimeoutMs: 300 }),
  });
  return { pool, clients, h: createHandlers(pool) };
}

test('footer formats: prompt, awaiting_input kinds with hints, timeout, truncated', () => {
  const f = (r) => text(formatStreamResult(r));
  assert.equal(f({ output: '/tmp\n', state: 'prompt' }), '/tmp\n[state: prompt]');
  assert.match(f({ output: '', state: 'awaiting_input', kind: 'sudo' }), /^\[state: awaiting_input\(sudo\)\] .*call ssh_sudo_auth/);
  assert.match(f({ output: 'x', state: 'awaiting_input', kind: 'password' }), /\[state: awaiting_input\(password\)\] not a sudo prompt for this user; ssh_sudo_auth will refuse/);
  assert.match(f({ output: '', state: 'awaiting_input', kind: 'confirm' }), /\[state: awaiting_input\(confirm\)\]/);
  assert.match(f({ output: 'a', state: 'timeout', droppedBytes: 12 }), /^a\n\[state: timeout\] .*ssh_stream_read\n\[truncated 12 bytes\]$/);
});

test('stream_start with command -> output + prompt; write verbatim; read; stop', async () => {
  const { h, clients } = setup();
  const r = await h('ssh_stream_start', { server: 's', stream_id: 'a', command: 'pwd' });
  assert.equal(text(r), '[stream a opened on S]\nout:pwd\n[state: prompt]');
  const w = await h('ssh_stream_write', { stream_id: 'a', data: "printf 'a\\nb\\n'\n" });
  assert.equal(clients[0].channels[0].writes[2], "printf 'a\\nb\\n'\n", 'no \\\\n replacement');
  assert.match(text(w), /\[state: prompt\]$/);
  assert.equal(text(await h('ssh_stream_read', { stream_id: 'a' })), '[state: prompt]');
  assert.equal(text(await h('ssh_stream_stop', { stream_id: 'a' })), '[stream a stopped on S]');
  assert.ok(clients[0].channels[0].writes.includes('\x03'));
  const after = await h('ssh_stream_read', { stream_id: 'a' });
  assert.equal(after.isError, true);
  assert.match(text(after), /unknown stream_id/);
});

test('long-running command -> [state: timeout] after wait_ms', async () => {
  const { h } = setup({ respond: () => [[5, 'log line\r\n']] });
  const r = await h('ssh_stream_start', { server: 'S', stream_id: 't', command: 'tail -f x', wait_ms: 100 });
  assert.match(text(r), /log line\n\[state: timeout\] command may still be running/);
});

test('sudo prompt for session user (RR=deploy) -> awaiting_input(sudo)', async () => {
  const { h } = setup({ respond: () => [[5, '[sudo] password for deploy: ']] });
  await h('ssh_stream_start', { server: 'RR', stream_id: 'x' });
  assert.match(text(await h('ssh_stream_write', { stream_id: 'x', data: 'sudo ls\n' })), /\[state: awaiting_input\(sudo\)\]/);
});

test('duplicate stream_id (any alias) -> error, existing stream untouched', async () => {
  const { h } = setup();
  await h('ssh_stream_start', { server: 'S', stream_id: 'dup' });
  for (const server of ['S', 'RR']) {
    const r = await h('ssh_stream_start', { server, stream_id: 'dup' });
    assert.equal(r.isError, true);
    assert.equal(text(r), 'Error: stream_id dup already open on S; stop it or pick another id');
  }
  assert.match(text(await h('ssh_stream_write', { stream_id: 'dup', data: 'echo hi\n' })), /out:echo hi/);
});

test('stream cap per session -> error; stopping one frees a slot; other alias unaffected', async () => {
  const { h } = setup({ maxStreams: 2 });
  await h('ssh_stream_start', { server: 'S', stream_id: 's1' });
  await h('ssh_stream_start', { server: 'S', stream_id: 's2' });
  const r = await h('ssh_stream_start', { server: 'S', stream_id: 's3' });
  assert.equal(text(r), 'Error: max 2 streams for S; stop one first');
  assert.equal((await h('ssh_stream_start', { server: 'RR', stream_id: 'r1' })).isError, undefined);
  await h('ssh_stream_stop', { stream_id: 's1' });
  assert.equal((await h('ssh_stream_start', { server: 'S', stream_id: 's3' })).isError, undefined);
  assert.deepEqual(JSON.parse(text(await h('ssh_status', {}))).map((x) => x.streams), [['s2', 's3'], ['r1']]);
});

test('two streams on one alias have separate channels; outputs do not mix', async () => {
  const { h, clients } = setup({ respond: (d) => [[20, `${d.trim()}-1\r\n`], [40, `${d.trim()}-2\r\n${PROMPT}`]] });
  await h('ssh_stream_start', { server: 'S', stream_id: 'p' });
  await h('ssh_stream_start', { server: 'S', stream_id: 'q' });
  const [a, b] = await Promise.all([
    h('ssh_stream_write', { stream_id: 'p', data: 'A\n' }),
    h('ssh_stream_write', { stream_id: 'q', data: 'B\n' }),
  ]);
  assert.equal(clients[0].channels.length, 2);
  assert.equal(text(a), 'A-1\nA-2\n[state: prompt]');
  assert.equal(text(b), 'B-1\nB-2\n[state: prompt]');
});

test('disconnect closes the session streams', async () => {
  const { h, pool } = setup();
  const r = await h('ssh_stream_start', { server: 'S', stream_id: 'd' });
  assert.equal(r.isError, undefined);
  const { stream } = await pool.getStream('d');
  await h('ssh_disconnect', { server: 'S' });
  assert.equal(stream.active, false);
  assert.match(text(await h('ssh_stream_read', { stream_id: 'd' })), /unknown stream_id/);
});

test('missing data / unknown stream -> errors', async () => {
  const { h } = setup();
  assert.match(text(await h('ssh_stream_write', { stream_id: 'nope', data: 'x' })), /unknown stream_id "nope"/);
  await h('ssh_stream_start', { server: 'S', stream_id: 'm' });
  assert.match(text(await h('ssh_stream_write', { stream_id: 'm' })), /"data" is required/);
});
