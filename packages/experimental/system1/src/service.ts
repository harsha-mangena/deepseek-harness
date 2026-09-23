/**
 * System 1 decision service: confidence gates, budgets, timeouts, and safe
 * fallbacks around a {@link System1Backend}.
 *
 * The service never throws for backend problems. Any failure — backend
 * error, timeout, abstention, low confidence, exhausted budget, or an open
 * circuit — resolves to a decision with `value: null` and a `fallback`
 * reason, so the harness always continues with existing behavior.
 *
 * Questions are asked in batches via {@link askMany}: the backend answers
 * every question in one round-trip (Jev evaluates them in parallel), and
 * per-question gates are applied to each judgment. Budgets count questions,
 * not batches, because each question costs tokens.
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

/**
 * Race a promise against a timeout that also aborts the underlying work:
 * the timeout fires `controller.abort()`, so a hung backend call releases
 * its socket instead of lingering after the race is lost.
 */
function withAbortTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const forward = (): void => {
    controller.abort(signal.reason)
  }
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener('abort', forward, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    if (ms <= 0) return
    timer = setTimeout(() => {
      const timeoutError = new Error(`system1: backend timed out after ${ms}ms`)
      controller.abort(timeoutError)
      reject(timeoutError)
    }, ms)
  })
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', forward)
  }
  return Promise.race([run(controller.signal), timeout]).finally(cleanup)
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
      ...(judgment?.model === undefined ? {} : { model: judgment.model }),
      ...(note === undefined ? {} : { note }),
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

  private gate<T>(
    question: System1Question,
    judgment: System1Judgment,
    validate: (answer: unknown) => T | null,
  ): System1Decision<T> {
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

  /**
   * Ask many System 1 questions in one backend round-trip. Never rejects:
   * every failure path resolves to fallback decisions so the caller keeps
   * existing behavior.
   *
   * @param questions - the typed questions for the backend, in order.
   * @param validators - one answer validator per question, in the same order.
   * @param scope - which budget each question counts against.
   * @param signal - caller cancellation; also bounds the backend call.
   */
  async askMany<T>(
    questions: readonly System1Question[],
    validators: ReadonlyArray<(answer: unknown) => T | null>,
    scope: BudgetScope,
    signal: AbortSignal,
  ): Promise<Array<System1Decision<T>>> {
    if (questions.length === 0) return []
    if (!this.config.enabled) {
      return questions.map(question => this.fallback<T>(question, 'disabled'))
    }
    if (this.circuitOpen()) {
      return questions.map(question => this.fallback<T>(question, 'backend-error', 'circuit open'))
    }

    // Budget counts questions, not batches: each question costs tokens.
    const askable: Array<{ index: number; question: System1Question; validate: (answer: unknown) => T | null }> = []
    const decisions = new Array<System1Decision<T> | undefined>(questions.length)
    questions.forEach((question, index) => {
      const used = scope === 'turn' ? this.turnUsed : this.taskUsed
      const budget = scope === 'turn' ? this.config.budgetPerTurn : this.config.budgetPerTask
      const validate = validators[index]
      if (validate === undefined) {
        decisions[index] = this.fallback<T>(question, 'backend-error', 'missing validator')
        return
      }
      if (used + askable.length >= budget) {
        decisions[index] = this.fallback<T>(question, 'budget-exceeded')
        return
      }
      askable.push({ index, question, validate })
    })

    if (askable.length > 0) {
      let judgments: System1Judgment[]
      try {
        judgments = await withAbortTimeout(
          batchSignal => this.backend.decideMany(askable.map(entry => entry.question), batchSignal),
          this.config.timeoutMs,
          signal,
        )
      } catch (error: unknown) {
        this.consecutiveFailures += 1
        if (this.consecutiveFailures >= this.config.failureThreshold) {
          this.circuitOpenedAt = Date.now()
        }
        const message = error instanceof Error ? error.message : String(error)
        const reason: System1FallbackReason = message.includes('timed out') ? 'timeout' : 'backend-error'
        askable.forEach(({ index, question }) => {
          decisions[index] = this.fallback<T>(question, reason, message)
        })
        return decisions as Array<System1Decision<T>>
      }
      this.consecutiveFailures = 0
      askable.forEach(({ index, question, validate }, batchIndex) => {
        const judgment = judgments[batchIndex]
        if (judgment === undefined) {
          decisions[index] = this.fallback<T>(question, 'backend-error', 'backend dropped a question')
          return
        }
        if (scope === 'turn') this.turnUsed += 1
        else this.taskUsed += 1
        decisions[index] = this.gate(question, judgment, validate)
      })
    }
    return decisions as Array<System1Decision<T>>
  }

  /**
   * Ask one System 1 question. Never rejects: every failure path resolves
   * to a fallback decision so the caller keeps existing behavior.
   */
  async ask<T>(
    question: System1Question,
    scope: BudgetScope,
    signal: AbortSignal,
    validate: (answer: unknown) => T | null,
  ): Promise<System1Decision<T>> {
    const decisions = await this.askMany([question], [validate], scope, signal)
    const first = decisions[0]
    if (first === undefined) throw new Error('system1: askMany returned no decisions')
    return first
  }
}
