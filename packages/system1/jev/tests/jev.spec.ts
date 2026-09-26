/** Jev provider and normalization tests (mocked transport, no live calls). */

import { describe, expect, it } from 'vitest'
import { JevDecisionProvider, nonRetryableCode, normalizeJevResponse } from '@deepseek-ai/dsh-system1-jev'
import { System1Error, system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type { Candidate, DecisionInput } from '@deepseek-ai/dsh-system1-contracts'

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
      answers: {
        q1: {
          choice: 'c1',
          probabilities: { c1: 0.8, c2: 0.2 },
          confidence: 0.9,
        },
      },
      model: 'jev-1.13.0',
      requestId: 'req-123',
      usage: { inputTokens: 150, outputTokens: 0 },
    }
    const decision = normalizeJevResponse(raw, input, 'jev-1.13.0')
    expect(decision.selectedId).toBe('c1')
    expect(decision.selectedProbability).toBe(0.8)
    expect(decision.vendorConfidence).toBe(0.9)
    expect(decision.modelRequested).toBe('jev-1.13.0')
    expect(decision.modelResolved).toBe('jev-1.13.0')
    expect(decision.requestId).toBe('req-123')
    expect(decision.usage).toEqual({ inputTokens: 150, outputTokens: 0 })
    expect(decision.reasonCode).toBe('accepted')
    // Calibrated correctness is null until Phase 4.
    expect(decision.calibratedCorrectness).toBeNull()
  })

  it('normalizes a noul response as uncertain', () => {
    const raw = { answers: { q1: { noul: 0.99 } }, model: 'jev-1.13.0' }
    const decision = normalizeJevResponse(raw, input, 'jev-1.13.0')
    expect(decision.selectedId).toBe('escalate-none')
    expect(decision.reasonCode).toBe('uncertain')
  })

  it('normalizes a score response by selecting the top candidate', () => {
    const raw = {
      answers: {
        q1: {
          score: 1.0,
          probabilities: { c1: 0.3, c2: 0.7 },
          confidence: 0.75,
        },
      },
    }
    const decision = normalizeJevResponse(raw, input, 'jev-1.13.0')
    expect(decision.selectedId).toBe('c2')
    expect(decision.selectedProbability).toBe(0.7)
  })

  it('uses score directly when probabilities are absent', () => {
    const raw = { answers: { q1: { score: { c1: 0.4, c2: 0.6 } } } }
    const decision = normalizeJevResponse(raw, input, 'jev-1.13.0')
    expect(decision.selectedId).toBe('c2')
  })

  it('rejects score maps that omit a candidate', () => {
    const rawPartial = { answers: { q1: { score: { c2: 0.6 } } } }
    expect(() => normalizeJevResponse(rawPartial, input, 'jev-1.13.0')).toThrow(
      /missing candidate/,
    )
  })

  it('rejects score responses with no valid candidate', () => {
    expect(() =>
      normalizeJevResponse({ answers: { q1: { score: { c99: 0.5 } } } }, input, 'jev-1.13.0'),
    ).toThrow(/unknown candidate/)
  })

  it('rejects probabilities for unknown candidates', () => {
    const raw = { answers: { q1: { choice: 'c1', probabilities: { c1: 0.6, c99: 0.4 } } } }
    expect(() => normalizeJevResponse(raw, input, 'jev-1.13.0')).toThrow(/unknown candidate/)
  })

  it('accepts snake_case request_id', () => {
    const raw = {
      answers: { q1: { choice: 'c1', probabilities: { c1: 1, c2: 0 } } },
      request_id: 'snake-123',
    }
    const decision = normalizeJevResponse(raw, input, 'jev-1.13.0')
    expect(decision.requestId).toBe('snake-123')
  })

  it('handles missing request ID and model', () => {
    const raw = { answers: { q1: { choice: 'c1', probabilities: { c1: 1, c2: 0 } } } }
    const decision = normalizeJevResponse(raw, input, 'jev-1.13.0')
    expect(decision.requestId).toBeNull()
    expect(decision.modelResolved).toBeNull()
  })

  it('rejects when the selected choice is missing from the probability map', () => {
    // Choice is valid but the map omits it.
    const raw = { answers: { q1: { choice: 'c1', probabilities: { c2: 1 } } } }
    expect(() => normalizeJevResponse(raw, input, 'jev-1.13.0')).toThrow(/missing candidate/)
  })

  it('rejects malformed responses', () => {
    expect(() => normalizeJevResponse(null, input, 'jev-1.13.0')).toThrow(/not an object/)
    expect(() => normalizeJevResponse({}, input, 'jev-1.13.0')).toThrow(/has no answers/)
    expect(() => normalizeJevResponse({ answers: {} }, input, 'jev-1.13.0')).toThrow(
      /missing the answer/,
    )
    expect(() =>
      normalizeJevResponse({ answers: { q1: { choice: 'c99' } } }, input, 'jev-1.13.0'),
    ).toThrow(/not a valid candidate/)
    expect(() =>
      normalizeJevResponse(
        { answers: { q1: { choice: 'c1', probabilities: { c1: 1.5 } } } },
        input,
        'jev-1.13.0',
      ),
    ).toThrow(/Invalid probability/)
    expect(() =>
      normalizeJevResponse({ answers: { q1: { choice: 'c1', probabilities: 'nope' } } }, input, 'jev-1.13.0'),
    ).toThrow(/not an object/)
    expect(() =>
      normalizeJevResponse({ answers: { q1: { bogus: true } } }, input, 'jev-1.13.0'),
    ).toThrow(/no choice, score, or noul/)
  })

  it('handles null-safe usage accounting', () => {
    const decision = normalizeJevResponse(
      { answers: { q1: { choice: 'c1', probabilities: { c1: 1, c2: 0 } } } },
      input,
      'jev-1.13.0',
    )
    expect(decision.usage).toEqual({ inputTokens: null, outputTokens: null })
    const withSnake = normalizeJevResponse(
      {
        answers: { q1: { choice: 'c1', probabilities: { c1: 1, c2: 0 } } },
        usage: { input_tokens: 50 },
      },
      input,
      'jev-1.13.0',
    )
    expect(withSnake.usage.inputTokens).toBe(50)
  })

  it('rejects an empty probability map', () => {
    const raw = { answers: { q1: { type: 'choice', choice: 'c1', probabilities: {} } } }
    expect(() => normalizeJevResponse(raw, input, 'jev-1.13.0')).toThrow(/empty/)
  })

  it('rejects probabilities that do not sum to one', () => {
    const high = {
      answers: { q1: { type: 'choice', choice: 'c1', probabilities: { c1: 0.9, c2: 0.9 } } },
    }
    expect(() => normalizeJevResponse(high, input, 'jev-1.13.0')).toThrow(/sum to 1/)
    const low = {
      answers: { q1: { type: 'choice', choice: 'c1', probabilities: { c1: 0.25, c2: 0.25 } } },
    }
    expect(() => normalizeJevResponse(low, input, 'jev-1.13.0')).toThrow(/sum to 1/)
  })

  it('accepts sums within floating-point tolerance', () => {
    // 1/3 + 2/3 is 0.9999999999999999 in floating point.
    const raw = {
      answers: { q1: { type: 'choice', choice: 'c1', probabilities: { c1: 1 / 3, c2: 2 / 3 } } },
    }
    const decision = normalizeJevResponse(raw, input, 'jev-1.13.0')
    expect(decision.selectedId).toBe('c1')
  })

  it('rejects non-numeric or out-of-range probabilities', () => {
    const bad = (probabilities: unknown) => ({
      answers: { q1: { type: 'choice', choice: 'c1', probabilities } },
    })
    expect(() =>
      normalizeJevResponse(bad({ c1: 'high', c2: 0.5 }), input, 'jev-1.13.0'),
    ).toThrow(/Invalid probability/)
    expect(() =>
      normalizeJevResponse(bad({ c1: Number.NaN, c2: 0.5 }), input, 'jev-1.13.0'),
    ).toThrow(/Invalid probability/)
    expect(() =>
      normalizeJevResponse(bad({ c1: -0.1, c2: 1.1 }), input, 'jev-1.13.0'),
    ).toThrow(/Invalid probability/)
  })

  it('rejects a choice answer with no probability map', () => {
    const raw = { answers: { q1: { type: 'choice', choice: 'c1' } } }
    expect(() => normalizeJevResponse(raw, input, 'jev-1.13.0')).toThrow(/not an object/)
  })

  it('rejects an answer type that does not match the requested choice question', () => {
    // A Noul answer to a Choice request is a type mismatch: Noul is a yes/no
    // probability, not an abstention.
    const noul = { answers: { q1: { type: 'noul', noul: 0.99 } } }
    expect(() => normalizeJevResponse(noul, input, 'jev-1.13.0')).toThrow(/does not match/)
    const score = { answers: { q1: { type: 'score', score: { c1: 0.5, c2: 0.5 } } } }
    expect(() => normalizeJevResponse(score, input, 'jev-1.13.0')).toThrow(/does not match/)
  })

  it('accepts an explicit choice answer type', () => {
    const raw = {
      answers: { q1: { type: 'choice', choice: 'c2', probabilities: { c1: 0.2, c2: 0.8 } } },
    }
    expect(normalizeJevResponse(raw, input, 'jev-1.13.0').selectedId).toBe('c2')
  })

  it('rejects a non-string choice', () => {
    const raw = { answers: { q1: { choice: 42, probabilities: { c1: 0.5, c2: 0.5 } } } }
    expect(() => normalizeJevResponse(raw, input, 'jev-1.13.0')).toThrow(/not a valid candidate/)
  })

  it('selects the top score across orderings', () => {
    const raw = { answers: { q1: { score: { c1: 0.7, c2: 0.3 } } } }
    const decision = normalizeJevResponse(raw, input, 'jev-1.13.0')
    expect(decision.selectedId).toBe('c1')
    expect(decision.selectedProbability).toBe(0.7)
  })

  it('rejects out-of-range confidence when present', () => {
    const mk = (confidence: unknown) => ({
      answers: {
        q1: { type: 'choice', choice: 'c1', probabilities: { c1: 1, c2: 0 }, confidence },
      },
    })
    expect(() => normalizeJevResponse(mk(1.5), input, 'jev-1.13.0')).toThrow(/confidence/)
    expect(() => normalizeJevResponse(mk('high'), input, 'jev-1.13.0')).toThrow(/confidence/)
    expect(() => normalizeJevResponse(mk(Number.NaN), input, 'jev-1.13.0')).toThrow(/confidence/)
    expect(() => normalizeJevResponse(mk(-0.2), input, 'jev-1.13.0')).toThrow(/confidence/)
    // Absent confidence stays null.
    const absent = normalizeJevResponse(
      { answers: { q1: { type: 'choice', choice: 'c1', probabilities: { c1: 1, c2: 0 } } } },
      input,
      'jev-1.13.0',
    )
    expect(absent.vendorConfidence).toBeNull()
  })

  it('rejects non-integer or negative usage tokens as malformed accounting', () => {
    const mk = (usage: unknown) => ({
      answers: { q1: { type: 'choice', choice: 'c1', probabilities: { c1: 1, c2: 0 } } },
      usage,
    })
    const fractional = normalizeJevResponse(mk({ inputTokens: 1.5 }), input, 'jev-1.13.0')
    expect(fractional.usage.inputTokens).toBeNull()
    const negative = normalizeJevResponse(mk({ outputTokens: -3 }), input, 'jev-1.13.0')
    expect(negative.usage.outputTokens).toBeNull()
  })
})

