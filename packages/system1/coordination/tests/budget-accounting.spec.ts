/** Budget accounting tests: monotonic settlement, overrun policy, reconciliation holds, restart. */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  CoordinationStore,
  ManualClock,
  SequentialIdGenerator,
} from '@deepseek-ai/dsh-system1-coordination'

function makeStore(maxOverrunUnits = 0): CoordinationStore {
  return new CoordinationStore({
    path: ':memory:',
    clock: new ManualClock(1_000_000),
    ids: new SequentialIdGenerator(),
    maxOverrunUnits,
  })
}

function makeFileStore(dir: string, maxOverrunUnits = 0): CoordinationStore {
  return new CoordinationStore({
    path: join(dir, 'coord.db'),
    clock: new ManualClock(1_000_000),
    ids: new SequentialIdGenerator(),
    maxOverrunUnits,
  })
}

let store: CoordinationStore | undefined
let dir: string | undefined
afterEach(() => {
  store?.close()
  store = undefined
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('monotonic settlement', () => {
  it('rejects negative usage fail-closed: utilization and reservation unchanged', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 1000)
    store.settle(store.reserve('tenant-a', 'tokens', 't0', 100).reservationId, 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    expect(() => store.settle(r.reservationId, -50)).toThrow(/non-negative integer/)
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 1000,
      reserved: 10,
      consumed: 100,
    })
    expect(store.getReservation(r.reservationId).status).toBe('active')
  })

  it('rejects NaN, Infinity, and fractional usage', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 100)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 3.5]) {
      const r = store.reserve('tenant-a', 'tokens', 't1', 10)
      expect(() => store.settle(r.reservationId, bad)).toThrow(/non-negative integer/)
      expect(store.getReservation(r.reservationId).status).toBe('active')
    }
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 30,
      consumed: 0,
    })
  })

  it('allows zero settlement: consumed stays monotonic, reservation settles', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    store.settle(r.reservationId, 0)
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 0,
      consumed: 0,
    })
    expect(store.getReservation(r.reservationId).status).toBe('settled')
  })

  it('never lets consumed decrease across failed settlements', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 1000)
    store.settle(store.reserve('tenant-a', 'tokens', 't0', 100).reservationId, 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 50)
    // A fraudulent negative report cannot refund earlier spend.
    expect(() => store.settle(r.reservationId, -1000)).toThrow()
    expect(store.getPoolUtilization('tenant-a', 'tokens').consumed).toBe(100)
    // Settling a non-active reservation cannot move consumed either.
    expect(() => store.settle(r.reservationId, 10)).not.toThrow()
    expect(() => store.settle(r.reservationId, 5)).toThrow(/not active/)
    expect(store.getPoolUtilization('tenant-a', 'tokens').consumed).toBe(110)
  })
})

describe('overrun policy', () => {
  it('rejects usage above the reservation by default: reservation stays active', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    expect(() => store.settle(r.reservationId, 11)).toThrow(/exceeds reservation/)
    expect(store.getReservation(r.reservationId).status).toBe('active')
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 10,
      consumed: 0,
    })
  })

  it('absorbs usage within the configured overrun allowance', () => {
    store = makeStore(5)
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    store.settle(r.reservationId, 15)
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 0,
      consumed: 15,
    })
  })

  it('rejects usage above units + maxOverrunUnits', () => {
    store = makeStore(5)
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    expect(() => store.settle(r.reservationId, 16)).toThrow(/exceeds reservation/)
    expect(store.getReservation(r.reservationId).status).toBe('active')
  })

  it('holds the reservation on overrun when onOverrun is hold', () => {
    store = makeStore(5)
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    store.settle(r.reservationId, 50, { onOverrun: 'hold' })
    const held = store.getReservation(r.reservationId)
    expect(held.status).toBe('held')
    expect(held.claimedUnits).toBe(50)
    expect(held.holdReason).toMatch(/overrun/)
    // Nothing absorbed, nothing released: the pool still encumbers the hold.
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 10,
      consumed: 0,
    })
  })

  it('rejects an invalid maxOverrunUnits at construction', () => {
    expect(() => makeStore(-1)).toThrow(/maxOverrunUnits/)
    expect(() => makeStore(1.5)).toThrow(/maxOverrunUnits/)
  })
})

