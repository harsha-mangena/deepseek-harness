/**
 * System 1 decision service: confidence gates, budgets, timeouts, and safe
 * fallbacks around a {@link System1Backend}.
 *
 * The service never throws for backend problems. Any failure — backend
 * error, timeout, abstention, low confidence, exhausted budget, or an open
 * circuit — resolves to a decision with `value: null` and a `fallback`
 * reason, so the harness always continues with existing behavior.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import { randomUUID } from 'node:crypto'
import type { System1Backend } from './backend.ts'
import type {
  System1Decision,
  System1FallbackReason,
  System1Judgment,
  System1Question,
  System1RuntimeConfig,
  System1Trace,
} from './types.ts'

/** Budget scope: one agent turn or one whole agent task. */
export type BudgetScope = 'turn' | 'task'

function clampConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  if (ms <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`system1: backend timed out after ${ms}ms`))
    }, ms)
  })
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer)
  }
  signal.addEventListener('abort', cleanup, { once: true })
  return Promise.race([promise, timeout]).finally(() => {
    cleanup()
    signal.removeEventListener('abort', cleanup)
  })
}

/**
 * Runs System 1 questions through confidence, budget, timeout, and circuit
 * gates. Create one per plugin lifetime; call {@link resetTask} when a new
 * agent task starts.
 */
export class System1Service {
  private turnUsed = 0
  private taskUsed = 0
  private consecutiveFailures = 0
  private circuitOpenedAt: number | null = null
  private readonly traces: System1Trace[] = []

  constructor(
    private readonly backend: System1Backend,
    private readonly config: System1RuntimeConfig,
  ) {}

  /** Reset per-task budgets; call when a new agent task starts. */
  resetTask(): void {
    this.taskUsed = 0
    this.turnUsed = 0
  }

  /** Reset per-turn budgets; call when a new agent turn starts. */
  resetTurn(): void {
    this.turnUsed = 0
  }

  /** Recent traces, newest last, up to `traceBufferSize`. */
  getTraces(): readonly System1Trace[] {
    return this.traces
  }

  private circuitOpen(): boolean {
    if (this.circuitOpenedAt === null) return false
    if (Date.now() - this.circuitOpenedAt < this.config.cooldownMs) return true
    this.circuitOpenedAt = null
    this.consecutiveFailures = 0
    return false
  }

  private recordTrace(
    question: System1Question,
    judgment: System1Judgment | null,
    fallback: System1FallbackReason | null,
    acted: boolean,
    note?: string,
  ): System1Trace {
    const trace: System1Trace = {
      id: randomUUID(),
      at: Date.now(),
      questionKind: question.kind,
      mode: this.config.mode,
      backend: this.backend.kind,
      confidence: judgment === null ? null : clampConfidence(judgment.confidence),
      latencyMs: judgment?.latencyMs ?? 0,
      fallback,
      acted,
      ...note === undefined ? {} : { note },
    }
    this.traces.push(trace)
    while (this.traces.length > this.config.traceBufferSize) this.traces.shift()
    return trace
  }

  private fallback<T>(
    question: System1Question,
    reason: System1FallbackReason,
    note?: string,
  ): System1Decision<T> {
    return {
      judgment: null,
      value: null,
      fallback: reason,
      trace: this.recordTrace(question, null, reason, false, note),
    }
  }

  /**
   * Ask one System 1 question. Never rejects: every failure path resolves
   * to a fallback decision so the caller keeps existing behavior.
   *
   * @param question - the typed question for the backend.
   * @param scope - which budget the call counts against.
   * @param signal - caller cancellation; also bounds the backend call.
   * @param validate - validates the raw answer into a typed value, or null.
   */
  async ask<T>(
    question: System1Question,
    scope: BudgetScope,
    signal: AbortSignal,
    validate: (answer: unknown) => T | null,
  ): Promise<System1Decision<T>> {
    if (!this.config.enabled) return this.fallback(question, 'disabled')
    if (this.circuitOpen()) {
      return this.fallback(question, 'backend-error', 'circuit open')
    }
    const used = scope === 'turn' ? this.turnUsed : this.taskUsed
    const budget = scope === 'turn' ? this.config.budgetPerTurn : this.config.budgetPerTask
    if (used >= budget) return this.fallback(question, 'budget-exceeded')

    let judgment: System1Judgment
    try {
      judgment = await withTimeout(this.backend.decide(question, signal), this.config.timeoutMs, signal)
    } catch (error: unknown) {
      this.consecutiveFailures += 1
      if (this.consecutiveFailures >= this.config.failureThreshold) {
        this.circuitOpenedAt = Date.now()
      }
      const reason: System1FallbackReason = error instanceof Error && error.message.includes('timed out')
        ? 'timeout'
        : 'backend-error'
      return this.fallback(question, reason, error instanceof Error ? error.message : String(error))
    }
    this.consecutiveFailures = 0
    if (scope === 'turn') this.turnUsed += 1
    else this.taskUsed += 1

    const confidence = clampConfidence(judgment.confidence)
    if (judgment.abstained) {
      return {
        judgment,
        value: null,
        fallback: 'abstain',
        trace: this.recordTrace(question, judgment, 'abstain', false),
      }
    }
    if (confidence < this.config.confidenceThreshold) {
      return {
        judgment,
        value: null,
        fallback: 'low-confidence',
        trace: this.recordTrace(question, judgment, 'low-confidence', false),
      }
    }
    const value = validate(judgment.answer)
    if (value === null) {
      return {
        judgment,
        value: null,
        fallback: 'backend-error',
        trace: this.recordTrace(question, judgment, 'backend-error', false, 'answer failed validation'),
      }
    }
    return {
      judgment,
      value,
      fallback: null,
      trace: this.recordTrace(question, judgment, null, false),
    }
  }
}
