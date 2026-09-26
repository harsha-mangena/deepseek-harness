/** Supplemental coverage: error defaults, migrations, reducer edge cases. */

import { describe, expect, it } from 'vitest'
import {
  __registerMigration,
  initialWorkflowState,
  isDecisionProvider,
  migrateToCurrent,
  reduceTransition,
  System1Error,
  system1Error,
} from '@deepseek-ai/dsh-system1-contracts'

describe('error taxonomy edge cases', () => {
  it('supports explicit retry classes and causes', () => {
    const err = new System1Error('PROVIDER_TIMEOUT', 'timed out', {
      retryClass: 'immediate',
      isContractViolation: true,
      details: { attempt: 1 },
      cause: new Error('root'),
    })
    expect(err.retryClass).toBe('immediate')
    expect(err.isContractViolation).toBe(true)
    expect(err.details).toEqual({ attempt: 1 })
    expect(err.cause).toBeInstanceOf(Error)
    // Details are frozen.
    expect(Object.isFrozen(err.details)).toBe(true)
  })

  it('defaults the retry class from the code table', () => {
    expect(system1Error('PROVIDER_TIMEOUT', 't').retryClass).toBe('backoff')
    expect(system1Error('GUARD_BLOCKED', 'g').retryClass).toBe('none')
  })
})

describe('decision provider interface', () => {
  it('identifies providers by their decide method', () => {
    expect(isDecisionProvider({ decide: async () => ({}) })).toBe(true)
    expect(isDecisionProvider({})).toBe(false)
    expect(isDecisionProvider(null)).toBe(false)
    expect(isDecisionProvider({ decide: 'not-a-function' })).toBe(false)
  })
})

describe('reducer edge cases', () => {
  it('rejects task ID mismatches', () => {
    const s0 = initialWorkflowState('t1', 1)
    expect(() =>
      reduceTransition(s0, { taskId: 't2', to: 'observing', expectedVersion: 0, expectedFencingToken: 1 }),
    ).toThrow(/Task ID mismatch/)
  })
})

describe('migrations', () => {
  it('rejects records with no migration path', () => {
    // Version 1 is current and has no registered migrations; a record
    // claiming version 1 is returned as-is (covered elsewhere). A record
    // with a non-integer version is corrupt.
    expect(() => migrateToCurrent({ schemaVersion: 1.5 })).toThrow(/no valid schemaVersion/)
    expect(() => migrateToCurrent({} as never)).toThrow(/no valid schemaVersion/)
  })

  it('round-trips through a registered migration', () => {
    __registerMigration(1, (record) => ({ ...record, schemaVersion: 2, migrated: true }))
    const migrated = migrateToCurrent({ schemaVersion: 1, data: 'x' }, 2)
    expect(migrated).toEqual({ schemaVersion: 2, data: 'x', migrated: true })
  })

  it('rejects missing migrations and bad version bumps', () => {
    // No migration from version 2 registered.
    expect(() => migrateToCurrent({ schemaVersion: 1 }, 3)).toThrow(/No migration from version 2/)
    // Migration that does not advance by exactly one.
    __registerMigration(2, (record) => ({ ...record, schemaVersion: 5 }))
    expect(() => migrateToCurrent({ schemaVersion: 2 }, 3)).toThrow(/did not advance/)
    // Migration that throws a non-System1Error.
    __registerMigration(2, () => {
      throw new Error('boom')
    })
    expect(() => migrateToCurrent({ schemaVersion: 2 }, 3)).toThrow(/failed/)
  })
})
