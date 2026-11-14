/**
 * Live smoke cases for shell streams (phase 03), used by scripts/smoke-test.js.
 * Read-only commands only. Checks marker-prompt completion latency, stateful
 * cwd, verbatim data, history untouched (sha256 before/after), no output
 * mixing between concurrent streams, and the D12 channel budget (incl. the
 * cached SFTP channel).
 */
const HISTORY_HASH = 'sha256sum ~/.bash_history 2>/dev/null || echo none';

/** Write and time one command on a stream. */
async function timedWrite(stream, data, opts) {
  const t0 = Date.now();
  const r = await stream.write(data, opts);
  return { ...r, ms: Date.now() - t0, out: r.output.replace(/\s+$/, '') };
}

/**
 * @param {object} pool - Session pool
 * @param {object} session - Connected session for the alias
 * @param {Function} check - (name, pass, detail) reporter
 */
export async function runStreamChecks(pool, session, check) {
  const alias = session.alias;
  const histBefore = (await session.exec.exec(HISTORY_HASH)).stdout.trim();

  let t0 = Date.now();
  const { stream: a } = await pool.openStream(alias, 'smoke-a');
  check('stream open + init (marker mode)', a.markerMode === true, `${Date.now() - t0} ms, warning ${a.initWarning || 'none'}`);

  const base = await timedWrite(a, 'true\n');
  check('stream `true` -> prompt', base.state === 'prompt' && base.out === '', `${base.ms} ms (baseline RTT)`);

  const cd = await timedWrite(a, 'cd /tmp && pwd\n');
  check('stream cd /tmp && pwd', cd.state === 'prompt' && cd.out === '/tmp', `${cd.ms} ms: ${JSON.stringify(cd.out)}`);

  const pwd = await timedWrite(a, 'pwd\n');
  check('stream stateful cwd', pwd.out === '/tmp', `${pwd.ms} ms`);

  const loop = await timedWrite(a, 'for i in 1 2 3; do echo $i; sleep 0.3; done\n');
  check('stream loop 3 x 0.3 s', loop.state === 'prompt' && loop.out === '1\n2\n3' && loop.ms < 900 + base.ms + 300,
    `${loop.ms} ms (limit ${900 + base.ms + 300}): ${JSON.stringify(loop.out)}`);

  const pf = await timedWrite(a, "printf 'a\\nb\\n'\n");
  check("stream printf 'a\\nb\\n' verbatim", pf.out === 'a\nb', JSON.stringify(pf.out));

  const hist = await timedWrite(a, 'echo "[$HISTFILE]"; set -o | grep -E "^history"\n');
  check('stream history disabled', /^\[\]\nhistory\s+off$/.test(hist.out), JSON.stringify(hist.out));

  const slow = await timedWrite(a, 'sleep 3\n', { waitMs: 500 });
  const after = await a.read({ waitMs: 4000 });
  check('stream timeout state then read', slow.state === 'timeout' && after.state === 'prompt', `${slow.ms} ms, read state ${after.state} ${JSON.stringify(after.output)}`);

  const { stream: b } = await pool.openStream(alias, 'smoke-b');
  const cmd = (p) => `for i in 1 2 3; do echo ${p}$i; sleep 0.1; done\n`;
  const [ra, rb] = await Promise.all([timedWrite(a, cmd('A')), timedWrite(b, cmd('B'))]);
  check('two concurrent streams do not mix', ra.out === 'A1\nA2\nA3' && rb.out === 'B1\nB2\nB3', `${ra.ms}/${rb.ms} ms ${JSON.stringify([ra.out, rb.out])}`);

  await pool.closeStream('smoke-a');
  await pool.closeStream('smoke-b');
  check('streams stopped', session.streams.size === 0);

  const histAfter = (await session.exec.exec(HISTORY_HASH)).stdout.trim();
  check('~/.bash_history sha256 unchanged', histBefore === histAfter, histBefore.slice(0, 16));

  await channelBudget(pool, session, check);
}

/** D12: 4 streams + cached SFTP op + 3 parallel execs succeed; a 5th stream gets the cap error. */
async function channelBudget(pool, session, check) {
  const ids = ['budget-1', 'budget-2', 'budget-3', 'budget-4'];
  try {
    for (const id of ids) await pool.openStream(session.alias, id);
    const t0 = Date.now();
    const [file, ...execs] = await Promise.all([
      session.sftp.readRemoteFile('/etc/hostname'),
      ...[1, 2, 3].map(() => session.exec.exec('sleep 1; echo ok')),
    ]);
    check('4 streams + SFTP op + 3 parallel execs',
      execs.every((r) => r.exitCode === 0 && r.stdout.trim() === 'ok') && file.bytes > 0,
      `${Date.now() - t0} ms, sftp channels opened ${session.sftp.opens}`);
    let err = null;
    try { await pool.openStream(session.alias, 'budget-5'); } catch (e) { err = e; }
    check('5th stream -> cap error', /^max 4 streams for /.test(err?.message || ''), err?.message || 'no error');
  } finally {
    for (const id of ids) await pool.closeStream(id).catch(() => {});
  }
}
