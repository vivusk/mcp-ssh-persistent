/**
 * ANSI escape code utilities
 * Handles stripping terminal control sequences from output
 */

/**
 * Strip ANSI escape codes from string
 * Removes color codes, cursor movements, and other terminal sequences
 * @param {string} str - Input string with potential ANSI codes
 * @returns {string} Clean string without ANSI codes
 */
export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[[\?]?[0-9;]*[hlm]/g, '');
}

/**
 * Clean output - strip ANSI codes and trim whitespace
 * @param {string} output - Raw terminal output
 * @returns {string} Cleaned output
 */
export function cleanOutput(output) {
  return stripAnsi(output).trim();
}
