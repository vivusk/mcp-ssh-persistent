/**
 * Local path policy for SFTP upload/download (D8)
 * A local path is allowed only when its realpath lies under an allowed root
 * (os.tmpdir() + configured `localPathRoots`; cwd is NOT a default root) and
 * matches no deny rule. Deny always wins, even inside a root:
 *  - dirs: every privateKeyPath dir, ~/.ssh, ~/.claude, this repo, `localPathDeny`
 *  - files: the config file in use + its known-hosts.json
 *  - anywhere: a path segment `.claude` / `.git`, a file named `.mcp.json` / `CLAUDE.md`
 * Comparison is case-insensitive with normalised separators on win32.
 */
import { realpathSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, getConfigPath } from '../config/load-config-and-server-aliases.js';
import { getKnownHostsPath } from '../config/known-hosts-fingerprint-store.js';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIN = process.platform === 'win32';
const DENY_SEGMENTS = ['.claude', '.git'];
const DENY_BASENAMES = WIN ? ['.mcp.json', 'claude.md'] : ['.mcp.json', 'CLAUDE.md'];

/** Comparable form: resolved (no trailing sep except a drive root), win32 -> lower case. */
function norm(p) {
  const out = resolve(p);
  return WIN ? out.toLowerCase() : out;
}

/** True when normalised path `p` equals `dir` or lies below it. */
function isUnder(p, dir) {
  return p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * Realpath of `p`; for a path that does not exist yet, realpath of the nearest
 * existing ancestor with the missing tail re-appended (so a junction/symlink in
 * the parent chain cannot smuggle a new file outside the roots).
 * @returns {{ real: string, exists: boolean }}
 */
export function realpathOrAncestor(p) {
  const tail = [];
  let cur = resolve(p);
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return { real: tail.length ? join(real, ...tail) : real, exists: tail.length === 0 };
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = dirname(cur);
      if (parent === cur) return { real: resolve(p), exists: false };
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** win32: a ':' after the drive (NTFS alternate data stream, e.g. "CLAUDE.md:x") is never allowed. */
const hasStreamSuffix = (p) => WIN && p.replace(/^\\\\[?.]\\/, '').replace(/^[a-z]:/i, '').includes(':');

/** Normalised realpath (or resolved path when nothing of it exists). */
const canon = (p) => norm(realpathOrAncestor(p).real);

/**
 * Build a policy from explicit inputs (pure apart from realpath lookups; tested directly).
 * @param {object} o
 * @param {string[]} [o.roots] - configured localPathRoots (tmpDir is always added)
 * @param {string[]} [o.deny] - configured localPathDeny
 * @param {string[]} [o.keyPaths] - every configured privateKeyPath
 * @param {string} o.configPath - config file in use
 * @param {string} [o.knownHostsPath] - known-hosts file (default: beside config)
 * @param {string} [o.homeDir] @param {string} [o.repoDir] @param {string} [o.tmpDir]
 * @returns {{ check: Function, roots: string[] }}
 */
export function createLocalPathPolicy(o) {
  const configPath = resolve(o.configPath);
  const rootsRaw = [o.tmpDir || tmpdir(), ...(o.roots || []).map((r) => resolve(dirname(configPath), r))];
  const roots = [...new Set(rootsRaw.map(canon))];
  const home = o.homeDir || homedir();
  const denyDirs = [
    ...(o.keyPaths || []).filter(Boolean).map((k) => ({ dir: dirname(resolve(k)), rule: 'privateKeyPath dir' })),
    { dir: join(home, '.ssh'), rule: '~/.ssh' },
    { dir: join(home, '.claude'), rule: '~/.claude' },
    { dir: o.repoDir || REPO_DIR, rule: 'mcp-ssh-persistent repo dir' },
    { dir: configPath, rule: 'config file' },
    { dir: o.knownHostsPath || join(dirname(configPath), 'known-hosts.json'), rule: 'known-hosts file' },
    ...(o.deny || []).map((d) => ({ dir: resolve(dirname(configPath), d), rule: `localPathDeny "${d}"` })),
  ].map((d) => ({ ...d, canon: canon(d.dir), literal: norm(d.dir) }));
  const rootList = `allowed roots: [${roots.join(', ')}]`;

  /** First deny rule matching normalised path `p`, or null. */
  function denyRule(p) {
    const hit = denyDirs.find((d) => isUnder(p, d.canon) || isUnder(p, d.literal));
    if (hit) return hit.rule;
    const parts = p.split(sep); // already lower case on win32 (norm)
    const seg = parts.find((s) => DENY_SEGMENTS.includes(s));
    if (seg) return `path segment "${seg}"`;
    const base = parts[parts.length - 1];
    return DENY_BASENAMES.includes(base) ? `file name "${base}"` : null;
  }

  /**
   * Validate a local path before any I/O.
   * @param {string} input - user-supplied local path
   * @param {object} [opts] - { mustExist: true for upload sources }
   * @returns {string} realpath to use for the I/O
   */
  function check(input, { mustExist = false } = {}) {
    if (typeof input !== 'string' || input === '') throw new Error('local path is required');
    if (hasStreamSuffix(norm(input))) throw new Error(`local path "${input}" is denied (":" alternate data stream); ${rootList}`);
    const { real, exists } = realpathOrAncestor(input);
    const p = norm(real);
    const rule = denyRule(p) || denyRule(norm(input));
    if (rule) throw new Error(`local path "${input}" is denied (${rule}); ${rootList}`);
    if (!roots.some((r) => isUnder(p, r))) {
      throw new Error(`local path "${input}" is outside the ${rootList}; add a parent dir to "localPathRoots" in ${configPath}`);
    }
    // Existence is reported only after the policy passed (no probing of denied paths).
    if (mustExist && !exists) throw new Error(`local path "${input}" does not exist`);
    return real;
  }

  return { check, roots };
}

/** Policy built from the current config (config is cached, so this is cheap). */
function currentPolicy() {
  const cfg = loadConfig();
  const keyPaths = [cfg.defaults?.privateKeyPath, ...Object.values(cfg.servers || {}).map((s) => s?.privateKeyPath)];
  return createLocalPathPolicy({
    roots: cfg.localPathRoots,
    deny: cfg.localPathDeny,
    keyPaths,
    configPath: getConfigPath(),
    knownHostsPath: getKnownHostsPath(),
  });
}

/**
 * Throw unless `path` is allowed by the configured policy.
 * @param {string} path - local path
 * @param {object} [opts] - { mustExist, forWrite } (forWrite: target may not exist yet)
 * @returns {string} realpath to use for the I/O
 */
export function assertLocalPathAllowed(path, opts = {}) {
  return currentPolicy().check(path, opts);
}
