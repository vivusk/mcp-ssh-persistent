import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, stripMarker, MARKER } from '../src/ssh/shell-completion-detector.js';

const user = { username: 'deploy' };

test('marker prompt ($ and #) -> prompt, even with ANSI and no quiet', () => {
  assert.deepEqual(detect(`/tmp\r\n${MARKER}$ `, 0, user), { state: 'prompt' });
  assert.deepEqual(detect(`x\n\x1b[?2004h${MARKER}# `, 0, user), { state: 'prompt' });
  assert.deepEqual(detect(`${MARKER}$ more output`, 1000, user), { state: 'running' });
});

test('sudo prompt for the session user -> kind sudo', () => {
  assert.deepEqual(detect('[sudo] password for deploy: ', 0, user), { state: 'awaiting_input', kind: 'sudo' });
  assert.deepEqual(detect('blah\r\n[sudo] password for deploy:', 0, user), { state: 'awaiting_input', kind: 'sudo' });
});

test('sudo-rs prompt "[sudo: authenticate] Password:" -> kind sudo; variants -> password', () => {
  assert.deepEqual(detect('[sudo: authenticate] Password: ', 0, user), { state: 'awaiting_input', kind: 'sudo' });
  assert.deepEqual(detect('x\r\n[sudo: authenticate] Password:', 0, user), { state: 'awaiting_input', kind: 'sudo' });
  assert.equal(detect('fake [sudo: authenticate] Password: ', 0, user).kind, 'password');
  assert.equal(detect('[sudo: other] Password: ', 0, user).kind, 'password');
  assert.equal(detect('[sudo: authenticate] Password: ', 0, {}).kind, 'password', 'no session user -> never sudo');
});

test('sudo prompt for another user -> kind password, not sudo', () => {
  assert.deepEqual(detect('[sudo] password for otheruser: ', 0, user), { state: 'awaiting_input', kind: 'password' });
  assert.deepEqual(detect('[sudo] password for deployx: ', 0, user), { state: 'awaiting_input', kind: 'password' });
  // Prompt text inside a line (not at its start) is not the sudo prompt.
  assert.deepEqual(detect('fake [sudo] password for deploy: ', 0, user), { state: 'awaiting_input', kind: 'password' });
});

test("ssh / su / generic password prompts -> kind password, never sudo", () => {
  assert.deepEqual(detect("deploy@192.0.2.10's password: ", 0, user), { state: 'awaiting_input', kind: 'password' });
  assert.deepEqual(detect('Password: ', 0, user), { state: 'awaiting_input', kind: 'password' });
  assert.deepEqual(detect('Enter password:', 0, user), { state: 'awaiting_input', kind: 'password' });
});

test('username with regex characters is escaped (exact match)', () => {
  const opts = { username: 'a.b+c' };
  assert.equal(detect('[sudo] password for a.b+c: ', 0, opts).kind, 'sudo');
  assert.equal(detect('[sudo] password for aXbbc: ', 0, opts).kind, 'password');
});

test('no username -> sudo prompt is only kind password', () => {
  assert.equal(detect('[sudo] password for deploy: ', 0, {}).kind, 'password');
});

test('Status: line and > are not completion', () => {
  assert.deepEqual(detect('Status: ', 5000, user), { state: 'running' });
  assert.deepEqual(detect('Installing...\nStatus:', 5000, user), { state: 'running' });
  assert.deepEqual(detect('PS C:\\> ', 5000, user), { state: 'running' });
  assert.deepEqual(detect('> ', 5000, user), { state: 'running' });
});

test('generic $/# prompt only after 300 ms quiet (fallback)', () => {
  assert.deepEqual(detect('root@host:~# ', 0, user), { state: 'running' });
  assert.deepEqual(detect('root@host:~# ', 299, user), { state: 'running' });
  assert.deepEqual(detect('root@host:~# ', 300, user), { state: 'prompt', fallback: true });
  assert.deepEqual(detect('user@host:~$ ', 1000, user), { state: 'prompt', fallback: true });
});

test('yes/no confirmations -> kind confirm', () => {
  const s = 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ';
  assert.deepEqual(detect(s, 0, user), { state: 'awaiting_input', kind: 'confirm' });
  assert.deepEqual(detect('Do you want to continue? (Y/n) ', 0, user), { state: 'awaiting_input', kind: 'confirm' });
  assert.deepEqual(detect('Proceed (y/n): ', 0, user), { state: 'awaiting_input', kind: 'confirm' });
  assert.deepEqual(detect('Continue? [Y/n] ', 0, user), { state: 'running' });
});

test('only the last 1 KB is inspected; output ending with newline is running', () => {
  assert.deepEqual(detect(`${MARKER}$ ${'x'.repeat(2000)}`, 0, user), { state: 'running' });
  assert.deepEqual(detect('line1\nline2\n', 0, user), { state: 'running' });
});

test('stripMarker removes prompt lines and fragments', () => {
  assert.equal(stripMarker(`/tmp\n${MARKER}$ `), '/tmp\n');
  assert.equal(stripMarker(`${MARKER}# \na\n${MARKER}# `), 'a\n');
  assert.equal(stripMarker('plain'), 'plain');
});
