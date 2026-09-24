/**
 * Distributed execution and operational recovery.
 *
 * Work queue: distributes tasks to workers with fencing tokens. Deliveries
 * are deduplicated per task ID and claims are atomic ownership records, but
 * all state is process-local: there is no shared backend, so this queue must
 * not be treated as safe for multi-process deployment.
 * Checkpoints: save/restore task state for recovery. State is deep-copied on
 * save and load so caller mutation can never corrupt a saved checkpoint.
 *
 * @module @deepseek-ai/dsh-system1-distributed/distributed
 */

import { system1Error } from '@deepseek-ai/dsh-system1-contracts'

/** A unit of work. */
export interface WorkItem {
  readonly taskId: string
  readonly fencingToken: string
  readonly payload: unknown
  readonly enqueuedAtMs: number
}

/** Ownership record for a claimed task. */
export interface ClaimRecord {
  readonly taskId: string
  readonly workerId: string
  readonly fencingToken: string
  readonly claimedAtMs: number
  readonly expiresAtMs: number
  readonly status: 'claimed' | 'settled' | 'released'
}

/** Work queue configuration. */
export interface WorkQueueConfig {
  /** Maximum queued items. Defaults to 1000. */
  readonly maxSize?: number
  /** Claim time-to-live in milliseconds. Defaults to 60000. */
  readonly claimTtlMs?: number
  /** Clock (injectable for tests). */
  readonly now?: () => number
}

/**
 * In-memory work queue with fencing. Single-process only: ownership records
 * live in this process, so a second process (or a second queue instance)
 * cannot observe or respect claims made here.
 */
export class WorkQueue {
  private readonly maxSize: number
  private readonly claimTtlMs: number
  private readonly now: () => number
  private readonly pending = new Map<string, WorkItem>() // taskId -> item, insertion-ordered
  private readonly claims = new Map<string, ClaimRecord>() // taskId -> claim record

  /**
   * @param config - queue configuration.
   */
  constructor(config: WorkQueueConfig = {}) {
    this.maxSize = config.maxSize ?? 1000
    this.claimTtlMs = config.claimTtlMs ?? 60_000
    this.now = config.now ?? Date.now
  }

  /**
   * The active claim for a task, or null when there is no unexpired,
   * unsettled claim.
   * @param taskId - task ID.
   * @returns the active claim record, or null.
   */
  private activeClaim(taskId: string): ClaimRecord | null {
    const claim = this.claims.get(taskId)
    if (!claim) return null
    if (claim.status !== 'claimed') return null
    if (claim.expiresAtMs <= this.now()) return null
    return claim
  }

  /**
   * Enqueue a work item. Deliveries are deduplicated per task ID: a delivery
   * for a task with an active (unexpired, unsettled) claim is dropped so two
   * workers can never claim the same task concurrently; a delivery for an
   * already-pending task replaces the pending item (latest delivery wins).
   * @param taskId - task ID.
   * @param fencingToken - fencing token.
   * @param payload - work payload.
   */
  enqueue(taskId: string, fencingToken: string, payload: unknown): void {
    if (this.activeClaim(taskId)) {
      return
    }
    if (!this.pending.has(taskId) && this.pending.size >= this.maxSize) {
      throw system1Error('CONCURRENCY_LIMIT_EXCEEDED', 'Work queue full', {
        maxSize: this.maxSize,
      })
    }
    this.pending.set(taskId, {
      taskId,
      fencingToken,
      payload,
      enqueuedAtMs: this.now(),
    })
  }

  /**
   * Claim the oldest pending work item for a worker. The claim atomically
   * records task ID, worker, fencing token, lease expiry, and settlement
   * status together.
   * @param workerId - worker ID.
   * @returns the claimed item, or null if no item is claimable.
   */
  claim(workerId: string): WorkItem | null {
    for (const [taskId, item] of this.pending) {
      this.pending.delete(taskId)
      const claimedAtMs = this.now()
      this.claims.set(taskId, {
        taskId,
        workerId,
        fencingToken: item.fencingToken,
        claimedAtMs,
        expiresAtMs: claimedAtMs + this.claimTtlMs,
        status: 'claimed',
      })
      return item
    }
    return null
  }

