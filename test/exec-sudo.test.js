import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { SSHExec } from '../src/ssh/exec.js';
import { redact } from '../src/security/secret-redaction.js';
import { buildSudoCommand } from '../src/ssh/exec-sudo-prompt-gate.js';

const PW = 'fake-sudo-pw-for-tests';
const tick = () => new Promise((r) => setImmediate(r));

/** Fake ssh2 client whose exec() yields a scripted channel (EventEmitter + stdin + stderr). */
function fakeClient() {
  const state = { command: null, ch: null, opened: 0 };
  const client = {
    exec(command, opts, cb) {
      state.opened += 1;
      state.command = command;
      const ch = new EventEmitter();
      ch.stderr = new EventEmitter();
      ch.stdin = { writes: [], endCalls: 0, write(d) { this.writes.push(d); }, end() { this.endCalls += 1; } };
      ch.signal = () => {};
      ch.close = () => { if (!ch.closed) { ch.closed = true; setImmediate(() => ch.emit('close')); } };
      state.ch = ch;
      setImmediate(() => cb(null, ch));
    },
  };
  return { client, state };
}

/** Marker from the sudo command line: -p '<marker>'. */
const markerOf = (cmd) => /-p '(__MCP_SUDO_[0-9a-f]{24}__)'/.exec(cmd)[1];
/** Sentinel the root-side wrapper prints before user code. */
const sentinelOf = (cmd) => /(__MCP_SUDO_GO_[0-9a-f]{24}__)/.exec(cmd)[1];
const exitWith = (ch, code = 0) => { ch.emit('exit', code); ch.emit('close'); };

function setup(username = 'deploy') {
  const { client, state } = fakeClient();
  const exec = new SSHExec(() => client, { alias: 'RR' });
  let fetched = 0;
  const sudo = { username, getPassword: async () => { fetched += 1; return PW; } };
  return { exec, state, sudo, fetched: () => fetched };
}

/** Start an exec, wait until the fake channel is open; returns { p } (not awaited). */
async function start(t, opts = {}) {
  const p = t.exec.exec(opts.command ?? 'id -u', { sudo: t.sudo, timeout: 10000, ...opts });
  while (!t.state.ch) await tick();
  await tick();
  return { p };
}

test('(a) marker split over 2 chunks -> password once, then end(); marker not in stderr', async () => {
  const t = setup();
  const { p } = await start(t);
  const { ch } = t.state;
  const marker = markerOf(t.state.command);
  ch.stderr.emit('data', Buffer.from(marker.slice(0, 10)));
  assert.equal(ch.stdin.writes.length, 0);
  ch.stderr.emit('data', Buffer.from(marker.slice(10)));
  assert.deepEqual(ch.stdin.writes, [`${PW}\n`]);
  assert.equal(ch.stdin.endCalls, 1);
  ch.emit('data', Buffer.from('0\n'));
  exitWith(ch);
  const r = await p;
  assert.equal(r.stdout, '0\n');
  assert.equal(r.stderr, '');
  assert.equal(t.fetched(), 1);
});

test('(b) stdout before any marker -> nothing written, end() called', async () => {
  const t = setup();
  const { p } = await start(t);
  await tick();
  const { ch } = t.state;
  ch.emit('data', Buffer.from('0\n'));
  assert.equal(ch.stdin.writes.length, 0);
  assert.equal(ch.stdin.endCalls, 1);
  ch.stderr.emit('data', Buffer.from(markerOf(t.state.command)));
  assert.equal(ch.stdin.writes.length, 0, 'marker after stdin ended is ignored');
  exitWith(ch);
  assert.equal((await p).stdout, '0\n');
});

test('(c) exit without marker -> nothing written', async () => {
  const t = setup();
  const { p } = await start(t);
  await tick();
  exitWith(t.state.ch, 1);
  const r = await p;
  assert.equal(r.exitCode, 1);
  assert.equal(t.state.ch.stdin.writes.length, 0);
});

test('(d) second marker -> auth failed error, password written once, channel killed', async () => {
  const t = setup();
  const { p } = await start(t);
  await tick();
  const { ch } = t.state;
  const marker = markerOf(t.state.command);
  ch.stderr.emit('data', Buffer.from(marker));
  ch.stderr.emit('data', Buffer.from(`Sorry, try again.\n${marker}`));
  assert.deepEqual(ch.stdin.writes, [`${PW}\n`]);
  assert.equal(ch.closed, true, 'channel killed');
  await assert.rejects(p, /sudo authentication failed on RR/);
});

test('(e) root user / pty:true -> error before channel opens, password not fetched', async () => {
  const root = setup('root');
  await assert.rejects(root.exec.exec('id -u', { sudo: root.sudo }), /already root on RR; run without sudo:true/);
  const pty = setup();
  await assert.rejects(pty.exec.exec('id -u', { sudo: pty.sudo, pty: true }), /cannot be combined with pty:true/);
  for (const t of [root, pty]) {
    assert.equal(t.fetched(), 0);
    assert.equal(t.state.opened, 0);
  }
});

