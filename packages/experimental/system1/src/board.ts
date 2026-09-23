/**
 * Judgment board: the non-blocking actuation primitive.
 *
 * Jev round-trips cost hundreds of milliseconds to seconds. Awaiting them on
 * the agent's critical path (pre-step, pre-execute, post-execute) makes the
 * harness slower than having no System 1 at all. The board decouples *asking*
 * from *acting*: a listener posts a pending judgment as early as its inputs
 * exist, and a later seam consumes it —
 *
 * - {@link JudgmentBoard.peek} never waits: the answer is used only if it
 *   already arrived;
 * - {@link JudgmentBoard.take} waits at most `deadlineMs`, then gives up and
 *   reports the judgment as late (it stays posted for a later peek).
 *
 * Posting never rejects and never throws: a rejected judgment settles as
 * `null`, which every consumer reads as "no opinion".
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

/** Outcome of a bounded wait. `late` means the deadline passed first. */
export type BoardTake<T> =
  | { readonly status: 'ready'; readonly value: T | null }
  | { readonly status: 'late' }
  | { readonly status: 'missing' }

interface Slot {
  readonly promise: Promise<unknown>
  readonly postedAt: number
  settled: boolean
  value: unknown
}

/** Default cap on live slots; the oldest slot is evicted past it. */
export const DEFAULT_BOARD_CAPACITY = 512

/**
 * Bounded map of in-flight and settled judgments keyed by caller-chosen
 * strings (convention: `<agentId>:<purpose>[:<id>]`).
 */
export class JudgmentBoard {
  private readonly slots = new Map<string, Slot>()

  constructor(private readonly capacity: number = DEFAULT_BOARD_CAPACITY) {}

  /** Number of live slots (settled or pending). */
  get size(): number {
    return this.slots.size
  }

  /**
   * Post a pending judgment under `key`, replacing any previous slot. The
   * promise may reject; it settles as `null` on the board either way.
   */
  post<T>(key: string, promise: Promise<T | null>): void {
    const slot: Slot = { promise, postedAt: Date.now(), settled: false, value: null }
    const settle = (value: unknown): void => {
      // A newer post may have replaced this slot; only settle our own.
      if (this.slots.get(key) !== slot) return
      slot.settled = true
      slot.value = value
    }
    promise.then(settle, () => { settle(null) })
    this.slots.delete(key)
    this.slots.set(key, slot)
    while (this.slots.size > this.capacity) {
      const oldest = this.slots.keys().next().value
      if (oldest === undefined) break
      this.slots.delete(oldest)
    }
  }

  /** Whether a slot exists under `key`. */
  has(key: string): boolean {
    return this.slots.has(key)
  }

  /** Whether the slot under `key` has settled. False when missing. */
  isSettled(key: string): boolean {
    return this.slots.get(key)?.settled ?? false
  }

  /** Milliseconds since the slot under `key` was posted, or null when missing. */
  ageMs(key: string): number | null {
    const slot = this.slots.get(key)
    return slot === undefined ? null : Date.now() - slot.postedAt
  }

  /** Non-blocking read: the value when settled, otherwise the status. Never waits. */
  peek<T>(key: string): BoardTake<T> {
    const slot = this.slots.get(key)
    if (slot === undefined) return { status: 'missing' }
    if (!slot.settled) return { status: 'late' }
    return { status: 'ready', value: slot.value as T | null }
  }

  /**
   * Bounded wait: resolves `ready` as soon as the slot settles, or `late`
   * once `deadlineMs` elapses — whichever comes first. A deadline of 0 is a
   * peek. Aborting `signal` resolves `late` immediately. Never rejects.
   */
  async take<T>(key: string, deadlineMs: number, signal?: AbortSignal): Promise<BoardTake<T>> {
    const slot = this.slots.get(key)
    if (slot === undefined) return { status: 'missing' }
    if (slot.settled) return { status: 'ready', value: slot.value as T | null }
    if (deadlineMs <= 0 || signal?.aborted === true) return { status: 'late' }
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const late = new Promise<BoardTake<T>>((resolve) => {
      timer = setTimeout(() => { resolve({ status: 'late' }) }, deadlineMs)
      onAbort = () => { resolve({ status: 'late' }) }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    const ready = slot.promise.then(
      value => ({ status: 'ready', value: value as T | null }) as BoardTake<T>,
      () => ({ status: 'ready', value: null }) as BoardTake<T>,
    )
    try {
      return await Promise.race([ready, late])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Remove the slot under `key` (consumed or obsolete). */
  delete(key: string): void {
    this.slots.delete(key)
  }

  /** Remove every slot whose key starts with `prefix`. */
  clear(prefix = ''): void {
    for (const key of [...this.slots.keys()]) {
      if (key.startsWith(prefix)) this.slots.delete(key)
    }
  }
}
