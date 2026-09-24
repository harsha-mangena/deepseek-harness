/** Coordination store tests: budgets, leases, deduplication, determinism. */

import { afterEach, describe, expect, it } from 'vitest'
import {
  CoordinationStore,
  ManualClock,
  RecordedDecisionProvider,
  SequentialIdGenerator,
  SystemClock,
} from '@deepseek-ai/dsh-system1-coordination'
import { initialWorkflowState, reduceTransition } from '@deepseek-ai/dsh-system1-contracts'

function makeStore(): CoordinationStore {
  return new CoordinationStore({
    path: ':memory:',
    clock: new ManualClock(1_000_000),
    ids: new SequentialIdGenerator(),
  })
}

let store: CoordinationStore | undefined
afterEach(() => {
  store?.close()
  store = undefined
})

describe('budget reservations', () => {
  it('reserves, settles, and tracks utilization', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'provider-requests', 10)
    const r1 = store.reserve('tenant-a', 'provider-requests', 't1', 4)
    expect(r1.status).toBe('active')
    expect(r1.reservationId).toBe('res-000001')
    let util = store.getPoolUtilization('tenant-a', 'provider-requests')
    expect(util).toEqual({ capacity: 10, reserved: 4, consumed: 0 })

    store.settle(r1.reservationId, 3)
    util = store.getPoolUtilization('tenant-a', 'provider-requests')
    expect(util).toEqual({ capacity: 10, reserved: 0, consumed: 3 })

    // Settling twice is a conflict.
    expect(() => store.settle(r1.reservationId, 3)).toThrow(/not active/)
  })

  it('rejects reservations beyond capacity', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 5)
    store.reserve('tenant-a', 'tokens', 't1', 5)
    expect(() => store.reserve('tenant-a', 'tokens', 't2', 1)).toThrow(/Insufficient budget/)
  })

  it('decides the race for the final budget unit inside the transaction', () => {
    // Two coordinators share one store (single-process deployment).
    // Only one may win the last unit; the loser gets BUDGET_EXHAUSTED.
    store = makeStore()
    store.createBudgetPool('tenant-a', 'actions', 1)
    const winner = store.reserve('tenant-a', 'actions', 't-winner', 1)
    expect(winner.units).toBe(1)
    expect(() => store.reserve('tenant-a', 'actions', 't-loser', 1)).toThrow(/Insufficient budget/)
    const util = store.getPoolUtilization('tenant-a', 'actions')
    expect(util.reserved).toBe(1)
    expect(util.consumed).toBe(0)
  })

  it('cancels without resetting consumed budget', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'provider-requests', 10)
    const r1 = store.reserve('tenant-a', 'provider-requests', 't1', 4)
    store.settle(r1.reservationId, 4)
    const r2 = store.reserve('tenant-a', 'provider-requests', 't2', 3)
    // Cancellation releases the hold but never touches consumed.
    store.release(r2.reservationId, true)
    const util = store.getPoolUtilization('tenant-a', 'provider-requests')
    expect(util).toEqual({ capacity: 10, reserved: 0, consumed: 4 })
    // The 4 consumed units stay consumed; only 6 remain available.
    expect(() => store.reserve('tenant-a', 'provider-requests', 't3', 7)).toThrow(/Insufficient budget/)
    const r3 = store.reserve('tenant-a', 'provider-requests', 't3', 6)
    expect(r3.units).toBe(6)
  })
})

