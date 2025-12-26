/**
 * SSH Command Execution
 * Handles running commands via exec channel with PTY
 */
import { cleanOutput } from '../utils/ansi.js';

/**
 * Execute commands over SSH
 */
export class SSHExec {
  /**
   * @param {Function} getClient - Function to get SSH2 client
   * @param {Function} isConnected - Function to check connection status
   */
  constructor(getClient, isConnected) {
    this._getClient = getClient;
    this._isConnected = isConnected;
  }

  /**
   * Execute command using exec channel with PTY
   * Returns output with exit code - knows exactly when command finishes
   * @param {string} command - Command to execute
   * @param {number} timeout - Timeout in ms (default: 30000)
   * @returns {Promise<object>} { output, exitCode, timedOut }
   */
  async exec(command, timeout = 30000) {
    if (!this._isConnected()) {
      throw new Error('Not connected. Call connect() first.');
    }

    const client = this._getClient();

    return new Promise((resolve, reject) => {
      const options = {
        pty: {
          rows: 50,
          cols: 200,
          term: 'xterm-256color'
        }
      };

      client.exec(command, options, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let output = '';
        let exitCode = null;

        const timeoutId = setTimeout(() => {
          stream.close();
          resolve({
            output: cleanOutput(output),
            exitCode: -1,
            timedOut: true
          });
        }, timeout);

        // With PTY, all output (stdout + stderr) comes through 'data' event
        stream.on('data', (data) => {
          output += data.toString('utf8');
        });

        stream.on('close', (code) => {
          clearTimeout(timeoutId);
          exitCode = code;
          resolve({
            output: cleanOutput(output),
            exitCode: exitCode,
            timedOut: false
          });
        });

        stream.on('error', (err) => {
          clearTimeout(timeoutId);
          reject(err);
        });
      });
    });
  }
}
