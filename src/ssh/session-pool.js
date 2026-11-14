/**
 * Session pool: server alias -> connected Session (D1, D5)
 * Lazy connect on first use, one shared in-flight connect per alias, automatic
 * reconnect on the next call after a drop. Each alias owns its own connection,
 * so a call for one alias can never run on another alias's server.
 * Stream ids / shell streams are handled by session-stream-registry.js.
 */
import { SSHConnection } from './connection.js';
import { SSHExec } from './exec.js';
import { ShellStream } from './shell-stream.js';
import { SSHSFTP } from './sftp.js';
import { mapChannelOpenError } from './channel-open-failure-error.js';
import { createStreamRegistry } from './session-stream-registry.js';
import * as configModule from '../config/load-config-and-server-aliases.js';
import { log } from '../utils/logger.js';

/**
 * @param {object} [deps] - Injection points (tests)
 * @param {Function} [deps.resolveServer] - alias -> server settings (throws on unknown)
 * @param {Function} [deps.getLimits] - () -> limits
 * @param {Function} [deps.createConnection] - server -> connection-like object
 * @param {Function} [deps.openShell] - (client, opts) -> Promise<ShellStream>
 */
export function createSessionPool(deps = {}) {
  const resolveServer = deps.resolveServer || configModule.resolveServer;
  const getLimits = deps.getLimits || configModule.getLimits;
  const createConnection = deps.createConnection || ((server) => new SSHConnection(server));
  const openShell = deps.openShell || ((client, opts) => ShellStream.open(client, opts));

  const sessions = new Map(); // canonical alias -> Session
  const connecting = new Map(); // canonical alias -> Promise<Session>
  const streams = createStreamRegistry({
    lookupSession: (alias) => sessions.get(alias),
    withSession: (alias, fn) => withSession(alias, fn),
    getLimits,
    openShell,
  });

  /** Build a session around a connection (exec limiter, streams, cached SFTP channel). */
  function buildSession(server, connection) {
    const limits = getLimits();
    const getClient = () => connection.getClient();
    return {
      alias: server.alias,
      server,
      connection,
      exec: new SSHExec(getClient, {
        alias: server.alias,
        maxConcurrent: limits.maxConcurrentExec,
        maxOutputBytes: limits.maxOutputBytes,
      }),
      streams: new Map(), // stream_id -> ShellStream (null while opening)
      sftp: new SSHSFTP(getClient, { alias: server.alias, getLimits }),
    };
  }

  /** Tear down a session's channels and forget it. */
  function dropSession(session) {
    if (sessions.get(session.alias) !== session) return;
    sessions.delete(session.alias);
    streams.forgetAlias(session.alias);
    for (const stream of session.streams.values()) stream?.close();
    session.streams.clear();
    session.sftp.close();
  }

  async function connectSession(server) {
    const connection = createConnection(server);
    await connection.connect();
    const session = buildSession(server, connection);
    connection.onClose(() => {
      log('info', `connection closed: ${server.alias}`);
      dropSession(session);
    });
    sessions.set(server.alias, session);
    log('info', `connected: ${server.alias}`);
    return session;
  }

  /**
   * Connected session for an alias (case-insensitive). Throws on unknown alias.
   * @param {string} alias
   * @returns {Promise<object>} Session
   */
  async function getSession(alias) {
    const server = resolveServer(alias);
    const key = server.alias;
    const existing = sessions.get(key);
    if (existing && existing.connection.isConnected()) return existing;
    if (existing) { // dropped: clean up, then reconnect once below
      dropSession(existing);
      try { existing.connection.disconnect(); } catch { /* ignore */ }
    }
    if (connecting.has(key)) return connecting.get(key);
    const pending = connectSession(server).finally(() => connecting.delete(key));
    connecting.set(key, pending);
    return pending;
  }

  /**
   * Disconnect one alias (or all when omitted).
   * @param {string} [alias]
   * @returns {string[]} aliases that were disconnected
   */
  function disconnect(alias) {
    const targets = alias === undefined || alias === null || alias === ''
      ? [...sessions.values()]
      : [sessions.get(resolveServer(alias).alias)].filter(Boolean);
    for (const session of targets) {
      dropSession(session);
      try { session.connection.disconnect(); } catch { /* ignore */ }
    }
    return targets.map((s) => s.alias);
  }

  /** @returns {Array<object>} status of every pooled session */
  function status() {
    return [...sessions.values()].map((s) => ({
      alias: s.alias,
      host: s.server.host,
      user: s.server.username,
      connected: s.connection.isConnected(),
      fingerprint: s.connection.fingerprintInfo?.fingerprint || null,
      streams: streams.idsFor(s.alias),
    }));
  }

  /**
   * Run fn(session) for an alias, mapping channel-open refusals to the MaxSessions error.
   * @param {string} alias
   * @param {Function} fn
   */
  async function withSession(alias, fn) {
    const session = await getSession(alias);
    try {
      return await fn(session);
    } catch (err) {
      throw mapChannelOpenError(err, session.alias);
    }
  }

  const { forgetAlias, idsFor, ...streamApi } = streams;
  return { getSession, ...streamApi, disconnect, status, withSession };
}
