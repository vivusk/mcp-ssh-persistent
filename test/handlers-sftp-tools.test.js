import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createHandlers } from '../src/tools/handlers.js';
import { resolveServer, resetConfigCache } from '../src/config/load-config-and-server-aliases.js';
import { SSHSFTP } from '../src/ssh/sftp.js';
import { createFakeSftp, fakeSftpClient } from './fake-sftp-wrapper.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'mcp-ssh-sftp-handlers-'));
const prevEnv = process.env.MCP_SSH_CONFIG;
before(() => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    defaults: { privateKeyPath: join(dir, 'keys', 'id') },
    servers: { S: { host: '192.0.2.10', username: 'root' } },
    limits: { maxReadFileBytes: 64 },
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

/** Handlers over a pool whose session uses a real SSHSFTP on a fake SFTP channel. */
function setup(fakeOpts) {
  const sftp = createFakeSftp(fakeOpts);
  const client = fakeSftpClient(sftp);
  const session = { alias: 'S', sftp: new SSHSFTP(() => client, { alias: 'S', getLimits: () => ({ maxReadFileBytes: 64 }) }) };
  const pool = { withSession: async (alias, fn) => { resolveServer(alias); return fn(session); } };
  return { h: createHandlers(pool), sftp, client, session };
}
const text = (r) => r.content[0].text;
const noTmpLeft = (sftp) => assert.ok(![...sftp.files.keys()].some((p) => p.includes('.mcp-tmp-')), 'no .mcp-tmp- leftovers');

test('read: plain-text header + raw content (no JSON escaping); SFTP channel reused', async () => {
  const t = setup({ files: { '/etc/app.conf': 'a="1"\nb\\c\n' } });
  const r = await t.h('ssh_read_remote_file', { server: 's', remote_path: '/etc/app.conf' });
  assert.equal(text(r), '# /etc/app.conf (10 bytes)\na="1"\nb\\c\n');
  await t.h('ssh_read_remote_file', { server: 'S', remote_path: '/etc/app.conf' });
  assert.equal(t.client.opened, 1, 'one cached SFTP channel');
});

test('read: above limit -> ssh_exec hint; binary -> ssh_download hint; directory refused', async () => {
  const t = setup({ files: { '/big': 'x'.repeat(65), '/bin': 'ab\0cd' } });
  const big = await t.h('ssh_read_remote_file', { server: 'S', remote_path: '/big' });
  assert.equal(big.isError, true);
  assert.match(text(big), /65 bytes, above the 64-byte read limit; use ssh_exec with head\/tail\/sed -n/);
  assert.match(text(await t.h('ssh_read_remote_file', { server: 'S', remote_path: '/bin' })), /binary file; use ssh_download/);
  assert.match(text(await t.h('ssh_read_remote_file', { server: 'S', remote_path: '/dir' })), /is a directory/);
});

test('write: atomic posix-rename, existing mode kept, compact line, no tmp leftovers', async () => {
  const t = setup({ files: { '/etc/x.conf': 'old' } });
  t.sftp.files.get('/etc/x.conf').mode = 0o600;
  const r = await t.h('ssh_write_remote_file', { server: 'S', remote_path: '/etc/x.conf', content: 'héllo' });
  assert.equal(text(r), 'wrote /etc/x.conf (6 bytes, mode 0600)');
  const f = t.sftp.files.get('/etc/x.conf');
  assert.equal(f.data.toString(), 'héllo');
  assert.equal(f.mode, 0o600);
  assert.deepEqual([f.uid, f.gid], [1000, 1000], 'owner copied from original');
  assert.ok(t.sftp.calls.some((c) => c[0] === 'posix-rename' && /\/etc\/\.x\.conf\.mcp-tmp-[0-9a-f]+$/.test(c[1])));
  assert.ok(!t.sftp.calls.some((c) => c[0] === 'unlink'), 'original never unlinked');
  noTmpLeft(t.sftp);
});

test('write: new file default 0644; explicit mode; bad mode rejected', async () => {
  const t = setup();
  assert.equal(text(await t.h('ssh_write_remote_file', { server: 'S', remote_path: '/tmp/n', content: '' })), 'wrote /tmp/n (0 bytes, mode 0644)');
  assert.equal(text(await t.h('ssh_write_remote_file', { server: 'S', remote_path: '/tmp/n', content: 'k', mode: '600' })), 'wrote /tmp/n (1 bytes, mode 0600)');
  assert.equal(t.sftp.files.get('/tmp/n').mode, 0o600);
  const bad = await t.h('ssh_write_remote_file', { server: 'S', remote_path: '/tmp/n', content: 'k', mode: 'rwx' });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /"mode" must be an octal string/);
});

