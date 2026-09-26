/**
 * Recorded decision provider for replay and fault tests.
 *
 * Replays pre-recorded NormalizedDecisions keyed by decision ID. Unknown
 * decision IDs throw, so tests fail loudly instead of inventing answers.
 * An optional fault injector can simulate transport failures, timeouts,
 * and malformed responses.
 *
 * @module @deepseek-ai/dsh-system1-coordination/recorded-provider
 */

import { system1Error, DecisionInputSchema } from '@deepseek-ai/dsh-system1-contracts'
import type {
  DecisionProvider,
  DecisionInput,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'

/** Faults the recorded provider can inject. */
export type ProviderFault =
  | { readonly kind: 'transport-failed' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'malformed-response' }

/**
 * A DecisionProvider backed by recordings.
 */
export class RecordedDecisionProvider implements DecisionProvider {
  private readonly recordings = new Map<string, NormalizedDecision>()
  private readonly faults = new Map<string, ProviderFault>()
  /** Decision IDs seen, in call order (for ordering assertions). */
  readonly seenDecisionIds: string[] = []

  /**
   * Record a decision for a decision ID.
   * @param decisionId - decision ID to answer.
   * @param decision - normalized decision to return.
   */
  record(decisionId: string, decision: NormalizedDecision): void {
    this.recordings.set(decisionId, decision)
  }

  /**
   * Inject a fault for a decision ID.
   * @param decisionId - decision ID that will fault.
   * @param fault - fault to inject.
   */
  injectFault(decisionId: string, fault: ProviderFault): void {
    this.faults.set(decisionId, fault)
  }

  async decide(input: DecisionInput, signal: AbortSignal): Promise<NormalizedDecision> {
    // Validate the input at the trust boundary, as a real provider would.
    const parsed = DecisionInputSchema.safeParse(input)
    if (!parsed.success) {
      throw system1Error('SCHEMA_VALIDATION_FAILED', 'Decision input failed validation', {
        issues: parsed.error.issues,
      })
    }
    if (signal.aborted) {
      throw system1Error('TASK_CANCELLED', 'Decision request was cancelled', {
        decisionId: input.decisionId,
      })
    }
    this.seenDecisionIds.push(input.decisionId)

    const fault = this.faults.get(input.decisionId)
    if (fault) {
      switch (fault.kind) {
        case 'transport-failed':
          throw system1Error('PROVIDER_TRANSPORT_FAILED', 'Injected transport failure', {
            decisionId: input.decisionId,
          })
        case 'timeout':
          throw system1Error('PROVIDER_TIMEOUT', 'Injected timeout', { decisionId: input.decisionId })
        case 'malformed-response':
          throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Injected malformed response', {
            decisionId: input.decisionId,
          })
      }
    }

    const recorded = this.recordings.get(input.decisionId)
    if (!recorded) {
      throw system1Error('PROVIDER_MALFORMED_RESPONSE', `No recording for decision ${input.decisionId}`, {
        decisionId: input.decisionId,
      })
    }
    // The recorded decision must belong to this decision ID.
    if (recorded.decisionId !== input.decisionId) {
      throw system1Error('CORRUPT_RECORD', 'Recording decision ID mismatch', {
        expected: input.decisionId,
        actual: recorded.decisionId,
      })
    }
    return recorded
  }
}
