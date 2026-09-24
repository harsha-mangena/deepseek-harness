/**
 * Null backend: always abstains. Used when System 1 is configured with
 * `backend: 'none'` or as a safe stand-in in tests.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import { decideManySequential, type System1Backend } from '../backend.ts'
import type { System1Judgment, System1Question } from '../types.ts'

/** Backend that abstains on every question. */
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

  decideMany(questions: readonly System1Question[], signal: AbortSignal): Promise<System1Judgment[]> {
    return decideManySequential(this, questions, signal)
  }

  async dispose(): Promise<void> {}
}
