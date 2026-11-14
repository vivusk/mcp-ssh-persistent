/**
 * SSH connection wrapper (one ssh2 Client per server alias)
 * Hardened: host-key pinning via hostVerifier (D4), keepalive (D5),
 * key or ssh-agent auth only (no passwords).
 */
import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import { verify as verifyHostKey, getKnownHostsPath } from '../config/known-hosts-fingerprint-store.js';
import { log } from '../utils/logger.js';

const WIN_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

/**
 * Build ssh2 auth options for a server (agent or private key).
 * @param {object} server - Resolved server settings
 * @returns {object} partial ssh2 connect options
 */
function buildAuthOptions(server) {
  if (server.useAgent) {
    const agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? WIN_AGENT_PIPE : '');
    if (!agent) throw new Error(`ssh-agent not available for ${server.alias} (SSH_AUTH_SOCK unset)`);
    return { agent };
  }
  if (!server.privateKeyPath) {
    throw new Error(`server alias "${server.alias}" has no privateKeyPath and useAgent is false`);
  }
  let privateKey;
  try {
    privateKey = readFileSync(server.privateKeyPath);
  } catch (err) {
    throw new Error(`cannot read privateKeyPath for ${server.alias}: ${err.code || err.message}`);
  }
  const opts = { privateKey };
  if (process.env.MCP_SSH_KEY_PASSPHRASE) opts.passphrase = process.env.MCP_SSH_KEY_PASSPHRASE;
  return opts;
}

export class SSHConnection {
  /**
   * @param {object} server - Resolved server settings (alias, host, port, username, ...)
   * @param {object} [deps] - { verifyHostKey } override for tests
   */
  constructor(server, deps = {}) {
    this.server = server;
    this.client = null;
    this.connected = false;
    this.fingerprintInfo = null; // { fingerprint, isNew, source } after host-key check
    this._closeHandlers = [];
    this._verify = deps.verifyHostKey || verifyHostKey;
  }

  /** Register a callback fired once the underlying connection closes. */
  onClose(callback) {
    this._closeHandlers.push(callback);
  }

  /**
   * Open the connection. Rejects on host-key mismatch, auth failure, timeout.
   * @returns {Promise<void>}
   */
  connect() {
    const server = this.server;
    const port = server.port || 22;
    const options = {
      host: server.host,
      port,
      username: server.username,
      readyTimeout: server.readyTimeout,
      keepaliveInterval: server.keepaliveInterval,
      keepaliveCountMax: server.keepaliveCountMax,
      ...buildAuthOptions(server),
    };
    let hostError = null;
    options.hostVerifier = (key) => {
      try {
        const res = this._verify(server.host, port, key, server.fingerprint);
        this.fingerprintInfo = { fingerprint: res.fingerprint, isNew: res.isNew, source: res.source };
        if (res.ok) {
          if (res.isNew) log('info', `pinned new host key for ${server.alias}`, { fingerprint: res.fingerprint });
          return true;
        }
        const where = res.source === 'config' ? 'the fingerprint in config.json' : `that entry in ${getKnownHostsPath()}`;
        hostError = new Error(
          `HOST KEY MISMATCH for ${server.alias} (${server.host}:${port}) expected ${res.expected} got ${res.fingerprint}` +
          ` — if the server was legitimately reinstalled, delete ${where}`
        );
      } catch (err) {
        hostError = new Error(`host key check failed for ${server.alias}: ${err.message}`);
      }
      return false;
    };

    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;
      this._closeFired = false;
      let settled = false;
      client.on('ready', () => {
        settled = true;
        this.connected = true;
        resolve();
      });
      client.on('error', (err) => {
        this.connected = false;
        if (settled) {
          log('warn', `ssh connection error on ${server.alias}`, { error: err.message });
          return;
        }
        settled = true;
        reject(hostError || this._describeError(err));
      });
      client.on('close', () => {
        const wasClient = this.client === client;
        this.connected = false;
        if (!settled) {
          settled = true;
          reject(hostError || new Error(`connection to ${server.alias} closed during handshake`));
        }
        if (wasClient) this._fireClose();
      });
      try {
        client.connect(options);
      } catch (err) {
        settled = true;
        reject(this._describeError(err));
      }
    });
  }

  /** Map low-level ssh2 errors to actionable messages. */
  _describeError(err) {
    const msg = err?.message || String(err);
    if (this.server.useAgent && /agent|ENOENT|EPIPE|connect/i.test(msg) && !/Timed out/i.test(msg)) {
      return new Error(`ssh-agent not available or failed for ${this.server.alias}: ${msg}`);
    }
    return new Error(`connect ${this.server.alias} failed: ${msg}`);
  }

  /** Close the connection (idempotent). */
  disconnect() {
    const client = this.client;
    if (!client) return;
    this.connected = false;
    this.client = null; // cleared first so the late 'close' event is ignored
    try { client.end(); } catch { /* ignore */ }
    try { client.destroy(); } catch { /* ignore */ }
    this._fireClose();
  }

  /** Run close callbacks once per connection lifetime. */
  _fireClose() {
    if (this._closeFired) return;
    this._closeFired = true;
    this._closeHandlers.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
  }

  /** @returns {Client|null} underlying ssh2 client */
  getClient() {
    return this.client;
  }

  /** @returns {boolean} true while the connection is usable */
  isConnected() {
    return this.connected && this.client !== null;
  }
}
