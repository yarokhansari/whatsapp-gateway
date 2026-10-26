// Sends one message at a time per WhatsApp number, with a gap between messages.

export class SendQueue {
  #tail = Promise.resolve();
  #lastAt = 0;

  /**
   * @param {number} gapMs  least time between two sends
   * @param {(ms: number) => Promise<void>} sleep
   */
  constructor(gapMs, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    this.gapMs = gapMs;
    this.sleep = sleep;
  }

  /**
   * Runs task after the ones already waiting. Resolves or rejects with the task's result.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  push(task) {
    const run = this.#tail.then(async () => {
      // A little randomness on top of the gap, so sends don't tick like a clock.
      const wait = this.#lastAt + this.gapMs + Math.floor(Math.random() * (this.gapMs / 2)) - Date.now();

      if (this.#lastAt > 0 && wait > 0) {
        await this.sleep(wait);
      }

      try {
        return await task();
      } finally {
        this.#lastAt = Date.now();
      }
    });

    // One failed send must not stop the ones after it.
    this.#tail = run.catch(() => {});

    return run;
  }
}
