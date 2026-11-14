/**
 * MCP tool handlers
 * createHandlers(pool) -> handleToolCall(name, args). The session pool is
 * injected so handlers are testable with a fake pool.
 */
import { jsonResponse, textResponse, errorResponse, toolText } from '../utils/response.js';
import { formatStreamResult } from './format-stream-result.js';
import { listServerAliases } from '../config/load-config-and-server-aliases.js';
import { log } from '../utils/logger.js';
import { getSudoPassword } from '../security/windows-credential-sudo-password.js';

const DEFAULT_EXEC_TIMEOUT = 30000;
const START_WAIT_MS = 2000;
const WRITE_WAIT_MS = 5000;
const MAX_WAIT_MS = 600000;

/** Non-negative wait_ms from args (capped at 10 min), else the default. */
function waitMsArg(args, fallback) {
  const n = Number(args.wait_ms);
  return args.wait_ms === undefined || args.wait_ms === null || !Number.isFinite(n) || n < 0
    ? fallback : Math.min(n, MAX_WAIT_MS);
}

/**
 * Format an exec result as token-lean text.
 * isError only for timeout, exit >= 2 or a signal (exit 1 is normal for grep/diff).
 * @param {object} result - { stdout, stderr, exitCode, signal, timedOut }
 * @param {number} timeout - Timeout used (ms)
 * @returns {object} MCP response
 */
export function formatExecResult(result, timeout) {
  const parts = [];
  const stdout = (result.stdout || '').replace(/\s+$/, '');
  const stderr = (result.stderr || '').replace(/\s+$/, '');
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`--- stderr ---\n${stderr}`);
  if (result.exitCode !== null && result.exitCode !== undefined) parts.push(`[exit: ${result.exitCode}]`);
  if (result.signal) parts.push(`[signal: ${result.signal}]`);
  if (result.timedOut) parts.push(`[timed out after ${timeout}ms]`);
  const isError = Boolean(result.timedOut || result.signal || (result.exitCode ?? 0) >= 2);
  return toolText(parts.join('\n'), isError);
}

/** Throw unless args[key] is a non-empty string. */
function requireString(args, key) {
  const value = args?.[key];
  if (typeof value !== 'string' || value === '') {
    if (key === 'server') {
      let known = [];
      try { known = listServerAliases(); } catch { /* config error surfaces elsewhere */ }
      throw new Error(`"server" is required; known aliases: ${known.length ? known.join(', ') : '(none configured)'}`);
    }
    throw new Error(`"${key}" is required`);
  }
  return value;
}

/**
 * @param {object} pool - Session pool (see src/ssh/session-pool.js)
 * @param {object} [deps] - { getSudoPassword(username, {alias}) } (injectable for tests)
 * @returns {Function} async handleToolCall(name, args) -> MCP response
 */
