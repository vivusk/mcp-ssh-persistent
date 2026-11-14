/**
 * SSH command execution over exec channels (D6)
 * No PTY by default; stdout/stderr collected separately with a byte cap,
 * UTF-8 safe. Per-session FIFO limiter keeps exec channels within the
 * OpenSSH MaxSessions budget (D12).
 */
import { CappedOutputCollector } from '../utils/capped-output-collector.js';
import { FifoConcurrencyLimiter } from '../utils/fifo-concurrency-limiter.js';
import { stripAnsi } from '../utils/ansi.js';
import { mapChannelOpenError } from './channel-open-failure-error.js';

const PTY_OPTIONS = { rows: 50, cols: 200, term: 'xterm-256color' };
// After a timeout, give the channel this long to close before freeing its slot anyway.
const RELEASE_GRACE_MS = 5000;

export class SSHExec {
  /**
   * @param {Function} getClient - Returns the ssh2 client (or null)
   * @param {object} opts - { alias, maxConcurrent, maxOutputBytes }
   */
  constructor(getClient, { alias = '?', maxConcurrent = 4, maxOutputBytes = 102400 } = {}) {
    this._getClient = getClient;
    this.alias = alias;
    this.maxOutputBytes = maxOutputBytes;
    this.limiter = new FifoConcurrencyLimiter(maxConcurrent);
  }

  /** @returns {number} exec channels currently running */
  get inFlight() {
    return this.limiter.active;
  }

  /**
   * Run a command. Queues FIFO when the per-session limit is reached; the
   * timeout starts when the command actually starts running.
   * @param {string} command
   * @param {object} [opts] - { timeout = 30000, pty = false }
   * @returns {Promise<{stdout:string, stderr:string, exitCode:number|null, signal:string|null, timedOut:boolean}>}
   */
  async exec(command, { timeout = 30000, pty = false } = {}) {
    // sshd refuses exec requests containing NUL with an opaque "Unable to exec".
    if (String(command).includes(String.fromCharCode(0))) throw new Error('command contains a NUL character');
    const release = await this.limiter.acquire();
    try {
      return await this._run(command, timeout, pty, release);
    } catch (err) {
      release();
      throw err;
    }
  }

  /** Open the channel and collect output; `release` frees the limiter slot once the channel is gone. */
  _run(command, timeout, pty, release) {
    const client = this._getClient();
    if (!client) return Promise.reject(new Error(`not connected to ${this.alias}`));
    const stdout = new CappedOutputCollector(this.maxOutputBytes);
    const stderr = new CappedOutputCollector(this.maxOutputBytes);

    return new Promise((resolve, reject) => {
      let settled = false;
      let channel = null;
      let exitCode = null;
      let signal = null;

      const finish = (timedOut) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out = stdout.toString();
        resolve({
          stdout: pty ? stripAnsi(out) : out,
          stderr: stderr.toString(),
          exitCode: timedOut ? null : exitCode,
          signal: timedOut ? null : signal,
          timedOut,
        });
      };

      const kill = (ch) => {
        try { ch.signal('KILL'); } catch { /* sshd may not support signals */ }
        try { ch.close(); } catch { /* ignore */ }
      };

      const timer = setTimeout(() => {
        finish(true);
        if (channel) kill(channel);
        setTimeout(release, RELEASE_GRACE_MS).unref?.();
      }, timeout);

      const options = pty ? { pty: PTY_OPTIONS } : {};
      try {
        client.exec(command, options, (err, ch) => {
          if (err) {
            clearTimeout(timer);
            release();
            if (!settled) {
              settled = true;
              reject(mapChannelOpenError(err, this.alias));
            }
            return;
          }
          channel = ch;
          if (settled) { // timed out before the channel opened
            ch.on('close', release);
            kill(ch);
            return;
          }
          ch.on('data', (d) => stdout.push(d));
          ch.stderr?.on('data', (d) => stderr.push(d));
          ch.on('exit', (code, sig) => {
            if (typeof code === 'number') exitCode = code;
            if (sig) signal = String(sig);
          });
          ch.on('close', (code) => {
            release();
            if (exitCode === null && typeof code === 'number') exitCode = code;
            finish(false);
          });
          ch.on('error', (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            release();
            reject(e);
          });
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err); // caller releases
        settled = true;
      }
    });
  }
}