  /**
   * Release a claim (on failure). The fencing token must match the current
   * claim record; a stale token is rejected.
   * @param taskId - task ID.
   * @param fencingToken - must match the claim record's fencing token.
   * @throws System1Error STALE_FENCING_TOKEN on missing claim or token mismatch.
   */
  release(taskId: string, fencingToken: string): void {
    const claim = this.claims.get(taskId)
    if (!claim || claim.fencingToken !== fencingToken) {
      throw system1Error('STALE_FENCING_TOKEN', 'Fencing token mismatch on release', {
        taskId,
      })
    }
    this.claims.set(taskId, { ...claim, status: 'released' })
  }

  /**
   * Settle a claim (on successful completion). The fencing token must match
   * the current claim record; a stale token is rejected.
   * @param taskId - task ID.
   * @param fencingToken - must match the claim record's fencing token.
   * @throws System1Error STALE_FENCING_TOKEN on missing claim or token mismatch.
   */
  settle(taskId: string, fencingToken: string): void {
    const claim = this.claims.get(taskId)
    if (!claim || claim.fencingToken !== fencingToken) {
      throw system1Error('STALE_FENCING_TOKEN', 'Fencing token mismatch on settle', {
        taskId,
      })
    }
    this.claims.set(taskId, { ...claim, status: 'settled' })
  }

  /**
   * Get queue depth.
   * @returns number of queued (unclaimed) items.
   */
  depth(): number {
    return this.pending.size
  }
}

/** A checkpoint (saved task state). */
export interface Checkpoint {
  readonly taskId: string
  readonly fencingToken: string
  readonly state: unknown
  readonly checkpointedAtMs: number
}

/** Checkpoint manager configuration. */
export interface CheckpointManagerConfig {
  /** Clock (injectable for tests). */
  readonly now?: () => number
}

/**
 * Manages checkpoints for recovery. Checkpoint state is deep-copied with
 * structuredClone on save and on load, so mutating the caller's object (or a
 * previously loaded checkpoint) can never corrupt the saved checkpoint.
 * State must be structured-cloneable.
 */
export class CheckpointManager {
  private readonly now: () => number
  private readonly checkpoints = new Map<string, Checkpoint>()

  /**
   * @param config - manager configuration.
   */
  constructor(config: CheckpointManagerConfig = {}) {
    this.now = config.now ?? Date.now
  }

  /**
   * Save a checkpoint, storing an immutable deep copy of the state.
   * @param taskId - task ID.
   * @param fencingToken - fencing token (must match existing or be new).
   * @param state - state to save; must be structured-cloneable.
   */
  save(taskId: string, fencingToken: string, state: unknown): void {
    const existing = this.checkpoints.get(taskId)
    if (existing && existing.fencingToken !== fencingToken) {
      throw system1Error('STALE_FENCING_TOKEN', 'Cannot overwrite checkpoint with stale token', {
        taskId,
      })
    }
    this.checkpoints.set(taskId, {
      taskId,
      fencingToken,
      state: structuredClone(state),
      checkpointedAtMs: this.now(),
    })
  }

  /**
   * Load a checkpoint, returning a deep copy of the saved state.
   * @param taskId - task ID.
   * @returns the checkpoint, or null if none.
   */
  load(taskId: string): Checkpoint | null {
    const checkpoint = this.checkpoints.get(taskId)
    if (!checkpoint) return null
    return { ...checkpoint, state: structuredClone(checkpoint.state) }
  }

  /**
   * Delete a checkpoint.
   * @param taskId - task ID.
   */
  delete(taskId: string): void {
    this.checkpoints.delete(taskId)
  }
}
