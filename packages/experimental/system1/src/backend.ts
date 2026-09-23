/**
 * System 1 backend abstraction. Backends answer typed questions; they never
 * see harness internals and never act on the loop themselves.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import type { System1BackendKind, System1Judgment, System1Question } from './types.ts'

/**
 * One fast-thinking backend. `decide` must respect `signal` and either resolve
 * a judgment (possibly abstained) or reject; the service converts rejections
 * into safe fallbacks.
 */
export interface System1Backend {
  readonly kind: System1BackendKind
  decide(question: System1Question, signal: AbortSignal): Promise<System1Judgment>
  /** Release any held resources (sidecar processes, sockets). Never throws. */
  dispose(): Promise<void>
}
