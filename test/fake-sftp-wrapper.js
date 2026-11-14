/**
 * In-memory stand-in for an ssh2 SFTPWrapper (test helper, not a test file).
 * Supports the methods used by src/ssh/sftp*.js with ssh2-style callbacks and
 * SFTP status codes (2 = no such file, 3 = permission denied).
 */
import { EventEmitter } from 'events';
import { readFileSync, writeFileSync } from 'fs';
import { Readable } from 'stream';

const sftpErr = (code, msg) => Object.assign(new Error(msg), { code });

/** Minimal ssh2 Stats-like object. */
const statsOf = (f) => ({
  size: f.data.length, mode: 0o100000 | f.mode, uid: f.uid, gid: f.gid,
  isFile: () => true, isDirectory: () => false,
});

/**
 * @param {object} [o] - { posixRename = true, dirWritable = true, files: {path: string}, links: {path: target} }
 */
export function createFakeSftp(o = {}) {
  const files = new Map(Object.entries(o.files || {}).map(([p, d]) => [p, { data: Buffer.from(d), mode: 0o644, uid: 1000, gid: 1000 }]));
  const links = new Map(Object.entries(o.links || {}));
  const sftp = new EventEmitter();
  const later = (cb, ...args) => setImmediate(() => cb(...args));
  /** Kernel-like resolution of every symlinked component (null on a loop). */
  const realpathOf = (p) => {
    let parts = p.split('/').filter(Boolean);
    for (let i = 0, hops = 0; i < parts.length; i++) {
      if (parts[i] === '.') { parts.splice(i--, 1); continue; }
      if (parts[i] === '..') { parts.splice(Math.max(i - 1, 0), i ? 2 : 1); i = Math.max(i - 2, -1); continue; }
      const prefix = '/' + parts.slice(0, i + 1).join('/');
      if (links.has(prefix)) {
        if (++hops > 32) return null;
        const t = links.get(prefix);
        parts = [...(t.startsWith('/') ? [] : parts.slice(0, i)), ...t.split('/').filter(Boolean), ...parts.slice(i + 1)];
        i = -1;
      }
    }
    return '/' + parts.join('/');
  };
  /** Path with its parent dirs resolved but the last component kept (lstat semantics). */
  const parentResolved = (p) => {
    const i = p.lastIndexOf('/');
    if (i < 0) return p;
    const dir = realpathOf(p.slice(0, i) || '/');
    return `${dir === '/' ? '' : dir}/${p.slice(i + 1)}`;
  };
  Object.assign(sftp, {
    files,
    links,
    calls: [],
    lstat(p0, cb) {
      sftp.calls.push(['lstat', p0]);
      const p = parentResolved(p0);
      if (links.has(p)) return later(cb, null, { size: 0, mode: 0o120777, isFile: () => false, isDirectory: () => false });
      return sftp.stat(p, cb);
    },
    realpath(p, cb) {
      sftp.calls.push(['realpath', p]);
      const r = realpathOf(p);
      return r ? later(cb, null, r) : later(cb, sftpErr(4, 'Failure'));
    },
    readlink(p0, cb) {
      sftp.calls.push(['readlink', p0]);
      const p = parentResolved(p0);
      return links.has(p) ? later(cb, null, links.get(p)) : later(cb, sftpErr(4, 'Failure'));
    },
    stat(p, cb) {
      sftp.calls.push(['stat', p]);
      if (p === '/dir') return later(cb, null, { size: 0, mode: 0o40755, isFile: () => false, isDirectory: () => true });
      const f = files.get(p);
      return f ? later(cb, null, statsOf(f)) : later(cb, sftpErr(2, 'No such file'));
    },
    writeFile(p, data, opts, cb) {
      sftp.calls.push(['writeFile', p, opts.flag]);
      const isNew = !files.has(p);
      if (opts.flag === 'wx' && !isNew) return later(cb, sftpErr(4, 'Failure'));
      if (isNew && o.dirWritable === false) return later(cb, sftpErr(3, 'Permission denied'));
      const prev = files.get(p);
      files.set(p, { data: Buffer.from(data), mode: prev ? prev.mode : (opts.mode ?? 0o666) & ~0o022, uid: 0, gid: 0 });
      return later(cb, null);
    },
    chmod(p, mode, cb) { files.get(p).mode = mode; later(cb, null); },
    setstat(p, attrs, cb) { Object.assign(files.get(p), attrs); later(cb, null); },
    ext_openssh_rename(src, dst, cb) {
      if (o.posixRename === false) throw new Error('Server does not support this extended request');
      sftp.calls.push(['posix-rename', src, dst]);
      files.set(dst, files.get(src));
      files.delete(src);
      later(cb, null);
    },
    rename(src, dst, cb) {
      sftp.calls.push(['rename', src, dst]);
      if (files.has(dst)) return later(cb, sftpErr(4, 'Failure'));
      files.set(dst, files.get(src));
      files.delete(src);
      return later(cb, null);
    },
    unlink(p, cb) {
      sftp.calls.push(['unlink', p]);
      return files.delete(p) ? later(cb, null) : later(cb, sftpErr(2, 'No such file'));
    },
    createReadStream(p) { return Readable.from([files.get(p).data]); },
    fastPut(local, remote, opts, cb) {
      sftp.calls.push(['fastPut', local, remote, opts]);
      files.set(remote, { data: readFileSync(local), mode: 0o644, uid: 0, gid: 0 });
      later(cb, null);
    },
    fastGet(remote, local, opts, cb) {
      sftp.calls.push(['fastGet', remote, local, opts]);
      writeFileSync(local, files.get(remote).data);
      later(cb, null);
    },
    end() { sftp.emit('close'); },
  });
  return sftp;
}

/** Fake ssh2 client whose sftp() hands out `sftp` and counts opens. */
export function fakeSftpClient(sftp) {
  const client = { opened: 0, sftp(cb) { client.opened += 1; setImmediate(() => cb(null, sftp)); } };
  return client;
}
