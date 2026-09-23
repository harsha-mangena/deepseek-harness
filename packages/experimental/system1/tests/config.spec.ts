/**
 * Config schema tests: defaults are applied, invalid values are rejected,
 * and no secret material is required in configuration.
 */

import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

describe('system1 Config', () => {
  it('applies safe defaults', () => {
    const config = Config({})
    expect(config.enabled).toBe(true)
    expect(config.backend).toBe('jev')
    expect(config.mode).toBe('shadow')
    expect(config.confidenceThreshold).toBe(0.7)
    expect(config.thresholds).toEqual({})
    expect(config.budgetPerTurn).toBe(8)
    expect(config.budgetPerTask).toBe(16)
    expect(config.timeoutMs).toBe(1200)
    expect(config.loopStuckThreshold).toBe(0.7)
    expect(config.maxLoopNudgesPerTask).toBe(2)
    expect(config.stopStuckThreshold).toBe(0.9)
    expect(config.delegationWeights).toEqual({ novelty: 0.4, toolRisk: 0.35, irreversibility: 0.25 })
  })

  it('accepts explicit overrides', () => {
    const config = Config({
      backend: 'none',
      mode: 'assist',
      budgetPerTurn: 2,
      jevModel: 'jev-1.13.0',
      thresholds: { 'retry-judgment': 0.6 },
      delegationWeights: { novelty: 0.5, toolRisk: 0.3, irreversibility: 0.2 },
    })
    expect(config.backend).toBe('none')
    expect(config.mode).toBe('assist')
    expect(config.budgetPerTurn).toBe(2)
    expect(config.jevModel).toBe('jev-1.13.0')
    expect(config.thresholds).toEqual({ 'retry-judgment': 0.6 })
    expect(config.delegationWeights).toEqual({ novelty: 0.5, toolRisk: 0.3, irreversibility: 0.2 })
  })

  it('rejects unknown backends and modes', () => {
    expect(() => Config({ backend: 'gpt' })).toThrow()
    expect(() => Config({ mode: 'turbo' })).toThrow()
  })

  it('rejects out-of-range confidence thresholds', () => {
    expect(() => Config({ confidenceThreshold: 1.5 })).toThrow()
    expect(() => Config({ confidenceThreshold: -0.1 })).toThrow()
  })

  it('rejects negative budgets and timeouts', () => {
    expect(() => Config({ budgetPerTurn: -1 })).toThrow()
    expect(() => Config({ timeoutMs: -5 })).toThrow()
  })

  it('points at the real Jev endpoint and a pinned model by default', () => {
    const config = Config({})
    expect(config.jevEndpoint).toBe('https://api.typesafe.ai/v1/systemone')
    // Pinned: TypeSafe warns aliases move, and the shipped thresholds are
    // tuned against this release.
    expect(config.jevModel).toBe('jev-1.13.0')
  })

  it('names the key environment variable instead of holding a key', () => {
    const config = Config({})
    expect(config.jevApiKeyEnv).toBe('TYPESAFE_API_KEY')
    expect(JSON.stringify(config)).not.toContain('sk-')
  })
})
