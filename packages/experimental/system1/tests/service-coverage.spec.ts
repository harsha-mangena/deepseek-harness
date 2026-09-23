/**
 * Coverage for the {@link System1Service} branches the main service suite
 * does not reach: the half-open probe window, budget-map eviction, an abort
 * landing between the cancelled check and the batch, missing validators,
 * non-Error backend throws, and non-finite confidences.
 */

import { describe, expect, it, vi } from 'vitest'
import type { System1Backend } from '../src/backend.ts'
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

const validate = (a: unknown): string | null => (typeof a === 'string' ? a : null)

describe('System1Service coverage', () => {
  it('sees the circuit as open when a probe is in flight', async () => {
    let rejectSlow!: (error: Error) => void
    let resolveProbe!: (judgments: System1Judgment[]) => void
    let calls = 0
    const backend: System1Backend = {
      kind: 'none',
      async decide(question: System1Question, signal: AbortSignal): Promise<System1Judgment> {
        return (await this.decideMany([question], signal))[0] as System1Judgment
      },
      async decideMany(): Promise<System1Judgment[]> {
        calls += 1
        // Call 1 hangs (a slow non-probe batch); call 2 fails fast and opens
        // the circuit; call 3 is the half-open probe and hangs.
        if (calls === 1) return new Promise<System1Judgment[]>((_resolve, reject) => { rejectSlow = reject })
        if (calls === 2) throw new Error('backend down')
        return new Promise<System1Judgment[]>((resolve) => { resolveProbe = resolve })
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(
      backend,
      testConfig({ failureThreshold: 1, cooldownMs: 0, timeoutMs: 10_000 }),
    )
    const signal = (): AbortSignal => new AbortController().signal
    // The slow batch starts first as a normal (non-probe) batch...
    const slow = service.ask(question, 'turn', signal(), validate)
    // ...then a fast failure opens the circuit...
    const failed = await service.ask(question, 'turn', signal(), validate)
    expect(failed.fallback).toBe('backend-error')
    expect(calls).toBe(2)
    // ...then the half-open probe starts and hangs with probeInFlight set...
    const probe = service.ask(question, 'turn', signal(), validate)
    expect(calls).toBe(3)
    // ...then the slow non-probe batch fails, reopening the circuit without
    // clearing the in-flight probe flag.
    rejectSlow(new Error('slow backend failed'))
    const slowDecision = await slow
    expect(slowDecision.fallback).toBe('backend-error')
    // A concurrent batch now observes the open circuit without a backend call.
    const blocked = await service.ask(question, 'turn', signal(), validate)
    expect(blocked.fallback).toBe('backend-error')
    expect(blocked.trace.note).toBe('circuit open')
    expect(calls).toBe(3)
    resolveProbe([judgment('trivial', 0.9)])
    const probed = await probe
    expect(probed.fallback).toBeNull()
    expect(probed.value).toBe('trivial')
  })

  it('evicts the oldest agent budgets past 256 entries', async () => {
    const service = new System1Service(
      scriptedBackend([single('trivial', 0.9)]),
      testConfig({ budgetPerTurn: 1, budgetPerTask: 10_000 }),
    )
    for (let i = 0; i < 257; i += 1) {
      const decision = await service.ask(question, 'turn', new AbortController().signal, validate, `agent-${i}`)
      expect(decision.fallback).toBeNull()
    }
    // agent-0 was evicted as the oldest entry: its budget looks fresh again.
    const evicted = await service.ask(question, 'turn', new AbortController().signal, validate, 'agent-0')
    expect(evicted.fallback).toBeNull()
    // agent-256 was retained: its turn budget is still spent.
    const retained = await service.ask(question, 'turn', new AbortController().signal, validate, 'agent-256')
    expect(retained.fallback).toBe('budget-exceeded')
  })

  it('observes an abort that lands between the cancelled check and the batch', async () => {
    const controller = new AbortController()
    const service = new System1Service(
      scriptedBackend([single('trivial', 0.9)]),
      testConfig({ budgetPerTurn: 1 }),
    )
    // A trace listener aborts the caller's signal while the budget loop
    // runs: the abort lands after askMany's early cancelled check but before
    // the backend batch starts, so withAbortTimeout must observe it.
    const dispose = service.onTrace(() => { controller.abort() })
    const decisions = await service.askMany([question, question], [validate, validate], 'turn', controller.signal)
    dispose()
    expect(decisions).toHaveLength(2)
    expect(decisions[0]?.fallback).toBeNull()
    expect(decisions[1]?.fallback).toBe('budget-exceeded')
  })

  it('falls back when a question has no validator', async () => {
    const service = new System1Service(scriptedBackend([single('trivial', 0.9)]), testConfig())
    const decisions = await service.askMany([question], [], 'turn', new AbortController().signal)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.fallback).toBe('backend-error')
    expect(decisions[0]?.trace.note).toBe('missing validator')
  })

  it('stringifies a non-Error backend throw and trips the breaker on it', async () => {
    const backend: System1Backend = {
      kind: 'none',
      async decide(question: System1Question, signal: AbortSignal): Promise<System1Judgment> {
        return (await this.decideMany([question], signal))[0] as System1Judgment
      },
      async decideMany(): Promise<System1Judgment[]> {
        throw 'plain string failure'
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(backend, testConfig({ failureThreshold: 1 }))
    const decision = await service.ask(question, 'turn', new AbortController().signal, validate)
    expect(decision.fallback).toBe('backend-error')
    expect(decision.trace.note).toBe('plain string failure')
    // A non-transient throw counts against the circuit: the next batch fails open.
    const next = await service.ask(question, 'turn', new AbortController().signal, validate)
    expect(next.fallback).toBe('backend-error')
    expect(next.trace.note).toBe('circuit open')
  })

  it('treats a non-finite confidence as zero', async () => {
    const service = new System1Service(
      scriptedBackend([() => [judgment('trivial', Number.NaN)]]),
      testConfig(),
    )
    const decision = await service.ask(question, 'turn', new AbortController().signal, validate)
    expect(decision.fallback).toBe('low-confidence')
  })

  it('throws when the batch unexpectedly returns no decisions', async () => {
    const service = new System1Service(scriptedBackend([single('trivial', 0.9)]), testConfig())
    vi.spyOn(service, 'askMany').mockResolvedValue([])
    await expect(service.ask(question, 'turn', new AbortController().signal, validate)).rejects.toThrow(
      'askMany returned no decisions',
    )
  })
})
