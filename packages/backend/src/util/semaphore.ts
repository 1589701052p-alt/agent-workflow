// Minimal FIFO counting semaphore used by the scheduler (P-3-05).
//
// Construction with `capacity = N` allows at most N concurrent holders.
// `acquire()` resolves immediately when a slot is free, otherwise queues
// the caller in FIFO order. The returned function releases the slot —
// callers should call it exactly once (use try/finally).
//
// Not designed for cross-process use; one daemon = one event loop.

export class Semaphore {
  private remaining: number
  private waiters: Array<() => void> = []

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Semaphore capacity must be a positive integer, got ${capacity}`)
    }
    this.remaining = capacity
  }

  /** Currently-free slots (capacity - inFlight). */
  get available(): number {
    return this.remaining
  }

  /** Number of callers blocked waiting for a slot. */
  get queueLength(): number {
    return this.waiters.length
  }

  /**
   * Acquire one slot. Returns a `release` function that frees the slot.
   * Always wrap in try/finally so a thrown exception doesn't permanently
   * leak a slot.
   */
  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const grant = () => resolve(() => this.release())
      if (this.remaining > 0) {
        this.remaining -= 1
        grant()
        return
      }
      this.waiters.push(() => {
        this.remaining -= 1
        grant()
      })
    })
  }

  private release(): void {
    this.remaining += 1
    // Hand the freed slot to the next waiter — if there is one — in FIFO
    // order. The waiter's continuation re-decrements `remaining`.
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }

  /**
   * Convenience helper. `await sem.run(fn)` acquires, calls fn, releases.
   * Releases the slot even when fn throws.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
