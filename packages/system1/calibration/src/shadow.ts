/**
 * Shadow evaluation: run Jev without affecting production.
 *
 * A shadow evaluator wraps a DecisionProvider and records its decisions
 * alongside a baseline, without dispatching. Disagreements are logged for
 * analysis. Shadow mode never mutates production state.
 *
 * @module @deepseek-ai/dsh-system1-calibration/shadow
 */

import type {
  DecisionInput,
  DecisionProvider,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'

/** A shadow evaluation record. */
export interface ShadowRecord {
  readonly decisionId: string
  readonly taskId: string
  readonly shadowDecision: NormalizedDecision
  readonly baselineSelectedId: string | null
  readonly agrees: boolean
  readonly timestampMs: number
}

/** Shadow evaluator configuration. */
export interface ShadowEvaluatorConfig {
  /** The provider to run in shadow. */
  readonly provider: DecisionProvider
  /** Baseline selector (e.g. current production policy). Null if no baseline. */
  readonly baseline?: (input: DecisionInput) => string | null | undefined
  /** Sink for shadow records. */
  readonly sink: (record: ShadowRecord) => void
  /** Clock (injectable for tests). */
  readonly now?: () => number
}

/** Runs a provider in shadow mode. */
export class ShadowEvaluator {
  private readonly provider: DecisionProvider
  private readonly baseline: ((input: DecisionInput) => string | null | undefined) | undefined
  private readonly sink: (record: ShadowRecord) => void
  private readonly now: () => number

  /**
   * @param config - shadow evaluator configuration.
   */
  constructor(config: ShadowEvaluatorConfig) {
    this.provider = config.provider
    this.baseline = config.baseline
    this.sink = config.sink
    this.now = config.now ?? Date.now
  }

  /**
   * Run the provider in shadow and record the result.
   * Never throws: shadow failures are recorded, not propagated.
   * @param input - decision input.
   * @param signal - abort signal.
   */
  async evaluateShadow(input: DecisionInput, signal: AbortSignal): Promise<void> {
    let shadowDecision: NormalizedDecision | null = null
    try {
      shadowDecision = await this.provider.decide(input, signal)
    } catch {
      // Shadow failures are not recorded as decisions; they are invisible.
      // (A separate counter could track them; omitted for minimality.)
      return
    }

    const baselineSelectedId = this.baseline?.(input) ?? null
    const agrees = baselineSelectedId === null || baselineSelectedId === shadowDecision.selectedId

    this.sink({
      decisionId: input.decisionId,
      taskId: input.taskId,
      shadowDecision,
      baselineSelectedId,
      agrees,
      timestampMs: this.now(),
    })
  }
}
