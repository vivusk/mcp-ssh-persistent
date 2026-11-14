import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createSessionPool } from '../src/ssh/session-pool.js';

const SERVERS = {
  s: { alias: 'S', host: '192.0.2.10', username: 'root' },
  rr: { alias: 'RR', host: '192.0.2.11', username: 'deploy' },
};
const resolveServer = (alias) => {
  const s = SERVERS[String(alias).toLowerCase()];
  if (!s) throw new Error(`unknown server alias "${alias}"; known aliases: S, RR`);
  return { ...s };
};
const limits = { maxConcurrentExec: 4, maxOutputBytes: 102400, maxStreams: 4 };

/** Fake exec channel: emits stdout, exit + close after `delay` ms. */
function fakeChannel(out, code, delay) {
  const ch = new EventEmitter();
  ch.stderr = new EventEmitter();
  ch.signal = () => {};
  ch.close = () => setImmediate(() => ch.emit('close'));
  setTimeout(() => {
    ch.emit('data', Buffer.from(out));
    ch.emit('exit', code);
    ch.emit('close');
  }, delay);
  return ch;
}

/** Fake connection factory recording connects; client.exec behaviour injectable. */
function makeFactory(execImpl) {
  const created = [];
  const factory = (server) => {
    const conn = {
      server, connected: false, closeCbs: [], fingerprintInfo: { fingerprint: 'SHA256:fake' },
      client: { exec: (cmd, opts, cb) => execImpl(cmd, opts, cb), shell: () => {} },
      async connect() { await new Promise((r) => setTimeout(r, 20)); this.connected = true; },
      onClose(cb) { this.closeCbs.push(cb); },
      isConnected() { return this.connected; },
      getClient() { return this.client; },
      disconnect() { this.connected = false; this.closeCbs.forEach((cb) => cb()); },
      drop() { this.connected = false; this.closeCbs.forEach((cb) => cb()); },
    };
    created.push(conn);
    return conn;
  };
  return { factory, created };
}

const echoExec = (cmd, opts, cb) => cb(null, fakeChannel(`out:${cmd}`, 0, 5));

test('concurrent getSession for one alias -> one connect, shared session', async () => {
  const { factory, created } = makeFactory(echoExec);
  const pool = createSessionPool({ resolveServer, getLimits: () => limits, createConnection: factory });
  const [a, b, c] = await Promise.all([pool.getSession('S'), pool.getSession('s'), pool.getSession('S')]);
  assert.equal(created.length, 1);
  assert.ok(a === b && b === c);
  assert.equal(a.alias, 'S');
});

test('different aliases never share a connection', async () => {
  const { factory, created } = makeFactory(echoExec);
  const pool = createSessionPool({ resolveServer, getLimits: () => limits, createConnection: factory });
  const s = await pool.getSession('S');
  const rr = await pool.getSession('RR');
  assert.equal(created.length, 2);
  assert.notEqual(s.connection, rr.connection);
  assert.equal(rr.connection.server.host, '192.0.2.11');
});

test('dropped connection reconnects on next call', async () => {
  const { factory, created } = makeFactory(echoExec);
  const pool = createSessionPool({ resolveServer, getLimits: () => limits, createConnection: factory });
  const first = await pool.getSession('S');
  created[0].drop();
  assert.equal(pool.status().length, 0);
  const second = await pool.getSession('S');
  assert.equal(created.length, 2);
  assert.notEqual(first, second);
  assert.equal(second.connection.isConnected(), true);
});

test('unknown alias -> error listing aliases', async () => {
  const pool = createSessionPool({ resolveServer, getLimits: () => limits, createConnection: makeFactory(echoExec).factory });
  await assert.rejects(pool.getSession('nope'), /known aliases: S, RR/);
});

test('exec limiter: 6 concurrent execs, limit 4 -> max 4 in flight, all complete', async () => {
  let inFlight = 0;
  let maxSeen = 0;
  const execImpl = (cmd, opts, cb) => {
    inFlight++;
    maxSeen = Math.max(maxSeen, inFlight);
    const ch = fakeChannel(`out:${cmd}`, 0, 40);
    ch.on('close', () => { inFlight--; });
    cb(null, ch);
  };
  const { factory } = makeFactory(execImpl);
  const pool = createSessionPool({ resolveServer, getLimits: () => limits, createConnection: factory });
  const session = await pool.getSession('S');
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => session.exec.exec(`c${i}`, { timeout: 2000 })));
  assert.equal(maxSeen, 4);
  assert.deepEqual(results.map((r) => r.stdout), ['out:c1', 'out:c2', 'out:c3', 'out:c4', 'out:c5', 'out:c6']);
  assert.ok(results.every((r) => r.exitCode === 0 && !r.timedOut));
  assert.equal(session.exec.inFlight, 0);
});

test('channel open failure -> MaxSessions error text; slot released', async () => {
  const execImpl = (cmd, opts, cb) => cb(new Error('(SSH) Channel open failure: open failed'));
  const { factory } = makeFactory(execImpl);
  const pool = createSessionPool({ resolveServer, getLimits: () => limits, createConnection: factory });
  const session = await pool.getSession('S');
  await assert.rejects(session.exec.exec('ls'),
    { message: 'server MaxSessions reached for S; stop a stream (ssh_stream_stop) or retry' });
  assert.equal(session.exec.inFlight, 0);
  await assert.rejects(pool.withSession('S', async () => { throw new Error('(SSH) Channel open failure: x'); }),
    /server MaxSessions reached for S/);
});

test('exec timeout -> timedOut, exitCode null, stderr separate', async () => {
  const execImpl = (cmd, opts, cb) => {
    const ch = new EventEmitter();
    ch.stderr = new EventEmitter();
    let killed = false;
    ch.signal = (s) => { killed = s; };
    ch.close = () => setImmediate(() => ch.emit('close'));
    setTimeout(() => ch.stderr.emit('data', Buffer.from('warn')), 5);
    cb(null, ch);
    ch.killed = () => killed;
  };
  const { factory } = makeFactory(execImpl);
  const pool = createSessionPool({ resolveServer, getLimits: () => limits, createConnection: factory });
  const session = await pool.getSession('S');
  const t0 = Date.now();
  const r = await session.exec.exec('sleep 5', { timeout: 100 });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual([r.timedOut, r.exitCode, r.stderr], [true, null, 'warn']);
});

test('status and disconnect', async () => {
  const { factory } = makeFactory(echoExec);
  const pool = createSessionPool({ resolveServer, getLimits: () => limits, createConnection: factory });
  await pool.getSession('S');
  await pool.getSession('RR');
  pool.registerStream('tail1', 'S');
  const st = pool.status();
  assert.deepEqual(st.map((x) => [x.alias, x.connected, x.fingerprint]), [['S', true, 'SHA256:fake'], ['RR', true, 'SHA256:fake']]);
  assert.deepEqual(st[0].streams, ['tail1']);
  assert.equal((await pool.getStreamSession('tail1')).alias, 'S');
  assert.deepEqual(pool.disconnect('s'), ['S']);
  await assert.rejects(pool.getStreamSession('tail1'), /unknown stream_id/);
  assert.deepEqual(pool.disconnect(), ['RR']);
  assert.equal(pool.status().length, 0);
});
