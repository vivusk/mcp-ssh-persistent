/**
 * Test helper (not a test file): fake ssh2 shell channel.
 * EventEmitter with write/end/destroy. On the init line it answers with the
 * marker prompt (or a plain `$ ` when markerOnInit=false, like a non-bash
 * shell). Other writes are answered by `respond(data)` which returns
 * [[delayMs, text], ...] chunks to emit.
 */
import { EventEmitter } from 'events';
import { INIT_COMMAND } from '../src/ssh/shell-stream.js';

export const PROMPT = '__MCP_PS1__# ';

/** Default responder: `out:<cmd>` then the marker prompt after 5 ms. */
export const echoRespond = (data) => [[5, `out:${data.trim()}\r\n${PROMPT}`]];

export function createFakeShellChannel({ respond = echoRespond, markerOnInit = true } = {}) {
  const ch = new EventEmitter();
  ch.stderr = new EventEmitter();
  ch.writes = [];
  ch.closed = false;
  const emitLater = (chunks) => {
    for (const [delay, text] of chunks) {
      setTimeout(() => { if (!ch.closed) ch.emit('data', Buffer.from(text, 'utf8')); }, delay);
    }
  };
  ch.write = (data) => {
    ch.writes.push(data);
    if (data === INIT_COMMAND) emitLater([[2, 'motd line\r\nuser@host:~$ '], [5, markerOnInit ? PROMPT : 'sh$ ']]);
    else if (data === '\x03') emitLater([[1, `^C\r\n${PROMPT}`]]);
    else emitLater(respond(data));
    return true;
  };
  ch.end = () => {
    if (ch.closed) return;
    ch.closed = true;
    setImmediate(() => ch.emit('close'));
  };
  ch.destroy = ch.end;
  return ch;
}

/** Fake ssh2 client whose shell() yields fake channels (records them). */
export function createFakeShellClient(opts = {}) {
  const channels = [];
  return {
    channels,
    shell(window, cb) {
      const ch = createFakeShellChannel(opts);
      channels.push(ch);
      setImmediate(() => cb(null, ch));
    },
  };
}
