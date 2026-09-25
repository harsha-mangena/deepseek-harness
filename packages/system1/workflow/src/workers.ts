/**
 * Scoped workers: real DeepSeek children with restricted tool capabilities.
 *
 * A worker is a handoff with a narrower sandbox. The worker spec declares the
 * task, the tool capabilities the child may see, and its budget; everything
 * else flows through the shared handoff machinery:
 *
 * - Delegation pre-checks (depth tracking, positive budget) come from the
 *   existing {@link DelegationManager} — workers never reimplement them.
 * - Child creation, budget reservation/settlement/release, lineage metadata,
 *   cancellation propagation, and return validation come from
 *   {@link handoffToDeepSeek}.
 * - Tool scoping is enforced by the platform's `tools.restrict()` inside the
 *   child's unpublished setup scope: the child only ever sees the spec's
 *   capabilities, and unknown capability names fail loudly at setup.
 *
 * Workers share the parent's budget pool and cancellation signal, so a
 * cancelled parent always cancels its workers. Holds for work that never
 * started release; holds for work that may have started are retained for
 * reconciliation, never released free.
 *
 * @module @deepseek-ai/dsh-system1-workflow/workers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import { DelegationManager, type DelegatedTask } from '@deepseek-ai/dsh-system1-delegation'
import { System1Error, type System1ErrorCode } from '@deepseek-ai/dsh-system1-contracts'

import type { System1CoordinatorAgent } from './coordinator-agent.ts'
import {
  HANDOFF_SCHEMA_VERSION,
  handoffToDeepSeek,
  type HandoffBudgetLedger,
  type HandoffBundle,
  type HandoffChildLimits,
  type HandoffOutcome,
  type HandoffReturnContract,
} from './handoff.ts'

/** Specification for one scoped worker. */
export interface WorkerSpec {
  /** Stable id for this worker's task. */
  readonly taskId: string
  /** The objective, in the worker's own terms. */
  readonly objective: string
  /** Hard constraints the worker must respect. */
  readonly constraints?: readonly string[]
  /**
   * Global tool names the worker may see. Everything else is restricted
   * away; unknown names fail loudly at setup (fail-closed).
   */
  readonly capabilities: readonly string[]
  /** Budget units the worker may consume from the shared pool. */
  readonly budgetUnits: number
  /** What the worker's result must contain. */
  readonly returnContract: HandoffReturnContract
  /** Enforceable limits for the worker child. */
  readonly limits?: WorkerLimits
}

/**
 * Enforceable limits for a worker child. Every limit here is actually
 * enforced: the token cap travels in the child's agent options (the
 * provider adapter enforces it), the deadline cancels the child and is
 * recorded on the budget reservation, and the step bound cancels the child
 * through its own cancel path when its session exceeds the bound.
 */
export interface WorkerLimits {
  /**
   * Per-request output token cap. Must be a positive integer.
   */
  readonly maxTokens?: number
  /**
   * Wall-clock deadline for the worker run, in milliseconds from now.
   * Must be a positive finite duration.
   */
  readonly deadlineMs?: number
  /**
   * Maximum model steps the worker child may run. Must be a positive integer.
   */
  readonly maxSteps?: number
}

/** Explicit capabilities a worker needs; nothing is inferred. */
export interface WorkerOptions {
  /** Tenant owning the shared budget pool. */
  readonly tenantId: string
  /** Parent pool the worker's budget is reserved from. */
  readonly poolName: string
  /** Budget ledger; the production wiring passes the coordination store. */
  readonly ledger: HandoffBudgetLedger
  /** Existing delegation machinery for depth/budget pre-checks. */
  readonly delegation: DelegationManager
  /** Task id of the delegating parent. */
  readonly parentTaskId: string
  /** Decision id of the delegating parent (defaults to the worker task id). */
  readonly parentDecisionId?: string
  /** Delegation depth of the caller; the worker is created at `+1`. */
  readonly parentDepth?: number
  /** Child session id generator (injectable for deterministic tests). */
  readonly newSessionId?: () => SessionId
}

/** Outcome of {@link spawnWorker}. Never throws for expected failures. */
export type WorkerOutcome =
  | {
      readonly kind: 'completed'
      /** Validated artifact references returned by the worker. */
      readonly artifacts: readonly string[]
      /** Validated evidence references returned by the worker. */
      readonly evidence: readonly string[]
      /** Budget units settled against the shared pool. */
      readonly actualUnits: number
    }
  | {
      readonly kind: 'failed'
      /** Typed failure; one of the System 1 error codes. */
      readonly code: System1ErrorCode
      /** Human-readable reason; safe to surface. */
      readonly reason: string
    }

/**
 * Spawn a scoped DeepSeek worker as a real child agent of the coordinator.
 *
 * The delegation manager assigns the worker's task id and depth and enforces
 * the depth/budget pre-checks; the handoff then creates the child with its
 * tool capabilities restricted to the spec. The worker's budget is reserved
 * from the shared pool, settled against measured usage on success, and
 * released on failure or cancellation.
 *
 * @param coordinator - the System 1 coordinator owning the worker.
 * @param spec - the worker specification.
 * @param signal - parent cancellation signal, propagated to the worker.
 * @param options - explicit delegation/budget/session capabilities.
 */
