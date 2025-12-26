/**
 * SSH Manager - Facade for all SSH operations
 * Composes Connection, Exec, Stream, and SFTP modules
 */
import { SSHConnection } from './connection.js';
import { SSHExec } from './exec.js';
import { SSHStream } from './stream.js';
import { SSHSFTP } from './sftp.js';

/**
 * Unified SSH manager exposing all operations
 */
class SSHManager {
  constructor() {
    // Initialize connection module
    this.connection = new SSHConnection();

    // Bind helpers for other modules
    const getClient = () => this.connection.getClient();
    const isConnected = () => this.connection.isConnected();

    // Initialize operation modules
    this.exec = new SSHExec(getClient, isConnected);
    this.stream = new SSHStream(getClient, isConnected);
    this.sftp = new SSHSFTP(getClient, isConnected);

    // Clean up stream on connection close
    this.connection.onClose(() => {
      this.stream.cleanup();
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Connection Operations
  // ─────────────────────────────────────────────────────────────

  /** @returns {boolean} Connection state */
  get connected() {
    return this.connection.isConnected();
  }

  /**
   * Connect to SSH server
   * @param {object} config - Connection config
   */
  async connect(config) {
    return this.connection.connect(config);
  }

  /**
   * Disconnect from server
   */
  disconnect() {
    this.stream.cleanup();
    return this.connection.disconnect();
  }

  /**
   * Get full status info
   */
  getStatus() {
    return {
      ...this.connection.getStatus(),
      activeStreams: this.stream.getActiveStreamCount(),
      hasShell: this.stream.hasShell()
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Command Execution
  // ─────────────────────────────────────────────────────────────

  /**
   * Execute command via exec channel
   * @param {string} command - Command to run
   * @param {number} timeout - Timeout in ms
   */
  async execCommand(command, timeout) {
    return this.exec.exec(command, timeout);
  }

  // ─────────────────────────────────────────────────────────────
  // Streaming Operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Start streaming command
   * @param {string} streamId - Stream identifier
   * @param {string} command - Command to run
   */
  async execStream(streamId, command) {
    return this.stream.execStream(streamId, command);
  }

  /**
   * Read from stream
   * @param {string} streamId - Stream identifier
   * @param {boolean} clear - Clear buffer after read
   * @param {number} waitMs - Wait for new output
   */
  async readStream(streamId, clear, waitMs) {
    return this.stream.readStream(streamId, clear, waitMs);
  }

  /**
   * Write to shell with optional auto-read
   * @param {string} data - Data to write
   * @param {object} options - { wait_ms, poll_interval }
   */
  async writeToShell(data, options = {}) {
    return this.stream.writeToShell(data, options);
  }

  /**
   * Stop stream
   * @param {string} streamId - Stream to stop
   */
  stopStream(streamId) {
    return this.stream.stopStream(streamId);
  }

  /**
   * Send Ctrl+C to shell
   */
  sendCtrlC() {
    return this.stream.sendCtrlC();
  }

  /**
   * Reset shell state
   */
  resetShell() {
    return this.stream.resetShell();
  }

  // ─────────────────────────────────────────────────────────────
  // SFTP Operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Upload file to remote
   * @param {string} localPath - Local file
   * @param {string} remotePath - Remote destination
   */
  async scpUpload(localPath, remotePath) {
    return this.sftp.upload(localPath, remotePath);
  }

  /**
   * Download file from remote
   * @param {string} remotePath - Remote file
   * @param {string} localPath - Local destination
   */
  async scpDownload(remotePath, localPath) {
    return this.sftp.download(remotePath, localPath);
  }

  /**
   * Write content to remote file
   * @param {string} remotePath - Remote file path
   * @param {string} content - Content to write
   */
  async writeRemoteFile(remotePath, content) {
    return this.sftp.writeFile(remotePath, content);
  }

  /**
   * Read remote file content
   * @param {string} remotePath - Remote file path
   */
  async readRemoteFile(remotePath) {
    return this.sftp.readFile(remotePath);
  }
}

// Singleton instance
export const sshManager = new SSHManager();
export default SSHManager;
