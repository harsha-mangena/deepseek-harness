/** Jev provider and normalization tests (mocked transport, no live calls). */

import { describe, expect, it } from 'vitest'
import { JevDecisionProvider, nonRetryableCode, normalizeJevResponse } from '@deepseek-ai/dsh-system1-jev'
import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type { DecisionInput } from '@deepseek-ai/dsh-system1-contracts'

const input: DecisionInput = {
  schemaVersion: 1,
  taskId: 't1',
  decisionId: 'd1',
  stateVersion: 0,
  policyVersion: 'p1',
  catalogVersion: 'c1',
  observationHash: 'o1',
  questionFamily: 'q1',
  promptVersion: 'p1',
  state: 'test state',
  candidates: [
    {
      id: 'c1',
      label: 'First',
      route: 'tool',
      effect: 'read',
      operationRef: 'op1',
      preconditionHash: 'h1',
      verificationPolicyId: 'v1',
    },
    {
      id: 'c2',
      label: 'Second',
      route: 'tool',
      effect: 'read',
      operationRef: 'op2',
      preconditionHash: 'h2',
      verificationPolicyId: 'v2',
    },
  ],
}

/** Mock fetch returning a canned JSON response. */
function mockFetch(response: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    json: async () => response,
  })) as typeof fetch
}

describe('normalizeJevResponse', () => {
  it('normalizes a choice response', () => {
    const raw = {
      choice: 'c1',
      probabilities: { c1: 0.8, c2: 0.2 },
      confidence: 0.9,
      model: 'jev-1-rev3',
      requestId: 'req-123',
      usage: { inputTokens: 150, outputTokens: 0 },
    }
    const decision = normalizeJevResponse(raw, input, 'jev-1')
    expect(decision.selectedId).toBe('c1')
    expect(decision.selectedProbability).toBe(0.8)
    expect(decision.vendorConfidence).toBe(0.9)
    expect(decision.modelRequested).toBe('jev-1')
    expect(decision.modelResolved).toBe('jev-1-rev3')
    expect(decision.requestId).toBe('req-123')
    expect(decision.usage).toEqual({ inputTokens: 150, outputTokens: 0 })
    expect(decision.reasonCode).toBe('accepted')
    // Calibrated correctness is null until Phase 4.
    expect(decision.calibratedCorrectness).toBeNull()
  })

  it('normalizes a noul response as uncertain', () => {
    const raw = { noul: true, model: 'jev-1-rev3' }
    const decision = normalizeJevResponse(raw, input, 'jev-1')
    expect(decision.selectedId).toBe('escalate-none')
    expect(decision.reasonCode).toBe('uncertain')
  })

  it('normalizes a score response by selecting the top candidate', () => {
    const raw = {
      score: { c1: 0.3, c2: 0.7 },
      probabilities: { c1: 0.3, c2: 0.7 },
      confidence: 0.75,
    }
    const decision = normalizeJevResponse(raw, input, 'jev-1')
    expect(decision.selectedId).toBe('c2')
    expect(decision.selectedProbability).toBe(0.7)
  })

  it('uses score directly when probabilities are absent', () => {
    const raw = { score: { c1: 0.4, c2: 0.6 } }
    const decision = normalizeJevResponse(raw, input, 'jev-1')
    expect(decision.selectedId).toBe('c2')
    // Missing candidates default to 0.
    const rawPartial = { score: { c2: 0.6 } }
    const decisionPartial = normalizeJevResponse(rawPartial, input, 'jev-1')
    expect(decisionPartial.selectedId).toBe('c2')
  })

  it('rejects score responses with no valid candidate', () => {
    expect(() => normalizeJevResponse({ score: { c99: 0.5 } }, input, 'jev-1')).toThrow(
      /no valid candidate/,
    )
  })

  it('ignores probabilities for unknown candidates', () => {
    const raw = { choice: 'c1', probabilities: { c1: 0.6, c99: 0.4 } }
    const decision = normalizeJevResponse(raw, input, 'jev-1')
    expect(decision.probabilities).toEqual({ c1: 0.6 })
  })

  it('accepts snake_case request_id', () => {
    const raw = { choice: 'c1', probabilities: { c1: 1 }, request_id: 'snake-123' }
    const decision = normalizeJevResponse(raw, input, 'jev-1')
    expect(decision.requestId).toBe('snake-123')
  })

  it('handles missing request ID and model', () => {
    const raw = { choice: 'c1', probabilities: { c1: 1 } }
    const decision = normalizeJevResponse(raw, input, 'jev-1')
    expect(decision.requestId).toBeNull()
    expect(decision.modelResolved).toBeNull()
  })

  it('defaults selected probability to 0 when absent', () => {
    // Choice is valid but probabilities omit it.
    const raw = { choice: 'c1', probabilities: { c2: 0.5 } }
    const decision = normalizeJevResponse(raw, input, 'jev-1')
    expect(decision.selectedId).toBe('c1')
    expect(decision.selectedProbability).toBe(0)
  })

  it('rejects malformed responses', () => {
    expect(() => normalizeJevResponse(null, input, 'jev-1')).toThrow(/not an object/)
    expect(() => normalizeJevResponse({}, input, 'jev-1')).toThrow(/no choice, score, or noul/)
    expect(() => normalizeJevResponse({ choice: 'c99' }, input, 'jev-1')).toThrow(/not a valid candidate/)
    expect(() =>
      normalizeJevResponse({ choice: 'c1', probabilities: { c1: 1.5 } }, input, 'jev-1'),
    ).toThrow(/Invalid probability/)
    expect(() => normalizeJevResponse({ choice: 'c1', probabilities: 'nope' }, input, 'jev-1')).toThrow(
      /not an object/,
    )
  })

  it('handles null-safe usage accounting', () => {
    const decision = normalizeJevResponse({ choice: 'c1', probabilities: { c1: 1 } }, input, 'jev-1')
    expect(decision.usage).toEqual({ inputTokens: null, outputTokens: null })
    const withSnake = normalizeJevResponse(
      { choice: 'c1', probabilities: { c1: 1 }, usage: { input_tokens: 50 } },
      input,
      'jev-1',
    )
    expect(withSnake.usage.inputTokens).toBe(50)
  })
})

