/**
 * MCP tool handlers
 * createHandlers(pool) -> handleToolCall(name, args). The session pool is
 * injected so handlers are testable with a fake pool.
 */
import { jsonResponse, textResponse, errorResponse, toolText } from '../utils/response.js';
import { listServerAliases } from '../config/load-config-and-server-aliases.js';
import { log } from '../utils/logger.js';

const DEFAULT_EXEC_TIMEOUT = 30000;

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
 * @returns {Function} async handleToolCall(name, args) -> MCP response
 */
export function createHandlers(pool) {
  const handlers = {
    async ssh_exec(args) {
      const server = requireString(args, 'server');
      const command = requireString(args, 'command');
      const timeout = Number(args.timeout) > 0 ? Number(args.timeout) : DEFAULT_EXEC_TIMEOUT;
      const session = await pool.getSession(server);
      const result = await session.exec.exec(command, { timeout, pty: args.pty === true });
      return formatExecResult(result, timeout);
    },

    async ssh_stream_start(args) {
      const server = requireString(args, 'server');
      const streamId = requireString(args, 'stream_id');
      const command = requireString(args, 'command');
      const result = await pool.withSession(server, async (session) => {
        const res = await session.stream.execStream(streamId, command);
        pool.registerStream(streamId, session.alias);
        return { ...res, server: session.alias };
      });
      return jsonResponse(result);
    },

    async ssh_stream_read(args) {
      const streamId = requireString(args, 'stream_id');
      const session = await pool.getStreamSession(streamId);
      const result = await session.stream.readStream(streamId, args.clear !== false, args.wait_ms || 0);
      if (result.error) return errorResponse(result.error);
      return textResponse(result.buffer || '(no new output)');
    },

    async ssh_stream_write(args) {
      const streamId = requireString(args, 'stream_id');
      const data = requireString(args, 'data').replace(/\\n/g, '\n');
      const session = await pool.getStreamSession(streamId);
      const result = await session.stream.writeToShell(data, {
        wait_ms: args.wait_ms ?? 5000,
        poll_interval: args.poll_interval ?? 100,
      });
      if (result.output) return textResponse(`${result.output}\n---\n[complete: ${result.complete}]`);
      return jsonResponse(result);
    },

    async ssh_stream_stop(args) {
      const streamId = requireString(args, 'stream_id');
      const session = await pool.getStreamSession(streamId);
      session.stream.sendCtrlC();
      const result = session.stream.stopStream(streamId);
      pool.unregisterStream(streamId);
      return jsonResponse(result);
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
