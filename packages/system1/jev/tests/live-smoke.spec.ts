/** Live-smoke key-gating tests (no network calls; the live path needs a key). */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SMOKE_API_KEY_ENV,
  SMOKE_DEFAULT_MODEL,
  SMOKE_MODEL_ENV,
  buildSmokeInput,
  printSmokeDecision,
  resolveSmokeConfig,
  runSmoke,
} from '../src/live-smoke.ts'
import type { NormalizedDecision } from '@deepseek-ai/dsh-system1-contracts'
import { System1Error } from '@deepseek-ai/dsh-system1-contracts'

let mockDecideBehavior: 'success' | 'failure' | 'system1-error' | 'non-error' = 'success'

vi.mock('../src/jev-provider.ts', () => ({
  JevDecisionProvider: class {
    decide = vi.fn().mockImplementation(() => {
      if (mockDecideBehavior === 'failure') {
        return Promise.reject(new Error('network failure'))
      }
      if (mockDecideBehavior === 'system1-error') {
        return Promise.reject(
          new System1Error('PROVIDER_ERROR', 'provider error', {}),
        )
      }
      if (mockDecideBehavior === 'non-error') {
        return Promise.reject('string failure')
      }
      return Promise.resolve({
        decisionId: 'live-smoke-d1',
        questionFamily: 'live-smoke-routing',
        promptVersion: 'live-smoke/v1',
        selectedId: 'read-ci-status',
        probabilities: { 'read-ci-status': 0.8, 'read-logs': 0.1, escalate: 0.1 },
        selectedProbability: 0.8,
        vendorConfidence: 0.95,
        calibratedCorrectness: null,
        calibrationVersion: null,
        modelRequested: 'jev-1.13.0',
        modelResolved: 'jev-1.13.0',
        requestId: 'r1',
        usage: { inputTokens: 100, outputTokens: 50 },
        reasonCode: 'accepted',
      })
    })
    constructor(_config: unknown) {}
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveSmokeConfig', () => {
  it('returns null when the API key is unset', () => {
    expect(resolveSmokeConfig({})).toBeNull()
  })

  it('returns null when the API key is empty', () => {
    expect(resolveSmokeConfig({ [SMOKE_API_KEY_ENV]: '' })).toBeNull()
  })

  it('returns the key with the default pinned model', () => {
    expect(resolveSmokeConfig({ [SMOKE_API_KEY_ENV]: 'k' })).toEqual({
      apiKey: 'k',
      model: SMOKE_DEFAULT_MODEL,
    })
  })

  it('honors the model override', () => {
    expect(
      resolveSmokeConfig({ [SMOKE_API_KEY_ENV]: 'k', [SMOKE_MODEL_ENV]: 'jev-1.14.0' }),
    ).toEqual({ apiKey: 'k', model: 'jev-1.14.0' })
  })
})

describe('runSmoke without credentials', () => {
  it('exits 2 with a skip message and makes no network call', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await runSmoke({})
    expect(code).toBe(2)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('skipped: no credentials'),
    )
  })
})

describe('runSmoke with credentials (mocked provider)', () => {
  it('runs the live path and returns 0 on success', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = await runSmoke({ [SMOKE_API_KEY_ENV]: 'test-key' })
    expect(code).toBe(0)
    const output = log.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('live smoke: validated decision')
    expect(output).toContain('read-ci-status')
  })

  it('returns 1 when the provider throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockDecideBehavior = 'failure'
    try {
      const code = await runSmoke({ [SMOKE_API_KEY_ENV]: 'test-key' })
      expect(code).toBe(1)
      expect(error).toHaveBeenCalledWith(expect.stringContaining('live smoke failed'))
    } finally {
      mockDecideBehavior = 'success'
    }
  })

  it('reports the System1Error code when the provider throws System1Error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockDecideBehavior = 'system1-error'
    try {
      const code = await runSmoke({ [SMOKE_API_KEY_ENV]: 'test-key' })
      expect(code).toBe(1)
      expect(error).toHaveBeenCalledWith(expect.stringContaining('PROVIDER_ERROR'))
    } finally {
      mockDecideBehavior = 'success'
    }
  })

  it('stringifies non-Error throwables', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockDecideBehavior = 'non-error'
    try {
      const code = await runSmoke({ [SMOKE_API_KEY_ENV]: 'test-key' })
      expect(code).toBe(1)
      expect(error).toHaveBeenCalledWith(expect.stringContaining('string failure'))
    } finally {
      mockDecideBehavior = 'success'
    }
  })
})

describe('buildSmokeInput', () => {
  it('builds a bounded choice with an escalation candidate', () => {
    const input = buildSmokeInput()
    expect(input.candidates).toHaveLength(3)
    expect(input.candidates.map(c => c.id)).toContain('escalate')
    expect(input.questionFamily).toBeTruthy()
  })
})

describe('printSmokeDecision', () => {
  it('prints the decision fields without credentials', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const decision: NormalizedDecision = {
      decisionId: 'live-smoke-d1',
      questionFamily: 'live-smoke-routing',
      promptVersion: 'live-smoke/v1',
      selectedId: 'read-ci-status',
      probabilities: { 'read-ci-status': 0.6, 'read-logs': 0.3, escalate: 0.1 },
      selectedProbability: 0.6,
      vendorConfidence: 0.9,
      calibratedCorrectness: null,
      calibrationVersion: null,
      modelRequested: 'jev-1.13.0',
      modelResolved: 'jev-1.13.0',
      requestId: 'r1',
      usage: { inputTokens: 120, outputTokens: null },
      reasonCode: 'accepted',
    }
    printSmokeDecision(decision)
    const output = log.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('jev-1.13.0')
    expect(output).toContain('read-ci-status')
    expect(output).toContain('calibrated correctness: null')
    expect(output).not.toContain('sk-')
  })

  it('prints null fallbacks for unresolved model and missing usage', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const decision: NormalizedDecision = {
      decisionId: 'live-smoke-d1',
      questionFamily: 'live-smoke-routing',
      promptVersion: 'live-smoke/v1',
      selectedId: 'escalate',
      probabilities: { escalate: 1.0 },
      selectedProbability: 1.0,
      vendorConfidence: null,
      calibratedCorrectness: null,
      calibrationVersion: null,
      modelRequested: 'jev-1.13.0',
      modelResolved: null,
      requestId: 'r1',
      usage: { inputTokens: null, outputTokens: null },
      reasonCode: 'accepted',
    }
    printSmokeDecision(decision)
    const output = log.mock.calls.map(c => String(c[0])).join('\n')
    expect(output).toContain('model resolved:  null')
    expect(output).toContain('vendor confidence:     null')
    expect(output).toContain('input=unknown output=unknown')
  })
})
