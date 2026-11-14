import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHandlers } from '../src/tools/handlers.js';
import { getToolDefinitions } from '../src/tools/definitions.js';
import { resolveServer, resetConfigCache } from '../src/config/load-config-and-server-aliases.js';
import { registerSecret } from '../src/security/secret-redaction.js';

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
