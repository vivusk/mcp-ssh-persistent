/**
 * macOS Keychain backend for the sudo password store (D-M1).
 * Spawns `/usr/bin/security` (generic password, default = login keychain).
 * The secret never appears in argv: writes pipe an `add-generic-password` line
 * to `security -i` on stdin; reads parse the `-g` line printed on stderr.
 * Error messages are built from stderr only and never include stdin.
 */
import { spawn } from 'child_process';

const SECURITY_BIN = '/usr/bin/security';
const TIMEOUT_MS = 5000;
const EXIT_NOT_FOUND = 44;
const UNLOCK_HINT = 'unlock the login keychain';

/**
 * Run `security` with args, optional stdin. Resolves on any exit code.
 * @param {string[]} args
 * @param {string} [stdin]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runSecurity(args, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`macOS Keychain '${args[0]}' timed out after ${TIMEOUT_MS} ms (${UNLOCK_HINT})`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`cannot run ${SECURITY_BIN}: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => { /* child exited early; close handler reports */ });
    child.stdin.end(stdin, 'utf8');
  });
}

/** First non-empty stderr line, or `exit <code>`. */
const firstLine = (stderr, code) => stderr.split('\n').map((l) => l.trim()).find(Boolean) || `exit ${code}`;

/**
 * Quote a value for one `security -i` command line: only `\` and `"` are escaped (D-M4).
 * @param {string} value
 * @returns {string} double-quoted token
 */
export function escapeSecurityArg(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Extract the password from `find-generic-password -g` stderr (F4).
 * `password: 0x<HEX>  "..."` → hex-decoded UTF-8; `password: "<raw>"` → outer quotes stripped;
 * `password: ` → ''.
 * @param {string} stderr
 * @returns {string}
 */
export function parseSecurityPasswordLine(stderr) {
  const line = String(stderr).split('\n').find((l) => /^password:/.test(l));
  if (line === undefined) throw new Error("Unexpected 'security' output (no password line)");
  const rest = line.replace(/^password: ?/, '').replace(/\r$/, '');
  if (rest === '') return '';
  const hex = /^0x([0-9A-Fa-f]*)/.exec(rest);
  if (hex) return Buffer.from(hex[1], 'hex').toString('utf8');
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1);
  throw new Error("Unexpected 'security' output (unrecognised password format)");
}

/**
 * Read a generic password.
 * @returns {Promise<string|null>} secret, or null when no such item
 */
export async function macReadPassword(service, account) {
  const { code, stderr } = await runSecurity(['find-generic-password', '-s', service, '-a', account, '-g']);
  if (code === EXIT_NOT_FOUND) return null;
  if (code !== 0) throw new Error(`macOS Keychain read failed: ${firstLine(stderr, code)} (${UNLOCK_HINT})`);
  return parseSecurityPasswordLine(stderr);
}

/**
 * Create or update (-U) a generic password, then verify by reading it back
 * (`security -i` exits 0 even when the sub-command fails).
 */
export async function macWritePassword(service, account, secret) {
  if (/[\r\n]/.test(secret)) throw new Error('password must not contain line breaks (macOS Keychain)');
  const line = ['add-generic-password', '-U', '-s', escapeSecurityArg(service), '-a', escapeSecurityArg(account),
    '-w', escapeSecurityArg(secret)].join(' ');
  const { code } = await runSecurity(['-i'], `${line}\n`);
  // stderr of `-i` is deliberately not surfaced: keep the secret-bearing command out of errors.
  if (code !== 0) throw new Error(`macOS Keychain write failed: exit ${code} (${UNLOCK_HINT})`);
  if ((await macReadPassword(service, account)) !== secret) {
    throw new Error(`macOS Keychain write failed (read-back mismatch; ${UNLOCK_HINT})`);
  }
}

/**
 * Delete a generic password.
 * @returns {Promise<boolean>} true when deleted, false when not found
 */
export async function macDeletePassword(service, account) {
  const { code, stderr } = await runSecurity(['delete-generic-password', '-s', service, '-a', account]);
  if (code === 0) return true;
  if (code === EXIT_NOT_FOUND) return false;
  throw new Error(`macOS Keychain delete failed: ${firstLine(stderr, code)} (${UNLOCK_HINT})`);
}
