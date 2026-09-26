/**
 * DeepSeek handoff and delegation.
 *
 * When System 1 (Jev) determines a task requires the full DeepSeek model,
 * it delegates via a structured handoff. Delegation is bounded by:
 * - Maximum depth (prevents infinite recursion)
 * - Budget pools (delegation consumes from the parent's budget)
 * - Parent-child linkage (every delegated task links to its parent)
 *
 * @module @deepseek-ai/dsh-system1-delegation/delegation
 */

import { system1Error } from '@deepseek-ai/dsh-system1-contracts'

/** Maximum delegation depth. */
export const MAX_DELEGATION_DEPTH = 5

/** A delegation request from System 1 to DeepSeek. */
export interface DelegationRequest {
  readonly parentTaskId: string
  readonly parentDecisionId: string
  readonly depth: number
  /** The task for DeepSeek (natural language or structured). */
  readonly task: string
  /** Context to include (bounded). */
  readonly context: string
  /** Budget allocated for this delegation (in provider request units). */
  readonly budgetUnits: number
}

/** A delegated task (child). */
export interface DelegatedTask {
  readonly taskId: string
  readonly parentTaskId: string
  readonly depth: number
  readonly task: string
  readonly context: string
  readonly budgetUnits: number
}

/** Delegation manager configuration. */
export interface DelegationConfig {
  /** Task ID generator. */
  readonly newTaskId: () => string
  /** Maximum depth (defaults to MAX_DELEGATION_DEPTH). */
  readonly maxDepth?: number
}

/** Manages delegation with depth and budget enforcement. */
export class DelegationManager {
  private readonly newTaskId: () => string
  private readonly maxDepth: number

  /**
   * @param config - delegation configuration.
   */
  constructor(config: DelegationConfig) {
    this.newTaskId = config.newTaskId
    this.maxDepth = config.maxDepth ?? MAX_DELEGATION_DEPTH
    if (this.maxDepth < 1) {
      throw system1Error('DELEGATION_DEPTH_EXCEEDED', 'Max delegation depth must be at least 1', {
        maxDepth: this.maxDepth,
      })
    }
  }

  /**
   * Create a delegated task from a request.
   * @param request - delegation request.
   * @returns the delegated task.
   * @throws if depth exceeds maximum.
   */
  delegate(request: DelegationRequest): DelegatedTask {
    if (request.depth >= this.maxDepth) {
      throw system1Error('DELEGATION_DEPTH_EXCEEDED', 'Delegation depth limit exceeded', {
        depth: request.depth,
        maxDepth: this.maxDepth,
      })
    }
    if (request.budgetUnits <= 0) {
      throw system1Error('BUDGET_EXHAUSTED', 'Delegation requires positive budget', {
        budgetUnits: request.budgetUnits,
      })
    }

    return {
      taskId: this.newTaskId(),
      parentTaskId: request.parentTaskId,
      depth: request.depth + 1,
      task: request.task,
      context: request.context,
      budgetUnits: request.budgetUnits,
    }
  }

  /**
   * Check if a task can delegate further.
   * @param depth - current depth.
   * @returns true if delegation is allowed.
   */
  canDelegate(depth: number): boolean {
    return depth < this.maxDepth
  }
}
