#!/usr/bin/env node
/**
 * Live smoke test (read-only) against one configured alias.
 * Usage: npm run smoke -- <alias>
 * Connects through the session pool, runs read-only commands, prints results
 * + timings, disconnects. Exit code 0 only when every check passes.
 */
import { createSessionPool } from '../src/ssh/session-pool.js';
import { getKnownHostsPath } from '../src/config/known-hosts-fingerprint-store.js';
import { readFileSync } from 'fs';

const alias = process.argv[2];
if (!alias) {
  console.error('usage: npm run smoke -- <alias>');
  process.exit(2);
}

const pool = createSessionPool();
let failures = 0;

/** Print one check line and count failures. */
function check(name, pass, detail = '') {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Run a command and time it. */
async function timed(session, command, opts) {
  const t0 = Date.now();
  const r = await session.exec.exec(command, opts);
  return { ...r, ms: Date.now() - t0 };
}

try {
  let t0 = Date.now();
  const session = await pool.getSession(alias);
  const fp = session.connection.fingerprintInfo;
  check('connect', true, `${Date.now() - t0} ms, fingerprint ${fp?.fingerprint} (${fp?.isNew ? 'new, pinned' : fp?.source})`);

  const uname = await timed(session, 'uname -a');
  check('uname -a', uname.exitCode === 0 && /Linux/.test(uname.stdout), `${uname.ms} ms: ${uname.stdout.trim()}`);

  const utf = await timed(session, 'echo ệ');
  check('echo ệ', utf.stdout.trim() === 'ệ', `${utf.ms} ms: ${JSON.stringify(utf.stdout.trim())}`);

  const big = await timed(session, "head -c 300000 /dev/zero | tr '\\0' a");
  const marker = big.stdout.match(/\[\.\.\. truncated (\d+) bytes \.\.\.\]/);
  check('300 KB output capped', Boolean(marker) && Buffer.byteLength(big.stdout) < 110000,
    `${big.ms} ms, returned ${Buffer.byteLength(big.stdout)} bytes, marker ${marker ? marker[0] : 'missing'}`);

  const slow = await timed(session, 'sleep 5', { timeout: 1000 });
  check('timeout 1000 ms', slow.timedOut && slow.exitCode === null && slow.ms < 2000, `${slow.ms} ms`);

  const ex3 = await timed(session, 'exit 3');
  check('exit 3', ex3.exitCode === 3, `${ex3.ms} ms, exitCode ${ex3.exitCode}`);

  const err = await timed(session, 'echo out; echo err >&2');
  check('stderr separate', err.stdout.trim() === 'out' && err.stderr.trim() === 'err', `${err.ms} ms`);

  t0 = Date.now();
  const par = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => session.exec.exec(`sleep 0.3; echo p${i}`)));
  check('6 parallel execs (limit 4, queued)', par.every((r, i) => r.stdout.trim() === `p${i + 1}`), `${Date.now() - t0} ms`);

  const again = await pool.getSession(alias);
  check('session reused', again === session);

  const known = JSON.parse(readFileSync(getKnownHostsPath(), 'utf8'));
  const key = `${session.server.host}:${session.server.port || 22}`;
  check('known-hosts.json has entry', Boolean(known[key]?.fingerprint) || session.server.fingerprint !== undefined);
} catch (err) {
  check('smoke run', false, err.message);
} finally {
  pool.disconnect();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
