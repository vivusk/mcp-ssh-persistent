/**
 * SSH Streaming Operations
 * Handles persistent shell sessions for streaming/interactive commands
 */
import { stripAnsi } from '../utils/ansi.js';

/** Buffer size limit per stream (500KB) */
const MAX_BUFFER_SIZE = 500000;

/** Prompt patterns to detect command completion */
const PROMPT_PATTERNS = [
  /\$\s*$/,              // user@host:~$
  /#\s*$/,               // root@host:~#
  />\s*$/,               // PS C:\> or other shells
  /\]\$\s*$/,            // [user@host ~]$
  /\]#\s*$/,             // [root@host ~]#
  /password.*:\s*$/i,    // sudo password prompt, Password:, etc.
  /\(yes\/no.*\)\s*$/i,  // SSH key confirmation
  /:\s*$/,               // Generic prompt ending with :
];

/**
 * Manage SSH shell streams for interactive/long-running commands
 */
export class SSHStream {
  constructor(getClient, isConnected) {
    this._getClient = getClient;
    this._isConnected = isConnected;
    this.shell = null;
    this.shellBuffer = ''; // Single global buffer for shell output
    this.streams = new Map();
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _ensureShell() {
    if (this.shell) return;

    const client = this._getClient();

    return new Promise((resolve, reject) => {
      client.shell({ rows: 50, cols: 200 }, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        this.shell = stream;
        this.shellBuffer = '';

        // Collect ALL output to global buffer
        stream.on('data', (data) => {
          const text = data.toString('utf8');
          this.shellBuffer += text;
          
          // Also add to active streams
          for (const [, streamData] of this.streams) {
            if (streamData.active) {
              streamData.buffer += text;
              if (streamData.buffer.length > MAX_BUFFER_SIZE) {
                streamData.buffer = streamData.buffer.slice(-MAX_BUFFER_SIZE / 2);
              }
            }
          }
        });

        stream.stderr?.on('data', (data) => {
          const text = data.toString('utf8');
          this.shellBuffer += text;
          
          for (const [, streamData] of this.streams) {
            if (streamData.active) {
              streamData.buffer += text;
            }
          }
        });

        stream.on('close', () => {
          this.shell = null;
        });

        stream.on('error', () => {
          this.shell = null;
        });

        setTimeout(resolve, 500);
      });
    });
  }

  startStream(streamId) {
    if (!this._isConnected()) {
      throw new Error('Not connected');
    }

    this.streams.set(streamId, {
      buffer: '',
      active: true,
      startedAt: Date.now()
    });

    return { success: true, streamId };
  }

  async execStream(streamId, command) {
    if (!this._isConnected()) {
      throw new Error('Not connected');
    }

    await this._ensureShell();
    this.startStream(streamId);
    this.shell.write(command + '\n');

    return { success: true, streamId, message: `Streaming started: ${command}` };
  }

  async readStream(streamId, clear = true, waitMs = 0) {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return { error: 'Stream not found', buffer: '' };
    }

    // Wait for output if requested
    if (waitMs > 0) {
      const startTime = Date.now();
      let lastLength = stream.buffer.length;
      let noChangeCount = 0;

      while (Date.now() - startTime < waitMs) {
        await this._sleep(100);
        
        if (stream.buffer.length > lastLength) {
          lastLength = stream.buffer.length;
          noChangeCount = 0;
        } else {
          noChangeCount++;
          // Exit early if we have content and no new data for 500ms
          if (noChangeCount >= 5 && lastLength > 0) {
            break;
          }
        }
      }
    }

    const buffer = stripAnsi(stream.buffer);
    if (clear) {
      stream.buffer = '';
    }

    return { buffer, active: stream.active };
  }

  /**
   * Write data to shell with optional auto-read
   * @param {string} data - Data to write
   * @param {object} options - Options
   * @param {number} options.wait_ms - Max wait time for output (0 = no wait, default 5000)
   * @param {number} options.poll_interval - Poll interval in ms (default 100)
   * @returns {object} { success, bytes, output?, complete? }
   */
  async writeToShell(data, options = {}) {
    if (!this._isConnected()) {
      throw new Error('Not connected');
    }

    const { wait_ms = 0, poll_interval = 100 } = options;

    await this._ensureShell();

    // Clear shell buffer before writing to capture only new output
    this.shellBuffer = '';

    this.shell.write(data);

    // If no wait requested, return immediately
    if (wait_ms === 0) {
      return { success: true, bytes: data.length };
    }

    // Poll for output with prompt detection
    const startTime = Date.now();

    while (Date.now() - startTime < wait_ms) {
      await this._sleep(poll_interval);

      const output = stripAnsi(this.shellBuffer);

      if (output.length > 0 && this._isPromptDetected(output)) {
        // Clear buffer after reading
        this.shellBuffer = '';
        return {
          success: true,
          bytes: data.length,
          output,
          complete: true
        };
      }
    }

    // Timeout - return whatever we have
    const output = stripAnsi(this.shellBuffer);
    this.shellBuffer = '';

    return {
      success: true,
      bytes: data.length,
      output: output || '(no output yet)',
      complete: false
    };
  }

  /**
   * Check if output ends with a prompt pattern (command completed)
   * @param {string} output - Output to check
   * @returns {boolean}
   */
  _isPromptDetected(output) {
    const trimmed = output.trimEnd();
    const lines = trimmed.split('\n');
    const lastLine = lines[lines.length - 1] || '';

    return PROMPT_PATTERNS.some(pattern => pattern.test(lastLine));
  }

  sendCtrlC() {
    if (this.shell) {
      this.shell.write('\x03');
      return { success: true };
    }
    return { error: 'No active shell' };
  }

  stopStream(streamId) {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.active = false;
      this.streams.delete(streamId);
      if (this.streams.size === 0 && this.shell) {
        this.shell.end();
        this.shell = null;
      }
      return { success: true };
    }
    return { error: 'Stream not found' };
  }

  resetShell() {
    if (this.shell) {
      this.shell.end();
      this.shell = null;
    }
    this.streams.clear();
    this.shellBuffer = '';
    return { success: true };
  }

  getActiveStreamCount() {
    return this.streams.size;
  }

  hasShell() {
    return this.shell !== null;
  }

  cleanup() {
    if (this.shell) {
      try { this.shell.end(); } catch {}
      try { this.shell.destroy(); } catch {}
    }
    this.shell = null;
    this.streams.clear();
    this.shellBuffer = '';
  }
}
