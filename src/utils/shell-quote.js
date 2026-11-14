/**
 * POSIX shell quoting.
 * Wraps a string in single quotes; embedded `'` becomes `'\''`. Inside single
 * quotes nothing is special ($, backticks, \, newlines stay literal).
 */

/**
 * @param {string} str
 * @returns {string} single-quoted shell word
 */
export function shellSingleQuote(str) {
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}
