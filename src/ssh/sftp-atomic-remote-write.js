/**
 * Atomic remote file write over SFTP
 * Writes `<dir>/.<name>.mcp-tmp-<rand>`, copies mode (+ best-effort uid/gid) of
 * the existing file, then replaces the target with posix-rename (atomic on
 * OpenSSH). Servers without the posix-rename extension fall back to
 * unlink + rename (short non-atomic window). If the directory is not writable
 * but the file is, the file is rewritten in place and a warning is returned.
 * Symlinks are followed: the write lands on the link's final target and the
 * link itself is kept (result.target names the resolved path).
 * Note: rename gives the file a new inode, so hard links to the old file break.
 */
import { randomBytes } from 'crypto';
import { posix } from 'path';

const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;
const DEFAULT_MODE = 0o644;

/** Promisified call of an SFTPWrapper method (callback last). */
export function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (err, value) => (err ? reject(err) : resolve(value)));
  });
}

/** True for an SFTP / errno "permission denied" error. */
const isPermissionDenied = (err) => err?.code === SFTP_PERMISSION_DENIED || err?.code === 'EACCES' || /permission denied/i.test(err?.message || '');

/** stat that returns null when the path does not exist. */
async function statOrNull(sftp, path) {
  try {
    return await sftpCall(sftp, 'stat', path);
  } catch (err) {
    if (err?.code === SFTP_NO_SUCH_FILE || err?.code === 'ENOENT') return null;
    throw err;
  }
}

const MAX_SYMLINK_HOPS = 32;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Server-side realpath of the directory of `p` (lexical dirname when it does not exist). */
async function realDir(sftp, p) {
  try {
    return await sftpCall(sftp, 'realpath', posix.dirname(p));
  } catch {
    return posix.dirname(p);
  }
}
const joinDir = (dir, name) => `${dir === '/' ? '' : dir}/${name}`;

/**
 * Follow symlinks (readlink hop by hop, so dangling links resolve too) and
 * return the final path to write. Paths are never normalised lexically: a
 * relative target is joined to the server-side realpath of the link's
 * directory, so '..' after a symlinked parent dir resolves like the kernel does.
 */
async function resolveSymlinks(sftp, path) {
  let cur = path;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    let st;
    try {
      st = await sftpCall(sftp, 'lstat', cur);
    } catch (err) {
      if (err?.code !== SFTP_NO_SUCH_FILE && err?.code !== 'ENOENT') throw err;
      st = null;
    }
    if (!st || (st.mode & S_IFMT) !== S_IFLNK) return hop ? joinDir(await realDir(sftp, cur), posix.basename(cur)) : cur;
    const link = await sftpCall(sftp, 'readlink', cur);
    cur = link.startsWith('/') ? link : joinDir(await realDir(sftp, cur), link);
  }
  throw new Error(`${path}: too many levels of symbolic links`);
}

/** Parse an optional octal mode string ("600" / "0644") -> number, or undefined. */
export function parseMode(mode) {
  if (mode === undefined || mode === null || mode === '') return undefined;
  if (typeof mode !== 'string' || !/^[0-7]{3,4}$/.test(mode)) {
    throw new Error(`"mode" must be an octal string like "644" or "0600" (got ${JSON.stringify(mode)})`);
  }
  return parseInt(mode, 8);
}

/**
 * Replace tmp -> final. posix-rename throws SYNCHRONOUSLY when the server lacks
 * the extension, so the call itself is wrapped; only that case uses the
 * non-atomic unlink + rename fallback (a real rename error is not retried).
 */
async function replaceFile(sftp, tmp, final) {
  let supported = true;
  const posixRename = new Promise((resolve, reject) => {
    try {
      sftp.ext_openssh_rename(tmp, final, (err) => (err ? reject(err) : resolve()));
    } catch {
      supported = false;
      resolve();
    }
  });
  await posixRename;
  if (supported) return false;
  try {
    await sftpCall(sftp, 'unlink', final);
  } catch (err) {
    if (err?.code !== SFTP_NO_SUCH_FILE) throw err;
  }
  try {
    await sftpCall(sftp, 'rename', tmp, final);
  } catch (err) {
    // Original is already gone: keep tmp so the new content is not lost too.
    const kept = new Error(`rename ${tmp} -> ${final} failed after unlink (${err.message}); new content kept at ${tmp}`);
    kept.keepTmp = true;
    throw kept;
  }
  return true;
}

/**
 * @param {object} sftp - ssh2 SFTPWrapper
 * @param {string} linkPath - absolute or home-relative remote path (symlinks followed)
 * @param {string} content - text to write (UTF-8)
 * @param {object} [opts] - { mode: octal string } (explicit mode wins over the existing file's)
 * @returns {Promise<{remotePath, bytes, mode, target?, warning?}>}
 */
export async function atomicWriteRemoteFile(sftp, linkPath, content, opts = {}) {
  const data = Buffer.from(content, 'utf8');
  const remotePath = await resolveSymlinks(sftp, linkPath);
  const existing = await statOrNull(sftp, remotePath);
  if (existing && existing.isDirectory()) throw new Error(`${remotePath} is a directory`);
  const mode = parseMode(opts.mode) ?? (existing ? existing.mode & 0o7777 : DEFAULT_MODE);
  const tmp = posix.join(posix.dirname(remotePath), `.${posix.basename(remotePath)}.mcp-tmp-${randomBytes(6).toString('hex')}`);
  const result = { remotePath: linkPath, bytes: data.length, mode: mode.toString(8).padStart(4, '0') };
  if (remotePath !== linkPath) result.target = remotePath;

  try {
    await sftpCall(sftp, 'writeFile', tmp, data, { flag: 'wx', mode });
  } catch (err) {
    if (!existing || !isPermissionDenied(err)) throw err;
    // File writable but directory not: in-place rewrite keeps owner/mode, not atomic.
    await sftpCall(sftp, 'writeFile', remotePath, data, { flag: 'w' });
    if (opts.mode !== undefined) await sftpCall(sftp, 'chmod', remotePath, mode).catch(() => {});
    return { ...result, warning: 'non-atomic in-place write; directory not writable' };
  }

  try {
    await sftpCall(sftp, 'chmod', tmp, mode); // open() mode is subject to the server umask
    if (existing) {
      await sftpCall(sftp, 'setstat', tmp, { uid: existing.uid, gid: existing.gid }).catch(() => {}); // EPERM ok
    }
    if (await replaceFile(sftp, tmp, remotePath)) result.warning = 'server lacks posix-rename; replaced via unlink + rename';
    return result;
  } catch (err) {
    if (!err.keepTmp) await sftpCall(sftp, 'unlink', tmp).catch(() => {});
    throw err;
  }
}
