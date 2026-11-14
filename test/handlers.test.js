import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHandlers } from '../src/tools/handlers.js';
import { getToolDefinitions } from '../src/tools/definitions.js';
import { resolveServer, resetConfigCache } from '../src/config/load-config-and-server-aliases.js';
import { registerSecret } from '../src/security/secret-redaction.js';
import { ShellStream } from '../src/ssh/shell-stream.js';
import { createFakeShellClient, PROMPT } from './fake-shell-channel.js';

const dir = mkdtempSync(join(tmpdir(), 'mcp-ssh-handlers-'));
const prevEnv = process.env.MCP_SSH_CONFIG;
before(() => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    defaults: { privateKeyPath: 'C:/keys/id' },
    servers: { S: { host: '192.0.2.10', username: 'root' }, RR: { host: '203.0.113.5', username: 'deploy' } },
  }));
  process.env.MCP_SSH_CONFIG = path;
  resetConfigCache();
});
after(() => {
  if (prevEnv === undefined) delete process.env.MCP_SSH_CONFIG;
  else process.env.MCP_SSH_CONFIG = prevEnv;
  resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

/** Fake pool: resolves aliases via real config, exec returns the queued result. */
function fakePool(result) {
  const calls = [];
  return {
    calls,
    async getSession(alias) {
      const server = resolveServer(alias);
      return {
        alias: server.alias,
        server,
        exec: { async exec(command, opts) { calls.push({ alias: server.alias, command, opts }); return result; } },
      };
    },
    status: () => [{ alias: 'S', connected: true }],
    disconnect: (a) => (a ? [resolveServer(a).alias] : ['S']),
  };
}

const ok = (o) => ({ stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, ...o });
const text = (r) => r.content[0].text;

test('exec text: stdout, no stderr section when empty, [exit: N]', async () => {
  const pool = fakePool(ok({ stdout: 'hello\n' }));
  const r = await createHandlers(pool)('ssh_exec', { server: 's', command: 'echo hello' });
  assert.equal(text(r), 'hello\n[exit: 0]');
  assert.equal(r.isError, undefined);
  assert.deepEqual(pool.calls[0], { alias: 'S', command: 'echo hello', opts: { timeout: 30000, pty: false } });
});

test('exec text: stderr section when non-empty', async () => {
  const r = await createHandlers(fakePool(ok({ stdout: 'a', stderr: 'b\n', exitCode: 1 })))('ssh_exec', { server: 'S', command: 'x' });
  assert.equal(text(r), 'a\n--- stderr ---\nb\n[exit: 1]');
  assert.equal(r.isError, undefined, 'exit 1 is not an error');
});

test('isError for exit >= 2, signal, timeout; pty/timeout passed through', async () => {
  const h = (res) => createHandlers(fakePool(res));
  assert.equal((await h(ok({ exitCode: 2 }))('ssh_exec', { server: 'S', command: 'x' })).isError, true);
  const sig = await h(ok({ exitCode: null, signal: 'KILL' }))('ssh_exec', { server: 'S', command: 'x' });
  assert.equal(sig.isError, true);
  assert.match(text(sig), /\[signal: KILL\]/);
  const pool = fakePool(ok({ exitCode: null, timedOut: true }));
  const to = await createHandlers(pool)('ssh_exec', { server: 'S', command: 'sleep 5', timeout: 1000, pty: true });
  assert.equal(to.isError, true);
  assert.equal(text(to), '[timed out after 1000ms]');
  assert.deepEqual(pool.calls[0].opts, { timeout: 1000, pty: true });
});

test('missing server -> error listing aliases', async () => {
  const r = await createHandlers(fakePool(ok()))('ssh_exec', { command: 'ls' });
  assert.equal(r.isError, true);
  assert.match(text(r), /"server" is required; known aliases: S, RR/);
});

test('unknown alias -> error listing aliases', async () => {
  const r = await createHandlers(fakePool(ok()))('ssh_exec', { server: 'ZZ', command: 'ls' });
  assert.equal(r.isError, true);
  assert.match(text(r), /unknown server alias "ZZ"; known aliases: S, RR/);
});

test('registered secret in stdout is redacted', async () => {
  registerSecret('hunter2-secret');
  const r = await createHandlers(fakePool(ok({ stdout: 'pw=hunter2-secret' })))('ssh_exec', { server: 'S', command: 'x' });
  assert.equal(text(r), 'pw=***\n[exit: 0]');
});

test('removed tools -> unknown tool error', async () => {
  const h = createHandlers(fakePool(ok()));
  for (const name of ['ssh_connect', 'ssh_reset_shell', 'toString', '__proto__']) {
    const r = await h(name, {});
    assert.equal(r.isError, true);
    assert.match(text(r), /Unknown tool/);
  }
});

test('status / disconnect return compact JSON', async () => {
  const h = createHandlers(fakePool(ok()));
  assert.equal(text(await h('ssh_status', {})), '[{"alias":"S","connected":true}]');
  assert.equal(text(await h('ssh_disconnect', { server: 'rr' })), '{"disconnected":["RR"]}');
  assert.equal(text(await h('ssh_disconnect', {})), '{"disconnected":["S"]}');
});

test('ListTools: server description lists config aliases; no removed tools', () => {
  const tools = getToolDefinitions();
  const names = tools.map((t) => t.name);
  assert.ok(!names.includes('ssh_connect') && !names.includes('ssh_reset_shell'));
  const exec = tools.find((t) => t.name === 'ssh_exec');
  assert.match(exec.inputSchema.properties.server.description, /S, RR/);
  assert.deepEqual(exec.inputSchema.required, ['server', 'command']);
  for (const name of ['ssh_upload', 'ssh_download', 'ssh_write_remote_file', 'ssh_read_remote_file', 'ssh_stream_start']) {
    assert.ok(tools.find((t) => t.name === name).inputSchema.required.includes('server'), name);
  }
});

// ---- sudo (phase 04) ----

const SUDO_PW = 'handler-test-sudo-pw';

test('exec sudo:true -> username from session.server, password getter bound to alias', async () => {
  const pool = fakePool(ok({ stdout: '0\n' }));
  const got = [];
  const h = createHandlers(pool, { getSudoPassword: async (u, o) => { got.push([u, o.alias]); return SUDO_PW; } });
  await h('ssh_exec', { server: 'rr', command: 'id -u', sudo: true, username: 'evil' });
  const { sudo } = pool.calls[0].opts;
  assert.equal(sudo.username, 'deploy', 'LLM-supplied username ignored');
  assert.equal(await sudo.getPassword(), SUDO_PW);
  assert.deepEqual(got, [['deploy', 'RR']]);
});

/** Pool with one real ShellStream (user deploy on RR) over a fake shell channel. */
async function sudoStreamSetup(promptText, onFetch = null) {
  const client = createFakeShellClient({
    respond: (d) => (d === `${SUDO_PW}\n` ? [[5, `\r\nroot\r\n${PROMPT}`]] : [[5, promptText]]),
  });
  const stream = await ShellStream.open(client, { streamId: 'x', alias: 'RR', username: 'deploy', initTimeoutMs: 300 });
  const session = { alias: 'RR', server: { username: 'deploy' } };
  const pool = { getStream: async () => ({ session, stream }) };
  let fetched = 0;
  const h = createHandlers(pool, { getSudoPassword: async () => {
    fetched += 1;
    if (onFetch) await onFetch(client.channels[0]);
    return SUDO_PW;
  } });
  const pwWrites = () => client.channels[0].writes.filter((w) => w.includes(SUDO_PW)).length;
  return { h, fetched: () => fetched, pwWrites };
}

for (const tail of ["deploy@203.0.113.5's password: ", 'Password: ', '[sudo] password for root: ']) {
  test(`sudo_auth refuses non-sudo prompt: ${JSON.stringify(tail)}`, async () => {
    const t = await sudoStreamSetup(tail);
    assert.match(text(await t.h('ssh_stream_write', { stream_id: 'x', data: 'ssh other\n' })), /awaiting_input\(password\)/);
    const r = await t.h('ssh_sudo_auth', { stream_id: 'x' });
    assert.equal(r.isError, true);
    assert.match(text(r), /pending prompt is not a sudo prompt for deploy; password not sent/);
    assert.equal(t.fetched(), 0);
    assert.equal(t.pwWrites(), 0);
  });
}

test('sudo_auth: prompt returned by write (buffer cleared) -> detected on retained tail, written once', async () => {
  const t = await sudoStreamSetup('[sudo] password for deploy: ');
  assert.match(text(await t.h('ssh_stream_write', { stream_id: 'x', data: 'sudo whoami\n' })), /awaiting_input\(sudo\)/);
  assert.match(text(await t.h('ssh_stream_read', { stream_id: 'x' })), /awaiting_input\(sudo\)/, 'read clears buffer, tail kept');
  const r = await t.h('ssh_sudo_auth', { stream_id: 'x' });
  assert.match(text(r), /^\s*root\n\[state: prompt\]$/);
  assert.ok(!text(r).includes(SUDO_PW));
  assert.equal(t.pwWrites(), 1);
  const again = await t.h('ssh_sudo_auth', { stream_id: 'x' });
  assert.match(text(again), /no sudo prompt pending on stream x; password not sent/);
  assert.equal(t.pwWrites(), 1);
  assert.equal(t.fetched(), 1);
});

test('sudo_auth: prompt replaced while the password is fetched -> re-check refuses, nothing sent', async () => {
  const t = await sudoStreamSetup('[sudo] password for deploy: ', async (ch) => {
    ch.emit('data', Buffer.from('\nsudo: timed out reading password\nPassword: '));
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.match(text(await t.h('ssh_stream_write', { stream_id: 'x', data: 'sudo whoami\n' })), /awaiting_input\(sudo\)/);
  const r = await t.h('ssh_sudo_auth', { stream_id: 'x' });
  assert.equal(r.isError, true);
  assert.match(text(r), /password not sent/);
  assert.equal(t.fetched(), 1);
  assert.equal(t.pwWrites(), 0);
});

test('ListTools: ssh_sudo_auth takes only stream_id; ssh_exec has sudo flag', () => {
  const tools = getToolDefinitions(['S']);
  const auth = tools.find((t) => t.name === 'ssh_sudo_auth');
  assert.deepEqual(auth.inputSchema.required, ['stream_id']);
  assert.ok(!('password' in auth.inputSchema.properties));
  assert.equal(tools.find((t) => t.name === 'ssh_exec').inputSchema.properties.sudo.type, 'boolean');
});
