/**
 * Deterministic clock and ID injection for replay and fault tests.
 *
 * Production code uses the system clock and random IDs. Tests inject the
 * manual clock and sequential IDs to make execution fully deterministic.
 *
 * @module @deepseek-ai/dsh-system1-coordination/deterministic
 */

/** A clock abstraction. */
export interface Clock {
  /** Current time in milliseconds since the Unix epoch. */
  now(): number
}

/** The real system clock. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}

/**
 * A manually advanced clock for deterministic tests.
 */
export class ManualClock implements Clock {
  private current: number

  /**
   * @param startMs - initial time in milliseconds.
   */
  constructor(startMs = 0) {
    this.current = startMs
  }

  now(): number {
    return this.current
  }

  /**
   * Advance the clock by the given milliseconds.
   * @param ms - milliseconds to advance.
   */
  advance(ms: number): void {
    if (ms < 0) throw new Error('Cannot advance the clock backwards')
    this.current += ms
  }

  /**
   * Set the clock to an absolute time.
   * @param ms - new time in milliseconds.
   */
  set(ms: number): void {
    this.current = ms
  }
}

/** An ID generator abstraction. */
export interface IdGenerator {
  /**
   * Generate a new ID.
   * @param prefix - optional prefix for readability.
   */
  next(prefix?: string): string
}

/** Random IDs for production use. */
export class RandomIdGenerator implements IdGenerator {
  next(prefix = 'id'): string {
    const rand = Math.random().toString(36).slice(2, 10)
    return `${prefix}-${Date.now().toString(36)}-${rand}`
  }
}

/**
 * Sequential IDs for deterministic tests and replay.
 * The same sequence of `next` calls always yields the same IDs.
 */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0

  next(prefix = 'id'): string {
    this.counter += 1
    return `${prefix}-${String(this.counter).padStart(6, '0')}`
  }

  /** Reset the sequence (for test isolation). */
  reset(): void {
    this.counter = 0
  }
}
