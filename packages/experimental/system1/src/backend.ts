/**
 * System 1 backend abstraction. Backends answer typed questions; they never
 * see harness internals and never act on the loop themselves.
 *
 * The batch entry point {@link System1Backend.decideMany} is the efficiency
 * core: Jev evaluates every question in one request in parallel, so asking N
 * questions costs barely more time than asking one. Backends without native
 * batching fall back to sequential `decide` calls via
 * {@link decideManySequential}.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import type { System1BackendKind, System1Judgment, System1Question } from './types.ts'

/**
 * One fast-thinking backend. `decide`/`decideMany` must respect `signal` and
 * either resolve judgments (possibly abstained) or reject; the service
 * converts rejections into safe fallbacks. `decideMany` resolves judgments
 * in the same order as the questions it was given.
 */
export interface System1Backend {
  readonly kind: System1BackendKind
  decide(question: System1Question, signal: AbortSignal): Promise<System1Judgment>
  /** Answer many questions in one backend round-trip when supported. */
  decideMany(questions: readonly System1Question[], signal: AbortSignal): Promise<System1Judgment[]>
  /** Optional connection warm-up before the first judgment. Never throws. */
  warm?(signal: AbortSignal): Promise<void>
  /** Release any held resources (sidecar processes, sockets). Never throws. */
  dispose(): Promise<void>
}

/**
 * Default `decideMany` for backends with no native batching: asks each
 * question in turn. Prefer a real batch implementation whenever the backend
 * supports one request for many questions.
 */
export async function decideManySequential(
  backend: Pick<System1Backend, 'decide' | 'kind'>,
  questions: readonly System1Question[],
  signal: AbortSignal,
): Promise<System1Judgment[]> {
  const judgments: System1Judgment[] = []
  for (const question of questions) {
    judgments.push(await backend.decide(question, signal))
  }
  return judgments
}