test('write: server without posix-rename (sync throw) -> unlink + rename fallback', async () => {
  const t = setup({ posixRename: false, files: { '/srv/a': 'old' } });
  const r = await t.h('ssh_write_remote_file', { server: 'S', remote_path: '/srv/a', content: 'new' });
  assert.equal(r.isError, undefined);
  assert.match(text(r), /\[warn: server lacks posix-rename; replaced via unlink \+ rename\]$/);
  assert.equal(t.sftp.files.get('/srv/a').data.toString(), 'new');
  noTmpLeft(t.sftp);
});

test('write: symlink followed (abs, relative, chained, dangling) -> link kept, target updated', async () => {
  const t = setup({
    files: { '/etc/nginx/sites-available/site': 'old' },
    links: { '/etc/nginx/sites-enabled/site': '../sites-available/site', '/srv/current': '/srv/rel', '/srv/rel': 'v2/app.conf', '/srv/dangling': '/srv/new.conf' },
  });
  t.sftp.files.get('/etc/nginx/sites-available/site').mode = 0o640;
  const r = await t.h('ssh_write_remote_file', { server: 'S', remote_path: '/etc/nginx/sites-enabled/site', content: 'new' });
  assert.equal(text(r), 'wrote /etc/nginx/sites-enabled/site (via symlink -> /etc/nginx/sites-available/site) (3 bytes, mode 0640)');
  assert.equal(t.sftp.files.get('/etc/nginx/sites-available/site').data.toString(), 'new');
  assert.ok(!t.sftp.files.has('/etc/nginx/sites-enabled/site'), 'link not replaced by a regular file');
  assert.ok(t.sftp.links.has('/etc/nginx/sites-enabled/site'));
  assert.ok(t.sftp.calls.some((c) => c[0] === 'posix-rename' && c[1].startsWith('/etc/nginx/sites-available/.site.mcp-tmp-')), 'tmp beside target');
  await t.h('ssh_write_remote_file', { server: 'S', remote_path: '/srv/current', content: 'c' });
  assert.equal(t.sftp.files.get('/srv/v2/app.conf').data.toString(), 'c');
  await t.h('ssh_write_remote_file', { server: 'S', remote_path: '/srv/dangling', content: 'd' });
  assert.equal(t.sftp.files.get('/srv/new.conf').data.toString(), 'd');
  noTmpLeft(t.sftp);
  const loop = await setup({ links: { '/a': '/b', '/b': '/a' } }).h('ssh_write_remote_file', { server: 'S', remote_path: '/a', content: 'x' });
  assert.equal(loop.isError, true);
  assert.match(text(loop), /too many levels of symbolic links/);
});

test('write: relative ".." link under a symlinked parent dir resolves server-side (capistrano layout)', async () => {
  const t = setup({
    files: { '/var/www/app/shared/.env': 'old' },
    links: { '/var/www/app/current': 'releases/5', '/var/www/app/releases/5/.env': '../../shared/.env' },
  });
  const r = await t.h('ssh_write_remote_file', { server: 'S', remote_path: '/var/www/app/current/.env', content: 'new' });
  assert.equal(text(r), 'wrote /var/www/app/current/.env (via symlink -> /var/www/app/shared/.env) (3 bytes, mode 0644)');
  assert.equal(t.sftp.files.get('/var/www/app/shared/.env').data.toString(), 'new');
  assert.ok(!t.sftp.files.has('/var/www/shared/.env'), 'no lexical ".." resolution');
  noTmpLeft(t.sftp);
});

