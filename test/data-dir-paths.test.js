import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { getConfigPath, getLogDir, PACKAGE_DIR } from '../src/config/data-dir-paths.js';

function withEnv(value, fn) {
  const prev = process.env.MCP_SSH_CONFIG;
  if (value === undefined) delete process.env.MCP_SSH_CONFIG;
  else process.env.MCP_SSH_CONFIG = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.MCP_SSH_CONFIG;
    else process.env.MCP_SSH_CONFIG = prev;
  }
}

test('MCP_SSH_CONFIG wins and logs sit beside it', () => {
  withEnv('some/dir/cfg.json', () => {
    assert.equal(getConfigPath(), resolve('some/dir/cfg.json'));
    assert.equal(getLogDir(), join(resolve('some/dir'), 'logs'));
  });
});

test('without env: package config.json if present, else ~/.mcp-ssh-persistent', () => {
  withEnv(undefined, () => {
    const packaged = join(PACKAGE_DIR, 'config.json');
    const expected = existsSync(packaged) ? packaged : join(homedir(), '.mcp-ssh-persistent', 'config.json');
    assert.equal(getConfigPath(), expected);
  });
});
