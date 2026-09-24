/**
 * Transactional coordination store.
 *
 * Backed by SQLite (node:sqlite) for single-process deployment. The interface
 * is backend-agnostic; PostgreSQL provides the distributed implementation.
 * All mutating operations run in IMMEDIATE transactions so concurrent
 * coordinators cannot duplicate reservations or leases.
 *
 * Uniqueness constraints enforced:
 * - (tenant_id, pool_name) for budget pools
 * - (tenant_id, idempotency_key) for deduplication
 * - (task_id, decision_id) and (task_id, attempt_id) for decisions/attempts
 * - task_id for leases (one active lease per task)
 * - task_id for lease_epochs (one durable fencing epoch per task)
 *
 * Fencing epochs are durable: releasing a lease removes only the active lease
 * row and never resets the epoch, so a stale worker holding an old token can
 * never be mistaken for the current holder after release, expiry, or restart.
 *
 * @module @deepseek-ai/dsh-system1-coordination/store
 */

import { DatabaseSync } from 'node:sqlite'
import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type { Clock, IdGenerator } from './deterministic.ts'

/** A budget reservation. Consume-once; settle or release exactly once. */
export interface Reservation {
  readonly reservationId: string
  readonly tenantId: string
  readonly poolName: string
  readonly taskId: string
  readonly units: number
  readonly status: 'active' | 'settled' | 'released' | 'cancelled'
  readonly deadlineAt: number | null
}

/** A task lease with a fencing token. */
export interface Lease {
  readonly taskId: string
  readonly tenantId: string
  readonly fencingToken: number
  readonly expiresAt: number
  readonly holder: string
}

/** Options for creating the store. */
export interface CoordinationStoreOptions {
  /** SQLite path, or ':memory:' for ephemeral use. */
  readonly path?: string
  readonly clock: Clock
  readonly ids: IdGenerator
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_pools (
  tenant_id TEXT NOT NULL,
  pool_name TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  PRIMARY KEY (tenant_id, pool_name)
);
CREATE TABLE IF NOT EXISTS reservations (
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
CREATE INDEX IF NOT EXISTS idx_reservations_task ON reservations(task_id);
CREATE TABLE IF NOT EXISTS leases (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  expires_at INTEGER NOT NULL,
  holder TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leases_expiry ON leases(expires_at);
CREATE TABLE IF NOT EXISTS lease_epochs (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0)
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  result_ref TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS decisions (
  task_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  PRIMARY KEY (task_id, decision_id)
);
CREATE TABLE IF NOT EXISTS attempts (
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  PRIMARY KEY (task_id, attempt_id)
);
`

/** Transactional coordination store. */
export class CoordinationStore {
  private readonly db: DatabaseSync
  private readonly clock: Clock
  private readonly ids: IdGenerator

  /**
   * @param options - store options.
   */
  constructor(options: CoordinationStoreOptions) {
    this.db = new DatabaseSync(options.path ?? ':memory:')
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    this.clock = options.clock
    this.ids = options.ids
  }

  /** Close the underlying database. */
  close(): void {
    this.db.close()
  }

  /**
   * Run a function inside an IMMEDIATE transaction.
   * @param fn - work to perform atomically.
   */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;')
    try {
      const result = fn()
      this.db.exec('COMMIT;')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK;')
      throw error
    }
  }

  // -- Budget pools and reservations ---------------------------------------

  /**
   * Create a budget pool with a fixed capacity.
   * @param tenantId - owning tenant.
   * @param poolName - pool name (e.g. 'provider-requests', 'tokens').
   * @param capacity - total units.
   */
  createBudgetPool(tenantId: string, poolName: string, capacity: number): void {
    this.db
      .prepare('INSERT INTO budget_pools (tenant_id, pool_name, capacity) VALUES (?, ?, ?)')
      .run(tenantId, poolName, capacity)
  }

  /**
   * Get current pool utilization.
   * @param tenantId - owning tenant.
   * @param poolName - pool name.
   */
  getPoolUtilization(tenantId: string, poolName: string): {
    capacity: number
    reserved: number
    consumed: number
  } {
    const row = this.db
      .prepare('SELECT capacity, reserved, consumed FROM budget_pools WHERE tenant_id = ? AND pool_name = ?')
      .get(tenantId, poolName) as { capacity: number; reserved: number; consumed: number } | undefined
    if (!row) {
      throw system1Error('BUDGET_EXHAUSTED', `Unknown budget pool ${poolName} for tenant ${tenantId}`, {
        tenantId,
        poolName,
      })
    }
    return row
  }

  /**
   * Atomically reserve units from a pool. The race for the last unit is
   * decided inside the transaction: only one concurrent reserver wins.
   * @param tenantId - owning tenant.
   * @param poolName - pool name.
   * @param taskId - reserving task.
   * @param units - units to reserve.
   * @param deadlineAt - optional deadline (ms); null for none.
   * @returns the active reservation.
   * @throws System1Error BUDGET_EXHAUSTED when insufficient capacity.
   */
  reserve(
    tenantId: string,
    poolName: string,
    taskId: string,
    units: number,
    deadlineAt: number | null = null,
  ): Reservation {
    return this.transaction(() => {
      const pool = this.db
        .prepare('SELECT capacity, reserved, consumed FROM budget_pools WHERE tenant_id = ? AND pool_name = ?')
        .get(tenantId, poolName) as { capacity: number; reserved: number; consumed: number } | undefined
      if (!pool) {
        throw system1Error('BUDGET_EXHAUSTED', `Unknown budget pool ${poolName}`, { tenantId, poolName })
      }
      const available = pool.capacity - pool.reserved - pool.consumed
      if (available < units) {
        throw system1Error('BUDGET_EXHAUSTED', `Insufficient budget in pool ${poolName}`, {
          tenantId,
          poolName,
          requested: units,
          available,
        })
      }
      const reservationId = this.ids.next('res')
      const now = this.clock.now()
      this.db
        .prepare(
          `INSERT INTO reservations
             (reservation_id, tenant_id, pool_name, task_id, units, status, created_at, deadline_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(reservationId, tenantId, poolName, taskId, units, now, deadlineAt)
      this.db
        .prepare('UPDATE budget_pools SET reserved = reserved + ? WHERE tenant_id = ? AND pool_name = ?')
        .run(units, tenantId, poolName)
      return {
        reservationId,
        tenantId,
        poolName,
        taskId,
        units,
        status: 'active' as const,
        deadlineAt,
      }
    })
  }

