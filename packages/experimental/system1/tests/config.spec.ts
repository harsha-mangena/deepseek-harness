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
    expect(config.backend).toBe('laya')
    expect(config.mode).toBe('shadow')
    expect(config.confidenceThreshold).toBe(0.7)
    expect(config.budgetPerTurn).toBe(4)
    expect(config.budgetPerTask).toBe(12)
    expect(config.timeoutMs).toBe(150)
  })

  it('accepts explicit overrides', () => {
    const config = Config({ backend: 'jev', mode: 'assist', budgetPerTurn: 2 })
    expect(config.backend).toBe('jev')
    expect(config.mode).toBe('assist')
    expect(config.budgetPerTurn).toBe(2)
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

  it('names the key environment variable instead of holding a key', () => {
    const config = Config({})
    expect(config.jevApiKeyEnv).toBe('JEV_API_KEY')
    expect(JSON.stringify(config)).not.toContain('sk-')
  })
})
