/**
 * Tests for {@link JevBackend}: the documented `POST /v1/systemone` wire
 * format, verified against TypeSafe's getting-started guide. `fetch` is
 * stubbed; no network is touched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { JevBackend, JevRateLimitError } from '../src/backends/jev.ts'
import type { System1Question, System1RuntimeConfig } from '../src/types.ts'

const KEY_ENV = 'SYSTEM1_TEST_TYPESAFE_KEY'

function testConfig(overrides: Partial<System1RuntimeConfig> = {}): System1RuntimeConfig {
  return {
    backend: 'jev',
    mode: 'shadow',
    enabled: true,
    confidenceThreshold: 0.7,
    thresholds: {},
    budgetPerTurn: 4,
    budgetPerTask: 12,
    timeoutMs: 1200,
    failureThreshold: 3,
    cooldownMs: 30_000,
    traceBufferSize: 200,
    delegationWeights: { novelty: 0.4, toolRisk: 0.35, irreversibility: 0.25 },
    jevApiKeyEnv: KEY_ENV,
    jevEndpoint: 'https://api.typesafe.ai/v1/systemone',
    jevModel: 'jev-latest',
    layaEndpoint: 'http://127.0.0.1:17840/decide',
    layaAutoStart: true,
    layaCommand: ['python3', '-m', 'laya_serve'],
    ...overrides,
  }
}

const triage: System1Question = {
  kind: 'triage',
  primitive: 'choice',
  prompt: 'How much reasoning does this agent step need?',
  context: { messagePreview: 'hi' },
  options: { trivial: 'no reasoning needed', complex: 'full reasoning' },
}

const loopCheck: System1Question = {
  kind: 'loop-check',
  primitive: 'noul',
  prompt: 'The agent is stuck repeating itself and should be interrupted',
  context: { history: [{ name: 'read' }] },
}

interface SeenRequest {
  url: string
  init: RequestInit
}

function stubFetch(handler: (seen: SeenRequest) => Response): void {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const seen = { url, init }
    return Promise.resolve(handler(seen))
  })
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.SYSTEM1_TEST_TYPESAFE_KEY
})

describe('JevBackend wire format', () => {
  it('posts model, state, and typed questions to /v1/systemone', async () => {
    process.env[KEY_ENV] = 'test-key'
    const seenRequests: SeenRequest[] = []
    stubFetch((request) => {
      seenRequests.push(request)
      return jsonResponse({ model: 'jev-1.13.0', answers: {} })
    })
    const backend = new JevBackend(testConfig())
    await backend.decideMany([triage, loopCheck], new AbortController().signal)

    const seen = seenRequests[0]
    if (seen === undefined) throw new Error('expected fetch to be called')
    expect(seen.url).toBe('https://api.typesafe.ai/v1/systemone')
    const headers = seen.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer test-key')
    const body = JSON.parse(seen.init.body as string) as {
      model: string
      state: Record<string, unknown>
      questions: Record<string, { type: string; instructions: string; criteria?: unknown }>
    }
    expect(body.model).toBe('jev-latest')
    expect(body.questions['triage#0']).toMatchObject({
      type: 'choice',
      instructions: 'How much reasoning does this agent step need?',
      criteria: { trivial: 'no reasoning needed', complex: 'full reasoning' },
    })
    expect(body.questions['loop-check#1']).toMatchObject({ type: 'noul' })
    expect(body.questions['loop-check#1']).not.toHaveProperty('criteria')
    expect(body.state['triage#0']).toEqual({ messagePreview: 'hi' })
  })

  it('parses choice answers with confidence and the model id', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({
      model: 'jev-1.13.0',
      answers: { 'triage#0': { choice: 'trivial', confidence: 0.92 } },
    }))
    const backend = new JevBackend(testConfig())
    const [judgment] = await backend.decideMany([triage], new AbortController().signal)
    expect(judgment?.answer).toBe('trivial')
    expect(judgment?.confidence).toBe(0.92)
    expect(judgment?.model).toBe('jev-1.13.0')
    expect(judgment?.abstained).toBe(false)
  })

  it('maps a decided noul to its probability with full confidence', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({
      model: 'jev-1.13.0',
      answers: { 'loop-check#0': { noul: 0.85 } },
    }))
    const backend = new JevBackend(testConfig())
    const [judgment] = await backend.decideMany([loopCheck], new AbortController().signal)
    expect(judgment?.answer).toBe(0.85)
    // noul has no separate confidence (TypeSafe docs): a decided probability
    // is thresholded directly by the caller, so no confidence is invented.
    expect(judgment?.confidence).toBe(1)
    expect(judgment?.abstained).toBe(false)
  })

  it('abstains on a near-even noul instead of judging a coin flip', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({
      model: 'jev-1.13.0',
      answers: { 'loop-check#0': { noul: 0.55 } },
    }))
    const backend = new JevBackend(testConfig())
    const [judgment] = await backend.decideMany([loopCheck], new AbortController().signal)
    expect(judgment?.answer).toBe(0.55)
    expect(judgment?.abstained).toBe(true)
    expect(judgment?.confidence).toBe(0)
  })

  it('does not abstain just outside the band', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({
      model: 'jev-1.13.0',
      answers: { 'loop-check#0': { noul: 0.61 } },
    }))
    const backend = new JevBackend(testConfig())
    const [judgment] = await backend.decideMany([loopCheck], new AbortController().signal)
    expect(judgment?.abstained).toBe(false)
  })

  it('abstains on a missing noul instead of judging a confident zero', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({
      model: 'jev-1.13.0',
      answers: { 'loop-check#0': { confidence: 0.9 } },
    }))
    const backend = new JevBackend(testConfig())
    const [judgment] = await backend.decideMany([loopCheck], new AbortController().signal)
    expect(judgment?.answer).toBeNull()
    expect(judgment?.abstained).toBe(true)
    expect(judgment?.confidence).toBe(0)
  })

  it('abstains on a non-numeric noul', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({
      model: 'jev-1.13.0',
      answers: { 'loop-check#0': { noul: 'high' } },
    }))
    const backend = new JevBackend(testConfig())
    const [judgment] = await backend.decideMany([loopCheck], new AbortController().signal)
    expect(judgment?.answer).toBeNull()
    expect(judgment?.abstained).toBe(true)
    expect(judgment?.confidence).toBe(0)
  })

  it('abstains when an answer is missing or malformed', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({ model: 'jev-1.13.0', answers: {} }))
    const backend = new JevBackend(testConfig())
    const [judgment] = await backend.decideMany([triage], new AbortController().signal)
    expect(judgment?.abstained).toBe(true)
    expect(judgment?.confidence).toBe(0)
  })

  it('throws JevRateLimitError on HTTP 429', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '2' }))
    const backend = new JevBackend(testConfig())
    const error = await backend
      .decideMany([triage], new AbortController().signal)
      .then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(JevRateLimitError)
    expect((error as JevRateLimitError).retryAfterMs).toBe(2000)
  })

  it('marks rate-limit errors transient so the service skips the circuit breaker', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({ error: 'slow down' }, 429))
    const backend = new JevBackend(testConfig())
    const error = await backend
      .decideMany([triage], new AbortController().signal)
      .then(() => null, (e: unknown) => e)
    expect((error as { transient?: unknown }).transient).toBe(true)
  })

  it('throws on other HTTP errors', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({ error: 'bad key' }, 401))
    const backend = new JevBackend(testConfig())
    await expect(backend.decideMany([triage], new AbortController().signal)).rejects.toThrow('401')
  })

  it('throws a helpful error when the API key is missing', async () => {
    delete process.env.SYSTEM1_TEST_TYPESAFE_KEY
    let called = false
    stubFetch(() => {
      called = true
      return jsonResponse({})
    })
    const backend = new JevBackend(testConfig())
    await expect(backend.decideMany([triage], new AbortController().signal)).rejects.toThrow(KEY_ENV)
    expect(called).toBe(false)
  })

  it('decide() asks a single question through the batch path', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({
      model: 'jev-1.13.0',
      answers: { 'triage#0': { choice: 'complex', confidence: 0.8 } },
    }))
    const backend = new JevBackend(testConfig({ jevModel: 'jev-1.13.0' }))
    const judgment = await backend.decide(triage, new AbortController().signal)
    expect(judgment.answer).toBe('complex')
  })

  it('returns no judgments for no questions without calling fetch', async () => {
    process.env[KEY_ENV] = 'test-key'
    let called = false
    stubFetch(() => {
      called = true
      return jsonResponse({})
    })
    const backend = new JevBackend(testConfig())
    expect(await backend.decideMany([], new AbortController().signal)).toEqual([])
    expect(called).toBe(false)
  })
})
