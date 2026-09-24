/**
 * Production CoordinatorDriver for the System 1 read-only workflow.
 *
 * One turn per wake: drain the coordinator inbox into observations, run the
 * real {@link ReadOnlyCoordinator} decision loop (policy filter → Jev
 * decision → admission → calibration gate → dispatch recheck), dispatch the
 * admitted read-only candidate through the coordinator's scoped tool
 * runtime, verify the real tool result, and record the outcome with the
 * shipped `finalizeTerminal` finalizer.
 *
 * Fail-closed: admission failures, policy denials, provider errors,
 * unresolvable tool mappings, tool failures, failed verification, and
 * aborts all end the turn without dispatching. Nothing ever executes on an
 * unadmitted decision.
 *
 * @module @deepseek-ai/dsh-system1-integration/driver
 */

import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type {
  Candidate,
  DecisionProvider,
  ExecutionOutcome,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'
import type {
  CatalogTool,
  Observation,
} from '@deepseek-ai/dsh-system1-observations'
import type {
  CapabilityProfile,
  PolicyEngine,
} from '@deepseek-ai/dsh-system1-policy'
import type { IsotonicCalibration } from '@deepseek-ai/dsh-system1-calibration'
import {
  finalizeTerminal,
  System1RequestId,
} from '@deepseek-ai/dsh-system1-workflow'
import type {
  CoordinatorDriver,
  FinalizerVerification,
  HandoffBundle,
  HandoffHandler,
  HandoffOutcome,
  System1CoordinatorAgent,
} from '@deepseek-ai/dsh-system1-workflow'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { TextBlock, UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import { ReadOnlyCoordinator } from './coordinator.ts'
import type { CoordinatorResult } from './coordinator.ts'

/** A concrete tool call resolved from an admitted candidate. */
export interface ResolvedToolCall {
  /** Registered tool name in the coordinator's scoped tool runtime. */
  readonly name: string
  /** Losslessly JSON-serializable parsed arguments. */
  readonly arguments: unknown
}

/** Real tool result offered to the host verifier. */
export interface ToolVerificationContext {
  /** The admitted candidate that was dispatched. */
  readonly candidate: Candidate
  /** The materialized successful tool execution. */
  readonly result: ToolExecutionSuccess
  /** Receipt reference recorded on the execution outcome. */
  readonly receiptRef: string
}

/** Input for {@link buildEscalationBundle}. */
export interface EscalationBundleInput {
  /** Request id of the escalated turn. */
  readonly requestId: ReturnType<typeof System1RequestId>
  /** Observations drained from the coordinator inbox this turn. */
  readonly observations: readonly Observation[]
  /** The decision that led to escalation. */
  readonly decision: NormalizedDecision
  /** Why the turn escalated. */
  readonly reason: string
  /** Budget for the handoff child. */
  readonly budget: { readonly poolName: string; readonly units: number }
  /** Tenant the escalation belongs to. */
  readonly tenantId: string
}

/**
 * Build the DeepSeek handoff bundle for an escalated turn. The bundle is
 * honest about what the turn established: escalation happens with no tool
 * dispatched, so there are no completed effects and no fresh evidence — the
 * drained observations become the objective and the rejected selection is
 * recorded as a failed choice.
 */
export function buildEscalationBundle(input: EscalationBundleInput): HandoffBundle {
  const objective =
    input.observations.length > 0
      ? input.observations.map((observation) => observation.content).join('\n')
      : `Escalated decision ${input.decision.decisionId}: ${input.reason}`
  return {
    schemaVersion: 1,
    taskId: `${input.requestId}-escalation`,
    objective,
    constraints: [
      `System 1 read-only escalation for tenant ${input.tenantId}`,
      'No System 1 tool is dispatched after escalation',
      `Escalation reason: ${input.reason}`,
    ],
    acceptedFacts: [],
    resourceVersions: {},
    completedEffects: [],
    unknownEffects: [],
    failedChoices: [{ choice: input.decision.selectedId, reason: input.reason }],
    remainingBudget: { poolName: input.budget.poolName, units: input.budget.units },
    verifierRequirements: [],
    returnContract: { requiredArtifacts: [], requiredEvidence: [] },
  }
}

/** Production driver configuration. */
export interface ProductionDriverConfig {
  readonly policy: PolicyEngine
  readonly capabilityProfile: CapabilityProfile
  /** Jev decision provider; only the HTTP boundary is mocked in tests. */
  readonly provider: DecisionProvider
  readonly catalog: readonly CatalogTool[]
  readonly calibration: IsotonicCalibration
  /** Pinned model id; the decision's modelResolved must match exactly. */
  readonly expectedModel: string
  /** Tenant id used for policy evaluation. Never defaults. */
  readonly tenantId: string
  /** Minimum calibrated correctness for execution. Defaults to 0.5. */
  readonly minCalibratedConfidence?: number
  /**
   * Resolve an admitted candidate to a concrete tool call. Returning
   * undefined fails the turn closed: the candidate is never dispatched.
   */
  readonly resolveCall: (candidate: Candidate) => ResolvedToolCall | undefined
  /**
   * Verify a successful tool result against fresh evidence. The returned
   * record backs the success terminal's `verifiedBy`; a failed check
   * finalizes the turn as failure instead of success.
   */
  readonly verify: (ctx: ToolVerificationContext) => FinalizerVerification
  /** Request ID generator (injectable for tests). */
  readonly newRequestId?: () => ReturnType<typeof System1RequestId>
  /** Tool call ID generator (injectable for tests). */
  readonly newCallId?: () => ToolCallId
  /**
   * Optional DeepSeek handoff handler. When set (with `handoffBudget`), an
   * escalated turn invokes the handler with a bundle built from the turn's
   * observation/decision instead of finalizing `escalated` with no
   * transfer of ownership. The handler owns the child lifecycle and
   * budget. Default: unset — escalation keeps the fail-safe `escalated`
   * terminal behavior.
   */
  readonly handoff?: HandoffHandler
  /**
   * Budget for the escalation handoff child, debited from the handler's
   * ledger. Required when `handoff` is set; ignored otherwise.
   */
  readonly handoffBudget?: {
    /** Parent pool the child's budget is reserved from. */
    readonly poolName: string
    /** Units reserved for the child. */
    readonly units: number
  }
}

/** Production driver: one durable read-only turn per wake. */
export class ReadOnlyProductionDriver implements CoordinatorDriver {
  private readonly config: ProductionDriverConfig

  /**
   * @param config - driver configuration.
   * @throws when tenantId or expectedModel is missing.
   */
  constructor(config: ProductionDriverConfig) {
    if (!config.tenantId) {
      throw system1Error('INVALID_CONFIG', 'Production driver requires an explicit tenantId', {})
    }
    if (!config.expectedModel) {
      throw system1Error(
        'INVALID_CONFIG',
        'Production driver requires a pinned expectedModel',
        {},
      )
    }
    if (config.handoff !== undefined) {
      if (config.handoffBudget === undefined) {
        throw system1Error(
          'INVALID_CONFIG',
          'Production driver handoff requires an explicit handoffBudget',
          {},
        )
      }
      if (config.handoffBudget.units <= 0) {
        throw system1Error(
          'INVALID_CONFIG',
          'Production driver handoffBudget.units must be positive',
          { units: config.handoffBudget.units },
        )
      }
    }
    this.config = config
  }

  /**
   * Run one read-only turn for the coordinator.
   * @param coordinator - the coordinator being driven.
   * @param signal - aborts when the coordinator is cancelled or disposed.
   * @returns resolves when the turn settles; the outcome is recorded with
   * the shipped terminal finalizer.
   */
  async run(coordinator: System1CoordinatorAgent, signal: AbortSignal): Promise<void> {
    const newRequestId =
      this.config.newRequestId ??
      (() => System1RequestId(`req-${Date.now()}-${Math.random().toString(36).slice(2)}`))
    const requestId = newRequestId()
    const session = coordinator.session

    if (signal.aborted) {
      finalizeTerminal({
        session,
        requestId,
        outcome: 'cancelled',
        summary: 'Turn aborted before start',
        verifiedBy: [],
        verifications: [],
      })
      return
    }

    const observations = drainInbox(coordinator)

    // The executor captures the real dispatched tool result so the driver
    // can verify fresh evidence before declaring success.
    let dispatched: ToolVerificationContext | undefined
    const inner = new ReadOnlyCoordinator({
      policy: this.config.policy,
      capabilityProfile: this.config.capabilityProfile,
      provider: this.config.provider,
      calibration: this.config.calibration,
      expectedModel: this.config.expectedModel,
      tenantId: this.config.tenantId,
      ...(this.config.minCalibratedConfidence !== undefined
        ? { minCalibratedConfidence: this.config.minCalibratedConfidence }
        : {}),
      executor: {
        execute: async (candidate, execSignal) => {
          const dispatchedOutcome = await this.dispatch(coordinator, candidate, execSignal)
          if (dispatchedOutcome.verification !== undefined) {
            dispatched = dispatchedOutcome.verification
          }
          return dispatchedOutcome.outcome
        },
      },
    })

    let result: CoordinatorResult
    try {
      result = await inner.run({ observations, catalog: this.config.catalog }, signal)
    } catch (error) {
      finalizeTerminal({
        session,
        requestId,
        outcome: 'failure',
        summary: `Turn failed: ${failureSummary(error)}`,
        verifiedBy: [],
        verifications: [],
      })
      return
    }

    if (signal.aborted) {
      finalizeTerminal({
        session,
        requestId,
        outcome: 'cancelled',
        summary: 'Turn aborted after decision',
        verifiedBy: [],
        verifications: [],
      })
      return
    }

    if (result.decision.selectedId === 'escalate-none' || result.outcome === null) {
      await this.escalate(coordinator, requestId, observations, result, signal)
      return
    }

    // A concrete selection always dispatches through the executor above, so
    // a missing captured result (or a non-success outcome) means there is
    // no real evidence to verify: fail closed.
    if (dispatched === undefined || result.outcome.kind !== 'succeeded') {
      finalizeTerminal({
        session,
        requestId,
        outcome: 'failure',
        summary: `Tool execution did not succeed: ${result.decision.selectedId}`,
        verifiedBy: [],
        verifications: [],
      })
      return
    }

    let verification: FinalizerVerification
    try {
      verification = this.config.verify(dispatched)
    } catch (error) {
      finalizeTerminal({
        session,
        requestId,
        outcome: 'failure',
        summary: `Verifier threw: ${failureSummary(error)}`,
        verifiedBy: [],
        verifications: [],
      })
      return
    }
    // Durable evidence: the verification record enters the session log
    // before the terminal event, so getEvidence can retrieve it later.
    session.append('system1/verification', {
      schemaVersion: 1,
      requestId,
      checkId: verification.checkId,
      passed: verification.passed,
      evidence: `tool-call:${dispatched.receiptRef}`,
    })
    if (!verification.passed) {
      finalizeTerminal({
        session,
        requestId,
        outcome: 'failure',
        summary: `Verification failed for check "${verification.checkId}"`,
        verifiedBy: [],
        verifications: [],
      })
      return
    }

    finalizeTerminal({
      session,
      requestId,
      outcome: 'success',
      summary: `Dispatched ${dispatched.candidate.id} (${dispatched.receiptRef})`,
      verifiedBy: [verification.checkId],
      verifications: [verification],
    })
  }

  /**
   * Handle an escalated turn. With no handoff handler configured this keeps
   * the fail-safe behavior: a durable `escalated` terminal with no transfer
   * of ownership. With a handler, the turn's observation/decision is built
   * into a handoff bundle and handed to DeepSeek; the handler owns the
   * child lifecycle and budget. A throwing handler fails the turn closed
   * as `escalated`.
   */
  private async escalate(
    coordinator: System1CoordinatorAgent,
    requestId: ReturnType<typeof System1RequestId>,
    observations: readonly Observation[],
    result: CoordinatorResult,
    signal: AbortSignal,
  ): Promise<void> {
    const session = coordinator.session
    const handler = this.config.handoff
    const budget = this.config.handoffBudget
    if (handler === undefined || budget === undefined) {
      finalizeTerminal({
        session,
        requestId,
        outcome: 'escalated',
        summary: 'Decision escalated; no tool dispatched',
        verifiedBy: [],
        verifications: [],
      })
      return
    }
    const bundle = buildEscalationBundle({
      requestId,
      observations,
      decision: result.decision,
      reason:
        result.decision.selectedId === 'escalate-none'
          ? 'Coordinator selected escalate-none'
          : 'Coordinator produced no executable outcome',
      budget,
      tenantId: this.config.tenantId,
    })
    let outcome: HandoffOutcome
    try {
      outcome = await handler(coordinator, bundle, signal)
    } catch (error) {
      finalizeTerminal({
        session,
        requestId,
        outcome: 'escalated',
        summary: `Escalation handoff threw: ${failureSummary(error)}; no tool dispatched`,
        verifiedBy: [],
        verifications: [],
      })
      return
    }
    if (outcome.kind === 'completed') {
      // The child's evidence enters the session log before the terminal
      // event, so getEvidence can retrieve it later.
      for (const ref of outcome.evidence) {
        session.append('system1/verification', {
          schemaVersion: 1,
          requestId,
          checkId: 'deepseek-handoff',
          passed: true,
          evidence: ref,
        })
      }
      finalizeTerminal({
        session,
        requestId,
        outcome: 'escalated',
        summary:
          `Escalated to DeepSeek; child returned ${outcome.artifacts.length} ` +
          `artifact(s) and ${outcome.evidence.length} evidence ref(s), ` +
          `settling ${outcome.actualUnits} units`,
        verifiedBy: [],
        verifications: [],
      })
      return
    }
    finalizeTerminal({
      session,
      requestId,
      outcome: 'escalated',
      summary: `Escalation handoff failed (${outcome.code}): ${outcome.reason}; no tool dispatched`,
      verifiedBy: [],
      verifications: [],
    })
  }

  /**
   * Dispatch an admitted candidate through the coordinator's scoped tool
   * runtime and materialize the execution outcome.
   * @param coordinator - the coordinator whose scoped tools run the call.
   * @param candidate - the admitted candidate to dispatch.
   * @param signal - abort signal for the tool execution.
   * @returns the execution outcome and, on success, the verification
   * context built from the real tool result.
   */
  private async dispatch(
    coordinator: System1CoordinatorAgent,
    candidate: Candidate,
    signal: AbortSignal,
  ): Promise<{ outcome: ExecutionOutcome; verification?: ToolVerificationContext }> {
    // Defense in depth: the coordinator already filtered the menu to
    // read-only, but the driver never dispatches a non-read candidate even
    // if that filter regresses.
    if (candidate.effect !== 'read') {
      throw system1Error('EFFECT_NOT_ALLOWED', 'Production driver is read-only', {
        candidateId: candidate.id,
        effect: candidate.effect,
      })
    }
    const call = this.config.resolveCall(candidate)
    if (call === undefined) {
      throw system1Error('EXECUTION_FAILED', `No tool mapping for candidate ${candidate.id}`, {
        candidateId: candidate.id,
        operationRef: candidate.operationRef,
      })
    }
    const newCallId =
      this.config.newCallId ??
      (() => ToolCallId(`call-${Date.now()}-${Math.random().toString(36).slice(2)}`))
    const callId = newCallId()
    const result = await coordinator.ctx.tools.execute({
      callId,
      name: call.name,
      arguments: call.arguments,
      agent: coordinator,
      signal,
    })
    if (result.isError) {
      return {
        outcome: {
          kind: 'failed',
          errorCode: result.error.info?.code ?? 'TOOL_EXECUTION_FAILED',
          retryClass: 'none',
        },
      }
    }
    const receiptRef = `tool-call:${callId}`
    return {
      outcome: { kind: 'succeeded', receiptRef, evidenceRefs: [receiptRef] },
      verification: { candidate, result, receiptRef },
    }
  }
}

/**
 * Drain the coordinator inbox into observations, next-step before next-turn.
 * @param coordinator - the coordinator whose inbox is drained.
 * @returns provenance-labelled observations in drain order.
 */
function drainInbox(coordinator: System1CoordinatorAgent): Observation[] {
  const messages: UserMessage[] = [
    ...coordinator.inbox.nextStep,
    ...coordinator.inbox.nextTurn,
  ]
  coordinator.inbox.clear()
  const observations: Observation[] = []
  for (const message of messages) {
    const content = messageText(message)
    if (content.length === 0) continue
    observations.push({
      provenance: { kind: 'user-input' },
      content,
      timestampMs: Date.now(),
    })
  }
  return observations
}

/**
 * Render a user message to observation text.
 * @param message - the message to render.
 * @returns concatenated text blocks; empty when the message carries no text.
 */
function messageText(message: UserMessage): string {
  return message.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Summarize a turn failure without stack traces.
 * @param error - the caught failure.
 * @returns a one-line summary.
 */
function failureSummary(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
