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

/**
 * Receives every recorded trace, synchronously, in record order. A throwing
 * listener must not break the service — the service swallows listener
 * errors — but listeners should still be cheap: they run on the decision
 * path.
 */
export type TraceListener = (trace: System1Trace) => void

function clampConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0
}

/**
 * Run an answer validator without letting it break the service's never-reject
 * contract: a throwing validator resolves to a backend-error fallback, not a
 * rejected `askMany`.
 */
function safeValidate<T>(
  validate: (answer: unknown) => T | null,
  answer: unknown,
): { ok: true; value: T | null } | { ok: false; message: string } {
  try {
    return { ok: true, value: validate(answer) }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Race a promise against a timeout that also aborts the underlying work:
 * the timeout fires `controller.abort()`, so a hung backend call releases
 * its socket instead of lingering after the race is lost.
 *
 * @param ms - timeout in milliseconds. Values <= 0 disable the timeout
 * entirely; the call is then bounded only by the caller's `signal`.
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
 *
 * Budgets are partitioned per agent: each agent's turn/task counters are
 * keyed by agent id, so one chatty agent cannot starve another's questions.
 * The circuit breaker stays global — it measures backend health, which is
 * shared across agents.
 */
export class System1Service {
  private readonly turnUsed = new Map<string, number>()
  private readonly taskUsed = new Map<string, number>()
  private consecutiveFailures = 0
  private circuitOpenedAt: number | null = null
  private readonly traces: System1Trace[] = []
  private readonly traceListeners = new Set<TraceListener>()

  constructor(
    private readonly backend: System1Backend,
    private readonly config: System1RuntimeConfig,
  ) {}

  /**
   * Subscribe to every recorded trace, including `markActed` updates.
   * Returns a disposer. Listener errors are swallowed so telemetry can
   * never break the decision path.
   */
  onTrace(listener: TraceListener): () => void {
    this.traceListeners.add(listener)
    return () => {
      this.traceListeners.delete(listener)
    }
  }

  private notifyTrace(trace: System1Trace): void {
    for (const listener of this.traceListeners) {
      try {
        listener(trace)
      } catch {
        // Telemetry must never break decisions; the listener is at fault.
      }
    }
  }

  /** Cap a budget map; agents are bounded upstream, this is a backstop. */
  private capBudgets(): void {
    for (const map of [this.turnUsed, this.taskUsed]) {
      while (map.size > 256) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    }
  }

  /** Reset per-task budgets for one agent; call when a new agent task starts. */
  resetTask(agentId = ''): void {
    this.taskUsed.delete(agentId)
    this.turnUsed.delete(agentId)
  }

  /** Reset per-turn budgets for one agent; call when a new agent turn starts. */
  resetTurn(agentId = ''): void {
    this.turnUsed.delete(agentId)
  }

  /** Recent traces, newest last, up to `traceBufferSize`. */
  getTraces(): readonly System1Trace[] {
    return this.traces
  }

  /**
   * Mark a previously recorded trace as acted-upon: the harness injected
   * guidance because of this judgment. No-op for unknown ids; traces are
   * replaced immutably so readers never see a half-updated record.
   * Listeners registered via {@link onTrace} also see the updated trace.
   */
  markActed(traceId: string): void {
    const index = this.traces.findIndex(trace => trace.id === traceId)
    if (index === -1) return
    const trace = this.traces[index] as System1Trace
    const updated = { ...trace, acted: true }
    this.traces[index] = updated
    this.notifyTrace(updated)
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
    agentId: string,
    note?: string,
  ): System1Trace {
    const trace: System1Trace = {
      id: randomUUID(),
      at: Date.now(),
      agentId,
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
    this.notifyTrace(trace)
    return trace
  }

  private fallback<T>(
    question: System1Question,
    reason: System1FallbackReason,
    agentId: string,
    note?: string,
  ): System1Decision<T> {
    return {
      judgment: null,
      value: null,
      fallback: reason,
      trace: this.recordTrace(question, null, reason, false, agentId, note),
    }
  }

  /**
   * The confidence gate. Threshold precedence: per-kind config override
   * (`thresholds`), the question's own `threshold` (its builder knows the
   * stakes — TypeSafe: "a confidence threshold is not one number"), then the
   * global `confidenceThreshold`.
   */
  private gate<T>(
    question: System1Question,
    judgment: System1Judgment,
    validate: (answer: unknown) => T | null,
    agentId: string,
  ): System1Decision<T> {
    const threshold = this.config.thresholds[question.kind] ?? question.threshold ?? this.config.confidenceThreshold
    const confidence = clampConfidence(judgment.confidence)
    if (judgment.abstained) {
      return {
        judgment,
        value: null,
        fallback: 'abstain',
        trace: this.recordTrace(question, judgment, 'abstain', false, agentId),
      }
    }
    if (confidence < threshold) {
      return {
        judgment,
        value: null,
        fallback: 'low-confidence',
        trace: this.recordTrace(question, judgment, 'low-confidence', false, agentId, `confidence ${confidence.toFixed(2)} below gate ${threshold.toFixed(2)}`),
      }
    }
    const validated = safeValidate(validate, judgment.answer)
    if (!validated.ok) {
      return {
        judgment,
        value: null,
        fallback: 'backend-error',
        trace: this.recordTrace(question, judgment, 'backend-error', false, agentId, `validator threw: ${validated.message}`),
      }
    }
    if (validated.value === null) {
      return {
        judgment,
        value: null,
        fallback: 'backend-error',
        trace: this.recordTrace(question, judgment, 'backend-error', false, agentId, 'answer failed validation'),
      }
    }
    return {
      judgment,
      value: validated.value,
      fallback: null,
      trace: this.recordTrace(question, judgment, null, false, agentId),
    }
  }

  /**
   * Ask many System 1 questions in one backend round-trip. Never rejects:
   * every failure path resolves to fallback decisions so the caller keeps
   * existing behavior.
   *
   * @param questions - the typed questions for the backend, in order.
   * @param validators - one answer validator per question, in the same order.
   * @param scope - primary budget for the gate (`'turn'` or `'task'`);
   *   every question additionally counts against the per-task ceiling.
   * @param signal - caller cancellation; also bounds the backend call.
   * @param agentId - the agent the questions belong to; budgets are
   * partitioned per agent. Defaults to a shared bucket; production call
   * sites always pass the agent id.
   */
  async askMany<T>(
    questions: readonly System1Question[],
    validators: ReadonlyArray<(answer: unknown) => T | null>,
    scope: BudgetScope,
    signal: AbortSignal,
    agentId = '',
  ): Promise<Array<System1Decision<T>>> {
    if (questions.length === 0) return []
    if (!this.config.enabled) {
      return questions.map(question => this.fallback<T>(question, 'disabled', agentId))
    }
    if (this.circuitOpen()) {
      return questions.map(question => this.fallback<T>(question, 'backend-error', agentId, 'circuit open'))
    }

    // Budget counts questions, not batches: each question costs tokens.
    // Every question consumes from BOTH the per-turn and the per-task
    // budget, so a long task cannot outspend its task ceiling even when
    // each turn stays under its own. Counters are per agent, so agents
    // never starve each other. `scope` selects the primary budget for the
    // gate; the task budget additionally binds as a universal ceiling.
    const primaryUsed = scope === 'turn'
      ? this.turnUsed.get(agentId) ?? 0
      : this.taskUsed.get(agentId) ?? 0
    const primaryBudget = scope === 'turn' ? this.config.budgetPerTurn : this.config.budgetPerTask
    const taskUsed = this.taskUsed.get(agentId) ?? 0
    const askable: Array<{ index: number; question: System1Question; validate: (answer: unknown) => T | null }> = []
    const decisions = new Array<System1Decision<T> | undefined>(questions.length)
    questions.forEach((question, index) => {
      const validate = validators[index]
      if (validate === undefined) {
        decisions[index] = this.fallback<T>(question, 'backend-error', agentId, 'missing validator')
        return
      }
      if (primaryUsed + askable.length >= primaryBudget ||
          taskUsed + askable.length >= this.config.budgetPerTask) {
        decisions[index] = this.fallback<T>(question, 'budget-exceeded', agentId)
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
        const message = error instanceof Error ? error.message : String(error)
        const reason: System1FallbackReason = message.includes('timed out') ? 'timeout' : 'backend-error'
        // A rate-limit response is a pacing signal, not backend unhealth: it
        // falls back for this batch without touching the circuit breaker —
        // the next batch simply tries again, which is the backoff. The Jev
        // backend marks such errors with `transient: true`.
        const transient = typeof error === 'object' && error !== null
          && (error as { transient?: unknown }).transient === true
        if (!transient) {
          this.consecutiveFailures += 1
          if (this.consecutiveFailures >= this.config.failureThreshold) {
            this.circuitOpenedAt = Date.now()
          }
        }
        const note = transient ? `${message} (transient pacing signal; circuit untouched)` : message
        askable.forEach(({ index, question }) => {
          decisions[index] = this.fallback<T>(question, reason, agentId, note)
        })
        return decisions as Array<System1Decision<T>>
      }
      let dropped = 0
      askable.forEach(({ index, question, validate }, batchIndex) => {
        const judgment = judgments[batchIndex]
        if (judgment === undefined) {
          dropped += 1
          decisions[index] = this.fallback<T>(question, 'backend-error', agentId, 'backend dropped a question')
          return
        }
        // Every answered question spends from both budgets (see the gate
        // above): the per-turn counter refreshes each turn, the per-task
        // counter only on a new task.
        this.turnUsed.set(agentId, (this.turnUsed.get(agentId) ?? 0) + 1)
        this.taskUsed.set(agentId, (this.taskUsed.get(agentId) ?? 0) + 1)
        decisions[index] = this.gate(question, judgment, validate, agentId)
      })
      this.capBudgets()
      // A backend that answers short violates its contract (one judgment per
      // question, in order): count it as a failure for circuit purposes even
      // when the rest of the batch succeeded.
      if (dropped > 0) {
        this.consecutiveFailures += 1
        if (this.consecutiveFailures >= this.config.failureThreshold) {
          this.circuitOpenedAt = Date.now()
        }
      } else {
        this.consecutiveFailures = 0
      }
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
    agentId = '',
  ): Promise<System1Decision<T>> {
    const decisions = await this.askMany([question], [validate], scope, signal, agentId)
    const first = decisions[0]
    if (first === undefined) throw new Error('system1: askMany returned no decisions')
    return first
  }
}