describe('reconciliation holds', () => {
  it('holds an active reservation: reserved stays encumbered, consumed untouched', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    store.holdForReconciliation(r.reservationId, 10, 'child failed after start')
    const held = store.getReservation(r.reservationId)
    expect(held.status).toBe('held')
    expect(held.claimedUnits).toBe(10)
    expect(held.holdReason).toBe('child failed after start')
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 10,
      consumed: 0,
    })
  })

  it('rejects invalid hold claims fail-closed', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    expect(() => store.holdForReconciliation(r.reservationId, -1, 'x')).toThrow(
      /non-negative integer/,
    )
    expect(() => store.holdForReconciliation(r.reservationId, Number.NaN, 'x')).toThrow(
      /non-negative integer/,
    )
    expect(() => store.holdForReconciliation(r.reservationId, 5, '   ')).toThrow(/reason/)
    expect(() => store.holdForReconciliation('res-unknown', 5, 'x')).toThrow(/Unknown reservation/)
    expect(store.getReservation(r.reservationId).status).toBe('active')
  })

  it('reconciles a hold from authoritative usage', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    store.holdForReconciliation(r.reservationId, 10, 'malformed child result')
    expect(store.reconcileHold(r.reservationId, 7)).toBe('settled')
    expect(store.getReservation(r.reservationId).status).toBe('settled')
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 0,
      consumed: 7,
    })
  })

  it('keeps the hold when reconciliation usage is still above the allowance', () => {
    store = makeStore(5)
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    store.holdForReconciliation(r.reservationId, 50, 'overrun')
    expect(store.reconcileHold(r.reservationId, 50)).toBe('held')
    expect(store.getReservation(r.reservationId).status).toBe('held')
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 10,
      consumed: 0,
    })
    // Authoritative usage within the allowance settles later.
    expect(store.reconcileHold(r.reservationId, 15)).toBe('settled')
    expect(store.getPoolUtilization('tenant-a', 'tokens').consumed).toBe(15)
  })

  it('rejects invalid reconciliation usage fail-closed: the hold survives', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    store.holdForReconciliation(r.reservationId, 10, 'child failed')
    expect(() => store.reconcileHold(r.reservationId, -3)).toThrow(/non-negative integer/)
    expect(store.getReservation(r.reservationId).status).toBe('held')
  })

  it('rejects reconciling a reservation that is not held', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    expect(() => store.reconcileHold(r.reservationId, 5)).toThrow(/not held/)
  })

  it('releases a held reservation without consuming', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    store.holdForReconciliation(r.reservationId, 10, 'cancelled mid-run')
    store.release(r.reservationId, true)
    expect(store.getReservation(r.reservationId).status).toBe('cancelled')
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 0,
      consumed: 0,
    })
  })

  it('a held reservation cannot settle directly', () => {
    store = makeStore()
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    store.holdForReconciliation(r.reservationId, 10, 'uncertain spend')
    expect(() => store.settle(r.reservationId, 5)).toThrow(/not active/)
  })

  it('getReservation rejects unknown ids', () => {
    store = makeStore()
    expect(() => store.getReservation('res-unknown')).toThrow(/Unknown reservation/)
  })
})

describe('restarted executions', () => {
  it('a held reservation survives close/reopen and reconciles afterwards', () => {
    dir = mkdtempSync(join(tmpdir(), 'sys1-budget-'))
    store = makeFileStore(dir)
    store.createBudgetPool('tenant-a', 'tokens', 100)
    const r = store.reserve('tenant-a', 'tokens', 't1', 10)
    store.holdForReconciliation(r.reservationId, 10, 'process restarted mid-handoff')
    store.close()

    store = makeFileStore(dir)
    const held = store.getReservation(r.reservationId)
    expect(held.status).toBe('held')
    expect(held.claimedUnits).toBe(10)
    expect(held.holdReason).toBe('process restarted mid-handoff')
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 10,
      consumed: 0,
    })
    expect(store.reconcileHold(r.reservationId, 9)).toBe('settled')
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 0,
      consumed: 9,
    })
  })

  it('migrates a v1 database: rows preserved, holds become available', () => {
    dir = mkdtempSync(join(tmpdir(), 'sys1-budget-v1-'))
    const path = join(dir, 'coord.db')
    // Build a v1 database with the pre-hold schema by hand.
    const v1 = new DatabaseSync(path)
    v1.exec(`
      CREATE TABLE budget_pools (
        tenant_id TEXT NOT NULL,
        pool_name TEXT NOT NULL,
        capacity INTEGER NOT NULL CHECK (capacity >= 0),
        reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
        consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
        PRIMARY KEY (tenant_id, pool_name)
      );
      CREATE TABLE reservations (
        reservation_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        pool_name TEXT NOT NULL,
        task_id TEXT NOT NULL,
        units INTEGER NOT NULL CHECK (units > 0),
        status TEXT NOT NULL CHECK (status IN ('active','settled','released','cancelled')),
        created_at INTEGER NOT NULL,
        deadline_at INTEGER,
        settled_units INTEGER
      );
      CREATE INDEX idx_reservations_task ON reservations(task_id);
      INSERT INTO budget_pools (tenant_id, pool_name, capacity, reserved, consumed)
        VALUES ('tenant-a', 'tokens', 100, 10, 0);
      INSERT INTO reservations
        (reservation_id, tenant_id, pool_name, task_id, units, status, created_at, deadline_at, settled_units)
        VALUES ('res-000001', 'tenant-a', 'tokens', 't1', 10, 'active', 1000000, NULL, NULL);
    `)
    v1.close()

    store = new CoordinationStore({
      path,
      clock: new ManualClock(1_000_000),
      ids: new SequentialIdGenerator(),
    })
    // The pre-existing active reservation survived the migration.
    const migrated = store.getReservation('res-000001')
    expect(migrated.status).toBe('active')
    expect(migrated.units).toBe(10)
    expect(migrated.claimedUnits).toBeNull()
    // Holds work after migration: the rebuilt CHECK admits 'held'.
    store.holdForReconciliation('res-000001', 10, 'migrated hold')
    expect(store.getReservation('res-000001').status).toBe('held')
    expect(store.getPoolUtilization('tenant-a', 'tokens')).toEqual({
      capacity: 100,
      reserved: 10,
      consumed: 0,
    })
    store.close()

    // Reopening is idempotent: the version stamp short-circuits migration.
    const check = new DatabaseSync(path)
    const version = check.prepare('PRAGMA user_version').get() as { user_version: number }
    check.close()
    expect(version.user_version).toBe(2)
    store = makeFileStore(dir)
    expect(store.getReservation('res-000001').status).toBe('held')
  })
})