test('(f) non-marker stderr warning, then marker -> written once; warning kept', async () => {
  const t = setup();
  const { p } = await start(t);
  await tick();
  const { ch } = t.state;
  const warn = 'sudo: unable to resolve host x: Name or service not known\n';
  ch.stderr.emit('data', Buffer.from(warn));
  assert.equal(ch.stdin.endCalls, 0, 'stdin not ended on non-marker stderr');
  ch.stderr.emit('data', Buffer.from(markerOf(t.state.command)));
  assert.deepEqual(ch.stdin.writes, [`${PW}\n`]);
  assert.equal(ch.stdin.endCalls, 1);
  exitWith(ch);
  assert.equal((await p).stderr, warn);
});

test('(g) spoofed static / other markers -> nothing written', async () => {
  const t = setup();
  const { p } = await start(t);
  await tick();
  const { ch } = t.state;
  ch.stderr.emit('data', Buffer.from('__MCP_SUDO_PROMPT__'));
  ch.stderr.emit('data', Buffer.from(`__MCP_SUDO_${'ab'.repeat(12)}__`));
  exitWith(ch);
  await p;
  assert.equal(ch.stdin.writes.length, 0);
});

test('(h) nothing for 3 s -> end() without write', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['setTimeout'] });
  const t = setup();
  const { p } = await start(t);
  await tick();
  const { ch } = t.state;
  ctx.mock.timers.tick(2999);
  assert.equal(ch.stdin.endCalls, 0);
  ctx.mock.timers.tick(1);
  assert.equal(ch.stdin.endCalls, 1);
  assert.equal(ch.stdin.writes.length, 0);
  exitWith(ch);
  await p;
});

test('(i) tokens never in output; redacted during the call, forgotten after; command shape', async () => {
  const t = setup();
  const { p } = await start(t, { command: "echo 'hi' && id -u" });
  await tick();
  const { ch } = t.state;
  const marker = markerOf(t.state.command);
  const sentinel = sentinelOf(t.state.command);
  assert.equal(t.state.command, buildSudoCommand("echo 'hi' && id -u", { marker, sentinel }));
  assert.match(t.state.command, /^sudo -S -k -p '__MCP_SUDO_[0-9a-f]{24}__' -- bash -c 'printf %s /);
  assert.ok(t.state.command.includes('exec bash -c'));
  assert.equal(redact(`log ${marker} ${sentinel}`), 'log *** ***', 'tokens registered while running');
  ch.stderr.emit('data', Buffer.from(marker));
  ch.stderr.emit('data', Buffer.from(sentinel));
  ch.emit('data', Buffer.from(`out ${marker} ${sentinel}\n`));
  exitWith(ch);
  const r = await p;
  assert.equal(r.stdout, 'out  \n');
  assert.equal(r.stderr, '');
  assert.equal(redact(marker), marker, 'marker unregistered after finalize (bounded registry)');
  assert.equal(redact(sentinel), sentinel);
});

test('(j) NOPASSWD: sentinel before marker -> stdin ended, nothing written; marker read from argv by user code ignored', async () => {
  const t = setup();
  const { p } = await start(t);
  await tick();
  const { ch } = t.state;
  const marker = markerOf(t.state.command);
  const sentinel = sentinelOf(t.state.command);
  ch.stderr.emit('data', Buffer.from(sentinel.slice(0, 8)));
  ch.stderr.emit('data', Buffer.from(`${sentinel.slice(8)}${marker}`)); // spoof in same chunk
  ch.stderr.emit('data', Buffer.from(`${marker}\n${marker}`)); // spoof again (no kill, no write)
  assert.equal(ch.stdin.writes.length, 0);
  assert.equal(ch.stdin.endCalls, 1);
  assert.equal(ch.closed, undefined, 'not killed');
  exitWith(ch);
  const r = await p;
  assert.equal(r.stderr, '\n');
  assert.equal(ch.stdin.writes.length, 0);
});

test('(k) command stderr "incorrect password" after sentinel -> real result, no auth error', async () => {
  const t = setup();
  const { p } = await start(t);
  await tick();
  const { ch } = t.state;
  ch.stderr.emit('data', Buffer.from(markerOf(t.state.command)));
  ch.stderr.emit('data', Buffer.from(`${sentinelOf(t.state.command)}app: incorrect password for db user\nSorry, try again.\n`));
  assert.deepEqual(ch.stdin.writes, [`${PW}\n`]);
  exitWith(ch, 3);
  const r = await p;
  assert.equal(r.exitCode, 3);
  assert.equal(r.stderr, 'app: incorrect password for db user\nSorry, try again.\n');
});

test('(l) wrong password, sudo gives up (no 2nd marker, no sentinel) -> auth error', async () => {
  const t = setup();
  const { p } = await start(t);
  await tick();
  const { ch } = t.state;
  ch.stderr.emit('data', Buffer.from(markerOf(t.state.command)));
  ch.stderr.emit('data', Buffer.from('sudo: 1 incorrect password attempt\n'));
  exitWith(ch, 1);
  await assert.rejects(p, /sudo authentication failed on RR/);
});