describe('nonRetryableCode', () => {
  it('identifies non-retryable System1Errors', () => {
    expect(nonRetryableCode(system1Error('TASK_CANCELLED', 'cancelled', {}))).toBe('TASK_CANCELLED')
    expect(nonRetryableCode(system1Error('PROVIDER_MALFORMED_RESPONSE', 'bad', {}))).toBe(
      'PROVIDER_MALFORMED_RESPONSE',
    )
    // Permanent failures (retryClass 'none') are never retried, whatever
    // their code.
    const authFailed = new System1Error('PROVIDER_TRANSPORT_FAILED', 'Jev auth failed', {
      retryClass: 'none',
      details: { status: 401 },
    })
    expect(nonRetryableCode(authFailed)).toBe('PROVIDER_TRANSPORT_FAILED')
  })

  it('returns undefined for retryable or non-System1 errors', () => {
    expect(nonRetryableCode(system1Error('PROVIDER_TIMEOUT', 'timeout', {}))).toBeUndefined()
    expect(nonRetryableCode(system1Error('PROVIDER_RATE_LIMITED', 'limited', {}))).toBeUndefined()
    expect(nonRetryableCode(new Error('plain error'))).toBeUndefined()
    expect(nonRetryableCode('string failure')).toBeUndefined()
    expect(nonRetryableCode(null)).toBeUndefined()
    expect(nonRetryableCode(undefined)).toBeUndefined()
  })
})

