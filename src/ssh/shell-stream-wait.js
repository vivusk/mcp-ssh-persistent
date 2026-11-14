/**
 * Event-driven wait for a ShellStream (no polling).
 * Re-runs `check(quietMs)` on every data/close event of the stream and, when
 * quietMs > 0, once more after each quiet period with no new data.
 */

/**
 * @param {object} stream - ShellStream (uses .waiters Set, .active, .lastDataAt)
 * @param {Function} check - (msSinceLastData) -> boolean
 * @param {number} timeoutMs - Give up after this long
 * @param {number} [quietMs=0] - Quiet period after which check re-runs (0 = events only)
 * @returns {Promise<boolean>} true when check passed; false on timeout or stream close
 */
export function waitForStream(stream, check, timeoutMs, quietMs = 0) {
  return new Promise((resolve) => {
    let quietTimer = null;
    const sinceData = () => Date.now() - stream.lastDataAt;
    const done = (ok) => {
      clearTimeout(timer);
      clearTimeout(quietTimer);
      stream.waiters.delete(onEvent);
      resolve(ok);
    };
    const armQuiet = () => {
      if (quietMs <= 0) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => { if (check(sinceData())) done(true); }, quietMs);
    };
    const onEvent = () => {
      if (!stream.active) return done(false);
      if (check(sinceData())) return done(true);
      armQuiet();
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    stream.waiters.add(onEvent);
    onEvent();
  });
}
