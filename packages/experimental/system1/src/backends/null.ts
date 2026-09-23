/**
 * Null backend: always abstains. Used when System 1 is disabled or no backend
 * is configured; every gate falls back to existing harness behavior.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import type { System1Backend } from '../backend.ts'
import type { System1Judgment, System1Question } from '../types.ts'

/** Backend that abstains on every question with zero confidence. */
export class NullBackend implements System1Backend {
  readonly kind = 'none' as const

  decide(_question: System1Question, _signal: AbortSignal): Promise<System1Judgment> {
    return Promise.resolve({
      answer: null,
      confidence: 0,
      latencyMs: 0,
      backend: 'none',
      abstained: true,
    })
  }

  async dispose(): Promise<void> {
    // Nothing held.
  }
}
