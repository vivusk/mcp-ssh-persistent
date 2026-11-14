/**
 * ANSI escape code utilities
 * Handles stripping terminal control sequences from output
 */

// OSC: ESC ] ... terminated by BEL or ST (ESC \), e.g. window-title updates.
// Body bounded to non-BEL/ESC/newline so an unterminated OSC cannot swallow later lines.
const OSC_RE = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)/g;
// CSI: ESC [ params intermediates final, e.g. colors, cursor moves, ?2004h.
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Charset selection (ESC ( B) and keypad modes (ESC = / ESC >).
const MISC_ESC_RE = /\x1b[()][0-9A-Za-z]|\x1b[=>]/g;

/**
 * Strip ANSI escape codes from string and normalise CRLF (`\r+\n` -> `\n`).
 * Removes color codes, cursor movements, OSC titles and other terminal sequences.
 * @param {string} str - Input string with potential ANSI codes
 * @returns {string} Clean string without ANSI codes
 */
export function stripAnsi(str) {
  return String(str ?? '')
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(MISC_ESC_RE, '')
    .replace(/\r+\n/g, '\n');
}

/**
 * Clean output - strip ANSI codes and trim whitespace
 * @param {string} output - Raw terminal output
 * @returns {string} Cleaned output
 */
export function cleanOutput(output) {
  return stripAnsi(output).trim();
}
