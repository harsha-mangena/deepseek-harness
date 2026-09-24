/**
 * Decision provider interface.
 *
 * Implemented by the Jev adapter (Phase 3) and by recorded fixtures for
 * replay and fault tests. The provider receives a validated DecisionInput
 * and returns a NormalizedDecision; all transport, retry, and validation
 * policy lives in the implementation, not the caller.
 *
 * @module @deepseek-ai/dsh-system1-contracts/decision-provider
 */

import type { DecisionInput, NormalizedDecision } from './schemas.ts'

/**
 * A source of normalized decisions.
 */
export interface DecisionProvider {
  /**
   * Decide among the candidates in the input.
   * @param input - validated decision input.
   * @param signal - abort signal; the provider must honor cancellation.
   * @returns the normalized decision.
   */
  decide(input: DecisionInput, signal: AbortSignal): Promise<NormalizedDecision>
}

/**
 * Check that a value implements the DecisionProvider interface.
 * @param value - value to check.
 */
export function isDecisionProvider(value: unknown): value is DecisionProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    'decide' in value &&
    typeof (value as { decide: unknown }).decide === 'function'
  )
}
