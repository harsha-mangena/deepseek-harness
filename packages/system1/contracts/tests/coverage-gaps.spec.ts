/** Coverage-gap tests: exercise uncovered branches in errors.ts. */

import { describe, expect, it } from 'vitest'
import { System1Error, system1Error } from '../src/errors.ts'

describe('errors coverage gaps', () => {
  it('accepts explicit retryClass and details via constructor', () => {
    const err = new System1Error('BUDGET_EXHAUSTED', 'custom', {
      retryClass: 'retry',
      details: { tenantId: 't1', units: 5 },
    })
    expect(err.retryClass).toBe('retry')
    expect(err.details).toEqual({ tenantId: 't1', units: 5 })
    // Details are frozen.
    expect(Object.isFrozen(err.details)).toBe(true)
  })

  it('accepts a cause via constructor', () => {
    const cause = new Error('root cause')
    const err = new System1Error('EXECUTION_FAILED', 'wrapped', { cause })
    expect(err.cause).toBe(cause)
  })

  it('factory passes details through', () => {
    const err = system1Error('BUDGET_EXHAUSTED', 'no budget', { tenantId: 't1' })
    expect(err.details).toEqual({ tenantId: 't1' })
  })
})
