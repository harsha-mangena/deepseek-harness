/**
 * Unit tests for {@link System1Service}: gates, budgets, timeouts, circuit
 * breaker, batch asking, and the never-throw fallback contract.
 */

import { describe, expect, it } from 'vitest'
import type { System1Backend } from '../src/backend.ts'
import { NullBackend } from '../src/backends/null.ts'
import { System1Service } from '../src/service.ts'
import type { System1Judgment, System1Question, System1RuntimeConfig } from '../src/types.ts'

function testConfig(overrides: Partial<System1RuntimeConfig> = {}): System1RuntimeConfig {
  return {
    backend: 'none',
    mode: 'shadow',
    enabled: true,
    confidenceThreshold: 0.7,
    thresholds: {},
    budgetPerTurn: 4,
    budgetPerTask: 12,
    timeoutMs: 150,
    failureThreshold: 3,
    cooldownMs: 30_000,
    traceBufferSize: 200,
    delegationWeights: { novelty: 0.4, toolRisk: 0.35, irreversibility: 0.25 },
    jevApiKeyEnv: 'TYPESAFE_API_KEY',
    jevEndpoint: 'https://api.typesafe.ai/v1/systemone',
    jevModel: 'jev-latest',
    layaEndpoint: 'http://127.0.0.1:17840/decide',
    layaAutoStart: true,
    layaCommand: ['python3', '-m', 'laya_serve'],
    loopStuckThreshold: 0.7,
    maxLoopNudgesPerTask: 2,
    ...overrides,
  }
}

const question: System1Question = {
  kind: 'triage',
  primitive: 'choice',
  prompt: 'Classify.',
  context: {},
  options: { trivial: 'no reasoning needed', complex: 'full reasoning' },
}

const loopQuestion: System1Question = {
  kind: 'loop-check',
  primitive: 'noul',
  prompt: 'The agent is stuck and should be interrupted',
  context: {},
}

function judgment(answer: unknown, confidence: number): System1Judgment {
  return { answer, confidence, latencyMs: 5, backend: 'none', abstained: false }
}

/** Backend scripted with one judgment-factory per decideMany call. */
function scriptedBackend(batches: Array<() => System1Judgment[]>): System1Backend {
  let calls = 0
  return {
    kind: 'none',
    async decide(question: System1Question, signal: AbortSignal): Promise<System1Judgment> {
      const judgments = await this.decideMany([question], signal)
      return judgments[0] as System1Judgment
    },
    async decideMany(): Promise<System1Judgment[]> {
      const fn = batches[Math.min(calls, batches.length - 1)] as () => System1Judgment[]
      calls += 1
      return fn()
    },
    async dispose(): Promise<void> {},
  }
}

function single(answer: unknown, confidence: number): () => System1Judgment[] {
  return () => [judgment(answer, confidence)]
}