export async function spawnWorker(
  coordinator: System1CoordinatorAgent,
  spec: WorkerSpec,
  signal: AbortSignal,
  options: WorkerOptions,
): Promise<WorkerOutcome> {
  const parentDepth = options.parentDepth ?? 0

  // Worker limits are enforceable bounds, validated before delegation: a
  // bad limit fails closed without touching the ledger or the registry.
  const limitsResult = workerChildLimits(spec.limits)
  if (limitsResult.kind === 'failed') return limitsResult.outcome
  const childLimits = limitsResult.limits

  // The existing delegation machinery owns depth tracking and the budget
  // pre-check; a refusal here never touches the budget ledger or the agent
  // registry.
  let task: DelegatedTask
  try {
    task = options.delegation.delegate({
      parentTaskId: options.parentTaskId,
      parentDecisionId: options.parentDecisionId ?? spec.taskId,
      depth: parentDepth,
      task: spec.objective,
      context: spec.constraints?.join('\n') ?? '',
      budgetUnits: spec.budgetUnits,
    })
  } catch (error) {
    const code = error instanceof System1Error ? error.code : 'EXECUTION_FAILED'
    return { kind: 'failed', code, reason: `Worker delegation refused: ${describeError(error)}` }
  }

  const bundle: HandoffBundle = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    taskId: task.taskId,
    objective: spec.objective,
    constraints: spec.constraints ?? [],
    acceptedFacts: [],
    resourceVersions: {},
    completedEffects: [],
    unknownEffects: [],
    failedChoices: [],
    remainingBudget: { poolName: options.poolName, units: task.budgetUnits },
    verifierRequirements: [],
    returnContract: spec.returnContract,
  }

  const outcome: HandoffOutcome = await handoffToDeepSeek(coordinator, bundle, signal, {
    tenantId: options.tenantId,
    ledger: options.ledger,
    parentDepth,
    // exactOptionalPropertyTypes: an absent generator must stay absent.
    ...(options.newSessionId !== undefined ? { newSessionId: options.newSessionId } : {}),
    // Worker limits become enforceable child limits: the token cap reaches
    // the child's agent options, the deadline cancels the child and is
    // recorded on the budget reservation, and the step bound watches the
    // child's session and cancels it past the bound.
    ...(childLimits !== undefined ? { childLimits } : {}),
    setupExtras: (agentCtx) => {
      // The worker sandbox: restrict the child's scoped tools to exactly the
      // spec's capabilities. Runs inside the child's unpublished setup scope.
      restrictWorkerTools(agentCtx, spec.capabilities)
    },
  })

  if (outcome.kind === 'completed') {
    return {
      kind: 'completed',
      artifacts: outcome.artifacts,
      evidence: outcome.evidence,
      actualUnits: outcome.actualUnits,
    }
  }
  return outcome
}

/**
 * Restrict the child's scoped tools to the worker's capabilities. Kept
 * separate so the restriction filter is trivially auditable.
 */
function restrictWorkerTools(agentCtx: Context, capabilities: readonly string[]): void {
  const filter: ToolRestriction = { allow: [...capabilities] }
  agentCtx.tools.restrict(filter)
}

/**
 * Validate worker limits and map them to enforceable child limits.
 * @param limits - the spec's limits, if any.
 * @returns the child limits, or a fail-closed worker outcome.
 */
function workerChildLimits(limits: WorkerLimits | undefined):
  | { readonly kind: 'ok'; readonly limits: HandoffChildLimits | undefined }
  | { readonly kind: 'failed'; readonly outcome: WorkerOutcome } {
  if (limits === undefined) return { kind: 'ok', limits: undefined }
  let maxTokens: number | undefined
  let deadlineAt: number | undefined
  let maxSteps: number | undefined
  if (limits.maxTokens !== undefined) {
    if (!Number.isInteger(limits.maxTokens) || limits.maxTokens <= 0) {
      return {
        kind: 'failed',
        outcome: {
          kind: 'failed',
          code: 'INVALID_CONFIG',
          reason: `Worker maxTokens must be a positive integer, got ${limits.maxTokens}`,
        },
      }
    }
    maxTokens = limits.maxTokens
  }
  if (limits.deadlineMs !== undefined) {
    if (!Number.isFinite(limits.deadlineMs) || limits.deadlineMs <= 0) {
      return {
        kind: 'failed',
        outcome: {
          kind: 'failed',
          code: 'INVALID_CONFIG',
          reason: `Worker deadlineMs must be a positive finite duration, got ${limits.deadlineMs}`,
        },
      }
    }
    deadlineAt = Date.now() + limits.deadlineMs
  }
  if (limits.maxSteps !== undefined) {
    if (!Number.isInteger(limits.maxSteps) || limits.maxSteps <= 0) {
      return {
        kind: 'failed',
        outcome: {
          kind: 'failed',
          code: 'INVALID_CONFIG',
          reason: `Worker maxSteps must be a positive integer, got ${limits.maxSteps}`,
        },
      }
    }
    maxSteps = limits.maxSteps
  }
  if (maxTokens === undefined && deadlineAt === undefined && maxSteps === undefined) {
    return { kind: 'ok', limits: undefined }
  }
  return {
    kind: 'ok',
    limits: {
      // exactOptionalPropertyTypes: absent limits stay absent.
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
    },
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
