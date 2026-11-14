import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createLocalPathPolicy } from '../src/security/local-path-policy.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = mkdtempSync(join(tmpdir(), 'mcp-ssh-policy-'));
const T = join(base, 'tmp'); // stands in for os.tmpdir()
const W = join(base, 'workspace'); // configured localPathRoots entry (mirrors D:/Haizzz)
const O = join(base, 'outside');
const HOME = join(base, 'home');
const FAKE_REPO = join(base, 'fake-repo');
for (const d of [T, W, O, HOME, FAKE_REPO]) mkdirSync(d, { recursive: true });
after(() => rmSync(base, { recursive: true, force: true }));

const CONFIG = join(base, 'cfg', 'config.json');
/** Policy with test-controlled roots; repo defaults to a fake dir unless given. */
const policy = (o = {}) => createLocalPathPolicy({
  roots: [W], configPath: CONFIG, homeDir: HOME, repoDir: FAKE_REPO, tmpDir: T, ...o,
});
const denied = (p, input, opts) => assert.throws(() => p.check(input, opts), /is denied \(/, input);
const outside = (p, input, opts) => assert.throws(() => p.check(input, opts), /is outside the allowed roots/, input);

test('inside root: existing file (upload) and new file (download) allowed', () => {
  const f = join(W, 'proj', 'dist', 'app.js');
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, 'x');
  const p = policy();
  assert.equal(p.check(f, { mustExist: true }).toLowerCase(), f.toLowerCase());
  assert.ok(p.check(join(W, 'proj', 'dist', 'new.bin'), { forWrite: true }));
  assert.ok(p.check(join(W, 'proj', 'not-yet', 'deep', 'x'), { forWrite: true }), 'missing parents ok');
  assert.ok(p.check(join(T, 'x.tar.gz'), { forWrite: true }), 'tmpdir is a root');
  assert.throws(() => p.check(join(W, 'missing.txt'), { mustExist: true }), /does not exist/);
});

test('.. escape and plain outside paths rejected', () => {
  const p = policy();
  outside(p, join(W, '..', 'outside', 'x'));
  outside(p, join(O, 'x'));
});

test('deny dirs inside a root: localPathDeny, privateKeyPath dir, ~/.ssh, ~/.claude', () => {
  const p = policy({
    roots: [W, HOME],
    deny: [join(W, 'secret')],
    keyPaths: [join(W, 'keys', 'id_ed25519')],
  });
  denied(p, join(W, 'secret', 'a.txt'));
  denied(p, join(W, 'keys', 'id_ed25519'), {});
  denied(p, join(W, 'keys', 'other'));
  denied(p, join(HOME, '.ssh', 'authorized_keys'));
  denied(p, join(HOME, '.claude', 'settings.json'));
  assert.ok(p.check(join(W, 'secretive', 'a.txt')), 'prefix of a deny dir name is not a match');
});

test('agent config / .git anywhere under a root denied for write', () => {
  const p = policy();
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'sub/CLAUDE.md', '.git/config', 'proj/.git/hooks/pre-commit']) {
    denied(p, join(W, rel), { forWrite: true });
  }
});

test('cwd is not a root unless configured; <cwd>/.claude denied even when configured', () => {
  const cwd = process.cwd();
  outside(createLocalPathPolicy({ configPath: CONFIG, homeDir: HOME, repoDir: FAKE_REPO, tmpDir: T }), join(cwd, 'x.txt'));
  const withCwd = createLocalPathPolicy({ roots: [cwd], configPath: CONFIG, homeDir: HOME, repoDir: FAKE_REPO, tmpDir: T });
  denied(withCwd, join(cwd, '.claude', 'settings.json'), { forWrite: true });
});

test('this repo (config, known-hosts, logs, src) denied even when root = repo parent', () => {
  const p = createLocalPathPolicy({ roots: [dirname(REPO)], configPath: join(REPO, 'config.json'), homeDir: HOME, tmpDir: T });
  for (const rel of ['config.json', 'known-hosts.json', 'logs/x', 'src/index.js']) denied(p, join(REPO, rel), { forWrite: true });
  assert.ok(p.check(join(dirname(REPO), 'other-project', 'dist', 'x'), { forWrite: true }), 'sibling project allowed');
});

test('MCP_SSH_CONFIG file elsewhere (inside a root) and its known-hosts.json denied', () => {
  const cfg = join(W, 'cfgdir', 'my-config.json');
  const p = policy({ configPath: cfg });
  denied(p, cfg, { forWrite: true });
  denied(p, join(W, 'cfgdir', 'known-hosts.json'), { forWrite: true });
  assert.ok(p.check(join(W, 'cfgdir', 'notes.txt'), { forWrite: true }));
});

test('outside-root error names localPathRoots and the config path', () => {
  assert.throws(() => policy().check(join(O, 'x')), (err) => err.message.includes('"localPathRoots"') && err.message.includes(resolve(CONFIG)));
});

test('denied error names the rule and allowed roots', () => {
  assert.throws(() => policy().check(join(W, '.mcp.json')), /denied \(file name "\.mcp\.json"\); allowed roots: \[/);
});

test('NTFS alternate data stream suffix denied on win32', { skip: process.platform !== 'win32' }, () => {
  const p = policy();
  for (const x of [join(W, 'CLAUDE.md:x'), join(W, '.mcp.json:x'), join(W, '.claude:x'), join(W, 'proj', 'ok.txt:s'), join(W, '.claude:x', 'y')]) {
    assert.throws(() => p.check(x), /":" alternate data stream/, x);
  }
  assert.ok(p.check(join(W, 'proj', 'ok.txt'), { forWrite: true }), 'drive-letter colon alone is fine');
});

test('case-insensitive on win32', { skip: process.platform !== 'win32' }, () => {
  const p = policy();
  assert.ok(p.check(join(W.toUpperCase(), 'proj', 'X.txt'), { forWrite: true }));
  denied(p, join(W, '.CLAUDE', 'settings.json'));
  denied(p, join(W, 'Claude.MD'));
  denied(p, join(W, 'SUB', '.Git', 'config'));
  outside(p, join(O.toUpperCase(), 'x'));
});

test('symlink/junction escape from a root is rejected (realpath)', (t) => {
  const link = join(W, 'link-out');
  try {
    symlinkSync(O, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`cannot create link: ${err.code}`);
    return;
  }
  writeFileSync(join(O, 'f.txt'), 'x');
  const p = policy();
  outside(p, join(link, 'f.txt'), { mustExist: true });
  outside(p, join(link, 'new.txt'), { forWrite: true });
  const linkToClaude = join(W, 'link-claude');
  mkdirSync(join(W, 'real', '.claude'), { recursive: true });
  symlinkSync(join(W, 'real', '.claude'), linkToClaude, process.platform === 'win32' ? 'junction' : 'dir');
  denied(p, join(linkToClaude, 'settings.json'), { forWrite: true });
});
