/**
 * Workflow reducer: the task state machine.
 *
 * Every transition is validated against the legal-transition table, the
 * expected workflow version, and the current fencing token. Illegal
 * transitions and stale versions/tokens are rejected with contract-violation
 * errors; the reducer never mutates its input.
 *
 * @module @deepseek-ai/dsh-system1-contracts/reducer
 */

import { system1Error } from './errors.ts'
import type { TaskState } from './schemas.ts'

/** Legal state transitions. Terminal states have no outgoing edges. */
const LEGAL_TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  admitted: new Set(['observing', 'cancelled']),
  observing: new Set(['deciding', 'waiting_input', 'escalated', 'cancelled']),
  deciding: new Set(['executing', 'observing', 'escalated', 'waiting_retry', 'cancelled']),
  executing: new Set(['verifying', 'reconciling', 'waiting_retry', 'failed', 'cancelled']),
  verifying: new Set(['succeeded', 'failed', 'observing', 'escalated', 'cancelled']),
  waiting_input: new Set(['observing', 'cancelled']),
  waiting_retry: new Set(['observing', 'deciding', 'cancelled']),
  escalated: new Set(['observing', 'cancelled']),
  reconciling: new Set(['verifying', 'blocked', 'failed', 'cancelled']),
  succeeded: new Set([]),
  failed: new Set([]),
  blocked: new Set(['reconciling', 'cancelled']),
  cancelled: new Set([]),
}

/** Durable workflow state tracked by the reducer. */
export interface WorkflowState {
  readonly taskId: string
  readonly state: TaskState
  /** Monotonic version; every transition increments it. */
  readonly version: number
  /** Fencing token from the current lease; must match on every transition. */
  readonly fencingToken: number
}

/** A requested state transition with optimistic-concurrency guards. */
export interface TransitionRequest {
  readonly taskId: string
  readonly to: TaskState
  /** Expected current version; rejects stale writers. */
  readonly expectedVersion: number
  /** Expected fencing token; rejects stale lease holders. */
  readonly expectedFencingToken: number
}

/**
 * Apply a validated transition, returning the new workflow state.
 * @param current - current durable workflow state.
 * @param request - requested transition with concurrency guards.
 * @returns the new workflow state with incremented version.
 * @throws System1Error on illegal transition, stale version, or stale token.
 */
export function reduceTransition(
  current: WorkflowState,
  request: TransitionRequest,
): WorkflowState {
  if (current.taskId !== request.taskId) {
    throw system1Error('ILLEGAL_STATE_TRANSITION', 'Task ID mismatch in transition request', {
      currentTaskId: current.taskId,
      requestTaskId: request.taskId,
    })
  }
  if (request.expectedVersion !== current.version) {
    throw system1Error('STALE_WORKFLOW_VERSION', 'Stale workflow version', {
      taskId: current.taskId,
      expected: request.expectedVersion,
      actual: current.version,
    })
  }
  if (request.expectedFencingToken !== current.fencingToken) {
    throw system1Error('STALE_FENCING_TOKEN', 'Stale fencing token', {
      taskId: current.taskId,
      expected: request.expectedFencingToken,
      actual: current.fencingToken,
    })
  }
  const allowed = LEGAL_TRANSITIONS[current.state]
  if (!allowed.has(request.to)) {
    throw system1Error('ILLEGAL_STATE_TRANSITION', `Illegal transition ${current.state} -> ${request.to}`, {
      taskId: current.taskId,
      from: current.state,
      to: request.to,
    })
  }
  return {
    taskId: current.taskId,
    state: request.to,
    version: current.version + 1,
    fencingToken: current.fencingToken,
  }
}

/**
 * Create the initial workflow state for an admitted task.
 * @param taskId - task identifier.
 * @param fencingToken - fencing token from the acquired lease.
 */
export function initialWorkflowState(taskId: string, fencingToken: number): WorkflowState {
  return { taskId, state: 'admitted', version: 0, fencingToken }
}

/** Whether the state is terminal (no outgoing transitions). */
export function isTerminalState(state: TaskState): boolean {
  return LEGAL_TRANSITIONS[state].size === 0
}
