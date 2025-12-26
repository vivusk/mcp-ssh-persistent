/**
 * SSH Connection Management
 * Handles establishing and managing SSH client connections
 */
import { Client } from 'ssh2';
import { readFileSync } from 'fs';

/**
 * Create and manage SSH connection
 */
export class SSHConnection {
  constructor() {
    this.client = null;
    this.connected = false;
    this.config = null;
    this._onClose = null; // Callback for connection close
  }

  /**
   * Set callback for connection close event
   * @param {Function} callback - Called when connection closes
   */
  onClose(callback) {
    this._onClose = callback;
  }

  /**
   * Connect to SSH server
   * @param {object} config - Connection config { host, port, username, privateKeyPath, password }
   * @returns {Promise<object>} Connection result
   */
  async connect(config) {
    if (this.connected) {
      return { success: true, message: 'Already connected' };
    }

    this.config = config;

    return new Promise((resolve, reject) => {
      this.client = new Client();

      let resolved = false;

      this.client.on('ready', () => {
        resolved = true;
        this.connected = true;
        resolve({ success: true, message: `Connected to ${config.host}` });
      });

      this.client.on('error', (err) => {
        this.connected = false;
        if (!resolved) {
          reject(err);
        }
        // Silently ignore errors after connection (e.g., during shutdown)
      });

      this.client.on('close', () => {
        this.connected = false;
        if (this._onClose) this._onClose();
      });

      this.client.on('end', () => {
        this.connected = false;
      });

      // Build connection options
      const connectOptions = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: 10000,
      };

      // Use private key if provided
      if (config.privateKeyPath) {
        connectOptions.privateKey = readFileSync(config.privateKeyPath);
      } else if (config.password) {
        connectOptions.password = config.password;
      }

      this.client.connect(connectOptions);
    });
  }

  /**
   * Disconnect from SSH server
   * @returns {object} Disconnect result
   */
  disconnect() {
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // Ignore end errors
      }
      try {
        this.client.destroy();
      } catch {
        // Ignore destroy errors
      }
      this.client = null;
      this.connected = false;
    }
    return { success: true };
  }

  /**
   * Get connection status
   * @returns {object} Status info
   */
  getStatus() {
    return {
      connected: this.connected,
      host: this.config?.host,
    };
  }

  /**
   * Get underlying SSH2 client for other modules
   * @returns {Client|null} SSH2 client instance
   */
  getClient() {
    return this.client;
  }

  /**
   * Check if connected
   * @returns {boolean} Connection state
   */
  isConnected() {
    return this.connected && this.client !== null;
  }
}
