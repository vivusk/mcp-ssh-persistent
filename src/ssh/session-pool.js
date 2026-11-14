/**
 * Session pool: server alias -> connected Session (D1, D5)
 * Lazy connect on first use, one shared in-flight connect per alias, automatic
 * reconnect on the next call after a drop. Each alias owns its own connection,
 * so a call for one alias can never run on another alias's server.
 * Also keeps the global index stream_id -> alias for stream tools.
 */
import { SSHConnection } from './connection.js';
import { SSHExec } from './exec.js';
import { SSHStream } from './stream.js';
import { SSHSFTP } from './sftp.js';
import { mapChannelOpenError } from './channel-open-failure-error.js';
import * as configModule from '../config/load-config-and-server-aliases.js';
import { log } from '../utils/logger.js';

/**
 * @param {object} [deps] - Injection points (tests)
 * @param {Function} [deps.resolveServer] - alias -> server settings (throws on unknown)
 * @param {Function} [deps.getLimits] - () -> limits
 * @param {Function} [deps.createConnection] - server -> connection-like object
 */
export function createSessionPool(deps = {}) {
  const resolveServer = deps.resolveServer || configModule.resolveServer;
  const getLimits = deps.getLimits || configModule.getLimits;
  const createConnection = deps.createConnection || ((server) => new SSHConnection(server));

  const sessions = new Map(); // canonical alias -> Session
  const connecting = new Map(); // canonical alias -> Promise<Session>
  const streamIndex = new Map(); // stream_id -> canonical alias

  /** Build a session around a connection (legacy stream/sftp classes until phases 03/05). */
  function buildSession(server, connection) {
    const limits = getLimits();
    const getClient = () => connection.getClient();
    const isConnected = () => connection.isConnected();
    return {
      alias: server.alias,
      server,
      connection,
      exec: new SSHExec(getClient, {
        alias: server.alias,
        maxConcurrent: limits.maxConcurrentExec,
        maxOutputBytes: limits.maxOutputBytes,
      }),
      stream: new SSHStream(getClient, isConnected),
      sftp: new SSHSFTP(getClient, isConnected),
    };
  }

  /** Drop stream index entries owned by an alias. */
  function forgetStreams(alias) {
    for (const [id, owner] of streamIndex) if (owner === alias) streamIndex.delete(id);
  }

  /** Tear down a session's channels and forget it. */
  function dropSession(session) {
    if (sessions.get(session.alias) !== session) return;
    sessions.delete(session.alias);
    forgetStreams(session.alias);
    try { session.stream.cleanup(); } catch { /* ignore */ }
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
   * Session owning a stream_id.
   * @param {string} streamId
   * @returns {Promise<object>} Session
   */
  async function getStreamSession(streamId) {
    const alias = streamIndex.get(streamId);
    if (!alias) throw new Error(`unknown stream_id "${streamId}"; start it with ssh_stream_start`);
    const session = sessions.get(alias);
    if (!session || !session.connection.isConnected()) {
      streamIndex.delete(streamId);
      throw new Error(`stream_id "${streamId}" lost: connection to ${alias} closed`);
    }
    return session;
  }

  /** Bind / unbind a stream_id to a session alias. */
  function registerStream(streamId, alias) {
    streamIndex.set(streamId, alias);
  }
  function unregisterStream(streamId) {
    streamIndex.delete(streamId);
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
      streams: [...streamIndex].filter(([, a]) => a === s.alias).map(([id]) => id),
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

  return { getSession, getStreamSession, registerStream, unregisterStream, disconnect, status, withSession };
}