describe('leases and fencing', () => {
  it('bumps the fencing token monotonically on re-acquire', () => {
    store = makeStore()
    const l1 = store.acquireLease('t1', 'tenant-a', 'holder-1', 60_000)
    expect(l1.fencingToken).toBe(1)
    const l2 = store.acquireLease('t1', 'tenant-a', 'holder-1', 60_000)
    expect(l2.fencingToken).toBe(2)
  })

  it('rejects a stale fencing token on renew and release', () => {
    store = makeStore()
    store.acquireLease('t1', 'tenant-a', 'holder-1', 60_000)
    const l2 = store.acquireLease('t1', 'tenant-a', 'holder-1', 60_000)
    expect(l2.fencingToken).toBe(2)
    // Token 1 is stale.
    expect(() => store.renewLease('t1', 1, 60_000)).toThrow(/Stale fencing token/)
    expect(() => store.releaseLease('t1', 1)).toThrow(/Stale fencing token/)
    // Token 2 works.
    const renewed = store.renewLease('t1', 2, 60_000)
    expect(renewed.fencingToken).toBe(2)
    store.releaseLease('t1', 2)
  })

  it('blocks a second holder while the lease is live, allows takeover after expiry', () => {
    const clock = new ManualClock(1_000_000)
    store = new CoordinationStore({ path: ':memory:', clock, ids: new SequentialIdGenerator() })
    store.acquireLease('t1', 'tenant-a', 'holder-1', 60_000)
    expect(() => store.acquireLease('t1', 'tenant-a', 'holder-2', 60_000)).toThrow(/leased to holder-1/)
    clock.advance(61_000)
    const l2 = store.acquireLease('t1', 'tenant-a', 'holder-2', 60_000)
    // Fencing token keeps increasing across holders; no reset.
    expect(l2.fencingToken).toBe(2)
  })

  it('denies cross-tenant lease acquisition', () => {
    store = makeStore()
    store.acquireLease('t1', 'tenant-a', 'holder-1', 60_000)
    expect(() => store.acquireLease('t1', 'tenant-b', 'holder-1', 60_000)).toThrow(/another tenant/)
  })
})

describe('deduplication', () => {
  it('returns the existing request on duplicate idempotency keys', () => {
    store = makeStore()
    const first = store.recordIdempotencyKey('tenant-a', 'key-1', 'req-1')
    expect(first).toEqual({ requestId: 'req-1', duplicate: false })
    const second = store.recordIdempotencyKey('tenant-a', 'key-1', 'req-2')
    expect(second).toEqual({ requestId: 'req-1', duplicate: true })
    // Result refs round-trip.
    store.attachIdempotencyResult('tenant-a', 'key-1', 'result://r1')
    expect(store.getIdempotencyResult('tenant-a', 'key-1')).toBe('result://r1')
  })

  it('rejects duplicate decision and attempt IDs', () => {
    store = makeStore()
    store.recordDecision('t1', 'd1')
    expect(() => store.recordDecision('t1', 'd1')).toThrow(/Duplicate decision/)
    // Same decision ID on a different task is fine.
    store.recordDecision('t2', 'd1')
    store.recordAttempt('t1', 'a1')
    expect(() => store.recordAttempt('t1', 'a1')).toThrow(/Duplicate attempt/)
  })

  it('scopes idempotency keys per tenant', () => {
    store = makeStore()
    store.recordIdempotencyKey('tenant-a', 'key-1', 'req-a')
    const other = store.recordIdempotencyKey('tenant-b', 'key-1', 'req-b')
    expect(other.duplicate).toBe(false)
  })
})

describe('deterministic replay', () => {
  it('reproduces terminal state and cost ledger from the same event sequence', () => {
    // Two independent runs with identical inputs must reach identical state.
    const runOnce = (): { state: string; version: number; consumed: number } => {
      const s = makeStore()
      try {
        s.createBudgetPool('tenant-a', 'tokens', 100)
        const lease = s.acquireLease('t-replay', 'tenant-a', 'coordinator-1', 60_000)
        let wf = initialWorkflowState('t-replay', lease.fencingToken)
        const r = s.reserve('tenant-a', 'tokens', 't-replay', 20)
        wf = reduceTransition(wf, {
          taskId: 't-replay',
          to: 'observing',
          expectedVersion: wf.version,
          expectedFencingToken: lease.fencingToken,
        })
        wf = reduceTransition(wf, {
          taskId: 't-replay',
          to: 'deciding',
          expectedVersion: wf.version,
          expectedFencingToken: lease.fencingToken,
        })
        wf = reduceTransition(wf, {
          taskId: 't-replay',
          to: 'executing',
          expectedVersion: wf.version,
          expectedFencingToken: lease.fencingToken,
        })
        s.settle(r.reservationId, 17)
        wf = reduceTransition(wf, {
          taskId: 't-replay',
          to: 'verifying',
          expectedVersion: wf.version,
          expectedFencingToken: lease.fencingToken,
        })
        wf = reduceTransition(wf, {
          taskId: 't-replay',
          to: 'succeeded',
          expectedVersion: wf.version,
          expectedFencingToken: lease.fencingToken,
        })
        const util = s.getPoolUtilization('tenant-a', 'tokens')
        return { state: wf.state, version: wf.version, consumed: util.consumed }
      } finally {
        s.close()
      }
    }
    expect(runOnce()).toEqual(runOnce())
    expect(runOnce()).toEqual({ state: 'succeeded', version: 5, consumed: 17 })
  })
})