describe('JevDecisionProvider', () => {
  it('requires an API key and pinned model', () => {
    expect(() => new JevDecisionProvider({ apiKey: '', model: 'jev-1.13.0' })).toThrow(/API key/)
    expect(() => new JevDecisionProvider({ apiKey: 'k', model: '' })).toThrow(/pinned/)
  })

  it('rejects mutable model aliases at construction', () => {
    expect(() => new JevDecisionProvider({ apiKey: 'k', model: 'jev-latest' })).toThrow(/pinned/)
    expect(() => new JevDecisionProvider({ apiKey: 'k', model: 'jev-1' })).toThrow(/pinned/)
    expect(() => new JevDecisionProvider({ apiKey: 'k', model: 'latest' })).toThrow(/pinned/)
  })

  it('accepts pinned model versions', () => {
    expect(
      () => new JevDecisionProvider({ apiKey: 'k', model: 'jev-1.13.0' }),
    ).not.toThrow()
  })

  it('validates the decision input before transport', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls++
      return { ok: true, status: 200, json: async () => ({}) }
    }) as typeof fetch
    const provider = new JevDecisionProvider({ apiKey: 'k', model: 'jev-1.13.0', fetchFn })
    const signal = new AbortController().signal
    await expect(provider.decide({ ...input, questionFamily: '' }, signal)).rejects.toThrow(
      /question family/,
    )
    await expect(provider.decide({ ...input, candidates: [] }, signal)).rejects.toThrow(
      /no candidates/,
    )
    const emptyId: Candidate = { ...input.candidates[0] as Candidate, id: '' }
    await expect(provider.decide({ ...input, candidates: [emptyId] }, signal)).rejects.toThrow(
      /id and label/,
    )
    const emptyLabel: Candidate = { ...input.candidates[0] as Candidate, label: '' }
    await expect(provider.decide({ ...input, candidates: [emptyLabel] }, signal)).rejects.toThrow(
      /id and label/,
    )
    // No HTTP attempt is made for invalid input.
    expect(calls).toBe(0)
  })

  it('decides via the TypeSafe API', async () => {
    const fetchFn = mockFetch({
      answers: {
        q1: {
          choice: 'c2',
          probabilities: { c1: 0.2, c2: 0.8 },
          confidence: 0.85,
        },
      },
      model: 'jev-1.13.0',
      usage: { inputTokens: 120, outputTokens: 0 },
    })
    const provider = new JevDecisionProvider({ apiKey: 'test-key', model: 'jev-1.13.0', fetchFn })
    const decision = await provider.decide(input, new AbortController().signal)
    expect(decision.selectedId).toBe('c2')
    expect(decision.decisionId).toBe('d1')
  })

  it('sends instructions and criteria in the documented wire format', async () => {
    let capturedBody = ''
    const fetchFn = (async (_url: string, init: { body?: unknown }) => {
      capturedBody = init.body as string
      return {
        ok: true,
        status: 200,
        json: async () => ({
          answers: { q1: { choice: 'c1', probabilities: { c1: 1, c2: 0 }, confidence: 0.9 } },
          model: 'jev-1.13.0',
        }),
      }
    }) as typeof fetch
    const provider = new JevDecisionProvider({ apiKey: 'test-key', model: 'jev-1.13.0', fetchFn })
    await provider.decide(input, new AbortController().signal)
    const body = JSON.parse(capturedBody) as {
      state: string
      model: string
      questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>
    }
    expect(body.state).toBe('test state')
    expect(body.model).toBe('jev-1.13.0')
    // Question key follows the input question family.
    expect(body.questions.q1.type).toBe('choice')
    expect(body.questions.q1.instructions).toContain('t1')
    expect(body.questions.q1.criteria).toEqual({ c1: 'First', c2: 'Second' })
  })

  it('retries transport failures once, then throws', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls++
      throw new Error('network down')
    }) as typeof fetch
    const provider = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1.13.0',
      fetchFn,
      maxTransportRetries: 1,
    })
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(/transport failed/)
    expect(calls).toBe(2)
  })

  it('maps HTTP errors to structured codes', async () => {
    const rateLimited = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1.13.0',
      fetchFn: mockFetch({}, false, 429),
      maxTransportRetries: 0,
    })
    await expect(rateLimited.decide(input, new AbortController().signal)).rejects.toThrow(/rate limited/i)

    const authFailed = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1.13.0',
      fetchFn: mockFetch({}, false, 401),
      maxTransportRetries: 0,
    })
    await expect(authFailed.decide(input, new AbortController().signal)).rejects.toThrow(/auth failed/)

    const serverError = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1.13.0',
      fetchFn: mockFetch({}, false, 500),
      maxTransportRetries: 0,
    })
    await expect(serverError.decide(input, new AbortController().signal)).rejects.toThrow(
      /HTTP 500/,
    )
  })

  it('does not retry invalid credentials: exactly one HTTP attempt', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls++
      return { ok: false, status: 401, json: async () => ({}) }
    }) as typeof fetch
    // Default maxTransportRetries would allow a retry; auth must not use it.
    const provider = new JevDecisionProvider({ apiKey: 'k', model: 'jev-1.13.0', fetchFn })
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(
      /auth failed/,
    )
    expect(calls).toBe(1)
  })

  it('treats other client errors as permanent', async () => {
    for (const status of [403, 422]) {
      let calls = 0
      const fetchFn = (async () => {
        calls++
        return { ok: false, status, json: async () => ({}) }
      }) as typeof fetch
      const provider = new JevDecisionProvider({ apiKey: 'k', model: 'jev-1.13.0', fetchFn })
      await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(
        new RegExp(`HTTP ${status}`),
      )
      expect(calls).toBe(1)
    }
  })

  it('retries transient server errors', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls++
      if (calls === 1) {
        return { ok: false, status: 503, json: async () => ({}) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            q1: {
              type: 'choice',
              choice: 'c1',
              probabilities: { c1: 1, c2: 0 },
              confidence: 0.9,
            },
          },
          model: 'jev-1.13.0',
        }),
      }
    }) as typeof fetch
    const provider = new JevDecisionProvider({ apiKey: 'k', model: 'jev-1.13.0', fetchFn })
    const decision = await provider.decide(input, new AbortController().signal)
    expect(calls).toBe(2)
    expect(decision.selectedId).toBe('c1')
  })

  it('handles non-Error throwables', async () => {
    const fetchFn = (async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string failure'
    }) as typeof fetch
    const provider = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1.13.0',
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
      model: 'jev-1.13.0',
      fetchFn: mockFetch({ choice: 'c1', probabilities: { c1: 1, c2: 0 } }),
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
    const provider = new JevDecisionProvider({ apiKey: 'k', model: 'jev-1.13.0', fetchFn })
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(
      /has no answers/,
    )
    expect(calls).toBe(1)
  })

  it('times out slow responses', async () => {
    const fetchFn = ((_url: string, opts: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as typeof fetch
    const provider = new JevDecisionProvider({
      apiKey: 'k',
      model: 'jev-1.13.0',
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
      model: 'jev-1.13.0',
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
    const provider = new JevDecisionProvider({ apiKey: 'k', model: 'jev-1.13.0' })
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
      model: 'jev-1.13.0',
      fetchFn,
      maxTransportRetries: 2,
    })
    await expect(provider.decide(input, controller.signal)).rejects.toThrow(/cancelled/)
    expect(calls).toBe(1)
  })
})
