/**
 * Shell completion detector (D7, D13) — pure functions, no I/O.
 * Classifies the tail of a shell stream's output as: our marker prompt
 * (command finished), a sudo prompt for the session user, another password
 * prompt, a yes/no confirmation, a generic `$`/`#` prompt after 300 ms of
 * quiet (e.g. root shell from `sudo -s`), or still running.
 */
import { stripAnsi } from '../utils/ansi.js';

/** Unique PS1 marker set at shell init; bash expands `\$` to `$` (or `#` for root). */
export const MARKER = '__MCP_PS1__';

const TAIL_CHARS = 1024;
export const FALLBACK_QUIET_MS = 300;

const MARKER_PROMPT_END_RE = new RegExp(`${MARKER}[$#]\\s*$`);
const MARKER_STRIP_RE = new RegExp(`${MARKER}[$#] ?(\\r?\\n)?`, 'g');
// Any password prompt incl. `[sudo] password for <other user>:`, `user@host's password:`, `Password:`.
const PASSWORD_RE = /(^|\n)[^\n]*[Pp]assword(?: for [^\n:]+)?:\s*$/;
const CONFIRM_RE = /\((yes\/no|y\/n)[^)]*\)\??\s*:?\s*$/i;
const FALLBACK_PROMPT_RE = /[$#]\s*$/;

/** Escape a string for literal use inside a RegExp. */
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text after the last newline, with carriage-return overwrites resolved (last segment wins). */
function lastLine(text) {
  const line = text.slice(text.lastIndexOf('\n') + 1);
  const cr = line.lastIndexOf('\r');
  return cr >= 0 && cr < line.length - 1 ? line.slice(cr + 1) : line.replace(/\r$/, '');
}

/**
 * Classify the current end of stream output.
 * @param {string} tailText - Recent raw output (ANSI allowed); only the last 1 KB is inspected
 * @param {number} quietMs - Milliseconds since the last data arrived
 * @param {object} [opts] - { username } session user; only its sudo prompt yields kind 'sudo'
 * @returns {{state:'prompt'|'awaiting_input'|'running', kind?:string, fallback?:boolean}}
 */
export function detect(tailText, quietMs = 0, { username } = {}) {
  const text = stripAnsi(tailText).slice(-TAIL_CHARS).replace(/\r+\n/g, '\n');
  if (MARKER_PROMPT_END_RE.test(text)) return { state: 'prompt' };
  const line = lastLine(text);
  if (username) {
    const sudoRe = new RegExp(`^\\[sudo\\] password for ${escapeRegExp(username)}:\\s*$`);
    if (sudoRe.test(line)) return { state: 'awaiting_input', kind: 'sudo' };
  }
  if (PASSWORD_RE.test(line)) return { state: 'awaiting_input', kind: 'password' };
  if (CONFIRM_RE.test(line)) return { state: 'awaiting_input', kind: 'confirm' };
  if (quietMs >= FALLBACK_QUIET_MS && FALLBACK_PROMPT_RE.test(line)) return { state: 'prompt', fallback: true };
  return { state: 'running' };
}

/**
 * Remove marker prompts (whole prompt lines or trailing fragments) from output.
 * @param {string} text
 * @returns {string}
 */
export function stripMarker(text) {
  return String(text ?? '').replace(MARKER_STRIP_RE, '');
}
