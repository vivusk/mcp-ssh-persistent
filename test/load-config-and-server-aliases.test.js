import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, resolve } from 'path';
import {
  loadConfig, resolveServer, getLimits, getConfigPath, resetConfigCache, listServerAliases,
} from '../src/config/load-config-and-server-aliases.js';

const dir = mkdtempSync(join(tmpdir(), 'mcp-ssh-cfg-'));
const prevEnv = process.env.MCP_SSH_CONFIG;

/** Write a temp config, point MCP_SSH_CONFIG at it and reset the cache. */
function useConfig(obj, name = 'config.json') {
  const path = join(dir, name);
  writeFileSync(path, typeof obj === 'string' ? obj : JSON.stringify(obj));
  process.env.MCP_SSH_CONFIG = path;
  resetConfigCache();
  return path;
}

beforeEach(() => resetConfigCache());
after(() => {
  if (prevEnv === undefined) delete process.env.MCP_SSH_CONFIG;
  else process.env.MCP_SSH_CONFIG = prevEnv;
  resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

const absKey = join(dir, 'keys', 'id'); // OS-absolute sample (C:/... is relative on darwin/linux)
const sample = {
  defaults: { privateKeyPath: absKey, keepaliveInterval: 20000 },
  servers: {
    S: { host: '192.0.2.10', username: 'root' },
    RR: { host: '192.0.2.11', username: 'deploy', port: 2222, fingerprint: 'SHA256:abc' },
  },
  limits: { maxOutputBytes: 5000 },
};

test('getConfigPath honours MCP_SSH_CONFIG', () => {
  const path = useConfig(sample);
  assert.equal(getConfigPath(), resolve(path));
});

test('resolveServer merges defaults and is case-insensitive', () => {
  useConfig(sample);
  const s = resolveServer('rr');
  assert.equal(s.alias, 'RR');
  assert.equal(s.host, '192.0.2.11');
  assert.equal(s.port, 2222);
  assert.equal(s.privateKeyPath, absKey);
  assert.equal(s.keepaliveInterval, 20000);
  assert.equal(s.keepaliveCountMax, 3);
  assert.equal(s.fingerprint, 'SHA256:abc');
  assert.equal(resolveServer('s').port, 22);
  assert.deepEqual(listServerAliases(), ['S', 'RR']);
});

test('unknown alias error lists known aliases', () => {
  useConfig(sample);
  assert.throws(() => resolveServer('nope'), /unknown server alias "nope".*S, RR/);
});

test('password anywhere in config is rejected', () => {
  useConfig({ servers: { X: { host: 'h', username: 'u', password: 'p' } } });
  assert.throws(() => loadConfig(), /passwords are not supported/);
  useConfig({ defaults: { Password: 'p' }, servers: {} });
  assert.throws(() => loadConfig(), /passwords are not supported/);
});

test('missing file yields empty config', () => {
  process.env.MCP_SSH_CONFIG = join(dir, 'does-not-exist.json');
  resetConfigCache();
  assert.deepEqual(loadConfig().servers, {});
  assert.throws(() => resolveServer('S'), /unknown server alias.*\(none/);
});

test('invalid JSON throws a clear error', () => {
  useConfig('{ not json');
  assert.throws(() => loadConfig(), /invalid JSON/);
});

test('getLimits applies defaults and overrides', () => {
  useConfig(sample);
  const l = getLimits();
  assert.equal(l.maxOutputBytes, 5000);
  assert.equal(l.maxReadFileBytes, 2097152);
  assert.equal(l.streamBufferBytes, 524288);
  assert.equal(l.maxStreams, 4);
  assert.equal(l.maxConcurrentExec, 4);
});

test('getLimits over channel budget only warns', () => {
  useConfig({ servers: {}, limits: { maxStreams: 8, maxConcurrentExec: 8 } });
  assert.equal(getLimits().maxStreams, 8);
});

test('server missing host/username is rejected', () => {
  useConfig({ servers: { Bad: { username: 'u' } } });
  assert.throws(() => resolveServer('bad'), /must define host and username/);
});

test('privateKeyPath: ~ expands to home, relative resolves against config dir', () => {
  useConfig({
    defaults: { privateKeyPath: '~/.ssh/k' },
    servers: {
      A: { host: 'h', username: 'u' },
      B: { host: 'h', username: 'u', privateKeyPath: 'keys/k' },
    },
  });
  assert.equal(resolveServer('a').privateKeyPath, join(homedir(), '.ssh', 'k'));
  assert.equal(resolveServer('b').privateKeyPath, join(dir, 'keys', 'k'));
  assert.equal(loadConfig().defaults.privateKeyPath, join(homedir(), '.ssh', 'k'));
});

test('localPathRoots / localPathDeny expand leading ~ only', () => {
  useConfig({ servers: {}, localPathRoots: ['~/work', 'rel', '~user/x'], localPathDeny: ['~/work/secret'] });
  const cfg = loadConfig();
  assert.deepEqual(cfg.localPathRoots, [join(homedir(), 'work'), 'rel', '~user/x']);
  assert.deepEqual(cfg.localPathDeny, [join(homedir(), 'work', 'secret')]);
});
