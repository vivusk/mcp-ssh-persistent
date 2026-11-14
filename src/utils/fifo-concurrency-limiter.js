/**
 * FIFO concurrency limiter (counting semaphore)
 * At most `max` holders at once; extra acquirers wait in arrival order.
 */
export class FifoConcurrencyLimiter {
  /** @param {number} max - Maximum concurrent holders (>= 1) */
  constructor(max) {
    this.max = Math.max(1, Math.floor(max) || 1);
    this.active = 0;
    this.queue = [];
  }

  /**
   * Wait for a slot.
   * @returns {Promise<Function>} release function (safe to call more than once)
   */
  acquire() {
    return new Promise((resolve) => {
      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      if (this.active < this.max) grant();
      else this.queue.push(grant);
    });
  }

  /** @returns {number} number of callers waiting for a slot */
  get pending() {
    return this.queue.length;
  }
}
