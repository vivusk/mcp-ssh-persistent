/**
 * Config loader + server alias resolution
 * Reads the config file (see data-dir-paths.js) once,
 * validates it (no passwords allowed) and exposes alias lookup + limits.
 */
import { readFileSync } from 'fs';
import { log } from '../utils/logger.js';
import { getConfigPath } from './data-dir-paths.js';

export { getConfigPath };

// Built-in connection defaults; config.defaults and per-server values override them.
const BUILTIN_DEFAULTS = {
  port: 22,
  useAgent: false,
  keepaliveInterval: 15000,
  keepaliveCountMax: 3,
  readyTimeout: 10000,
};

// Output/channel limits (D6, D12). OpenSSH MaxSessions default is 10 per connection.
const DEFAULT_LIMITS = {
  maxOutputBytes: 102400,
  maxReadFileBytes: 2097152,
  streamBufferBytes: 524288,
  maxStreams: 4,
  maxConcurrentExec: 4,
};
const OPENSSH_MAX_SESSIONS = 10;

let cached = null;
let limitsWarned = false;

/** Throw if any object in the config tree carries a `password` key. */
function rejectPasswords(node, path = 'config') {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key.toLowerCase() === 'password') {
      throw new Error(`${path}.${key}: passwords are not supported in config; use privateKeyPath or useAgent`);
    }
    rejectPasswords(value, `${path}.${key}`);
  }
}

/**
 * Load and validate config (cached after first successful read).
 * Missing file -> empty config. Invalid JSON or password fields -> throws.
 * @returns {object} config
 */
export function loadConfig() {
  if (cached) return cached;
  const path = getConfigPath();
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read config ${path}: ${err.message}`);
    cached = { defaults: {}, servers: {}, localPathRoots: [], localPathDeny: [], limits: {} };
    return cached;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in config ${path}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config ${path} must be a JSON object`);
  }
  rejectPasswords(parsed);
  cached = {
    defaults: parsed.defaults || {},
    servers: parsed.servers || {},
    localPathRoots: Array.isArray(parsed.localPathRoots) ? parsed.localPathRoots : [],
    localPathDeny: Array.isArray(parsed.localPathDeny) ? parsed.localPathDeny : [],
    limits: parsed.limits || {},
  };
  return cached;
}

/** Drop the cached config (tests / explicit reload). */
export function resetConfigCache() {
  cached = null;
  limitsWarned = false;
}

/** @returns {string[]} configured alias names */
export function listServerAliases() {
  return Object.keys(loadConfig().servers);
}

/**
 * Resolve an alias (case-insensitive) to merged connection settings:
 * builtin defaults <- config.defaults <- servers[alias], plus `alias` (canonical name).
 * @param {string} alias
 * @returns {object} server settings
 */
export function resolveServer(alias) {
  const { defaults, servers } = loadConfig();
  const wanted = String(alias ?? '').trim().toLowerCase();
  const key = Object.keys(servers).find((k) => k.toLowerCase() === wanted);
  if (!wanted || !key) {
    const known = Object.keys(servers);
    throw new Error(
      `unknown server alias "${alias}"; known aliases: ${known.length ? known.join(', ') : '(none - add servers to config)'}`
    );
  }
  const server = { ...BUILTIN_DEFAULTS, ...defaults, ...servers[key], alias: key };
  if (!server.host || !server.username) {
    throw new Error(`server alias "${key}" must define host and username`);
  }
  return server;
}

/**
 * Effective limits (defaults overridden by config.limits). Warns once when the
 * channel budget may exceed OpenSSH MaxSessions (user may have raised it).
 * @returns {object} limits
 */
export function getLimits() {
  const limits = { ...DEFAULT_LIMITS, ...loadConfig().limits };
  if (!limitsWarned && limits.maxStreams + limits.maxConcurrentExec + 1 > OPENSSH_MAX_SESSIONS) {
    limitsWarned = true;
    log('warn', 'channel budget exceeds OpenSSH default MaxSessions 10', {
      maxStreams: limits.maxStreams,
      maxConcurrentExec: limits.maxConcurrentExec,
    });
  }
  return limits;
}
