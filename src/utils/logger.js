/**
 * File logger
 * Appends `ISO level msg json(meta)` lines to <config dir>/logs/mcp-ssh.log.
 * Every line passes through secret redaction. Rotates to `.1` above 1 MB.
 * stderr is suppressed by the MCP server, so this file is the only diagnostic channel.
 * Use only on tool boundaries / errors (sync I/O), never per data chunk.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { join } from 'path';
import { getLogDir } from '../config/data-dir-paths.js';
import { redact } from '../security/secret-redaction.js';

const LOG_DIR = getLogDir();
const LOG_FILE = join(LOG_DIR, 'mcp-ssh.log');
const MAX_LOG_BYTES = 1024 * 1024;

let dirReady = false;

/** Rotate current log to `.1` (overwriting the previous one) when it grows too large. */
function rotateIfNeeded() {
  try {
    if (statSync(LOG_FILE).size > MAX_LOG_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // File does not exist yet or rename failed - nothing to rotate.
  }
}

/**
 * JSON replacer: Errors -> { error, stack }; string leaves redacted BEFORE escaping
 * (JSON escaping of `"`/`\` would otherwise defeat secret matching).
 */
function metaReplacer(_k, v) {
  if (v instanceof Error) return { error: redact(v.message), stack: redact(v.stack) };
  return typeof v === 'string' ? redact(v) : v;
}

/** Serialize meta safely (Errors -> message/stack, secrets redacted, circular refs tolerated). */
function formatMeta(meta) {
  if (meta === undefined) return '';
  try {
    return ` ${JSON.stringify(meta, metaReplacer)}`;
  } catch {
    return ' [unserializable meta]';
  }
}

/**
 * Append one log line. Never throws.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} msg
 * @param {*} [meta] - Extra context, JSON-serialized
 */
export function log(level, msg, meta) {
  try {
    if (!dirReady) {
      mkdirSync(LOG_DIR, { recursive: true });
      dirReady = true;
    }
    rotateIfNeeded();
    const line = `${new Date().toISOString()} ${level} ${msg}${formatMeta(meta)}`;
    appendFileSync(LOG_FILE, `${redact(line).replace(/\r?\n/g, '\\n')}\n`);
  } catch {
    // Logging must never break the server.
  }
}

/** Absolute path of the active log file (diagnostics / tests). */
export function getLogPath() {
  return LOG_FILE;
}
