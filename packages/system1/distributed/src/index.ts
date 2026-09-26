/**
 * System 1 distributed: execution and operational recovery.
 *
 * @module @deepseek-ai/dsh-system1-distributed
 */

/** Package version marker (ensures the barrel has executable statements). */
export const DISTRIBUTED_PACKAGE_VERSION = '0.1.7-alpha.2'

export { WorkQueue, CheckpointManager } from './distributed.ts'
export type {
  WorkItem,
  WorkQueueConfig,
  ClaimRecord,
  Checkpoint,
  CheckpointManagerConfig,
} from './distributed.ts'
