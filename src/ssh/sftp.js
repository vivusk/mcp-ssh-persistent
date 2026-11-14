/**
 * SFTP operations over one cached SFTP channel per session
 * The SFTPWrapper is opened lazily, shared by concurrent callers (one in-flight
 * open), reset when the channel closes/errors and closed on session drop (D12:
 * it is the "+1" channel of the per-connection budget).
 * Local paths go through the local path policy (D8) before any I/O.
 */
import { stat, rename, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';
import { basename, join, posix } from 'path';
import { assertLocalPathAllowed } from '../security/local-path-policy.js';
import { atomicWriteRemoteFile, sftpCall } from './sftp-atomic-remote-write.js';
import { log } from '../utils/logger.js';

const TRANSFER_OPTS = { concurrency: 64, chunkSize: 32768 };
const BINARY_SNIFF_BYTES = 8192;

export class SSHSFTP {
  /**
   * @param {Function} getClient - () -> ssh2 Client (null when disconnected)
   * @param {object} [opts]
   * @param {string} [opts.alias] - server alias (messages)
   * @param {Function} [opts.getLimits] - () -> { maxReadFileBytes }
   * @param {Function} [opts.checkLocalPath] - (path, opts) -> realpath (policy; injectable for tests)
   */
  constructor(getClient, opts = {}) {
    this._getClient = getClient;
    this._alias = opts.alias || '';
    this._getLimits = opts.getLimits || (() => ({ maxReadFileBytes: 2097152 }));
    this._checkLocalPath = opts.checkLocalPath || assertLocalPathAllowed;
    this._pending = null; // Promise<SFTPWrapper> while open / opening
    this.opens = 0; // number of SFTP channels opened (smoke: proves reuse)
  }

  /** Cached SFTPWrapper; opens one on first use or after the previous one closed. */
  getSftp() {
    if (this._pending) return this._pending;
    const pending = new Promise((resolve, reject) => {
      const client = this._getClient();
      if (!client) return reject(new Error(`not connected: ${this._alias}`));
      client.sftp((err, sftp) => {
        if (err) return reject(err);
        this.opens += 1;
        const reset = () => { if (this._pending === pending) this._pending = null; };
        sftp.on('close', reset);
        sftp.on('end', reset);
        sftp.on('error', (e) => { log('warn', `sftp channel error: ${this._alias}`, { error: e.message }); reset(); });
        resolve(sftp);
      });
    });
    this._pending = pending;
    pending.catch(() => { if (this._pending === pending) this._pending = null; });
    return pending;
  }

  /** Close the cached channel (session disconnect / drop). */
  close() {
    const pending = this._pending;
    this._pending = null;
    pending?.then((sftp) => { try { sftp.end(); } catch { /* ignore */ } }, () => {});
  }

  /**
   * Upload a local file (policy: must exist under an allowed root, not denied).
   * @param {string} localPath
   * @param {string} remotePath - file path, or directory ending with `/`
   * @returns {Promise<{localPath, remotePath, bytes, ms}>}
   */
  async upload(localPath, remotePath) {
    const real = this._checkLocalPath(localPath, { mustExist: true });
    const st = await stat(real);
    if (!st.isFile()) throw new Error(`local path "${localPath}" is not a file`);
    const finalRemote = remotePath.endsWith('/') ? remotePath + basename(real) : remotePath;
    const t0 = Date.now();
    const sftp = await this.getSftp();
    await sftpCall(sftp, 'fastPut', real, finalRemote, TRANSFER_OPTS);
    return { localPath: real, remotePath: finalRemote, bytes: st.size, ms: Date.now() - t0 };
  }

  /**
   * Download a remote file via `<local>.part-<rand>` + rename (no half files).
   * @param {string} remotePath
   * @param {string} localPath - file path, or directory ending with / or \
   * @returns {Promise<{remotePath, localPath, bytes, ms}>}
   */
  async download(remotePath, localPath) {
    let target = localPath;
    if (/[\\/]$/.test(target)) target = join(target, posix.basename(remotePath));
    const real = this._checkLocalPath(target, { forWrite: true });
    const t0 = Date.now();
    const sftp = await this.getSftp();
    const rst = await sftpCall(sftp, 'stat', remotePath);
    if (!rst.isFile()) throw new Error(`remote path ${remotePath} is not a regular file`);
    const part = `${real}.part-${randomBytes(4).toString('hex')}`;
    try {
      await sftpCall(sftp, 'fastGet', remotePath, part, TRANSFER_OPTS);
      await rename(part, real);
    } catch (err) {
      await unlink(part).catch(() => {});
      throw err;
    }
    return { remotePath, localPath: real, bytes: rst.size, ms: Date.now() - t0 };
  }

  /**
   * Atomic remote write (see sftp-atomic-remote-write.js).
   * @param {string} remotePath @param {string} content @param {object} [opts] - { mode }
   */
  async writeRemoteFile(remotePath, content, opts = {}) {
    return atomicWriteRemoteFile(await this.getSftp(), remotePath, content, opts);
  }

  /**
   * Read a remote text file, bounded by limits.maxReadFileBytes.
   * @param {string} remotePath
   * @returns {Promise<{remotePath, bytes, content}>}
   */
  async readRemoteFile(remotePath) {
    const max = this._getLimits().maxReadFileBytes;
    const sftp = await this.getSftp();
    const st = await sftpCall(sftp, 'stat', remotePath);
    if (st.isDirectory()) throw new Error(`${remotePath} is a directory`);
    const tooBig = (n) => new Error(`${remotePath} is ${n} bytes, above the ${max}-byte read limit; use ssh_exec with head/tail/sed -n to read part of it`);
    if (st.size > max) throw tooBig(st.size);
    const buf = await readBounded(sftp, remotePath, max, tooBig);
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      throw new Error(`${remotePath} is a binary file; use ssh_download`);
    }
    return { remotePath, bytes: buf.length, content: buf.toString('utf8') };
  }
}

/** Read a remote file into Buffer chunks, failing if it grows past `max` while reading. */
function readBounded(sftp, remotePath, max, tooBig) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const rs = sftp.createReadStream(remotePath);
    rs.on('data', (chunk) => {
      total += chunk.length;
      if (total > max) { rs.destroy(); reject(tooBig(`over ${max}`)); return; }
      chunks.push(chunk);
    });
    rs.on('error', reject);
    rs.on('end', () => resolve(Buffer.concat(chunks, total)));
  });
}
