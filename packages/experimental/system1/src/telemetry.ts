/**
 * Durable System 1 decision telemetry.
 *
 * The in-memory trace ring is useful for live debugging but evaporates with
 * the process. This module declares two session events:
 *
 * - `system1/decision`: one per trace, including shadow observations and
 *   fallbacks — never acted-only, so the log is an unbiased calibration
 *   source. Carries the trace id, question kind, confidence, latency,
 *   model, fallback reason, and the acted flag *at first sighting*.
 * - `system1/decision-acted`: appended when a trace is later marked
 *   acted-on (guidance injected, tool denied, delegation advised, result
 *   pruned...). Keyed by trace id; a replay joins it to the decision to
 *   recover exactly what the harness did.
 *
 * Both events are log-only — they carry no surface message, so they never
 * reach the model — and `ignorable` so builds that do not know the types
 * can still read the log. Appends are best-effort: a closed or foreign
 * session reports false instead of throwing, so telemetry can never break
 * the decision path.
 */

import type { InformationalEventIntent } from '@deepseek-ai/dsh-session'
import type {
  System1BackendKind,
  System1FallbackReason,
  System1Mode,
  System1QuestionKind,
  System1Trace,
} from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A System 1 judgment: Jev was asked a question and answered (or the
     * service fell back). One per trace, including shadow and fallback
     * traces. Log-only; carries no core message. `ignorable` so foreign
     * builds can still read the session.
     */
    'system1/decision': System1DecisionPayload
    /**
     * A System 1 trace the harness acted on, keyed by trace id. Joins to
     * `system1/decision` on `traceId`. Log-only and `ignorable`.
     */
    'system1/decision-acted': System1DecisionActedPayload
  }
}

/** Durable payload of a `system1/decision` session event. */
export interface System1DecisionPayload {
  /** Stable id of the service trace; joins to `system1/decision-acted`. */
  readonly traceId: string
  /** Wall-clock time the trace was recorded. */
  readonly at: number
  /** The agent the question belonged to. */
  readonly agentId: string
  readonly questionKind: System1QuestionKind
  readonly mode: System1Mode
  readonly backend: System1BackendKind
  readonly confidence: number | null
  readonly latencyMs: number
  readonly fallback: System1FallbackReason | null
  /** Whether the harness had already acted on the trace at first sighting. */
  readonly acted: boolean
  /** Versioned model id that answered, when the backend reports one. */
  readonly model?: string
  /** Operator note recorded with the trace (e.g. budget or threshold context). */
  readonly note?: string
}

/** Durable payload of a `system1/decision-acted` session event. */
export interface System1DecisionActedPayload {
  /** The trace id from the matching `system1/decision` event. */
  readonly traceId: string
  /** Wall-clock time the trace was marked acted-on. */
  readonly at: number
}

/**
 * The narrow session surface the telemetry helpers need. The real
 * `Session` satisfies this structurally; tests use a lightweight stub
 * instead of casting. The trailing marker is required (not optional):
 * every telemetry append stamps `{ ignorable: true }` so builds that do
 * not know the System 1 event types can still read the log, and the
 * required parameter keeps `Session`'s generic conditional signature
 * assignable under `exactOptionalPropertyTypes`.
 */
export interface TelemetrySession {
  append(type: 'system1/decision', data: System1DecisionPayload, opts: InformationalEventIntent): unknown
  append(type: 'system1/decision-acted', data: System1DecisionActedPayload, opts: InformationalEventIntent): unknown
}

/**
 * Append a durable `system1/decision` event for a trace — every trace,
 * including shadow observations and fallbacks, so the log stays an
 * unbiased calibration source.
 *
 * @param session - The agent's session log.
 * @param trace - The recorded trace.
 * @returns true when the event landed, false when the session rejected it
 * (telemetry must never break the decision path).
 */
export function appendDecisionEvent(session: TelemetrySession, trace: System1Trace): boolean {
  try {
    session.append('system1/decision', {
      traceId: trace.id,
      at: trace.at,
      agentId: trace.agentId,
      questionKind: trace.questionKind,
      mode: trace.mode,
      backend: trace.backend,
      confidence: trace.confidence,
      latencyMs: trace.latencyMs,
      fallback: trace.fallback,
      acted: trace.acted,
      ...(trace.model === undefined ? {} : { model: trace.model }),
      ...(trace.note === undefined ? {} : { note: trace.note }),
    }, { ignorable: true })
    return true
  } catch {
    // A closed or foreign session must not break the harness.
    return false
  }
}

/**
 * Append a durable `system1/decision-acted` event keyed by trace id.
 *
 * @param session - The agent's session log.
 * @param traceId - The id from the matching `system1/decision` event.
 * @returns true when the event landed, false when the session rejected it.
 */
export function appendDecisionActedEvent(session: TelemetrySession, traceId: string): boolean {
  try {
    session.append('system1/decision-acted', { traceId, at: Date.now() }, { ignorable: true })
    return true
  } catch {
    return false
  }
}
