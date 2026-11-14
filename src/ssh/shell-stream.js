/**
 * ShellStream — one ssh2 shell channel per stream_id (D7, D12).
 * Init sets a unique PS1 marker and disables history; writes wait event-driven
 * (data events + one 300 ms quiet re-check) until the completion detector sees
 * a prompt / input request, or waitMs elapses. Calls are serialized per stream.
 */
import { StringDecoder } from 'string_decoder';
import { CappedOutputCollector } from '../utils/capped-output-collector.js';
import { stripAnsi } from '../utils/ansi.js';
import { log } from '../utils/logger.js';
import { detect, stripMarker, FALLBACK_QUIET_MS } from './shell-completion-detector.js';
import { waitForStream } from './shell-stream-wait.js';

// Leading space + history off keeps this (and later commands) out of ~/.bash_history.
export const INIT_COMMAND = " unset HISTFILE; set +o history +o emacs +o vi; export PS1='__MCP_PS1__\\$ ' PS2='' PROMPT_COMMAND=''; stty -echo 2>/dev/null\n";
export const MARKER_WARNING = '[warn: shell prompt marker not set; completion detection is heuristic]';
const SHELL_WINDOW = { term: 'xterm', cols: 200, rows: 50 };
const TAIL_KEEP = 2048; // raw chars kept for the detector (it inspects the last 1 KB stripped)
const UNREAD_SHOWN = 2048;
const READ_QUIET_MS = 500;

