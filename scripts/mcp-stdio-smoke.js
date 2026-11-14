#!/usr/bin/env node
/**
 * MCP stdio smoke test: spawns `node src/index.js` and drives it over JSON-RPC.
 * Usage: npm run smoke:mcp -- [alias]
 * initialize -> notifications/initialized -> tools/list (asserts tool names)
 * -> tools/call ssh_exec "echo ok" (only when an alias is given) -> close stdin,
 * expect exit code 0.
 */
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const alias = process.argv[2];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_TOOLS = [
  'ssh_exec', 'ssh_stream_start', 'ssh_stream_read', 'ssh_stream_write', 'ssh_stream_stop',
  'ssh_sudo_auth', 'ssh_status', 'ssh_disconnect', 'ssh_upload', 'ssh_download', 'ssh_write_remote_file', 'ssh_read_remote_file',
];

const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let buffer = '';
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

/** Send a JSON-RPC request and wait for its response (20 s cap). */
function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
  });
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERT: ${message}`);
  console.log(`PASS ${message}`);
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stdio-smoke', version: '1.0.0' },
  });
  assert(init.serverInfo?.name === 'mcp-ssh-persistent', 'initialize');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const { tools } = await request('tools/list', {});
  const names = tools.map((t) => t.name);
  assert(EXPECTED_TOOLS.every((n) => names.includes(n)), `tools/list has ${EXPECTED_TOOLS.length} expected tools`);
  assert(!names.includes('ssh_connect') && !names.includes('ssh_reset_shell'), 'removed tools absent');

  if (alias) {
    const t0 = Date.now();
    const res = await request('tools/call', { name: 'ssh_exec', arguments: { server: alias, command: 'echo ok' } });
    const text = res.content?.[0]?.text || '';
    assert(/(^|\n)ok\n/.test(text) && text.includes('[exit: 0]') && !res.isError, `ssh_exec echo ok on ${alias} (${Date.now() - t0} ms)`);
    // sudo:true on a root alias must fail before any password lookup.
    const sudo = await request('tools/call', { name: 'ssh_exec', arguments: { server: alias, command: 'id -u', sudo: true } });
    const sudoText = sudo.content?.[0]?.text || '';
    if (/already root on/.test(sudoText)) assert(sudo.isError === true, `ssh_exec sudo:true on root alias ${alias} -> "already root" error`);
    else console.log(`INFO ssh_exec sudo:true on ${alias} (non-root): ${sudo.isError ? 'error' : 'ok'}: ${sudoText.split('\n')[0]}`);
  } else {
    console.log('SKIP ssh_exec call (no alias given)');
  }

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, 5000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    child.stdin.end();
  });
  assert(code === 0, `server exits 0 after stdin close (got ${code})`);
  console.log('\nall checks passed');
  process.exit(0);
} catch (err) {
  console.log(`FAIL ${err.message}`);
  child.kill();
  process.exit(1);
}
