/**
 * Docs vs tool definitions: the tool tables in README.md (and the parent
 * workspace CLAUDE.md "SSH Tools" table, when present) must list exactly the
 * tools from getToolDefinitions(), and each row must mention every required param.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getToolDefinitions } from '../src/tools/definitions.js';
import { loadConfig, resetConfigCache, resolveServer } from '../src/config/load-config-and-server-aliases.js';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(REPO_DIR, 'README.md');
const WORKSPACE_CLAUDE_MD = join(REPO_DIR, '..', 'CLAUDE.md');

/**
 * Extract rows of the first markdown table under `## <heading>` (until the next heading).
 * @returns {Map<string,string>} tool name -> full row text
 */
function parseToolTable(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  assert.ok(start >= 0, `section "## ${heading}" not found`);
  const rows = new Map();
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,3}\s/.test(line)) break;
    const m = line.match(/^\|\s*`(ssh_[a-z_]+)`\s*\|/);
    if (m) rows.set(m[1], line);
  }
  return rows;
}

function assertTableMatchesDefinitions(rows, label) {
  const defs = getToolDefinitions(['alias']);
  const expected = defs.map((d) => d.name).sort();
  assert.deepEqual([...rows.keys()].sort(), expected, `${label}: tool names differ from definitions`);
  for (const def of defs) {
    const row = rows.get(def.name);
    for (const param of def.inputSchema.required || []) {
      assert.ok(row.includes(`\`${param}\``), `${label}: ${def.name} row lacks required param ${param}`);
    }
  }
}

test('README tool table matches tool definitions (names + required params)', () => {
  const rows = parseToolTable(readFileSync(README, 'utf8'), 'Tools');
  assertTableMatchesDefinitions(rows, 'README.md');
});

test('workspace CLAUDE.md SSH tool table matches tool definitions', { skip: !existsSync(WORKSPACE_CLAUDE_MD) && 'no ../CLAUDE.md' }, () => {
  const rows = parseToolTable(readFileSync(WORKSPACE_CLAUDE_MD, 'utf8'), 'SSH Tools');
  assertTableMatchesDefinitions(rows, 'CLAUDE.md');
});

test('config.example.json loads via the config loader and uses placeholders only', () => {
  const file = join(REPO_DIR, 'config.example.json');
  const prev = process.env.MCP_SSH_CONFIG;
  process.env.MCP_SSH_CONFIG = file;
  resetConfigCache();
  try {
    loadConfig(); // throws on invalid JSON or password keys
    assert.equal(resolveServer('WEB').alias, 'web');
  } finally {
    if (prev === undefined) delete process.env.MCP_SSH_CONFIG;
    else process.env.MCP_SSH_CONFIG = prev;
    resetConfigCache();
  }
  const text = readFileSync(file, 'utf8');
  const parsed = JSON.parse(text);
  assert.ok(Object.keys(parsed.servers).length > 0);
  assert.ok(!/"password"\s*:/i.test(text));
  for (const s of Object.values(parsed.servers)) {
    assert.match(s.host, /^203\.0\.113\.\d+$/, 'example hosts must use TEST-NET-3 placeholders');
  }
});