export function createHandlers(pool, { getSudoPassword: getPw = getSudoPassword } = {}) {
  /** Password getter bound to the session's configured user (never a tool argument). */
  const sudoFor = (session) => ({
    username: session.server.username,
    getPassword: () => getPw(session.server.username, { alias: session.alias }),
  });

  const handlers = {
    async ssh_exec(args) {
      const server = requireString(args, 'server');
      const command = requireString(args, 'command');
      const timeout = Number(args.timeout) > 0 ? Number(args.timeout) : DEFAULT_EXEC_TIMEOUT;
      const session = await pool.getSession(server);
      const opts = { timeout, pty: args.pty === true };
      if (args.sudo === true) opts.sudo = sudoFor(session);
      const result = await session.exec.exec(command, opts);
      return formatExecResult(result, timeout);
    },

    async ssh_stream_start(args) {
      const server = requireString(args, 'server');
      const streamId = requireString(args, 'stream_id');
      const command = typeof args.command === 'string' && args.command !== '' ? args.command : null;
      const { session, stream } = await pool.openStream(server, streamId);
      const header = [stream.initWarning, `[stream ${streamId} opened on ${session.alias}]`].filter(Boolean).join('\n');
      if (!command) return textResponse(header);
      const result = await stream.write(`${command}\n`, { waitMs: waitMsArg(args, START_WAIT_MS) });
      return formatStreamResult(result, header);
    },

    async ssh_stream_read(args) {
      const streamId = requireString(args, 'stream_id');
      const { stream } = await pool.getStream(streamId);
      const result = await stream.read({ waitMs: waitMsArg(args, 0), clear: args.clear !== false });
      return formatStreamResult(result);
    },

    async ssh_stream_write(args) {
      const streamId = requireString(args, 'stream_id');
      if (typeof args.data !== 'string' || args.data === '') throw new Error('"data" is required');
      const { stream } = await pool.getStream(streamId);
      // Data is sent verbatim: no escape translation (keeps printf '\n' intact).
      return formatStreamResult(await stream.write(args.data, { waitMs: waitMsArg(args, WRITE_WAIT_MS) }));
    },

    async ssh_sudo_auth(args) {
      const streamId = requireString(args, 'stream_id');
      const { session, stream } = await pool.getStream(streamId);
      const sudo = sudoFor(session);
      // Checked on the retained tail inside the stream lock: only the exact
      // `[sudo] password for <session user>:` prompt (kind 'sudo') gets the password.
      const assertSudoPrompt = (s) => {
        const det = s.detect();
        if (det.state !== 'awaiting_input') throw new Error(`no sudo prompt pending on stream ${streamId}; password not sent`);
        if (det.kind !== 'sudo') throw new Error(`pending prompt is not a sudo prompt for ${sudo.username}; password not sent`);
      };
      const result = await stream.writeChecked(async (s) => {
        assertSudoPrompt(s);
        const password = await sudo.getPassword();
        assertSudoPrompt(s); // re-check: output may have arrived during the fetch
        return `${password}\n`;
      }, { waitMs: waitMsArg(args, WRITE_WAIT_MS) });
      return formatStreamResult(result);
    },

    async ssh_stream_stop(args) {
      const streamId = requireString(args, 'stream_id');
      const alias = await pool.closeStream(streamId);
      return textResponse(`[stream ${streamId} stopped on ${alias}]`);
    },

    async ssh_status() {
      return jsonResponse(pool.status());
    },

    async ssh_disconnect(args) {
      const server = typeof args?.server === 'string' && args.server ? args.server : undefined;
      return jsonResponse({ disconnected: pool.disconnect(server) });
    },

    async ssh_upload(args) {
      const server = requireString(args, 'server');
      const local = requireString(args, 'local_path');
      const remote = requireString(args, 'remote_path');
      return jsonResponse(await pool.withSession(server, (s) => s.sftp.upload(local, remote)));
    },

    async ssh_download(args) {
      const server = requireString(args, 'server');
      const remote = requireString(args, 'remote_path');
      const local = requireString(args, 'local_path');
      return jsonResponse(await pool.withSession(server, (s) => s.sftp.download(remote, local)));
    },

    async ssh_write_remote_file(args) {
      const server = requireString(args, 'server');
      const remote = requireString(args, 'remote_path');
      if (typeof args.content !== 'string') throw new Error('"content" is required');
      return jsonResponse(await pool.withSession(server, (s) => s.sftp.writeFile(remote, args.content)));
    },

    async ssh_read_remote_file(args) {
      const server = requireString(args, 'server');
      const remote = requireString(args, 'remote_path');
      return jsonResponse(await pool.withSession(server, (s) => s.sftp.readFile(remote)));
    },
  };

  return async function handleToolCall(name, args = {}) {
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) return errorResponse(`Unknown tool: ${name}`);
    try {
      return await handler(args || {});
    } catch (error) {
      const message = error?.message || String(error);
      log('error', `tool ${name} failed`, { error: message });
      return errorResponse(message);
    }
  };
}
