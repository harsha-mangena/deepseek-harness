/**
 * Coverage for the branches the main suites do not reach in the Jev
 * backend, the question builders, the delegation registry, and the
 * calibration helpers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { System1Backend } from '../src/backend.ts'
import { decideManyFallback, JevBackend } from '../src/backends/jev.ts'
import { computeECE, reliabilityCurve } from '../src/calibration.ts'
import {
  delegationScoreNames,
  extractFinalQa,
  messageText,
  previewMessages,
} from '../src/gates.ts'
import { createDelegationState, type DelegationScoreCache } from '../src/orchestrator.ts'
import type { System1Judgment, System1Question, System1RuntimeConfig } from '../src/types.ts'

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

describe('JevBackend coverage', () => {
  it('decideManyFallback asks each question through decide in order', async () => {
    const seen: string[] = []
    const backend: System1Backend = {
      kind: 'none',
      async decide(question: System1Question): Promise<System1Judgment> {
        seen.push(question.kind)
        return { answer: question.kind, confidence: 1, latencyMs: 1, backend: 'none', abstained: false }
      },
      async decideMany(questions, signal): Promise<System1Judgment[]> {
        const judgments: System1Judgment[] = []
        for (const question of questions) judgments.push(await this.decide(question, signal))
        return judgments
      },
      async dispose(): Promise<void> {},
    }
    const judgments = await decideManyFallback(backend, [triage, loopCheck], new AbortController().signal)
    expect(seen).toEqual(['triage', 'loop-check'])
    expect(judgments.map(judgment => judgment.answer)).toEqual(['triage', 'loop-check'])
  })

  it('warm() without an API key returns without calling fetch', async () => {
    delete process.env.SYSTEM1_TEST_TYPESAFE_KEY
    let called = false
    stubFetch(() => {
      called = true
      return jsonResponse({})
    })
    const backend = new JevBackend(testConfig())
    await expect(backend.warm(new AbortController().signal)).resolves.toBeUndefined()
    expect(called).toBe(false)
  })

  it('warm() swallows a fetch failure', async () => {
    process.env[KEY_ENV] = 'test-key'
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network down')))
    const backend = new JevBackend(testConfig())
    await expect(backend.warm(new AbortController().signal)).resolves.toBeUndefined()
  })

  it('clamps non-finite and non-numeric confidences to zero', async () => {
    process.env[KEY_ENV] = 'test-key'
    const confidences: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, 'high']
    stubFetch(() => {
      // JSON cannot carry NaN/Infinity, so override the parsed body directly.
      const response = jsonResponse({ answers: {} })
      response.json = async (): Promise<unknown> => ({
        answers: {
          'triage#0': { choice: 'trivial', confidence: confidences[0] },
          'triage#1': { choice: 'trivial', confidence: confidences[1] },
          'triage#2': { choice: 'trivial', confidence: confidences[2] },
        },
      })
      return response
    })
    const backend = new JevBackend(testConfig())
    const judgments = await backend.decideMany([triage, triage, triage], new AbortController().signal)
    expect(judgments.map(judgment => judgment?.confidence)).toEqual([0, 0, 0])
  })

  it('maps a choice answer without a choice field to a null answer', async () => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch(() => jsonResponse({ answers: { 'triage#0': { confidence: 0.9 } } }))
    const backend = new JevBackend(testConfig())
    const [judgment] = await backend.decideMany([triage], new AbortController().signal)
    expect(judgment?.answer).toBeNull()
    expect(judgment?.confidence).toBe(0.9)
    expect(judgment?.abstained).toBe(false)
  })

  it('decide() throws when the batch yields no judgments', async () => {
    process.env[KEY_ENV] = 'test-key'
    const backend = new JevBackend(testConfig())
    vi.spyOn(backend, 'decideMany').mockResolvedValue([])
    await expect(backend.decide(triage, new AbortController().signal)).rejects.toThrow('no judgments')
  })

  it('sends one flat state when contexts match through key reordering and arrays', async () => {
    process.env[KEY_ENV] = 'test-key'
    const seen: SeenRequest[] = []
    stubFetch((request) => {
      seen.push(request)
      return jsonResponse({ answers: {} })
    })
    const backend = new JevBackend(testConfig())
    const first: System1Question = {
      ...triage,
      context: { b: 2, tags: ['x', 'y'], nested: { y: 1, x: 2 } },
    }
    const second: System1Question = {
      ...loopCheck,
      context: { nested: { x: 2, y: 1 }, tags: ['x', 'y'], b: 2 },
    }
    await backend.decideMany([first, second], new AbortController().signal)
    const request = seen[0]
    if (request === undefined) throw new Error('expected fetch to be called')
    const body = JSON.parse(request.init.body as string) as {
      state: unknown
      questions: Record<string, { instructions: string }>
    }
    // Same context modulo key order: one flat shared state, and the array
    // passed through the key-sorting replacer untouched.
    expect(body.state).toEqual({ b: 2, tags: ['x', 'y'], nested: { y: 1, x: 2 } })
    expect(body.questions['triage#0']?.instructions).not.toContain('Use only the fields')
  })
})

describe('gates coverage', () => {
  it('messageText joins array content parts and skips non-text parts', () => {
    expect(messageText({ content: ['hello', 'world'] })).toBe('hello world')
    expect(messageText({ content: ['a', { text: 'b' }, 42, { text: 7 }, null] })).toBe('a b')
  })

  it('previewMessages falls back from role to type to a default label', () => {
    expect(previewMessages([{ role: 'user', content: 'hi' }])).toEqual(['[user] hi'])
    expect(previewMessages([{ type: 'tool', content: 'out' }])).toEqual(['[tool] out'])
    expect(previewMessages([{ content: 'x' }])).toEqual(['[message] x'])
  })

  it('extractFinalQa skips non-object messages, non-dialogue roles, and empty text', () => {
    expect(
      extractFinalQa([
        'junk',
        { role: 'system', content: 'be nice' },
        { role: 'user', content: '   ' },
        { role: 'user', content: 'the request' },
        { role: 'assistant', content: 'the answer' },
      ]),
    ).toEqual({ request: 'the request', answer: 'the answer' })
  })

  it('delegationScoreNames returns the three dimensions in builder order', () => {
    expect(delegationScoreNames()).toEqual(['novelty', 'toolRisk', 'irreversibility'])
  })
})

describe('orchestrator coverage', () => {
  it('findDuplicate never matches a record with an empty word set', () => {
    const state = createDelegationState()
    state.noteSpawn('the', 'of and to')
    // The existing record's words are all stopwords: jaccard takes its
    // empty-set branch and the candidate is not flagged as a duplicate.
    expect(state.findDuplicate('build the widget', 'write the code')).toBeNull()
  })

  it('noteScores evicts the oldest cached composite past maxSpawns', () => {
    const state = createDelegationState(2)
    const cached = (): DelegationScoreCache => ({
      scores: { novelty: 1, toolRisk: 1, irreversibility: 1 },
      oversight: {
        level: 'low',
        score: 0.2,
        scores: { novelty: 1, toolRisk: 1, irreversibility: 1 },
      },
      advisory: null,
    })
    state.noteScores('a', cached())
    state.noteScores('b', cached())
    expect(state.takeScores('a')).not.toBeNull()
    state.noteScores('c', cached())
    expect(state.takeScores('a')).toBeNull()
    expect(state.takeScores('b')).not.toBeNull()
    expect(state.takeScores('c')).not.toBeNull()
  })
})

describe('calibration coverage', () => {
  it('computeECE returns NaN with no pairs or no bins', () => {
    expect(computeECE([])).toBeNaN()
    expect(computeECE([{ confidence: 0.8, correct: true }], 0)).toBeNaN()
    expect(computeECE([], 0)).toBeNaN()
  })

  it('reliabilityCurve returns no bins with no pairs or no bins', () => {
    expect(reliabilityCurve([])).toEqual([])
    expect(reliabilityCurve([{ confidence: 0.8, correct: true }], 0)).toEqual([])
  })
})
