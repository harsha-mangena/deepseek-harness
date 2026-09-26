/**
 * Shadow evaluation: run Jev without affecting production.
 *
 * A shadow evaluator wraps a DecisionProvider and records its decisions
 * alongside a baseline, without dispatching. Disagreements are logged for
 * analysis. Shadow mode never mutates production state.
 *
 * The whole shadow pipeline is isolated: provider, baseline, and sink errors
 * are reported through onError and never propagate to the caller, so shadow
 * evaluation cannot interfere with the production path. Provider failures are
 * recorded as failed attempts rather than dropped, keeping evaluation
 * denominators complete. A missing baseline is recorded as an 'unknown'
 * comparison, never as agreement.
 *
 * @module @deepseek-ai/dsh-system1-calibration/shadow
 */

import type {
  DecisionInput,
  DecisionProvider,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'

/** How a shadow decision compared to the baseline. */
export type ShadowComparison = 'agree' | 'disagree' | 'unknown'

/** A shadow evaluation record. */
export interface ShadowRecord {
  readonly decisionId: string
  readonly taskId: string
  /** Shadow decision, or null when the provider failed. */
  readonly shadowDecision: NormalizedDecision | null
  /** True when the provider threw instead of deciding. */
  readonly providerFailed: boolean
  readonly baselineSelectedId: string | null
  /** 'unknown' when the provider failed or no baseline was available. */
  readonly comparison: ShadowComparison
  /** True only when comparison is 'agree'. */
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
  /** Receives sub-component errors (provider, baseline, sink). Never throws. */
  readonly onError?: (error: unknown) => void
  /** Clock (injectable for tests). */
  readonly now?: () => number
}

/** Runs a provider in shadow mode. */
export class ShadowEvaluator {
  private readonly provider: DecisionProvider
  private readonly baseline: ((input: DecisionInput) => string | null | undefined) | undefined
  private readonly sink: (record: ShadowRecord) => void
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly now: () => number

  /**
   * @param config - shadow evaluator configuration.
   */
  constructor(config: ShadowEvaluatorConfig) {
    this.provider = config.provider
    this.baseline = config.baseline
    this.sink = config.sink
    this.onError = config.onError
    this.now = config.now ?? Date.now
  }

  /**
   * Run the provider in shadow and record the result.
   *
   * Never rejects: provider, baseline, and sink failures are recorded or
   * reported through onError instead of propagating, preserving the
   * non-interference contract with the production path.
   * @param input - decision input.
   * @param signal - abort signal.
   * @returns a promise that always resolves.
   */
  async evaluateShadow(input: DecisionInput, signal: AbortSignal): Promise<void> {
    let shadowDecision: NormalizedDecision | null = null
    try {
      shadowDecision = await this.provider.decide(input, signal)
    } catch (err) {
      this.report(err)
    }

    let baselineSelectedId: string | null = null
    try {
      baselineSelectedId = this.baseline?.(input) ?? null
    } catch (err) {
      this.report(err)
    }

    const comparison: ShadowComparison =
      shadowDecision === null
        ? 'unknown'
        : baselineSelectedId === null
          ? 'unknown'
          : baselineSelectedId === shadowDecision.selectedId
            ? 'agree'
            : 'disagree'

    try {
      this.sink({
        decisionId: input.decisionId,
        taskId: input.taskId,
        shadowDecision,
        providerFailed: shadowDecision === null,
        baselineSelectedId,
        comparison,
        agrees: comparison === 'agree',
        timestampMs: this.now(),
      })
    } catch (err) {
      this.report(err)
    }
  }

  /**
   * Report a sub-component failure without propagating it.
   * @param error - the caught error.
   */
  private report(error: unknown): void {
    this.onError?.(error)
  }
}
