/**
 * Distributed execution and operational recovery.
 *
 * Work queue: distributes tasks to workers with fencing tokens.
 * Checkpoints: save/restore task state for recovery.
 * Recovery: resume from last checkpoint after failure.
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

/** Work queue configuration. */
export interface WorkQueueConfig {
  /** Maximum queued items. Defaults to 1000. */
  readonly maxSize?: number
  /** Clock (injectable for tests). */
  readonly now?: () => number
}

/** In-memory work queue with fencing. */
export class WorkQueue {
  private readonly maxSize: number
  private readonly now: () => number
  private readonly queue: WorkItem[] = []
  private readonly claimed = new Map<string, string>() // taskId -> workerId

  /**
   * @param config - queue configuration.
   */
  constructor(config: WorkQueueConfig = {}) {
    this.maxSize = config.maxSize ?? 1000
    this.now = config.now ?? Date.now
  }

  /**
   * Enqueue a work item.
   * @param taskId - task ID.
   * @param fencingToken - fencing token.
   * @param payload - work payload.
   */
  enqueue(taskId: string, fencingToken: string, payload: unknown): void {
    if (this.queue.length >= this.maxSize) {
      throw system1Error('CONCURRENCY_LIMIT_EXCEEDED', 'Work queue full', {
        maxSize: this.maxSize,
      })
    }
    this.queue.push({
      taskId,
      fencingToken,
      payload,
      enqueuedAtMs: this.now(),
    })
  }

  /**
   * Claim a work item for a worker.
   * @param workerId - worker ID.
   * @returns the claimed item, or null if queue empty.
   */
  claim(workerId: string): WorkItem | null {
    const item = this.queue.shift()
    if (!item) return null
    this.claimed.set(item.taskId, workerId)
    return item
  }

  /**
   * Release a claim (on failure or completion).
   * @param taskId - task ID.
   * @param fencingToken - must match the claimed item's token.
   */
  release(taskId: string, fencingToken: string): void {
    const item = this.queue.find((i) => i.taskId === taskId)
    if (item && item.fencingToken !== fencingToken) {
      throw system1Error('STALE_FENCING_TOKEN', 'Fencing token mismatch on release', {
        taskId,
      })
    }
    this.claimed.delete(taskId)
  }

  /**
   * Get queue depth.
   * @returns number of queued (unclaimed) items.
   */
  depth(): number {
    return this.queue.length
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

/** Manages checkpoints for recovery. */
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
   * Save a checkpoint.
   * @param taskId - task ID.
   * @param fencingToken - fencing token (must match existing or be new).
   * @param state - state to save.
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
      state,
      checkpointedAtMs: this.now(),
    })
  }

  /**
   * Load a checkpoint.
   * @param taskId - task ID.
   * @returns the checkpoint, or null if none.
   */
  load(taskId: string): Checkpoint | null {
    return this.checkpoints.get(taskId) ?? null
  }

  /**
   * Delete a checkpoint.
   * @param taskId - task ID.
   */
  delete(taskId: string): void {
    this.checkpoints.delete(taskId)
  }
}