describe('nonRetryableCode', () => {
  it('identifies non-retryable System1Errors', () => {
    expect(nonRetryableCode(system1Error('TASK_CANCELLED', 'cancelled', {}))).toBe('TASK_CANCELLED')
    expect(nonRetryableCode(system1Error('PROVIDER_MALFORMED_RESPONSE', 'bad', {}))).toBe(
      'PROVIDER_MALFORMED_RESPONSE',
    )
  })

  it('returns undefined for retryable or non-System1 errors', () => {
    expect(nonRetryableCode(system1Error('PROVIDER_TIMEOUT', 'timeout', {}))).toBeUndefined()
    expect(nonRetryableCode(new Error('plain error'))).toBeUndefined()
    expect(nonRetryableCode('string failure')).toBeUndefined()
    expect(nonRetryableCode(null)).toBeUndefined()
    expect(nonRetryableCode(undefined)).toBeUndefined()
  })
})

describe('JevDecisionProvider', () => {
  it('requires an API key and pinned model', () => {
    expect(() => new JevDecisionProvider({ apiKey: '', model: 'jev-1' })).toThrow(/API key/)
    expect(() => new JevDecisionProvider({ apiKey: 'k', model: '' })).toThrow(/pinned/)
  })

  it('decides via the TypeSafe API', async () => {
    const fetchFn = mockFetch({
      choice: 'c2',
      probabilities: { c1: 0.2, c2: 0.8 },
      confidence: 0.85,
      model: 'jev-1-rev3',
      usage: { inputTokens: 120, outputTokens: 0 },
    })
    const provider = new JevDecisionProvider({ apiKey: 'test-key', model: 'jev-1', fetchFn })
    const decision = await provider.decide(input, new AbortController().signal)
    expect(decision.selectedId).toBe('c2')
    expect(decision.decisionId).toBe('d1')
  })

  it('retries transport failures once, then throws', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls++
      throw new Error('network down')
    }) as typeof fetch
    const provider = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1',
      fetchFn,
      maxTransportRetries: 1,
    })
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(/transport failed/)
    expect(calls).toBe(2)
  })

  it('maps HTTP errors to structured codes', async () => {
    const rateLimited = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1',
      fetchFn: mockFetch({}, false, 429),
      maxTransportRetries: 0,
    })
    await expect(rateLimited.decide(input, new AbortController().signal)).rejects.toThrow(/rate limited/i)

    const authFailed = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1',
      fetchFn: mockFetch({}, false, 401),
      maxTransportRetries: 0,
    })
    await expect(authFailed.decide(input, new AbortController().signal)).rejects.toThrow(/auth failed/)

    const serverError = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1',
      fetchFn: mockFetch({}, false, 500),
      maxTransportRetries: 0,
    })
    await expect(serverError.decide(input, new AbortController().signal)).rejects.toThrow(
      /HTTP 500/,
    )
  })

  it('handles non-Error throwables', async () => {
    const fetchFn = (async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string failure'
    }) as typeof fetch
    const provider = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1',
      fetchFn,
      maxTransportRetries: 0,
    })
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(
      /transport failed/,
    )
  })

  it('honors cancellation', async () => {
    const provider = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1',
      fetchFn: mockFetch({ choice: 'c1', probabilities: { c1: 1 } }),
    })
    const controller = new AbortController()
    controller.abort()
    await expect(provider.decide(input, controller.signal)).rejects.toThrow(/cancelled/)
  })

  it('does not retry malformed responses', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls++
      return { ok: true, status: 200, json: async () => ({ bogus: true }) }
    }) as typeof fetch
    const provider = new JevDecisionProvider({ apiKey: 'k', model: 'jev-1', fetchFn })
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(/no choice/)
    expect(calls).toBe(1)
  })

  it('times out slow responses', async () => {
    const fetchFn = ((_url: string, opts: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as typeof fetch
    const provider = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1',
      fetchFn,
      timeoutMs: 10,
      maxTransportRetries: 0,
    })
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(/timed out/)
  })

  it('surfaces cancellation during the fetch', async () => {
    const controller = new AbortController()
    const fetchFn = ((_url: string, opts: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        // Simulate the fetch observing the caller's abort.
        controller.signal.addEventListener('abort', () => {
          opts.signal?.dispatchEvent(new Event('abort'))
          reject(new Error('aborted'))
        })
      })) as typeof fetch
    const provider = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1',
      fetchFn,
      maxTransportRetries: 0,
    })
    const promise = provider.decide(input, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow(/cancelled/)
  })

  it('uses the default fetch when none is injected', () => {
    // Construction with defaults is covered; the default fetch is only
    // exercised in integration (not unit tests).
    const provider = new JevDecisionProvider({ apiKey: 'k', model: 'jev-1' })
    expect(provider).toBeInstanceOf(JevDecisionProvider)
  })

  it('aborts between retries when cancelled', async () => {
    let calls = 0
    const controller = new AbortController()
    const fetchFn = (async () => {
      calls++
      controller.abort()
      throw new Error('network down')
    }) as typeof fetch
    const provider = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1',
      fetchFn,
      maxTransportRetries: 2,
    })
    await expect(provider.decide(input, controller.signal)).rejects.toThrow(/cancelled/)
    expect(calls).toBe(1)
  })
})
