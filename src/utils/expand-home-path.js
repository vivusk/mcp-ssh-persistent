/**
 * Expand a leading `~` / `~/` (and `~\` on win32) to the user's home directory.
 * `~user/...` is not supported and is returned unchanged; non-strings pass through.
 * Dependency-free (node:os / node:path only) so data-dir-paths.js can use it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {*} p - path as configured
 * @returns {*} expanded path, or `p` unchanged
 */
export function expandHome(p) {
  if (typeof p !== 'string' || !p.startsWith('~')) return p;
  if (p === '~') return homedir();
  const sepChar = p[1];
  if (sepChar === '/' || (sepChar === '\\' && process.platform === 'win32')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}
