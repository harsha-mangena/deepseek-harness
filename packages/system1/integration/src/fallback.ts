/**
 * Bounded DeepSeek fallback for the System 1 production driver.
 *
 * When the System 1 decision pipeline cannot produce an executable
 * decision — the Jev provider fails, or the decision is rejected for low
 * calibrated confidence — the driver escalates to the configured DeepSeek
 * fallback (the host's `handoff` handler, wired to the standard DeepSeek
 * path) instead of failing the turn outright.
 *
 * The fallback is bounded:
 * - per-call timeout: the driver aborts the handler's signal and abandons
 *   the call when it fires;
 * - per-run call budget: the handoff budget carried in the bundle, settled
 *   by the handoff implementation through the shared ledger;
 * - step caps: `maxSteps` is validated here and carried in the bundle
 *   constraints; the handoff implementation enforces it via childLimits;
 * - error-budget circuit breaker: after `maxConsecutiveFailures`
 *   consecutive fallback failures the breaker opens and escalation fails
 *   closed without invoking the handler. Breaker transitions are logged
 *   as `system1/fallback-breaker` session events.
 *
 * Fallback results are never System 1-verified: each invocation is
 * recorded as a `system1/fallback` event and the terminal summary labels
 * the outcome as a DeepSeek fallback, distinct from `success`.
 *
 * @module @deepseek-ai/dsh-system1-integration/fallback
 */

import { system1Error } from '@deepseek-ai/dsh-system1-contracts'

/** Bounds for the DeepSeek fallback invoked at escalation. */
export interface FallbackBounds {
  /**
   * Per-call timeout (ms) for the fallback handler. The driver aborts the
   * handler's signal and abandons the call when it fires. Must be a
   * positive integer.
   */
  readonly timeoutMs: number
  /**
   * Consecutive fallback failures before the circuit breaker opens. While
   * open, escalation fails closed without invoking the handler. Must be a
   * positive integer.
   */
  readonly maxConsecutiveFailures: number
  /**
   * Maximum model steps for the fallback child. Carried in the handoff
   * bundle constraints; the handoff implementation enforces it via
   * childLimits. Must be a positive integer.
   */
  readonly maxSteps: number
}

/** Default per-call fallback timeout: two minutes. */
export const DEFAULT_FALLBACK_TIMEOUT_MS = 120_000
/** Default consecutive failures before the breaker opens. */
export const DEFAULT_FALLBACK_MAX_CONSECUTIVE_FAILURES = 3
/** Default maximum model steps for the fallback child. */
export const DEFAULT_FALLBACK_MAX_STEPS = 10

/**
 * Data for the `system1/fallback` session event: one DeepSeek fallback
 * invocation and its outcome.
 */
export interface System1FallbackData {
  readonly schemaVersion: 1
  /** Workflow request id owning the turn. */
  readonly requestId: string
  /** Why the turn fell back to DeepSeek. */
  readonly reason: string
  /** Per-call timeout (ms) enforced for this invocation. */
  readonly timeoutMs: number
  /** Maximum model steps carried in the bundle constraints. */
  readonly maxSteps: number
  /** Outcome of the invocation: handler result, throw, or timeout. */
  readonly outcome: 'completed' | 'failed' | 'threw' | 'timeout'
}

/**
 * Data for the `system1/fallback-breaker` session event: the fallback
 * circuit breaker changed state.
 */
export interface System1FallbackBreakerData {
  readonly schemaVersion: 1
  /** Workflow request id owning the turn. */
  readonly requestId: string
  /** Breaker state after the transition. */
  readonly state: 'open' | 'closed'
  /** Consecutive fallback failures observed at transition time. */
  readonly consecutiveFailures: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** The driver invoked the DeepSeek fallback for a turn. */
    'system1/fallback': System1FallbackData
    /** The fallback circuit breaker changed state. */
    'system1/fallback-breaker': System1FallbackBreakerData
  }
}

/**
 * Resolve fallback bounds: apply defaults for absent fields and validate.
 * @param bounds - the configured bounds, if any.
 * @returns the effective bounds.
 * @throws a System1Error when a bound is not a positive integer.
 */
export function resolveFallbackBounds(bounds?: FallbackBounds): Required<FallbackBounds> {
  const resolved = {
    timeoutMs: bounds?.timeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS,
    maxConsecutiveFailures:
      bounds?.maxConsecutiveFailures ?? DEFAULT_FALLBACK_MAX_CONSECUTIVE_FAILURES,
    maxSteps: bounds?.maxSteps ?? DEFAULT_FALLBACK_MAX_STEPS,
  }
  for (const [field, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw system1Error(
        'INVALID_CONFIG',
        `Production driver fallback.${field} must be a positive integer`,
        { [field]: value },
      )
    }
  }
  return resolved
}

/**
 * Error-budget circuit breaker for the DeepSeek fallback. Tracks
 * consecutive fallback failures for one driver instance; opens after the
 * configured threshold and stays open until a fallback succeeds. The
 * driver logs every transition as a `system1/fallback-breaker` event.
 */
export class FallbackCircuitBreaker {
  private consecutiveFailures = 0
  private open = false

  /**
   * @param maxConsecutiveFailures - failures before the breaker opens.
   */
  constructor(private readonly maxConsecutiveFailures: number) {}

  /** Whether the breaker is currently open. */
  isOpen(): boolean {
    return this.open
  }

  /** Consecutive fallback failures observed. */
  failures(): number {
    return this.consecutiveFailures
  }

  /**
   * Record a successful fallback: reset the failure count and close the
   * breaker if it was open.
   * @returns true when the breaker transitioned from open to closed.
   */
  recordSuccess(): boolean {
    this.consecutiveFailures = 0
    if (this.open) {
      this.open = false
      return true
    }
    return false
  }

  /**
   * Record a failed fallback.
   * @returns true when the breaker transitioned from closed to open.
   */
  recordFailure(): boolean {
    this.consecutiveFailures += 1
    if (!this.open && this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.open = true
      return true
    }
    return false
  }
}

/**
 * Invoke the fallback handler with a per-call timeout. The handler's
 * signal aborts when the timeout fires or the parent signal aborts; the
 * call is abandoned (never silently awaited) on timeout.
 * @param handler - the configured DeepSeek fallback handler.
 * @param args - positional handler arguments (coordinator, bundle).
 * @param parentSignal - aborts when the coordinator is cancelled.
 * @param timeoutMs - per-call timeout in milliseconds.
 * @returns the handler outcome, or 'timeout' when the call was abandoned.
 */
export async function invokeFallbackWithTimeout<T>(
  handler: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<T | 'timeout'> {
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      // Resolve first so the race settles as a timeout even if the
      // handler's abort listener resolves synchronously during abort().
      resolve('timeout')
      controller.abort()
    }, timeoutMs)
  })
  if (parentSignal.aborted) {
    controller.abort()
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
  }
  try {
    return await Promise.race([handler(controller.signal), timeoutPromise])
  } finally {
    /* v8 ignore next -- defensive: the timer is always set synchronously above */
    if (timer !== undefined) clearTimeout(timer)
    parentSignal.removeEventListener('abort', onParentAbort)
  }
}