describe('store edge cases', () => {
  it('defaults to in-memory storage without a path', () => {
    const s = new CoordinationStore({ clock: new ManualClock(), ids: new SequentialIdGenerator() })
    try {
      s.createBudgetPool('t', 'p', 5)
      expect(s.getPoolUtilization('t', 'p').capacity).toBe(5)
    } finally {
      s.close()
    }
  })

  it('rejects unknown pools and reservations', () => {
    store = makeStore()
    expect(() => store!.getPoolUtilization('t', 'nope')).toThrow(/Unknown budget pool/)
    expect(() => store!.reserve('t', 'nope', 'task', 1)).toThrow(/Unknown budget pool/)
    expect(() => store!.settle('res-999999', 1)).toThrow(/Unknown reservation/)
    expect(() => store!.release('res-999999')).toThrow(/Unknown reservation/)
  })

  it('rejects release of non-active reservations', () => {
    store = makeStore()
    store.createBudgetPool('t', 'p', 10)
    const r = store.reserve('t', 'p', 'task', 3)
    store.release(r.reservationId) // non-cancelled release
    expect(() => store.release(r.reservationId)).toThrow(/not active/)
    const util = store.getPoolUtilization('t', 'p')
    expect(util.reserved).toBe(0)
  })

  it('rejects renew of missing or expired leases', () => {
    const clock = new ManualClock(1_000_000)
    store = new CoordinationStore({ path: ':memory:', clock, ids: new SequentialIdGenerator() })
    expect(() => store!.renewLease('t-missing', 1, 60_000)).toThrow(/No lease/)
    store.acquireLease('t1', 'tenant-a', 'holder-1', 60_000)
    clock.advance(61_000)
    expect(() => store!.renewLease('t1', 1, 60_000)).toThrow(/expired/)
  })
})

describe('recorded decision provider', () => {
  const input = {
    schemaVersion: 1 as const,
    taskId: 't1',
    decisionId: 'd1',
    stateVersion: 0,
    policyVersion: 'p1',
    catalogVersion: 'c1',
    observationHash: 'o1',
    questionFamily: 'q1',
    promptVersion: 'p1',
    state: 's',
    candidates: [
      {
        id: 'c1',
        label: 'l',
        route: 'tool' as const,
        effect: 'read' as const,
        operationRef: 'op',
        preconditionHash: 'h',
        verificationPolicyId: 'v',
      },
    ],
  }

  it('replays recordings and rejects unknown decision IDs', async () => {
    const provider = new RecordedDecisionProvider()
    const decision = {
      decisionId: 'd1',
      selectedId: 'c1',
      probabilities: { c1: 1 },
      selectedProbability: 1,
      vendorConfidence: null,
      calibratedCorrectness: null,
      calibrationVersion: null,
      modelRequested: 'jev-1',
      modelResolved: null,
      requestId: null,
      usage: { inputTokens: 10, outputTokens: null },
      reasonCode: 'accepted' as const,
    }
    provider.record('d1', decision)
    const result = await provider.decide(input, new AbortController().signal)
    expect(result).toEqual(decision)
    expect(provider.seenDecisionIds).toEqual(['d1'])
    await expect(provider.decide({ ...input, decisionId: 'd-unknown' }, new AbortController().signal)).rejects.toThrow(
      /No recording/,
    )
  })

  it('injects faults and honors cancellation', async () => {
    const provider = new RecordedDecisionProvider()
    provider.injectFault('d1', { kind: 'transport-failed' })
    await expect(provider.decide(input, new AbortController().signal)).rejects.toThrow(/transport failure/)
    const aborted = new AbortController()
    aborted.abort()
    await expect(provider.decide(input, aborted.signal)).rejects.toThrow(/cancelled/)
  })

  it('uses the system clock in production and manual clock in tests', () => {
    expect(new SystemClock().now()).toBeGreaterThan(0)
    const manual = new ManualClock(5000)
    expect(manual.now()).toBe(5000)
    manual.advance(100)
    expect(manual.now()).toBe(5100)
  })
})
