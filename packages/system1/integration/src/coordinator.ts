/**
 * System 1 read-only coordinator: end-to-end viable integration.
 *
 * Orchestrates the full decision loop for read-only work:
 * observations → candidate menu → policy filter → Jev decision →
 * admission → calibration gate → policy recheck → read-only execution.
 *
 * Write/mutate candidates are rejected at the coordinator boundary.
 * Every concrete selection passes through {@link admitDecision} before
 * execution: correlation, model pinning, menu membership, and the
 * calibration gate are all enforced. Unsupported mutation routes stay
 * disabled.
 *
 * @module @deepseek-ai/dsh-system1-integration/coordinator
 */

import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type {
  Candidate,
  DecisionInput,
  ExecutionOutcome,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'
import { hashObservations, synthesizeObservations } from '@deepseek-ai/dsh-system1-observations'
import type {
  CatalogTool,
  Observation,
} from '@deepseek-ai/dsh-system1-observations'
import { generateCandidateMenu } from '@deepseek-ai/dsh-system1-observations'
import type { PolicyEngine, CapabilityProfile } from '@deepseek-ai/dsh-system1-policy'
import type { DecisionProvider } from '@deepseek-ai/dsh-system1-contracts'
import { calibrate } from '@deepseek-ai/dsh-system1-calibration'
import type { IsotonicCalibration } from '@deepseek-ai/dsh-system1-calibration'

/** Read-only tool executor (injected by host). */
export interface ReadOnlyExecutor {
  /**
   * Execute a read-only candidate.
   * @param candidate - the candidate to execute (effect must be 'read').
   * @param signal - abort signal.
   * @returns the execution outcome.
   */
  execute(candidate: Candidate, signal: AbortSignal): Promise<ExecutionOutcome>
}

/** Coordinator configuration. */
export interface CoordinatorConfig {
  readonly policy: PolicyEngine
  readonly capabilityProfile: CapabilityProfile
  readonly provider: DecisionProvider
  readonly executor: ReadOnlyExecutor
  /**
   * Calibration used to gate execution. Required: a concrete selection
   * cannot be admitted without a bound calibration to gate it against.
   */
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
  /**
   * Minimum calibrated correctness for execution. Defaults to 0.5.
   * Decisions below this threshold are rejected, not executed.
   */
  readonly minCalibratedConfidence?: number
  /** Task ID generator (injectable for tests). */
  readonly newTaskId?: () => string
  /** Decision ID generator (injectable for tests). */
  readonly newDecisionId?: () => string
}

/** Input for a coordinator run. */
export interface CoordinatorInput {
  readonly observations: readonly Observation[]
  readonly catalog: readonly CatalogTool[]
  readonly stateVersion?: number
  readonly policyVersion?: string
  readonly catalogVersion?: string
}

/** Result of a coordinator run. */
export interface CoordinatorResult {
  readonly decision: NormalizedDecision
  readonly outcome: ExecutionOutcome | null
  readonly calibratedCorrectness: number | null
}

/** The admitted decision, before any execution. */
export interface DecideResult {
  /** The calibrated normalized decision. */
  readonly decision: NormalizedDecision
  /**
   * The selected candidate, or `null` when the decision escalates. The
   * candidate passed the menu policy filter; the dispatch recheck still
   * runs at execution time.
   */
  readonly selected: Candidate | null
  /** Calibrated correctness, `null` for escalations. */
  readonly calibratedCorrectness: number | null
  /** Task id the decision was made under; reused for the dispatch recheck. */
  readonly taskId: string
}

/** Context for decision admission. */
export interface AdmissionContext {
  /** The decision returned by the provider. */
  readonly decision: NormalizedDecision
  /** The input that was sent to the provider. */
  readonly input: DecisionInput
  /** The policy-filtered candidate menu the provider chose from. */
  readonly admittedCandidates: readonly Candidate[]
  /** Calibration used for gating. */
  readonly calibration: IsotonicCalibration
  /** Pinned model id the decision must resolve to. */
  readonly expectedModel: string
  /** Minimum calibrated correctness for admission. */
  readonly minCalibratedConfidence: number
}

/** Verdict of decision admission. */
export interface AdmissionVerdict {
  readonly admitted: boolean
  /** Machine-readable reason when not admitted. */
  readonly reason: string | null
  /** Calibrated correctness, when computable. */
  readonly calibratedCorrectness: number | null
}

/**
 * Authoritative decision admission: validate a provider decision before it
 * may be executed. Checks, in order:
 *
 * 1. Correlation: decisionId, questionFamily, and promptVersion must exactly
 *    equal the input they were requested with.
 * 2. Model pinning: modelResolved must exactly equal the pinned model id
 *    (exact equality, never prefix matching).
 * 3. Menu membership: the selected id must be in the admitted menu, or be
 *    the escalate-none sentinel.
 * 4. Calibration gate: the calibration must be bound to this exact
 *    model/prompt/question identity, and the calibrated correctness must
 *    meet the threshold. A concrete selection with no vendor confidence
 *    cannot be gated and is rejected.
 *
 * @param ctx - admission context.
 * @returns the admission verdict.
 */
export function admitDecision(ctx: AdmissionContext): AdmissionVerdict {
  const { decision, input } = ctx
  const reject = (reason: string, calibratedCorrectness: number | null = null): AdmissionVerdict => ({
    admitted: false,
    reason,
    calibratedCorrectness,
  })

  // 1. Correlation: exact equality with the requesting input.
  if (decision.decisionId !== input.decisionId) {
    return reject('correlation: decisionId mismatch')
  }
  if (decision.questionFamily !== input.questionFamily) {
    return reject('correlation: questionFamily mismatch')
  }
  if (decision.promptVersion !== input.promptVersion) {
    return reject('correlation: promptVersion mismatch')
  }

  // 2. Model pinning: exact equality with the pinned model.
  if (decision.modelResolved !== ctx.expectedModel) {
    return reject('model: modelResolved does not match pinned model')
  }

  // 3. Menu membership.
  const isEscalation = decision.selectedId === 'escalate-none'
  if (!isEscalation && !ctx.admittedCandidates.some((c) => c.id === decision.selectedId)) {
    return reject('menu: selected candidate not in admitted menu')
  }

  // 4. Calibration gate.
  const identity = ctx.calibration.identity
  if (identity === null) {
    return reject('calibration: fit is not bound to a decision identity')
  }
  if (
    identity.model !== ctx.expectedModel ||
    identity.questionFamily !== input.questionFamily ||
    identity.promptVersion !== input.promptVersion
  ) {
    return reject('calibration: identity does not match this decision context')
  }
  if (isEscalation) {
    // Escalation carries no selection to gate; admit without a score.
    return { admitted: true, reason: null, calibratedCorrectness: null }
  }
  if (decision.vendorConfidence === null) {
    return reject('calibration: no vendor confidence to gate on')
  }
  const calibratedCorrectness = calibrate(ctx.calibration, decision.vendorConfidence)
  if (calibratedCorrectness < ctx.minCalibratedConfidence) {
    return reject('calibration: below confidence threshold', calibratedCorrectness)
  }
  return { admitted: true, reason: null, calibratedCorrectness }
}

/** The read-only coordinator. */
export class ReadOnlyCoordinator {
  private readonly config: Required<Pick<CoordinatorConfig, 'newTaskId' | 'newDecisionId' | 'minCalibratedConfidence'>> &
    Omit<CoordinatorConfig, 'newTaskId' | 'newDecisionId' | 'minCalibratedConfidence'>

  /**
   * @param config - coordinator configuration.
   */
  constructor(config: CoordinatorConfig) {
    if (!config.tenantId) {
      throw system1Error('INVALID_CONFIG', 'Coordinator requires an explicit tenantId', {})
    }
    if (!config.expectedModel) {
      throw system1Error('INVALID_CONFIG', 'Coordinator requires a pinned expectedModel', {})
    }
    this.config = {
      policy: config.policy,
      capabilityProfile: config.capabilityProfile,
      provider: config.provider,
      executor: config.executor,
      calibration: config.calibration,
      expectedModel: config.expectedModel,
      tenantId: config.tenantId,
      minCalibratedConfidence: config.minCalibratedConfidence ?? 0.5,
      newTaskId: config.newTaskId ?? (() => `task-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      newDecisionId: config.newDecisionId ?? (() => `dec-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    }
  }

  /**
   * Run the decision pipeline without executing: observations → candidate
   * menu → policy filter → Jev decision → admission → calibration gate.
   * Shadow mode uses this to record an advisory suggestion; the returned
   * candidate is never executed by this method.
   * @param input - coordinator input.
   * @param signal - abort signal.
   * @returns the admitted decision and the selected candidate, if any.
   * @throws when no candidate is admissible or the decision is rejected.
   */
  async decide(input: CoordinatorInput, signal: AbortSignal): Promise<DecideResult> {
    const taskId = this.config.newTaskId()
    const decisionId = this.config.newDecisionId()
    const policyVersion = input.policyVersion ?? 'p1'

    // 1. Synthesize observations.
    const state = synthesizeObservations(input.observations)
    const observationHash = hashObservations(input.observations)

    // 2. Generate the candidate menu, filtered to read-only.
    const readOnlyCatalog = input.catalog.filter((tool) => tool.effect === 'read')
    const menu = generateCandidateMenu(readOnlyCatalog)

    // 3. Policy filter BEFORE prediction: only admitted candidates are
    // presented to the provider. Fail closed when nothing is admissible.
    const admittedCandidates: Candidate[] = []
    for (const candidate of menu) {
      const policyDecision = await this.config.policy.evaluate(
        candidate,
        this.config.capabilityProfile,
        {
          taskId,
          tenantId: this.config.tenantId,
          policyVersion,
        },
      )
      if (policyDecision.allowed) {
        admittedCandidates.push(candidate)
      }
    }
    if (admittedCandidates.length === 0) {
      throw system1Error('NO_ADMISSIBLE_CANDIDATES', 'Policy denied every candidate in the menu', {
        taskId,
        menuSize: menu.length,
      })
    }

    // 4. Jev decision over the admitted menu only.
    const questionFamily = 'select-candidate'
    const promptVersion = 'p1'
    const decisionInput: DecisionInput = {
      schemaVersion: 1,
      taskId,
      decisionId,
      stateVersion: input.stateVersion ?? 0,
      policyVersion,
      catalogVersion: input.catalogVersion ?? 'c1',
      observationHash,
      questionFamily,
      promptVersion,
      state,
      candidates: admittedCandidates,
    }
    const decision = await this.config.provider.decide(decisionInput, signal)

    // 5. Authoritative admission: correlation, model pinning, menu
    // membership, and the calibration gate.
    const verdict = admitDecision({
      decision,
      input: decisionInput,
      admittedCandidates,
      calibration: this.config.calibration,
      expectedModel: this.config.expectedModel,
      minCalibratedConfidence: this.config.minCalibratedConfidence,
    })
    if (!verdict.admitted) {
      throw system1Error('DECISION_NOT_ADMITTED', `Decision failed admission: ${verdict.reason}`, {
        decisionId: decision.decisionId,
        reason: verdict.reason,
        calibratedCorrectness: verdict.calibratedCorrectness,
      })
    }

    // Attach calibration to the decision for the result.
    const calibratedDecision: NormalizedDecision = {
      ...decision,
      calibratedCorrectness: verdict.calibratedCorrectness,
      calibrationVersion:
        verdict.calibratedCorrectness !== null ? this.config.calibration.version : null,
    }

    const selected =
      decision.selectedId === 'escalate-none'
        ? null
        : (admittedCandidates.find((c) => c.id === decision.selectedId) ?? null)
    // Unreachable: admission already verified menu membership.
    /* istanbul ignore next -- defensive: admission guarantees membership */
    if (decision.selectedId !== 'escalate-none' && selected === null) {
      throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Selected candidate not in menu', {
        selectedId: decision.selectedId,
      })
    }
    return {
      decision: calibratedDecision,
      selected,
      calibratedCorrectness: verdict.calibratedCorrectness,
      taskId,
    }
  }

  /**
   * Run the read-only decision loop: decide, then execute the selected
   * candidate if the decision is concrete.
   * @param input - coordinator input.
   * @param signal - abort signal.
   * @returns the decision and execution outcome.
   */
  async run(input: CoordinatorInput, signal: AbortSignal): Promise<CoordinatorResult> {
    const policyVersion = input.policyVersion ?? 'p1'
    const { decision, selected, calibratedCorrectness, taskId } = await this.decide(
      input,
      signal,
    )

    // 6. Execute if a concrete candidate was selected (not escalate).
    let outcome: ExecutionOutcome | null = null
    if (selected !== null) {
      // Defense in depth: coordinator never executes non-read effects.
      // Unreachable when the read-only filter above is correct; it guards
      // against future filter regressions.
      /* istanbul ignore next -- defensive: filter guarantees read-only */
      if (selected.effect !== 'read') {
        throw system1Error('EFFECT_NOT_ALLOWED', 'Coordinator is read-only', {
          candidateId: selected.id,
          effect: selected.effect,
        })
      }
      // Policy recheck immediately before dispatch: the grant is
      // re-evaluated at dispatch time, not trusted from step 3.
      const recheck = await this.config.policy.evaluate(selected, this.config.capabilityProfile, {
        taskId,
        tenantId: this.config.tenantId,
        policyVersion,
      })
      if (!recheck.allowed) {
        throw system1Error('CANDIDATE_NOT_ADMISSIBLE', `Selected candidate denied on dispatch recheck`, {
          candidateId: selected.id,
          reason: recheck.reason,
        })
      }
      outcome = await this.config.executor.execute(selected, signal)
    }

    return {
      decision,
      outcome,
      calibratedCorrectness,
    }
  }
}
