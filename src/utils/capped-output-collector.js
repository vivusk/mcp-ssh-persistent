/**
 * Capped output collector
 * Accumulates command output (Buffers) with a byte cap, UTF-8 safe across chunk
 * boundaries. Once over the cap it keeps the head (20%) and a rolling tail (80%),
 * and reports how many bytes were dropped in between.
 */
import { StringDecoder } from 'string_decoder';

const HEAD_RATIO = 0.2;

/** True when byte is a UTF-8 continuation byte (10xxxxxx). */
const isContinuation = (byte) => (byte & 0xc0) === 0x80;

export class CappedOutputCollector {
  /**
   * @param {number} maxBytes - Total bytes to retain (head + tail)
   */
  constructor(maxBytes = 102400) {
    this.maxBytes = Math.max(16, Math.floor(maxBytes));
    this.headCap = Math.floor(this.maxBytes * HEAD_RATIO);
    this.tailCap = this.maxBytes - this.headCap;
    this.decoder = new StringDecoder('utf8');
    this.head = '';
    this.headBytes = 0;
    this.tail = []; // [{ s: string, n: byteLength }]
    this.tailBytes = 0;
    this.totalBytes = 0;
    this.droppedBytes = 0;
    this.ended = false;
  }

  /**
   * Add a chunk of raw output.
   * @param {Buffer|string} chunk
   */
  push(chunk) {
    if (this.ended || chunk === undefined || chunk === null) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    this.totalBytes += buf.length;
    this.#addString(this.decoder.write(buf));
  }

  /** Flush any incomplete trailing multibyte sequence. Idempotent. */
  end() {
    if (this.ended) return;
    this.ended = true;
    this.#addString(this.decoder.end());
  }

  /** @returns {boolean} whether any bytes were dropped */
  get truncated() {
    return this.droppedBytes > 0;
  }

  /**
   * Final text: head + truncation marker + tail (marker only when bytes were dropped).
   * Calls end() so the decoder is flushed.
   * @returns {string}
   */
  toString() {
    this.end();
    const tail = this.tail.map((p) => p.s).join('');
    if (this.droppedBytes === 0) return this.head + tail;
    return `${this.head}\n[... truncated ${this.droppedBytes} bytes ...]\n${tail}`;
  }

  /** Route decoded text into head first, then into the rolling tail. */
  #addString(str) {
    if (!str) return;
    let rest = str;
    if (this.headBytes < this.headCap) {
      const buf = Buffer.from(rest, 'utf8');
      const room = this.headCap - this.headBytes;
      if (buf.length <= room) {
        this.head += rest;
        this.headBytes += buf.length;
        return;
      }
      // Cut at a character boundary that fits in the remaining head room.
      let cut = room;
      while (cut > 0 && isContinuation(buf[cut])) cut--;
      this.head += buf.subarray(0, cut).toString('utf8');
      this.headBytes += cut;
      // Head is now considered full even if a multibyte char left a byte or two unused.
      this.headCap = this.headBytes;
      rest = buf.subarray(cut).toString('utf8');
    }
    const n = Buffer.byteLength(rest, 'utf8');
    this.tail.push({ s: rest, n });
    this.tailBytes += n;
    this.#trimTail();
  }

  /** Drop bytes from the front of the tail until it fits tailCap. */
  #trimTail() {
    while (this.tailBytes > this.tailCap && this.tail.length > 0) {
      const excess = this.tailBytes - this.tailCap;
      const first = this.tail[0];
      if (first.n <= excess) {
        this.tail.shift();
        this.tailBytes -= first.n;
        this.droppedBytes += first.n;
        continue;
      }
      // Partial trim: advance past continuation bytes so we never split a char.
      const buf = Buffer.from(first.s, 'utf8');
      let cut = excess;
      while (cut < buf.length && isContinuation(buf[cut])) cut++;
      first.s = buf.subarray(cut).toString('utf8');
      first.n -= cut;
      this.tailBytes -= cut;
      this.droppedBytes += cut;
    }
  }
}