export class ShellStream {
  /**
   * @param {object} channel - ssh2 shell channel (or EventEmitter with write/end/destroy)
   * @param {object} [opts] - { streamId, alias, username, bufferBytes }
   */
  constructor(channel, { streamId = '?', alias = '?', username, bufferBytes = 524288 } = {}) {
    Object.assign(this, { channel, streamId, alias, username, bufferBytes });
    this.decoder = new StringDecoder('utf8');
    this.collector = new CappedOutputCollector(bufferBytes);
    this.tail = '';
    this.lastDetection = null;
    this.lastDataAt = Date.now();
    this.active = true;
    this.markerMode = true;
    this.initWarning = null;
    this.waiters = new Set(); // callbacks run on every data / close event
    this.queue = Promise.resolve();
    const onData = (d) => this.#onData(d);
    channel.on('data', onData);
    channel.stderr?.on?.('data', onData);
    channel.on('close', () => this.#onClose());
    channel.on('error', (e) => log('warn', `stream ${streamId} channel error`, { error: e?.message }));
  }

  /**
   * Open a shell channel on an ssh2 client and initialize it.
   * @param {object} client - ssh2 Client
   * @param {object} opts - constructor opts + { initTimeoutMs }
   * @returns {Promise<ShellStream>}
   */
  static async open(client, opts = {}) {
    if (!client) throw new Error(`not connected to ${opts.alias}`);
    const channel = await new Promise((resolve, reject) => {
      client.shell(SHELL_WINDOW, (err, ch) => (err ? reject(err) : resolve(ch)));
    });
    const stream = new ShellStream(channel, opts);
    await stream.init(opts.initTimeoutMs);
    return stream;
  }

  /** Send the init line, wait (max timeoutMs) for the marker prompt, discard init output. */
  async init(timeoutMs = 3000) {
    this.channel.write(INIT_COMMAND);
    const seen = await waitForStream(this, () => {
      const d = detect(this.tail, 0, { username: this.username });
      return d.state === 'prompt' && !d.fallback;
    }, timeoutMs);
    this.#take();
    this.tail = '';
    if (!seen && this.active) {
      this.markerMode = false;
      this.initWarning = MARKER_WARNING;
      log('warn', `stream ${this.streamId} on ${this.alias}: marker prompt not seen, heuristic mode`);
    }
    if (!this.active) throw new Error(`stream ${this.streamId} closed during init`);
  }

  /**
   * Write data verbatim, then wait for completion (prompt / awaiting input) or waitMs.
   * @param {string} data
   * @param {object} [opts] - { waitMs = 5000 }
   * @returns {Promise<{output:string, state:string, kind?:string, droppedBytes:number, unreadDiscardedBytes:number}>}
   */
  write(data, { waitMs = 5000 } = {}) {
    return this.#serialize(async () => {
      this.#assertOpen();
      const unread = this.#take();
      this.tail = '';
      this.lastDetection = null;
      this.channel.write(data);
      let det = { state: 'running' };
      if (waitMs > 0) {
        await waitForStream(this, (quietMs) => (det = this.detect(quietMs)).state !== 'running', waitMs, FALLBACK_QUIET_MS);
      }
      const out = this.#take();
      let output = clean(out.text);
      if (unread.bytes > 0) {
        output = `[unread before write: ${unread.bytes} bytes, tail shown]\n${clean(unread.text).slice(-UNREAD_SHOWN)}\n${output}`;
      }
      const state = !this.active ? 'closed' : det.state === 'running' ? 'timeout' : det.state;
      return { output, state, kind: det.kind, droppedBytes: out.dropped, unreadDiscardedBytes: unread.bytes };
    });
  }

  /**
   * Read buffered output. waitMs > 0: wait for data, then 500 ms quiet or waitMs.
   * @param {object} [opts] - { waitMs = 0, clear = true }
   * @returns {Promise<{output:string, state:string, kind?:string, droppedBytes:number}>}
   */
  read({ waitMs = 0, clear = true } = {}) {
    return this.#serialize(async () => {
      if (waitMs > 0 && this.active) {
        await waitForStream(this, (quietMs) => this.collector.totalBytes > 0 && quietMs >= READ_QUIET_MS, waitMs, READ_QUIET_MS);
      }
      const det = this.detect(Date.now() - this.lastDataAt);
      const out = clear ? this.#take() : { text: this.collector.peek(), dropped: this.collector.droppedBytes };
      const state = !this.active ? 'closed' : det.state;
      return { output: clean(out.text), state, kind: det.kind, droppedBytes: out.dropped };
    });
  }

  /** Run the detector on the retained tail; result kept in lastDetection. */
  detect(quietMs = Date.now() - this.lastDataAt) {
    this.lastDetection = detect(this.tail, quietMs, { username: this.username });
    return this.lastDetection;
  }

  /** Send Ctrl+C. */
  interrupt() {
    if (this.active) this.channel.write('\x03');
  }

  /** End and destroy the channel. Idempotent. */
  close() {
    try { this.channel.end(); } catch { /* ignore */ }
    try { this.channel.destroy?.(); } catch { /* ignore */ }
    this.#onClose();
  }

  /** Register a callback for when the channel closes. */
  onClose(cb) {
    if (!this.active) cb();
    else (this.closeCbs ||= []).push(cb);
  }

  #onData(chunk) {
    const text = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk);
    this.lastDataAt = Date.now();
    if (!text) return;
    this.collector.push(text);
    this.tail = (this.tail + text).slice(-TAIL_KEEP);
    for (const w of [...this.waiters]) w();
  }

  #onClose() {
    if (!this.active) return;
    this.active = false;
    for (const w of [...this.waiters]) w();
    for (const cb of this.closeCbs || []) { try { cb(); } catch { /* ignore */ } }
  }

  #assertOpen() {
    if (!this.active) throw new Error(`stream ${this.streamId} closed`);
  }

  /** Take (and reset) the unread buffer. */
  #take() {
    const c = this.collector;
    const res = { text: c.toString(), bytes: c.totalBytes, dropped: c.droppedBytes };
    this.collector = new CappedOutputCollector(this.bufferBytes);
    return res;
  }

  /** Chain fn after previous calls on this stream (per-stream mutex). */
  #serialize(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
}

/** ANSI-stripped output without marker prompts. */
function clean(text) {
  return stripMarker(stripAnsi(text));
}
