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
 * Execution posture is fixed at construction via {@link ProductionDriverConfig.mode},
 * threaded from the workflow plugin's resolved mode. In `shadow` mode the
 * driver runs the decision pipeline only: it records the decision as an
 * advisory `system1/decision` suggestion event and never dispatches a tool
 * or spawns a handoff worker — the baseline DeepSeek path owns execution.
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
import type { Session } from '@deepseek-ai/dsh-session'
import {
  finalizeTerminal,
  System1RequestId,
} from '@deepseek-ai/dsh-system1-workflow'
import type {
  CoordinatorDriver,
  FinalizerVerification,
  HandoffBudgetLedger,
  HandoffBundle,
  HandoffHandler,
  HandoffOutcome,
  System1CoordinatorAgent,
  System1Mode,
} from '@deepseek-ai/dsh-system1-workflow'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { TextBlock, UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import { ReadOnlyCoordinator } from './coordinator.ts'
import type { CoordinatorResult } from './coordinator.ts'
import {
  finalizeOnce,
  nextToolStep,
  recordDispatchPlan,
  recordToolEvidence,
  resolveCheckEvidence,
  resolveHandoffRefs,
  serializeArguments,
} from './evidence.ts'
import type {
  EvidenceSpillStore,
  ResolvedToolCall,
  SpilledEvidenceRef,
} from './evidence.ts'

/** Real tool result offered to the host verifier. */
export interface ToolVerificationContext {
  /** The admitted candidate that was dispatched. */
  readonly candidate: Candidate
  /** The materialized successful tool execution. */
  readonly result: ToolExecutionSuccess
  /** Receipt reference recorded on the execution outcome. */
  readonly receiptRef: string
  /** Evidence hash of the sanitized tool result persisted as `tool/result`. */
  readonly evidenceHash: string
  /** Spill reference, when the oversized result spilled by reference. */
  readonly spilled?: SpilledEvidenceRef
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

/** Budget accounting for the driver's own Jev and tool spend. */
export interface DriverBudgetConfig {
  /**
   * Budget ledger; the production wiring passes the coordination store.
   * Uncertain spend is retained through the ledger's optional
   * `holdForReconciliation`; ledgers without it leave the reservation
   * active as an implicit hold.
   */
  readonly ledger: HandoffBudgetLedger
  /** Pool the driver's reservations draw from. */
  readonly poolName: string
  /**
   * Units reserved per Jev decision request. Must cover the worst-case
   * metered usage below: the reservation settles from provider-reported
   * token usage (host-observed transport telemetry, never model content),
   * and usage above the reservation fails closed or is held.
   */
  readonly jevRequestUnits: number
  /** Units reserved per tool call; settled in full when the call executes. */
  readonly toolCallUnits: number
  /**
   * Convert provider-reported usage to settled units. Defaults to
   * `inputTokens + outputTokens`: units are tokens unless the deployment
   * defines otherwise. Must return a non-negative integer, or `null`
   * when usage is unknown (a null count means the provider did not
   * report it — settling 0 would release real spend free). A null
   * return, a throw, or an out-of-range value retains the reservation
   * as a reconciliation hold.
   */
  readonly meterJevUsage?: (usage: {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
  }) => number | null
  /** Reservation deadline (ms since epoch), applied to driver reservations. */
  readonly deadlineAt?: number
}

/** Production driver configuration. */
export interface ProductionDriverConfig {
  /**
   * Execution posture for this driver instance. Thread the workflow
   * plugin's resolved mode here (`workflows.config.mode`); the driver
   * never reads ambient plugin state. `shadow` records advisory
   * suggestions with no execution capability; `enforce` dispatches
   * admitted decisions. `off` is rejected: while the plugin is off,
   * coordinator creation is refused and no driver should be constructed.
   */
  readonly mode: System1Mode
  readonly policy: PolicyEngine
  readonly capabilityProfile: CapabilityProfile
  /** Jev decision provider; only the HTTP boundary is mocked in tests. */
  readonly provider: DecisionProvider
  readonly catalog: readonly CatalogTool[]
  readonly calibration: IsotonicCalibration
  /** Pinned model id; the decision's modelResolved must match exactly. */
  readonly expectedModel: string
  /**
   * Authenticated tenant identity from admission, for policy evaluation.
   * Never defaults. The capability profile must be issued to this same
   * tenant; the engine rejects any mismatch (`TENANT_MISMATCH`) at the
   * authoritative dispatch decision, before effects, routes, or guards.
   */
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
  /**
   * Optional budget accounting for the driver's own Jev and tool spend.
   * When set, every Jev decision request and every tool call reserves
   * from `budget.poolName` before the operation and settles from
   * host-observed usage after it. Uncertain spend is retained as a
   * reconciliation hold, never released free.
   */
  readonly budget?: DriverBudgetConfig
}

/** Production driver: one durable read-only turn per wake. */
export class ReadOnlyProductionDriver implements CoordinatorDriver {
  private readonly config: ProductionDriverConfig

  /**
   * @param config - driver configuration.
   * @throws when mode, tenantId, or expectedModel is missing, or when
   * mode is `off`.
   */
  constructor(config: ProductionDriverConfig) {
    if (config.mode === undefined) {
      throw system1Error('INVALID_CONFIG', 'Production driver requires an explicit mode', {})
    }
    if (config.mode === 'off') {
      throw system1Error(
        'INVALID_CONFIG',
        'Production driver cannot run with mode "off"; do not construct a System 1 driver while the workflow plugin is off',
        {},
      )
    }
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
    if (config.budget !== undefined) {
      validateBudgetConfig(config.budget)
    }
    this.config = config
  }

  /**
   * Run one read-only turn for the coordinator. In `shadow` mode the turn
   * records an advisory suggestion and never dispatches; in `enforce`
   * mode the admitted candidate is dispatched and verified.
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

    // The execution posture is enforced at this dispatch boundary: in
    // shadow mode the turn records an advisory suggestion and never
    // dispatches, so the baseline DeepSeek path owns execution.
    if (this.config.mode === 'shadow') {
      await this.runShadow(coordinator, requestId, observations, signal)
      return
    }

    // The executor captures the real dispatched tool result so the driver
    // can verify fresh evidence before declaring success. The provider
    // wrapper captures the normalized decision the coordinator admitted,
    // so the executor can record admission, decision identity, and the
    // execution intent before anything dispatches.
    let dispatched: ToolVerificationContext | undefined
    const decisionHolder: { decision?: NormalizedDecision } = {}
    const inner = new ReadOnlyCoordinator({
      policy: this.config.policy,
      capabilityProfile: this.config.capabilityProfile,
      provider: this.capturingProvider(this.meteredProvider(requestId), decisionHolder),
      calibration: this.config.calibration,
      expectedModel: this.config.expectedModel,
      tenantId: this.config.tenantId,
      ...(this.config.minCalibratedConfidence !== undefined
        ? { minCalibratedConfidence: this.config.minCalibratedConfidence }
        : {}),
      executor: {
        execute: async (candidate, execSignal) => {
          const captured = decisionHolder.decision
          /* v8 ignore next -- defensive: the coordinator decides before it dispatches */
          if (captured === undefined) {
            throw system1Error(
              'ILLEGAL_STATE_TRANSITION',
              'dispatch ran without a captured provider decision',
              { requestId },
            )
          }
          const dispatchedOutcome = await this.dispatch(
            coordinator,
            requestId,
            candidate,
            captured,
            execSignal,
          )
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
      finalizeOnce({
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
      finalizeOnce({
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
      finalizeOnce({
        session,
        requestId,
        outcome: 'failure',
        summary: `Tool execution did not succeed: ${result.decision.selectedId}`,
        verifiedBy: [],
        verifications: [],
      })
      return
    }

    // The required verifier policy is resolved from the admitted
    // candidate on every turn — never cached, never trusted from the
    // caller. Without one the tool result cannot be verified: fail closed.
    const requiredPolicy = dispatched.candidate.verificationPolicyId.trim()
    if (requiredPolicy.length === 0) {
      finalizeOnce({
        session,
        requestId,
        outcome: 'failure',
        summary:
          `No verification policy for candidate ${dispatched.candidate.id}; ` +
          `cannot verify the tool result`,
        verifiedBy: [],
        verifications: [],
      })
      return
    }

    let verification: FinalizerVerification
    try {
      verification = this.config.verify(dispatched)
    } catch (error) {
      finalizeOnce({
        session,
        requestId,
        outcome: 'failure',
        summary: `Verifier threw: ${failureSummary(error)}`,
        verifiedBy: [],
        verifications: [],
      })
      return
    }
    // Durable evidence: the verification record and its evidence binding
    // (the verifier version and the checked resource versions) enter the
    // session log before the terminal event, so the finalizer resolves
    // stored records instead of trusting caller-supplied booleans.
    session.append('system1/verification', {
      schemaVersion: 1,
      requestId,
      checkId: verification.checkId,
      passed: verification.passed,
      evidence: dispatched.receiptRef,
    })
    session.append('system1/evidence-binding', {
      schemaVersion: 1,
      requestId,
      checkId: verification.checkId,
      verifierVersion: requiredPolicy,
      resourceVersions: { [dispatched.receiptRef]: dispatched.evidenceHash },
      ...(dispatched.spilled === undefined ? {} : { spill: dispatched.spilled }),
    })
    if (!verification.passed) {
      finalizeOnce({
        session,
        requestId,
        outcome: 'failure',
        summary: `Verification failed for check "${verification.checkId}"`,
        verifiedBy: [],
        verifications: [],
      })
      return
    }
    // Finalize from the stored projection: the check backing success is
    // re-read from the session log and must cite the dispatched receipt
    // with matching evidence. Missing or stale evidence cannot produce
    // success.
    const resolution = resolveCheckEvidence(session, requestId, [
      {
        checkId: verification.checkId,
        expectedReceiptRef: dispatched.receiptRef,
        expectedHash: dispatched.evidenceHash,
        expectedTenantId: this.config.tenantId,
      },
    ])
    /* v8 ignore next -- defensive: the driver persisted the verification and tool/result above, so resolution cannot fail here; the resolver's failure modes are unit-tested */
    if (!resolution.ok) {
      finalizeOnce({
        session,
        requestId,
        outcome: 'failure',
        summary: `Stored evidence did not resolve: ${resolution.reason}`,
        verifiedBy: [],
        verifications: [],
      })
      return
    }

    finalizeOnce({
      session,
      requestId,
      outcome: 'success',
      summary:
        `Dispatched ${dispatched.candidate.id} (${dispatched.receiptRef}); ` +
        `check "${verification.checkId}" passed under policy ${requiredPolicy}`,
      verifiedBy: [verification.checkId],
      verifications: resolution.checks.map((check) => check.verification),
    })
  }

  /**
   * Wrap the configured provider with budget accounting. Without a budget
   * config this is the raw provider. With one, every decision request
   * reserves `jevRequestUnits` from the pool before the provider call,
   * under a per-call operation id (`<requestId>:jev-decide:<decisionId>`)
   * linked to the owning request and the coordinator's decision identity,
   * and settles from the host-observed token usage after it — never from
   * model-claimed content. A failed or aborted call, an unmetered usage
   * report (the provider did not report counts), a throwing meter, or a
   * usage figure that fails validation retains the reservation as a
   * reconciliation hold; the hold releases only when no request left the
   * host (reservation failure itself, or the decision never ran).
   * @param requestId - the workflow request id owning the turn.
   * @returns the (possibly metered) provider.
   */
  private meteredProvider(requestId: ReturnType<typeof System1RequestId>): DecisionProvider {
    const budget = this.config.budget
    if (budget === undefined) return this.config.provider
    const provider = this.config.provider
    const tenantId = this.config.tenantId
    const meter = budget.meterJevUsage ?? defaultJevMeter
    return {
      decide: async (input, signal) => {
        // The coordinator mints a fresh decisionId per decide call
        // (time+random by default), so the operation id is unique per
        // call even across process restarts — no local sequence needed.
        const operationId = `${requestId}:jev-decide:${input.decisionId}`
        let reservationId: string
        try {
          reservationId = budget.ledger.reserve(
            tenantId,
            budget.poolName,
            operationId,
            budget.jevRequestUnits,
            budget.deadlineAt,
          ).reservationId
        } catch (error) {
          throw system1Error(
            'BUDGET_EXHAUSTED',
            `Decision budget reservation failed: ${failureSummary(error)}`,
            { requestId },
          )
        }
        let decision: NormalizedDecision
        try {
          decision = await provider.decide(input, signal)
        } catch (error) {
          retainLedgerHold(
            budget.ledger,
            reservationId,
            budget.jevRequestUnits,
            `Jev decision request failed: ${failureSummary(error)}`,
          )
          throw error
        }
        let usage: number | null
        try {
          usage = meter(decision.usage)
        } catch (error) {
          retainLedgerHold(
            budget.ledger,
            reservationId,
            budget.jevRequestUnits,
            `Jev usage meter threw: ${failureSummary(error)}`,
          )
          return decision
        }
        if (
          usage === null ||
          !Number.isInteger(usage) ||
          usage < 0 ||
          usage > budget.jevRequestUnits
        ) {
          retainLedgerHold(
            budget.ledger,
            reservationId,
            budget.jevRequestUnits,
            `Unmetered or out-of-range Jev usage for decision ${decision.decisionId}`,
          )
          return decision
        }
        try {
          budget.ledger.settle(reservationId, usage)
        } catch (error) {
          retainLedgerHold(
            budget.ledger,
            reservationId,
            budget.jevRequestUnits,
            `Jev usage settlement failed: ${failureSummary(error)}`,
          )
        }
        return decision
      },
    }
  }

  /**
   * Wrap a provider to capture the normalized decision it returns for the
   * turn. The coordinator decides before it dispatches, so the executor
   * can record admission, decision identity, and execution intent before
   * anything executes.
   * @param provider - the (possibly metered) provider to wrap.
   * @param holder - receives the decision from the turn's `decide` call.
   * @returns a provider that captures and forwards the decision.
   */
  private capturingProvider(
    provider: DecisionProvider,
    holder: { decision?: NormalizedDecision },
  ): DecisionProvider {
    return {
      decide: async (input, signal) => {
        const decision = await provider.decide(input, signal)
        holder.decision = decision
        return decision
      },
    }
  }

  /**
   * Run one shadow-mode turn: the decision pipeline runs over a bounded
   * copy of the drained observations and the admitted decision is
   * recorded as an advisory `system1/decision` suggestion event. The
   * shadow path has no execution capability — the executor below refuses
   * unconditionally (defense in depth; `decide()` never invokes it), no
   * DeepSeek handoff worker is spawned, and nothing is dispatched. The
   * baseline DeepSeek path owns execution.
   * @param coordinator - the coordinator being driven.
   * @param requestId - the workflow request for this turn.
   * @param observations - the bounded observation copy for the turn.
   * @param signal - aborts when the coordinator is cancelled or disposed.
   * @returns resolves when the suggestion is recorded.
   */
  private async runShadow(
    coordinator: System1CoordinatorAgent,
    requestId: ReturnType<typeof System1RequestId>,
    observations: readonly Observation[],
    signal: AbortSignal,
  ): Promise<void> {
    const session: Session = coordinator.session
    const inner = new ReadOnlyCoordinator({
      policy: this.config.policy,
      capabilityProfile: this.config.capabilityProfile,
      provider: this.meteredProvider(requestId),
      calibration: this.config.calibration,
      expectedModel: this.config.expectedModel,
      tenantId: this.config.tenantId,
      ...(this.config.minCalibratedConfidence !== undefined
        ? { minCalibratedConfidence: this.config.minCalibratedConfidence }
        : {}),
      executor: {
        // Unreachable through decide(): shadow mode never dispatches.
        // Refuses fail-closed so a future pipeline restructure cannot
        // silently gain execution capability here.
        /* istanbul ignore next -- defense in depth: shadow never dispatches, so this executor is unreachable */
        execute: async (candidate) => {
          throw system1Error(
            'EFFECT_NOT_ALLOWED',
            'Shadow mode never dispatches System 1 tools',
            { candidateId: candidate.id },
          )
        },
      },
    })

    let decided: Awaited<ReturnType<ReadOnlyCoordinator['decide']>>
    try {
      decided = await inner.decide({ observations, catalog: this.config.catalog }, signal)
    } catch (error) {
      finalizeTerminal({
        session,
        requestId,
        outcome: 'failure',
        summary: `Shadow suggestion failed: ${failureSummary(error)}`,
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
        summary: 'Shadow turn aborted after decision',
        verifiedBy: [],
        verifications: [],
      })
      return
    }

    const { decision, selected } = decided
    const confidence: number | undefined =
      decision.calibratedCorrectness ?? decision.vendorConfidence ?? undefined
    // Admission pinned modelResolved to the expected model; the fallback
    // only satisfies the event's non-null model field.
    const model: string = decision.modelResolved ?? this.config.expectedModel
    if (selected === null) {
      session.append('system1/decision', {
        schemaVersion: 1,
        requestId,
        primitive: 'noul',
        noulReason: 'escalate-none: advisory suggestion only; baseline DeepSeek path owns execution',
        model,
      })
    } else {
      session.append('system1/decision', {
        schemaVersion: 1,
        requestId,
        primitive: 'choice',
        candidateId: selected.id,
        ...(confidence !== undefined ? { confidence } : {}),
        model,
      })
    }
    finalizeTerminal({
      session,
      requestId,
      outcome: 'escalated',
      summary:
        `Shadow mode: recorded suggestion for decision ${decision.decisionId} ` +
        `(${selected?.id ?? 'escalate-none'}); baseline DeepSeek path owns execution; ` +
        `no System 1 tool dispatched`,
      verifiedBy: [],
      verifications: [],
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
      // Handoff evidence references resolve against the bundle's return
      // contract before they are accepted: only well-formed,
      // contract-satisfying references are recorded as passing
      // verification evidence. Unresolved references are recorded as
      // failed so they can never back a success claim.
      const resolutions = resolveHandoffRefs(bundle, outcome)
      for (const resolution of resolutions) {
        session.append('system1/verification', {
          schemaVersion: 1,
          requestId,
          checkId: 'deepseek-handoff',
          passed: resolution.resolved,
          evidence: resolution.ref,
        })
      }
      const unresolved = resolutions.filter((resolution) => !resolution.resolved)
      finalizeTerminal({
        session,
        requestId,
        outcome: 'escalated',
        summary:
          unresolved.length === 0
            ? `Escalated to DeepSeek; child returned ${outcome.artifacts.length} ` +
              `artifact(s) and ${outcome.evidence.length} evidence ref(s), ` +
              `settling ${outcome.actualUnits} units`
            : `Escalated to DeepSeek with ${unresolved.length} unresolved evidence ref(s): ` +
              `${unresolved.map((resolution) => resolution.reason ?? resolution.ref).join('; ')}; ` +
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
   * runtime and materialize the execution outcome. With a budget config,
   * the call reserves `toolCallUnits` before the tool runs and settles
   * the full reservation when the tool executes — host-observed tool
   * execution is the usage measure. A tool failure or a mid-call abort
   * retains the reservation as a reconciliation hold instead of releasing
   * it free; the hold releases only when the tool never ran.
   * @param coordinator - the coordinator whose scoped tools run the call.
   * @param requestId - the workflow request id owning the turn.
   * @param candidate - the admitted candidate to dispatch.
   * @param decision - the captured provider decision the candidate was admitted under.
   * @param signal - abort signal for the tool execution.
   * @returns the execution outcome and, on success, the verification
   * context built from the real tool result.
   */
  private async dispatch(
    coordinator: System1CoordinatorAgent,
    requestId: ReturnType<typeof System1RequestId>,
    candidate: Candidate,
    decision: NormalizedDecision,
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
    const session = coordinator.session
    // Durable pre-dispatch evidence: admission, decision identity, the
    // approved operation/argument digest, the attempt, and execution
    // intent are all recorded before the tool runs.
    const argsJson = serializeArguments(call.arguments)
    recordDispatchPlan(session, {
      requestId,
      candidate,
      decision,
      callName: call.name,
      argsJson,
      expectedModel: this.config.expectedModel,
    })
    const budget = this.config.budget
    // The tool call id is minted before the reservation so the budget
    // reservation links to the stable operation id of this exact call.
    const newCallId =
      this.config.newCallId ??
      (() => ToolCallId(`call-${Date.now()}-${Math.random().toString(36).slice(2)}`))
    const callId = newCallId()
    let reservationId: string | undefined
    if (budget !== undefined) {
      try {
        reservationId = budget.ledger.reserve(
          this.config.tenantId,
          budget.poolName,
          callId,
          budget.toolCallUnits,
          budget.deadlineAt,
        ).reservationId
      } catch (error) {
        throw system1Error(
          'BUDGET_EXHAUSTED',
          `Tool call budget reservation failed: ${failureSummary(error)}`,
          { requestId, candidateId: candidate.id },
        )
      }
    }
    const settleTool = (): void => {
      if (budget === undefined || reservationId === undefined) return
      try {
        budget.ledger.settle(reservationId, budget.toolCallUnits)
      } catch (error) {
        retainLedgerHold(
          budget.ledger,
          reservationId,
          budget.toolCallUnits,
          `Tool call settlement failed: ${failureSummary(error)}`,
        )
      }
    }
    // The tool may have run before throwing: retain the reservation as a
    // hold instead of releasing it free.
    const result = await coordinator.ctx.tools
      .execute({
        callId,
        name: call.name,
        arguments: call.arguments,
        agent: coordinator,
        signal,
      })
      .catch((error: unknown) => {
        if (budget !== undefined && reservationId !== undefined) {
          retainLedgerHold(
            budget.ledger,
            reservationId,
            budget.toolCallUnits,
            `Tool call threw: ${failureSummary(error)}`,
          )
        }
        throw error
      })
    // The tool executed (error or not): its spend is real. A tool-level
    // error return still ran the call, so it settles; only a throw above
    // leaves spend uncertain.
    settleTool()
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
    // Durable evidence: the tool call and the real sanitized tool result
    // enter the session log before verification, so the verifier and the
    // finalizer both resolve stored records. Oversized results spill by
    // reference through the coordinator context's spill store when one is
    // loaded; the store is best-effort and the inline evidence stays
    // bounded either way.
    const { turn, step } = nextToolStep(session)
    const spillStore: EvidenceSpillStore | undefined =
      coordinator.ctx.get('spillStore') ?? undefined
    const { evidenceHash, spilled } = await recordToolEvidence(session, {
      turn,
      step,
      callId,
      name: call.name,
      argsJson,
      result,
      ...(spillStore === undefined
        ? {}
        : { spill: { store: spillStore, tenantId: this.config.tenantId } }),
    })
    return {
      outcome: { kind: 'succeeded', receiptRef, evidenceRefs: [receiptRef] },
      verification: {
        candidate,
        result,
        receiptRef,
        evidenceHash,
        ...(spilled === undefined ? {} : { spilled }),
      },
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

/**
 * Default Jev usage meter: input tokens plus output tokens. A null
 * count means the provider did not report that side, so usage is
 * unknown and the reservation is retained as a hold — never settled
 * at 0. The counts come from the provider adapter's transport
 * telemetry (host-observed), never from model content.
 * @param usage - the provider-reported token usage.
 * @returns total tokens as whole units, or null when unmetered.
 */
function defaultJevMeter(usage: {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
}): number | null {
  if (usage.inputTokens === null || usage.outputTokens === null) return null
  return usage.inputTokens + usage.outputTokens
}

/**
 * Retain a reservation as a reconciliation hold. Best-effort: ledgers
 * without explicit hold support leave the reservation active, which is
 * itself a hold until settled or released by reconciliation.
 * @param ledger - the budget ledger.
 * @param reservationId - the live reservation.
 * @param claimedUnits - advisory claimed usage.
 * @param reason - why the spend is uncertain.
 */
function retainLedgerHold(
  ledger: HandoffBudgetLedger,
  reservationId: string,
  claimedUnits: number,
  reason: string,
): void {
  try {
    ledger.holdForReconciliation?.(reservationId, claimedUnits, reason)
  } catch {
    // The reservation stays active as an implicit hold.
  }
}

/**
 * Validate the driver budget config at construction: misconfiguration
 * fails loud, never silently runs unmetered.
 * @param budget - the budget config to validate.
 * @throws an Error describing the first violation.
 */
function validateBudgetConfig(budget: DriverBudgetConfig): void {
  if (!budget.poolName) {
    throw new Error('system1 misconfiguration: budget.poolName must be a non-empty pool name')
  }
  for (const [field, value] of [
    ['jevRequestUnits', budget.jevRequestUnits],
    ['toolCallUnits', budget.toolCallUnits],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `system1 misconfiguration: budget.${field} must be a positive integer, got ${value}`,
      )
    }
  }
  if (budget.deadlineAt !== undefined && !Number.isFinite(budget.deadlineAt)) {
    throw new Error(
      `system1 misconfiguration: budget.deadlineAt must be a finite timestamp, got ${budget.deadlineAt}`,
    )
  }
}
