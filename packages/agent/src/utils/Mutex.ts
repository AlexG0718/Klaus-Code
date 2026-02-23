/**
 * Simple mutex for protecting critical sections in Node.js async code.
 * Prevents race conditions when multiple async operations compete for
 * the same resource (e.g., session counter).
 */
export class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  /**
   * Acquire the lock. Returns a release function that MUST be called
   * when done with the protected section.
   * 
   * Usage:
   *   const release = await mutex.acquire();
   *   try {
   *     // critical section
   *   } finally {
   *     release();
   *   }
   */
  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Execute a function while holding the lock.
   * Automatically releases the lock when the function completes.
   */
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Compare-and-swap style counter with atomic increment that checks a limit.
 * Returns success/failure instead of throwing, allowing callers to handle gracefully.
 */
export class AtomicCounter {
  private mutex = new Mutex();
  private _value = 0;

  get value(): number {
    return this._value;
  }

  /**
   * Atomically try to increment the counter if it's below the limit.
   * Returns true if increment succeeded, false if limit would be exceeded.
   */
  async tryIncrement(limit: number): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      if (this._value >= limit) {
        return false;
      }
      this._value++;
      return true;
    });
  }

  /**
   * Atomically decrement the counter (floor at 0).
   */
  async decrement(): Promise<void> {
    await this.mutex.runExclusive(() => {
      this._value = Math.max(0, this._value - 1);
    });
  }

  /**
   * Force set the value (use with caution).
   */
  async set(value: number): Promise<void> {
    await this.mutex.runExclusive(() => {
      this._value = value;
    });
  }
}
