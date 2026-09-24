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
})
