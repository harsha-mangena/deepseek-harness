/**
 * System 1 read-only coordinator: end-to-end viable integration.
 *
 * Orchestrates the full decision loop for read-only work:
 * observations → candidate menu → policy → Jev decision → calibration →
 * read-only execution. Write/mutate candidates are rejected at the
 * coordinator boundary (Phase 7 unlocks controlled mutations).
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
  readonly calibration: IsotonicCalibration | null
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

/** The read-only coordinator. */
export class ReadOnlyCoordinator {
  private readonly config: Required<Pick<CoordinatorConfig, 'newTaskId' | 'newDecisionId'>> &
    Omit<CoordinatorConfig, 'newTaskId' | 'newDecisionId'>

  /**
   * @param config - coordinator configuration.
   */
  constructor(config: CoordinatorConfig) {
    this.config = {
      policy: config.policy,
      capabilityProfile: config.capabilityProfile,
      provider: config.provider,
      executor: config.executor,
      calibration: config.calibration,
      newTaskId: config.newTaskId ?? (() => `task-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      newDecisionId: config.newDecisionId ?? (() => `dec-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    }
  }

  /**
   * Run the read-only decision loop.
   * @param input - coordinator input.
   * @param signal - abort signal.
   * @returns the decision and execution outcome.
   */
  async run(input: CoordinatorInput, signal: AbortSignal): Promise<CoordinatorResult> {
    const taskId = this.config.newTaskId()
    const decisionId = this.config.newDecisionId()

    // 1. Synthesize observations.
    const state = synthesizeObservations(input.observations)
    const observationHash = hashObservations(input.observations)

    // 2. Generate candidate menu, filtered to read-only.
    const readOnlyCatalog = input.catalog.filter((tool) => tool.effect === 'read')
    const candidates = generateCandidateMenu(readOnlyCatalog)

    // 3. Policy check: all candidates must be allowed.
    for (const candidate of candidates) {
      const policyDecision = await this.config.policy.evaluate(
        candidate,
        this.config.capabilityProfile,
        {
          taskId,
          tenantId: 'default',
          policyVersion: input.policyVersion ?? 'p1',
        },
      )
      if (!policyDecision.allowed) {
        throw system1Error('CANDIDATE_NOT_ADMISSIBLE', `Candidate ${candidate.id} denied by policy`, {
          candidateId: candidate.id,
          reason: policyDecision.reason,
        })
      }
    }

    // 4. Jev decision.
    const decisionInput: DecisionInput = {
      schemaVersion: 1,
      taskId,
      decisionId,
      stateVersion: input.stateVersion ?? 0,
      policyVersion: input.policyVersion ?? 'p1',
      catalogVersion: input.catalogVersion ?? 'c1',
      observationHash,
      questionFamily: 'select-candidate',
      promptVersion: 'p1',
      state,
      candidates,
    }
    const decision = await this.config.provider.decide(decisionInput, signal)

    // 5. Calibration (if available and vendor confidence present).
    let calibratedCorrectness: number | null = null
    if (this.config.calibration && decision.vendorConfidence !== null) {
      calibratedCorrectness = calibrate(this.config.calibration, decision.vendorConfidence)
    }

    // 6. Execute if a concrete candidate was selected (not escalate).
    let outcome: ExecutionOutcome | null = null
    if (decision.selectedId !== 'escalate-none') {
      const selected = candidates.find((c) => c.id === decision.selectedId)
      if (!selected) {
        throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Selected candidate not in menu', {
          selectedId: decision.selectedId,
        })
      }
      // Defense in depth: coordinator never executes non-read effects.
      // This is unreachable when the read-only filter above is correct;
      // it guards against future filter regressions.
      /* istanbul ignore next -- defensive: filter guarantees read-only */
      if (selected.effect !== 'read') {
        throw system1Error('EFFECT_NOT_ALLOWED', 'Coordinator is read-only', {
          candidateId: selected.id,
          effect: selected.effect,
        })
      }
      outcome = await this.config.executor.execute(selected, signal)
    }

    // Attach calibration to the decision for the result.
    const calibratedDecision: NormalizedDecision = {
      ...decision,
      calibratedCorrectness,
      calibrationVersion: calibratedCorrectness !== null ? this.config.calibration!.version : null,
    }

    return {
      decision: calibratedDecision,
      outcome,
      calibratedCorrectness,
    }
  }
}
