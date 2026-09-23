/**
 * Unit tests for {@link System1Service}: gates, budgets, timeouts, circuit
 * breaker, and the never-throw fallback contract.
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
    budgetPerTurn: 4,
    budgetPerTask: 12,
    timeoutMs: 150,
    failureThreshold: 3,
    cooldownMs: 30_000,
    traceBufferSize: 200,
    jevApiKeyEnv: 'JEV_API_KEY',
    jevEndpoint: 'https://api.jev.ai/v1/systemone',
    layaEndpoint: 'http://127.0.0.1:17840/decide',
    layaAutoStart: true,
    layaCommand: ['python3', '-m', 'laya_serve'],
    ...overrides,
  }
}

const question: System1Question = {
  kind: 'triage',
  prompt: 'Classify.',
  context: {},
  answerSchema: 'triage',
}

function scriptedBackend(judgments: Array<() => Promise<System1Judgment> | System1Judgment>): System1Backend {
  let calls = 0
  return {
    kind: 'none',
    async decide(): Promise<System1Judgment> {
      const fn = judgments[Math.min(calls, judgments.length - 1)]
      calls += 1
      return fn!()
    },
    async dispose(): Promise<void> {},
  }
}

function judgment(answer: unknown, confidence: number): System1Judgment {
  return { answer, confidence, latencyMs: 5, backend: 'none', abstained: false }
}

describe('System1Service', () => {
  it('passes a confident, valid judgment through the gate', async () => {
    const service = new System1Service(scriptedBackend([() => judgment('trivial', 0.9)]), testConfig())
    const decision = await service.ask(question, 'turn', new AbortController().signal, (a) => { return a === 'trivial' ? 'trivial' : null },
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
      scriptedBackend([() => judgment('trivial', 0.2)]),
      testConfig(),
    )
    const decision = await service.ask(question, 'turn', new AbortController().signal, (a) => { return a as string })
    expect(decision.fallback).toBe('low-confidence')
  })

  it('falls back when the answer fails validation', async () => {
    const service = new System1Service(
      scriptedBackend([() => judgment('nonsense', 0.95)]),
      testConfig(),
    )
    const decision = await service.ask(question, 'turn', new AbortController().signal, () => null)
    expect(decision.fallback).toBe('backend-error')
    expect(decision.trace.note).toContain('validation')
  })

  it('enforces the per-turn budget', async () => {
    const service = new System1Service(
      scriptedBackend([() => judgment('trivial', 0.9)]),
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
      scriptedBackend([() => judgment('trivial', 0.9)]),
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

  it('times out a hanging backend', async () => {
    const hanging: System1Backend = {
      kind: 'none',
      decide(): Promise<System1Judgment> {
        return new Promise(() => undefined)
      },
      async dispose(): Promise<void> {},
    }
    const service = new System1Service(hanging, testConfig({ timeoutMs: 20 }))
    const decision = await service.ask(question, 'turn', new AbortController().signal, (a) => { return a as string })
    expect(decision.fallback).toBe('timeout')
  }, 5000)

  it('returns disabled fallback when the service is disabled', async () => {
    const service = new System1Service(new NullBackend(), testConfig({ enabled: false }))
    const decision = await service.ask(question, 'turn', new AbortController().signal, () => 'x')
    expect(decision.fallback).toBe('disabled')
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
      scriptedBackend([() => ({ ...judgment('trivial', 42), confidence: 42 })]),
      testConfig(),
    )
    const decision = await service.ask(question, 'turn', new AbortController().signal, (a) => { return a as string })
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
})