describe('System1Service', () => {
  it('passes a confident, valid judgment through the gate', async () => {
    const service = new System1Service(scriptedBackend([single('trivial', 0.9)]), testConfig())
    const decision = await service.ask(question, 'turn', new AbortController().signal, (a) => {
      return a === 'trivial' ? 'trivial' : null
    },
    )
    expect(decision.fallback).toBeNull()
    expect(decision.value).toBe('trivial')
    expect(decision.trace.acted).toBe(false)
  })

  it('falls back on abstention', async () => {
    const service = new System1Service(new NullBackend(), testConfig())
    const decision = await service.ask(question, 'turn', new AbortController().signal, () => 'x')
    expect(decision.fallback).toBe('abstain')
    expect(decision.value).toBeNull()
  })

  it('falls back on low confidence', async () => {
    const service = new System1Service(
      scriptedBackend([single('trivial', 0.2)]),
      testConfig(),
    )
    const decision = await service.ask(question, 'turn', new AbortController().signal, (a) => {
      return a as string
    })
    expect(decision.fallback).toBe('low-confidence')
  })

  it('prefers the question-level threshold over the global one', async () => {
    // The question declares a 0.6 gate (cheap reversible hint); the global
    // threshold is 0.7, so 0.65 passes here.
    const cheapQuestion: System1Question = { ...question, threshold: 0.6 }
    const service = new System1Service(
      scriptedBackend([single('retry', 0.65)]),
      testConfig(),
    )
    const decision = await service.ask(cheapQuestion, 'turn', new AbortController().signal, a => a as string)
    expect(decision.fallback).toBeNull()
    expect(decision.value).toBe('retry')
  })

  it('prefers the per-kind config override over the question threshold', async () => {
    // Config says retry-judgment gates at 0.9; the question's own 0.6 loses.
    const retryQuestion: System1Question = { ...question, kind: 'retry-judgment', threshold: 0.6 }
    const service = new System1Service(
      scriptedBackend([single('retry', 0.8)]),
      testConfig({ thresholds: { 'retry-judgment': 0.9 } }),
    )
    const decision = await service.ask(retryQuestion, 'turn', new AbortController().signal, a => a as string)
    expect(decision.fallback).toBe('low-confidence')
  })

  it('does not trip the circuit breaker on transient pacing errors', async () => {
    const transient = Object.assign(new Error('system1: jev rate limited (HTTP 429)'), { transient: true })
    let calls = 0
    const backend: System1Backend = {
      kind: 'none',
      async decide(q: System1Question, signal: AbortSignal): Promise<System1Judgment> {
        return (await this.decideMany([q], signal))[0] as System1Judgment
      },
      async decideMany(): Promise<System1Judgment[]> {
        calls += 1
        throw transient
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(backend, testConfig({ failureThreshold: 1 }))
    const signal = new AbortController().signal
    const validate = (a: unknown): string => a as string
    // Even with failureThreshold 1, three transient failures must not open
    // the circuit: the next batch still reaches the backend.
    for (let i = 0; i < 3; i += 1) {
      const decision = await service.ask(question, 'turn', signal, validate)
      expect(decision.fallback).toBe('backend-error')
    }
    expect(calls).toBe(3)
  })

  it('trips the circuit breaker on repeated non-transient errors', async () => {
    let calls = 0
    const backend: System1Backend = {
      kind: 'none',
      async decide(q: System1Question, signal: AbortSignal): Promise<System1Judgment> {
        return (await this.decideMany([q], signal))[0] as System1Judgment
      },
      async decideMany(): Promise<System1Judgment[]> {
        calls += 1
        throw new Error('boom')
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(backend, testConfig({ failureThreshold: 2 }))
    const signal = new AbortController().signal
    const validate = (a: unknown): string => a as string
    // Two failures reach the backend; the third ask finds the circuit open
    // and never calls the backend again.
    const first = await service.ask(question, 'turn', signal, validate)
    expect(first.fallback).toBe('backend-error')
    expect(first.trace.note).not.toContain('circuit open')
    const second = await service.ask(question, 'turn', signal, validate)
    expect(second.trace.note).not.toContain('circuit open')
    const third = await service.ask(question, 'turn', signal, validate)
    expect(third.fallback).toBe('backend-error')
    expect(third.trace.note).toContain('circuit open')
    expect(calls).toBe(2)
  })

  it('falls back when the answer fails validation', async () => {
    const service = new System1Service(
      scriptedBackend([single('nonsense', 0.95)]),
      testConfig(),
    )
    const decision = await service.ask(question, 'turn', new AbortController().signal, () => null)
    expect(decision.fallback).toBe('backend-error')
    expect(decision.trace.note).toContain('validation')
  })

  it('enforces the per-turn budget', async () => {
    const service = new System1Service(
      scriptedBackend([single('trivial', 0.9)]),
      testConfig({ budgetPerTurn: 2 }),
    )
    const signal = new AbortController().signal
    const validate = (a: unknown): string => a as string
    expect((await service.ask(question, 'turn', signal, validate)).fallback).toBeNull()
    expect((await service.ask(question, 'turn', signal, validate)).fallback).toBeNull()
    const third = await service.ask(question, 'turn', signal, validate)
    expect(third.fallback).toBe('budget-exceeded')
  })

  it('resets the turn budget on resetTurn', async () => {
    const service = new System1Service(
      scriptedBackend([single('trivial', 0.9)]),
      testConfig({ budgetPerTurn: 1 }),
    )
    const signal = new AbortController().signal
    const validate = (a: unknown): string => a as string
    await service.ask(question, 'turn', signal, validate)
    service.resetTurn()
    expect((await service.ask(question, 'turn', signal, validate)).fallback).toBeNull()
  })

  it('converts backend errors into fallbacks and opens the circuit', async () => {
    const failing: System1Backend = {
      kind: 'none',
      async decide(): Promise<System1Judgment> {
        throw new Error('boom')
      },
      async decideMany(): Promise<System1Judgment[]> {
        throw new Error('boom')
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(failing, testConfig({ failureThreshold: 2, cooldownMs: 60_000 }))
    const signal = new AbortController().signal
    const validate = (a: unknown): string => a as string
    expect((await service.ask(question, 'turn', signal, validate)).fallback).toBe('backend-error')
    expect((await service.ask(question, 'turn', signal, validate)).fallback).toBe('backend-error')
    // Circuit is now open: the backend is not consulted again.
    const third = await service.ask(question, 'turn', signal, validate)
    expect(third.fallback).toBe('backend-error')
    expect(third.trace.note).toBe('circuit open')
  })

  it('times out a hanging backend and aborts the underlying call', async () => {
    let seenSignal: AbortSignal | null = null
    const hanging: System1Backend = {
      kind: 'none',
      async decide(): Promise<System1Judgment> {
        throw new Error('unreachable')
      },
      decideMany(_questions: readonly System1Question[], signal: AbortSignal): Promise<System1Judgment[]> {
        seenSignal = signal
        return new Promise(() => undefined)
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(hanging, testConfig({ timeoutMs: 20 }))
    const decision = await service.ask(question, 'turn', new AbortController().signal, (a) => {
      return a as string
    })
    expect(decision.fallback).toBe('timeout')
    expect(seenSignal?.aborted).toBe(true)
  }, 5000)

  it('returns disabled fallback when the service is disabled', async () => {
    const service = new System1Service(new NullBackend(), testConfig({ enabled: false }))
    const decision = await service.ask(question, 'turn', new AbortController().signal, () => 'x')
    expect(decision.fallback).toBe('disabled')
  })

  it('converts a throwing validator into a backend-error fallback', async () => {
    const service = new System1Service(
      scriptedBackend([single('trivial', 0.9), single('trivial', 0.9)]),
      testConfig(),
    )
    const signal = new AbortController().signal
    const throwing = await service.ask(question, 'turn', signal, (): string => {
      throw new Error('validator blew up')
    })
    expect(throwing.fallback).toBe('backend-error')
    expect(throwing.value).toBeNull()
    expect(throwing.trace.note).toContain('validator threw: validator blew up')
    const nonError = await service.ask(question, 'turn', signal, (): string => {
      throw { code: 42 }
    })
    expect(nonError.fallback).toBe('backend-error')
    expect(nonError.trace.note).toContain('validator threw')
  })

  it('treats timeoutMs 0 as no timeout', async () => {
    const slow: System1Backend = {
      kind: 'none',
      async decide(): Promise<System1Judgment> {
        throw new Error('unreachable')
      },
      async decideMany(): Promise<System1Judgment[]> {
        await new Promise(resolve => setTimeout(resolve, 50))
        return [judgment('trivial', 0.9)]
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(slow, testConfig({ timeoutMs: 0 }))
    const decision = await service.ask(question, 'turn', new AbortController().signal, (a) => {
      return a as string
    })
    expect(decision.fallback).toBeNull()
    expect(decision.value).toBe('trivial')
  })

  it('keeps a bounded trace ring buffer', async () => {
    const service = new System1Service(new NullBackend(), testConfig({ traceBufferSize: 3 }))
    const signal = new AbortController().signal
    for (let i = 0; i < 5; i += 1) {
      await service.ask(question, 'turn', signal, () => 'x')
    }
    expect(service.getTraces()).toHaveLength(3)
  })

  it('clamps out-of-range confidence to the 0..1 range', async () => {
    const service = new System1Service(
      scriptedBackend([single('trivial', 42)]),
      testConfig(),
    )
    const decision = await service.ask(question, 'turn', new AbortController().signal, (a) => {
      return a as string
    })
    expect(decision.fallback).toBeNull()
    expect(decision.trace.confidence).toBe(1)
  })

  it('NullBackend abstains with zero latency', async () => {
    const backend = new NullBackend()
    const result = await backend.decide(question, new AbortController().signal)
    expect(result.abstained).toBe(true)
    expect(result.confidence).toBe(0)
    await backend.dispose()
    await expect(backend.dispose()).resolves.toBeUndefined()
  })

  it('records the answering model in the trace', async () => {
    const service = new System1Service(
      scriptedBackend([() => [{ ...judgment('trivial', 0.9), model: 'jev-1.13.0' }]]),
      testConfig(),
    )
    const decision = await service.ask(question, 'turn', new AbortController().signal, (a) => {
      return a as string
    })
    expect(decision.trace.model).toBe('jev-1.13.0')
  })
})

describe('System1Service.askMany', () => {
  it('answers many questions in one backend round-trip', async () => {
    let batchCalls = 0
    let batchSize = 0
    const backend: System1Backend = {
      kind: 'jev',
      async decide(): Promise<System1Judgment> {
        throw new Error('unreachable')
      },
      async decideMany(questions: readonly System1Question[]): Promise<System1Judgment[]> {
        batchCalls += 1
        batchSize = questions.length
        return [judgment('trivial', 0.9), judgment(0.85, 0.85)]
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(backend, testConfig())
    const decisions = await service.askMany(
      [question, loopQuestion],
      [(a: unknown): string | null => (typeof a === 'string' ? a : null),
        (a: unknown): number | null => (typeof a === 'number' ? a : null)],
      'turn',
      new AbortController().signal,
    )
    expect(batchCalls).toBe(1)
    expect(batchSize).toBe(2)
    expect(decisions).toHaveLength(2)
    expect(decisions[0]?.value).toBe('trivial')
    expect(decisions[1]?.value).toBe(0.85)
    expect(decisions.every(d => d.fallback === null)).toBe(true)
  })

  it('applies per-question gates inside a batch', async () => {
    const service = new System1Service(
      scriptedBackend([() => [judgment('trivial', 0.9), judgment(0.55, 0.55)]]),
      testConfig(),
    )
    const decisions = await service.askMany(
      [question, loopQuestion],
      [() => 'trivial', (a: unknown): number | null => (typeof a === 'number' ? a : null)],
      'turn',
      new AbortController().signal,
    )
    expect(decisions[0]?.fallback).toBeNull()
    // noul p=0.55 -> confidence max(0.55, 0.45)=0.55 < 0.7 threshold
    expect(decisions[1]?.fallback).toBe('low-confidence')
  })

  it('counts each batched question against the budget', async () => {
    const service = new System1Service(
      scriptedBackend([() => [judgment('trivial', 0.9), judgment('trivial', 0.9), judgment('trivial', 0.9)]]),
      testConfig({ budgetPerTurn: 2 }),
    )
    const decisions = await service.askMany(
      [question, question, question],
      [() => 'x', () => 'x', () => 'x'],
      'turn',
      new AbortController().signal,
    )
    expect(decisions[0]?.fallback).toBeNull()
    expect(decisions[1]?.fallback).toBeNull()
    expect(decisions[2]?.fallback).toBe('budget-exceeded')
  })

  it('fails a whole batch closed on backend error without throwing', async () => {
    const failing: System1Backend = {
      kind: 'none',
      async decide(): Promise<System1Judgment> {
        throw new Error('boom')
      },
      async decideMany(): Promise<System1Judgment[]> {
        throw new Error('boom')
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(failing, testConfig())
    const decisions = await service.askMany(
      [question, loopQuestion],
      [() => 'x', () => 0],
      'turn',
      new AbortController().signal,
    )
    expect(decisions).toHaveLength(2)
    expect(decisions.every(d => d.fallback === 'backend-error')).toBe(true)
  })

  it('counts backend-dropped questions toward the circuit breaker', async () => {
    const short: System1Backend = {
      kind: 'none',
      async decide(): Promise<System1Judgment> {
        throw new Error('unreachable')
      },
      async decideMany(): Promise<System1Judgment[]> {
        return []
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(short, testConfig({ failureThreshold: 2, cooldownMs: 60_000 }))
    const signal = new AbortController().signal
    const validate = (a: unknown): string => a as string
    const first = await service.ask(question, 'turn', signal, validate)
    expect(first.fallback).toBe('backend-error')
    expect(first.trace.note).toBe('backend dropped a question')
    const second = await service.ask(question, 'turn', signal, validate)
    expect(second.fallback).toBe('backend-error')
    // Two short batches opened the circuit: the backend is not consulted again.
    const third = await service.ask(question, 'turn', signal, validate)
    expect(third.fallback).toBe('backend-error')
    expect(third.trace.note).toBe('circuit open')
  })

  it('returns an empty array for no questions without touching the backend', async () => {
    let touched = false
    const backend: System1Backend = {
      kind: 'none',
      async decide(): Promise<System1Judgment> {
        throw new Error('unreachable')
      },
      async decideMany(): Promise<System1Judgment[]> {
        touched = true
        return []
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(backend, testConfig())
    expect(await service.askMany([], [], 'turn', new AbortController().signal)).toEqual([])
    expect(touched).toBe(false)
  })
})

describe('markActed', () => {
  it('flips acted on the recorded trace without mutating other fields', async () => {
    const service = new System1Service(scriptedBackend([single('trivial', 0.9)]), testConfig())
    const decision = await service.ask(question, 'turn', new AbortController().signal, (a) => {
      return a === 'trivial' ? 'trivial' : null
    })
    expect(decision.trace.acted).toBe(false)
    service.markActed(decision.trace.id)
    const traces = service.getTraces()
    expect(traces).toHaveLength(1)
    expect(traces[0]!.acted).toBe(true)
    expect(traces[0]!.id).toBe(decision.trace.id)
    expect(traces[0]!.fallback).toBe(decision.trace.fallback)
  })

  it('ignores unknown trace ids', async () => {
    const service = new System1Service(scriptedBackend([single('trivial', 0.9)]), testConfig())
    await service.ask(question, 'turn', new AbortController().signal, (a) => {
      return a === 'trivial' ? 'trivial' : null
    })
    expect(() => { service.markActed('no-such-trace') }).not.toThrow()
    expect(service.getTraces()[0]!.acted).toBe(false)
  })
})
