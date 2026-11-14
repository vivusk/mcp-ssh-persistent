/**
 * Prompt-gated sudo password delivery for exec channels (D13).
 * Command runs as
 *   sudo -S -k -p '<marker>' -- bash -c "printf %s '<sentinel>' >&2; exec bash -c '<cmd>'"
 * with two per-call random tokens. The marker is sudo's prompt; the sentinel is
 * printed by the root-side wrapper BEFORE any user code runs. Both sit in the
 * remote argv (readable via ps), so they are not secret from the command itself;
 * safety comes from ordering instead:
 *  - password written only on a marker seen BEFORE the sentinel (only sudo can
 *    print it then: user code has not started yet);
 *  - sentinel first (NOPASSWD / !authenticate / cached rule: no prompt) -> stdin
 *    ended without writing, before user code can run;
 *  - stdin also ended on first stdout byte, channel exit, or 3 s quiet;
 *  - a second marker before the sentinel = wrong password -> kill (never retried).
 * Markers after the sentinel come from user code and are ignored.
 */
import { randomBytes } from 'crypto';
import { shellSingleQuote } from '../utils/shell-quote.js';
import { registerSecret, unregisterSecret } from '../security/secret-redaction.js';

export const NO_MARKER_QUIET_MS = 3000;
// sudo's own failure lines only (not arbitrary command stderr).
const AUTH_FAILED_RE = /^(Sorry, try again\.?|sudo: \d+ incorrect password attempts?)\s*$/im;

const token = (kind) => `__MCP_SUDO_${kind}${randomBytes(12).toString('hex')}__`;

/** Per-call unguessable prompt marker + sentinel, registered for redaction until finalize(). */
export function createSudoTokens() {
  const tokens = { marker: token(''), sentinel: token('GO_') };
  registerSecret(tokens.marker);
  registerSecret(tokens.sentinel);
  return tokens;
}

/** Remote command line for a sudo exec (bash -c keeps plain ssh_exec semantics). */
export function buildSudoCommand(command, { marker, sentinel }) {
  const inner = `printf %s ${shellSingleQuote(sentinel)} >&2; exec bash -c ${shellSingleQuote(command)}`;
  return `sudo -S -k -p ${shellSingleQuote(marker)} -- bash -c ${shellSingleQuote(inner)}`;
}

/** Throw when sudo:true cannot be used safely; checked before the password is fetched. */
export function assertSudoAllowed({ username, alias, pty }) {
  if (username === 'root') throw new Error(`already root on ${alias}; run without sudo:true`);
  if (pty) throw new Error('sudo:true cannot be combined with pty:true (a PTY would echo the password)');
}

export class SudoPromptGate {
  /**
   * @param {object} opts - { marker, sentinel, password, quietMs }
   */
  constructor({ marker, sentinel, password, quietMs = NO_MARKER_QUIET_MS }) {
    Object.assign(this, { marker, sentinel, password, quietMs });
    this.pending = ''; // unscanned stderr tail (tokens may be split across chunks)
    this.markersSeen = 0;
    this.sentinelSeen = false;
    this.written = false;
    this.stdinEnded = false;
    this.authFailed = false;
    this.timer = null;
  }

  /**
   * Watch a freshly opened exec channel.
   * @param {object} ch - ssh2 channel (stdin = ch.stdin or ch itself)
   * @param {Function} kill - Kills the channel (used on a second marker)
   */
  attach(ch, kill) {
    this.ch = ch;
    this.kill = kill;
    ch.on('data', () => this.#endStdin());
    ch.stderr?.on('data', (d) => this.#onStderr(d));
    ch.on('exit', () => this.#endStdin());
    ch.on('close', () => this.dispose());
    this.#armTimer();
  }

  /** Stop the quiet timer. Idempotent. */
  dispose() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Dispose and drop the per-call tokens from the redaction registry. Idempotent. */
  forget() {
    this.dispose();
    unregisterSecret(this.marker);
    unregisterSecret(this.sentinel);
  }

  /**
   * Strip the tokens from output, map auth failures to an error, forget the tokens.
   * @param {object} result - exec result
   * @param {string} alias
   * @returns {object} result with tokens removed
   */
  finalize(result, alias) {
    this.forget();
    const raw = String(result.stderr ?? '');
    const at = raw.indexOf(this.sentinel);
    // stderr before user code ran; prompts (no trailing newline) become line breaks
    const sudoPart = (at >= 0 ? raw.slice(0, at) : raw).split(this.marker).join('\n');
    if (this.authFailed || (this.written && !this.sentinelSeen && AUTH_FAILED_RE.test(sudoPart))) {
      throw new Error(`sudo authentication failed on ${alias} (stored password rejected; not retried). Update it: npm run set-sudo-password -- <username>`);
    }
    const strip = (s) => String(s ?? '').split(this.marker).join('').split(this.sentinel).join('');
    return { ...result, stdout: strip(result.stdout), stderr: strip(raw) };
  }

  #stdin() {
    return this.ch.stdin || this.ch;
  }

  #onStderr(chunk) {
    if (this.authFailed || this.sentinelSeen) return;
    // latin1 keeps ASCII bytes 1:1, enough to find the ASCII tokens.
    this.pending += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
    for (;;) {
      const m = this.pending.indexOf(this.marker);
      const s = this.pending.indexOf(this.sentinel);
      if (s >= 0 && (m < 0 || s < m)) {
        // Wrapper reached: user code starts now. Never write after this point.
        this.sentinelSeen = true;
        this.pending = '';
        this.#endStdin();
        return;
      }
      if (m < 0) break;
      this.pending = this.pending.slice(m + this.marker.length);
      this.#onMarker();
      if (this.authFailed) return;
    }
    this.pending = this.pending.slice(-(Math.max(this.marker.length, this.sentinel.length) - 1));
    if (!this.stdinEnded) this.#armTimer();
  }

  #onMarker() {
    this.markersSeen += 1;
    if (this.markersSeen === 1 && !this.stdinEnded) {
      this.#stdin().write(`${this.password}\n`);
      this.written = true;
      this.#endStdin();
    } else if (this.written) {
      // sudo re-prompted before the wrapper ran: password rejected. Never retry.
      this.authFailed = true;
      this.dispose();
      this.kill?.();
    }
  }

  #armTimer() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#endStdin(), this.quietMs);
    this.timer.unref?.();
  }

  #endStdin() {
    if (this.stdinEnded) return;
    this.stdinEnded = true;
    this.dispose();
    try { this.#stdin().end(); } catch { /* channel already gone */ }
  }
}
