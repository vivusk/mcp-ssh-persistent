/**
 * Live smoke cases for SFTP (phase 05), used by scripts/smoke-test.js.
 * Remote writes only under /tmp/mcp-ssh-smoke-<rand>/ (removed afterwards);
 * local files only under os.tmpdir(). Checks fastPut vs sequential pipe timing,
 * sha256 round trip, atomic rewrite keeping mode 600, no tmp leftovers,
 * bounded read, local path policy rejections and the cached SFTP channel.
 */
import { createHash, randomBytes } from 'crypto';
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, getLimits } from '../src/config/load-config-and-server-aliases.js';

const SIZE = 5 * 1024 * 1024;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Old-style sequential upload (createWriteStream pipe), for the timing comparison. */
async function pipeUpload(sftp, local, remote) {
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(remote);
    ws.on('close', resolve);
    ws.on('error', reject);
    createReadStream(local).on('error', reject).pipe(ws);
  });
  return Date.now() - t0;
}

/** Run fn and return the error message it throws ('' when it does not throw). */
async function errorOf(fn) {
  try { await fn(); return ''; } catch (err) { return err.message; }
}

/**
 * @param {object} session - Connected session
 * @param {Function} check - (name, pass, detail) reporter
 */
export async function runSftpChecks(session, check) {
  const remoteDir = `/tmp/mcp-ssh-smoke-${randomBytes(6).toString('hex')}`;
  const localDir = mkdtempSync(join(tmpdir(), 'mcp-ssh-smoke-'));
  const sh = (cmd) => session.exec.exec(cmd);
  try {
    const roots = loadConfig().localPathRoots;
    check('config.json localPathRoots has D:/Haizzz', roots.includes('D:/Haizzz'), JSON.stringify(roots));
    check('mkdir remote smoke dir', (await sh(`mkdir -m 700 ${remoteDir}`)).exitCode === 0, remoteDir);

    const local = join(localDir, 'big.bin');
    const payload = randomBytes(SIZE);
    writeFileSync(local, payload);
    const up = await session.sftp.upload(local, `${remoteDir}/`);
    const pipeMs = await pipeUpload(await session.sftp.getSftp(), local, `${remoteDir}/big-pipe.bin`);
    check('5 MB upload: fastPut <= sequential pipe', up.ms <= pipeMs && up.bytes === SIZE,
      `fastPut ${up.ms} ms, pipe ${pipeMs} ms, remote ${up.remotePath}`);

    const remoteSum = (await sh(`sha256sum ${remoteDir}/big.bin`)).stdout.split(/\s/)[0];
    const down = await session.sftp.download(`${remoteDir}/big.bin`, join(localDir, 'back.bin'));
    const back = readFileSync(join(localDir, 'back.bin'));
    check('download + sha256 round trip', sha256(back) === sha256(payload) && remoteSum === sha256(payload),
      `fastGet ${down.ms} ms, sha256 ${sha256(back).slice(0, 16)}`);

    const conf = `${remoteDir}/app.conf`;
    const w1 = await session.sftp.writeRemoteFile(conf, 'v=1\n');
    await sh(`chmod 600 ${conf}`);
    const w2 = await session.sftp.writeRemoteFile(conf, 'v="2" \\ ệ\n');
    const mode = (await sh(`stat -c %a ${conf}`)).stdout.trim();
    check('atomic rewrite keeps mode 600', mode === '600' && w2.mode === '0600' && !w2.warning, `first ${w1.mode}, after rewrite ${mode}`);
    const read = await session.sftp.readRemoteFile(conf);
    check('read back exact content', read.content === 'v="2" \\ ệ\n' && read.bytes === 12, JSON.stringify(read.content));
    const leftovers = (await sh(`ls -A ${remoteDir} | grep -c mcp-tmp || true`)).stdout.trim();
    check('no .mcp-tmp- leftovers', leftovers === '0', `count ${leftovers}`);

    await sh(`ln -s app.conf ${remoteDir}/link.conf`);
    const wl = await session.sftp.writeRemoteFile(`${remoteDir}/link.conf`, 'v=3\n');
    const viaLink = (await sh(`test -L ${remoteDir}/link.conf && cat ${remoteDir}/app.conf`)).stdout;
    check('write via symlink keeps link, updates target', viaLink === 'v=3\n' && wl.target === conf, `target ${wl.target}`);

    await sh(`cd ${remoteDir} && mkdir -p rel/5 shared && echo old > shared/.env && ln -s rel/5 current && ln -s ../../shared/.env rel/5/.env`);
    const wp = await session.sftp.writeRemoteFile(`${remoteDir}/current/.env`, 'new\n');
    const env = (await sh(`test -L ${remoteDir}/rel/5/.env && cat ${remoteDir}/shared/.env`)).stdout.trim();
    check('write via ../ link under symlinked dir hits real target', env === 'new' && wp.target === `${remoteDir}/shared/.env`, `target ${wp.target}`);

    const limit = getLimits().maxReadFileBytes;
    await sh(`head -c ${limit + 1} /dev/zero | tr '\\0' a > ${remoteDir}/too-big.txt`);
    const bigErr = await errorOf(() => session.sftp.readRemoteFile(`${remoteDir}/too-big.txt`));
    check('read > limit -> error suggesting ssh_exec', /read limit; use ssh_exec/.test(bigErr), bigErr);

    const keyErr = await errorOf(() => session.sftp.upload(session.server.privateKeyPath, `${remoteDir}/`));
    check('upload of a file under the key dir rejected', /denied \(privateKeyPath dir\)/.test(keyErr), keyErr.replace(/".*?"/, '"<key>"'));
    const agentErr = await errorOf(() => session.sftp.download(conf, join(process.cwd(), '.claude', 'settings.json')));
    check('download onto <cwd>/.claude/settings.json rejected', /is denied/.test(agentErr), agentErr.split(';')[0]);

    check('one cached SFTP channel for all ops', session.sftp.opens === 1, `opens ${session.sftp.opens}`);
  } finally {
    if (/^\/tmp\/mcp-ssh-smoke-[0-9a-f]{12}$/.test(remoteDir)) await sh(`rm -rf ${remoteDir}`).catch(() => {});
    rmSync(localDir, { recursive: true, force: true });
  }
  const gone = await sh(`test -e ${remoteDir} && echo left || echo gone`);
  check('remote smoke dir cleaned up', gone.stdout.trim() === 'gone');
}