test('write: dir not writable but file exists -> in-place write with warning', async () => {
  const t = setup({ dirWritable: false, files: { '/etc/hosts': 'old' } });
  const r = await t.h('ssh_write_remote_file', { server: 'S', remote_path: '/etc/hosts', content: 'new' });
  assert.equal(text(r), 'wrote /etc/hosts (3 bytes, mode 0644) [warn: non-atomic in-place write; directory not writable]');
  assert.equal(t.sftp.files.get('/etc/hosts').data.toString(), 'new');
  const missing = await setup({ dirWritable: false }).h('ssh_write_remote_file', { server: 'S', remote_path: '/etc/new', content: 'x' });
  assert.equal(missing.isError, true, 'no fallback when the file does not exist');
});

test('upload: fastPut with concurrency 64, dir target appends basename, one-line result', async () => {
  const t = setup();
  const local = join(dir, 'pkg.tgz');
  writeFileSync(local, 'payload');
  const r = await t.h('ssh_upload', { server: 'S', local_path: local, remote_path: '/opt/' });
  assert.match(text(r), /^uploaded .*pkg\.tgz -> \/opt\/pkg\.tgz \(7 bytes, \d+ ms\)$/);
  const call = t.sftp.calls.find((c) => c[0] === 'fastPut');
  assert.deepEqual(call[3], { concurrency: 64, chunkSize: 32768 });
  assert.equal(t.sftp.files.get('/opt/pkg.tgz').data.toString(), 'payload');
});

test('download: fastGet to .part then rename; dir target appends basename', async () => {
  const t = setup({ files: { '/var/log/app.log': 'line1\n' } });
  const r = await t.h('ssh_download', { server: 'S', remote_path: '/var/log/app.log', local_path: `${dir}/` });
  assert.match(text(r), /^downloaded \/var\/log\/app\.log -> .*app\.log \(6 bytes, \d+ ms\)$/);
  assert.equal(readFileSync(join(dir, 'app.log'), 'utf8'), 'line1\n');
  assert.match(t.sftp.calls.find((c) => c[0] === 'fastGet')[2], /app\.log\.part-[0-9a-f]+$/);
  assert.ok(!readdirSync(dir).some((n) => n.includes('.part-')), 'no .part leftovers');
});

test('upload/download: denied local path rejected before connecting (withSession not called)', async () => {
  let connects = 0;
  const h = createHandlers({ withSession: async () => { connects += 1; return {}; } });
  const up = await h('ssh_upload', { server: 'S', local_path: join(REPO, 'config.json'), remote_path: '/tmp/' });
  const down = await h('ssh_download', { server: 'S', remote_path: '/etc/CLAUDE.md', local_path: join(dir, 'w') + '/' });
  assert.equal(up.isError, true);
  assert.equal(down.isError, true);
  assert.match(text(down), /CLAUDE\.md" is denied/);
  assert.equal(connects, 0);
});

test('path policy errors surface as isError before any SFTP I/O', async () => {
  const t = setup({ files: { '/x': 'x' } });
  const cases = [
    ['ssh_upload', { local_path: join(dir, 'keys', 'id'), remote_path: '/tmp/' }, /denied \(privateKeyPath dir\)/],
    ['ssh_upload', { local_path: join(REPO, 'package.json'), remote_path: '/tmp/' }, /denied \(mcp-ssh-persistent repo dir\)/],
    ['ssh_download', { remote_path: '/x', local_path: join(dir, '.claude', 'settings.json') }, /denied \(path segment "\.claude"\)/],
    ['ssh_download', { remote_path: '/x', local_path: join(dir, 'CLAUDE.md') }, /denied \(file name/],
    ['ssh_download', { remote_path: '/x', local_path: join(REPO, '..', 'elsewhere.txt') }, /outside the allowed roots.*"localPathRoots"/],
  ];
  for (const [tool, args, re] of cases) {
    const r = await t.h(tool, { server: 'S', ...args });
    assert.equal(r.isError, true, tool);
    assert.match(text(r), re);
  }
  assert.equal(t.client.opened, 0, 'no SFTP channel opened');
});