  /**
   * Settle a reservation with actual usage. Reserved units are released and
   * actual units are charged to consumed.
   * @param reservationId - reservation to settle.
   * @param actualUnits - actual units consumed.
   */
  settle(reservationId: string, actualUnits: number): void {
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT tenant_id, pool_name, units, status FROM reservations WHERE reservation_id = ?')
        .get(reservationId) as
        | { tenant_id: string; pool_name: string; units: number; status: string }
        | undefined
      if (!row) {
        throw system1Error('CORRUPT_RECORD', `Unknown reservation ${reservationId}`, { reservationId })
      }
      if (row.status !== 'active') {
        throw system1Error('RESERVATION_CONFLICT', `Reservation ${reservationId} is not active`, {
          reservationId,
          status: row.status,
        })
      }
      this.db
        .prepare(`UPDATE reservations SET status = 'settled', settled_units = ? WHERE reservation_id = ?`)
        .run(actualUnits, reservationId)
      this.db
        .prepare('UPDATE budget_pools SET reserved = reserved - ?, consumed = consumed + ? WHERE tenant_id = ? AND pool_name = ?')
        .run(row.units, actualUnits, row.tenant_id, row.pool_name)
    })
  }

  /**
   * Release a reservation without charging consumption (e.g. on cancellation).
   * Cancellation releases the hold but never resets consumed budget.
   * @param reservationId - reservation to release.
   * @param cancelled - whether the release is due to cancellation.
   */
  release(reservationId: string, cancelled = false): void {
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT tenant_id, pool_name, units, status FROM reservations WHERE reservation_id = ?')
        .get(reservationId) as
        | { tenant_id: string; pool_name: string; units: number; status: string }
        | undefined
      if (!row) {
        throw system1Error('CORRUPT_RECORD', `Unknown reservation ${reservationId}`, { reservationId })
      }
      if (row.status !== 'active') {
        throw system1Error('RESERVATION_CONFLICT', `Reservation ${reservationId} is not active`, {
          reservationId,
          status: row.status,
        })
      }
      const status = cancelled ? 'cancelled' : 'released'
      this.db.prepare(`UPDATE reservations SET status = ? WHERE reservation_id = ?`).run(status, reservationId)
      this.db
        .prepare('UPDATE budget_pools SET reserved = reserved - ? WHERE tenant_id = ? AND pool_name = ?')
        .run(row.units, row.tenant_id, row.pool_name)
    })
  }

  // -- Leases ---------------------------------------------------------------

  /**
   * Acquire (or re-acquire) a task lease. Each acquisition bumps the fencing
   * token monotonically from a durable per-task epoch that survives release,
   * expiry, and process restart. A lease held by another holder that has not
   * expired cannot be taken.
   * @param taskId - task to lease.
   * @param tenantId - owning tenant.
   * @param holder - identity of the acquirer.
   * @param ttlMs - lease time-to-live in milliseconds.
   * @returns the lease with the new fencing token.
   * @throws System1Error CROSS_TENANT_DENIED when another tenant owns the task epoch.
   * @throws System1Error LEASE_CONFLICT when held by another live holder.
   */
  acquireLease(taskId: string, tenantId: string, holder: string, ttlMs: number): Lease {
    return this.transaction(() => {
      const now = this.clock.now()
      const epoch = this.db
        .prepare('SELECT tenant_id, fencing_token FROM lease_epochs WHERE task_id = ?')
        .get(taskId) as { tenant_id: string; fencing_token: number } | undefined
      if (epoch && epoch.tenant_id !== tenantId) {
        throw system1Error('CROSS_TENANT_DENIED', `Task ${taskId} is leased to another tenant`, {
          taskId,
        })
      }
      const existing = this.db
        .prepare('SELECT fencing_token, expires_at, holder FROM leases WHERE task_id = ?')
        .get(taskId) as { fencing_token: number; expires_at: number; holder: string } | undefined
      if (existing && existing.holder !== holder && existing.expires_at > now) {
        throw system1Error('LEASE_CONFLICT', `Task ${taskId} is leased to ${existing.holder}`, {
          taskId,
          holder: existing.holder,
        })
      }
      const fencingToken = (epoch?.fencing_token ?? 0) + 1
      const expiresAt = now + ttlMs
      this.db
        .prepare(
          `INSERT INTO lease_epochs (task_id, tenant_id, fencing_token)
           VALUES (?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET fencing_token = excluded.fencing_token`,
        )
        .run(taskId, tenantId, fencingToken)
      this.db
        .prepare(
          `INSERT INTO leases (task_id, tenant_id, fencing_token, expires_at, holder)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             fencing_token = excluded.fencing_token,
             expires_at = excluded.expires_at,
             holder = excluded.holder`,
        )
        .run(taskId, tenantId, fencingToken, expiresAt, holder)
      return { taskId, tenantId, fencingToken, expiresAt, holder }
    })
  }

  /**
   * Renew a lease. The caller must present the current fencing token.
   * @param taskId - leased task.
   * @param fencingToken - fencing token the caller holds.
   * @param ttlMs - new time-to-live in milliseconds.
   * @throws System1Error STALE_FENCING_TOKEN or LEASE_EXPIRED.
   */
  renewLease(taskId: string, fencingToken: number, ttlMs: number): Lease {
    return this.transaction(() => {
      const now = this.clock.now()
      const existing = this.db
        .prepare('SELECT tenant_id, fencing_token, expires_at, holder FROM leases WHERE task_id = ?')
        .get(taskId) as
        | { tenant_id: string; fencing_token: number; expires_at: number; holder: string }
        | undefined
      if (!existing) {
        throw system1Error('LEASE_EXPIRED', `No lease for task ${taskId}`, { taskId })
      }
      if (existing.fencing_token !== fencingToken) {
        throw system1Error('STALE_FENCING_TOKEN', `Stale fencing token for task ${taskId}`, {
          taskId,
          expected: fencingToken,
          actual: existing.fencing_token,
        })
      }
      if (existing.expires_at <= now) {
        throw system1Error('LEASE_EXPIRED', `Lease for task ${taskId} expired`, { taskId })
      }
      const expiresAt = now + ttlMs
      this.db.prepare('UPDATE leases SET expires_at = ? WHERE task_id = ?').run(expiresAt, taskId)
      return {
        taskId,
        tenantId: existing.tenant_id,
        fencingToken: existing.fencing_token,
        expiresAt,
        holder: existing.holder,
      }
    })
  }

  /**
   * Release a lease. Only the current fencing-token holder may release.
   * Release relinquishes ownership only: the durable fencing epoch is kept,
   * so the next acquisition continues the token sequence instead of
   * restarting at 1. A stale token (for example from a worker whose lease
   * was already released and re-acquired) is rejected.
   * @param taskId - leased task.
   * @param fencingToken - fencing token the caller holds.
   * @throws System1Error STALE_FENCING_TOKEN when the token is not the current one.
   */
  releaseLease(taskId: string, fencingToken: number): void {
    this.transaction(() => {
      const existing = this.db
        .prepare('SELECT fencing_token FROM leases WHERE task_id = ?')
        .get(taskId) as { fencing_token: number } | undefined
      if (!existing) return
      if (existing.fencing_token !== fencingToken) {
        throw system1Error('STALE_FENCING_TOKEN', `Stale fencing token for task ${taskId}`, {
          taskId,
        })
      }
      // Delete the active lease row only; the epoch row in lease_epochs is
      // retained so fencing tokens stay monotonic across releases.
      this.db.prepare('DELETE FROM leases WHERE task_id = ?').run(taskId)
    })
  }

  // -- Deduplication ----------------------------------------------------------

  /**
   * Record an idempotency key. Returns the existing request ID when the key
   * was already seen (duplicate request).
   * @param tenantId - owning tenant.
   * @param idempotencyKey - client-supplied key.
   * @param requestId - request ID for first-time recording.
   * @returns the request ID bound to the key and whether it was a duplicate.
   */
  recordIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
    requestId: string,
  ): { requestId: string; duplicate: boolean } {
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT request_id FROM idempotency_keys WHERE tenant_id = ? AND idempotency_key = ?')
        .get(tenantId, idempotencyKey) as { request_id: string } | undefined
      if (existing) {
        return { requestId: existing.request_id, duplicate: true }
      }
      this.db
        .prepare(
          'INSERT INTO idempotency_keys (tenant_id, idempotency_key, request_id, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(tenantId, idempotencyKey, requestId, this.clock.now())
      return { requestId, duplicate: false }
    })
  }

  /**
   * Attach a result reference to an idempotency key.
   * @param tenantId - owning tenant.
   * @param idempotencyKey - key to update.
   * @param resultRef - reference to the stored result.
   */
  attachIdempotencyResult(tenantId: string, idempotencyKey: string, resultRef: string): void {
    this.db
      .prepare('UPDATE idempotency_keys SET result_ref = ? WHERE tenant_id = ? AND idempotency_key = ?')
      .run(resultRef, tenantId, idempotencyKey)
  }

  /**
   * Get the result reference for an idempotency key.
   * @param tenantId - owning tenant.
   * @param idempotencyKey - key to look up.
   */
  getIdempotencyResult(tenantId: string, idempotencyKey: string): string | null {
    const row = this.db
      .prepare('SELECT result_ref FROM idempotency_keys WHERE tenant_id = ? AND idempotency_key = ?')
      .get(tenantId, idempotencyKey) as { result_ref: string | null } | undefined
    return row?.result_ref ?? null
  }

  /**
   * Record a decision ID for a task. Duplicate (task_id, decision_id) is rejected.
   * @param taskId - task.
   * @param decisionId - decision ID (consume-once token).
   * @throws System1Error DUPLICATE_DECISION_ID on duplicate.
   */
  recordDecision(taskId: string, decisionId: string): void {
    try {
      this.db.prepare('INSERT INTO decisions (task_id, decision_id) VALUES (?, ?)').run(taskId, decisionId)
    } catch {
      throw system1Error('DUPLICATE_DECISION_ID', `Duplicate decision ${decisionId} for task ${taskId}`, {
        taskId,
        decisionId,
      })
    }
  }

  /**
   * Record an attempt ID for a task. Duplicate (task_id, attempt_id) is rejected.
   * @param taskId - task.
   * @param attemptId - attempt ID.
   * @throws System1Error on duplicate (reused as DUPLICATE_REQUEST_ID).
   */
  recordAttempt(taskId: string, attemptId: string): void {
    try {
      this.db.prepare('INSERT INTO attempts (task_id, attempt_id) VALUES (?, ?)').run(taskId, attemptId)
    } catch {
      throw system1Error('DUPLICATE_REQUEST_ID', `Duplicate attempt ${attemptId} for task ${taskId}`, {
        taskId,
        attemptId,
      })
    }
  }
}
