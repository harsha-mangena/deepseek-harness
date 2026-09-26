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
 * Budget settlement is fail-closed: `settle` only accepts finite
 * non-negative integer usage, so pool `consumed` totals are monotonic and can
 * never be decreased by a settlement. Usage above the reservation plus the
 * configured overrun allowance is rejected (or explicitly held); it is never
 * silently absorbed. When spend is uncertain — child failure, malformed
 * result, mid-run cancellation — the reservation is retained as a
 * reconciliation hold (`holdForReconciliation`) instead of being released
 * free, and later settled from authoritative telemetry (`reconcileHold`).
 *
 * @module @deepseek-ai/dsh-system1-coordination/store
 */

import { DatabaseSync } from 'node:sqlite'
import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type { Clock, IdGenerator } from './deterministic.ts'

/** A budget reservation. Consume-once; settle, hold, or release exactly once. */
export interface Reservation {
  readonly reservationId: string
  readonly tenantId: string
  readonly poolName: string
  readonly taskId: string
  readonly units: number
  readonly status: 'active' | 'settled' | 'released' | 'cancelled' | 'held'
  readonly deadlineAt: number | null
  /** Claimed usage recorded when the reservation was held for reconciliation. */
  readonly claimedUnits: number | null
  /** Why the reservation was held for reconciliation. */
  readonly holdReason: string | null
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
  /**
   * Units of spend above a reservation that settlement may absorb.
   * Defaults to 0: any usage above the reservation fails closed unless the
   * caller explicitly asks for a reconciliation hold.
   */
  readonly maxOverrunUnits?: number
}

/** How to handle usage above `units + maxOverrunUnits` at settlement. */
export interface SettleOptions {
  /**
   * - 'reject' (default): fail closed with BUDGET_EXHAUSTED; the reservation
   *   stays active and nothing is absorbed.
   * - 'hold': retain the reservation as a reconciliation hold with the
   *   claimed usage recorded, for later authoritative reconciliation.
   */
  readonly onOverrun?: 'reject' | 'hold'
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
  status TEXT NOT NULL CHECK (status IN ('active','settled','released','cancelled','held')),
  created_at INTEGER NOT NULL,
  deadline_at INTEGER,
  settled_units INTEGER,
  claimed_units INTEGER,
  hold_reason TEXT,
  held_at INTEGER
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

/**
 * Monotonic SQLite schema version, tracked in `PRAGMA user_version`.
 * v2 adds the reconciliation-hold columns (`claimed_units`, `hold_reason`,
 * `held_at`) and the 'held' reservation status.
 */
const SCHEMA_VERSION = 2

/** Transactional coordination store. */
export class CoordinationStore {
  private readonly db: DatabaseSync
  private readonly clock: Clock
  private readonly ids: IdGenerator
  private readonly maxOverrunUnits: number

  /**
   * @param options - store options.
   * @throws System1Error INVALID_CONFIG when maxOverrunUnits is not a non-negative integer.
   */
  constructor(options: CoordinationStoreOptions) {
    this.db = new DatabaseSync(options.path ?? ':memory:')
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    this.migrateSchema()
    this.clock = options.clock
    this.ids = options.ids
    const maxOverrunUnits = options.maxOverrunUnits ?? 0
    if (!Number.isInteger(maxOverrunUnits) || maxOverrunUnits < 0) {
      throw system1Error('INVALID_CONFIG', `maxOverrunUnits must be a non-negative integer, got ${maxOverrunUnits}`, {
        maxOverrunUnits,
      })
    }
    this.maxOverrunUnits = maxOverrunUnits
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

  /**
   * Bring the SQLite schema to SCHEMA_VERSION. A v1 database (no
   * user_version, no hold columns) gets its reservations table rebuilt
   * with the hold columns and the 'held' status; every row is preserved.
   * A fresh database already carries the v2 schema from SCHEMA and only
   * gets stamped. Runs inside a transaction so a failed migration never
   * leaves a half-rebuilt table.
   */
  private migrateSchema(): void {
    const versionRow = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    if (versionRow.user_version >= SCHEMA_VERSION) return
    const columns = this.db.prepare('PRAGMA table_info(reservations)').all() as {
      name: string
    }[]
    const hasHoldColumns = columns.some((column) => column.name === 'claimed_units')
    if (hasHoldColumns) {
      this.transaction(() => {
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
      })
      return
    }
    this.transaction(() => {
      // Frozen v1 -> v2 migration history: rebuild the table because
      // SQLite cannot ALTER a CHECK constraint to admit 'held'.
      this.db.exec(`
        CREATE TABLE reservations_v2 (
          reservation_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          pool_name TEXT NOT NULL,
          task_id TEXT NOT NULL,
          units INTEGER NOT NULL CHECK (units > 0),
          status TEXT NOT NULL CHECK (status IN ('active','settled','released','cancelled','held')),
          created_at INTEGER NOT NULL,
          deadline_at INTEGER,
          settled_units INTEGER,
          claimed_units INTEGER,
          hold_reason TEXT,
          held_at INTEGER
        );
        INSERT INTO reservations_v2
          (reservation_id, tenant_id, pool_name, task_id, units, status, created_at, deadline_at, settled_units)
          SELECT reservation_id, tenant_id, pool_name, task_id, units, status, created_at, deadline_at, settled_units
          FROM reservations;
        DROP TABLE reservations;
        ALTER TABLE reservations_v2 RENAME TO reservations;
        CREATE INDEX idx_reservations_task ON reservations(task_id);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
    })
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
        claimedUnits: null,
        holdReason: null,
      }
    })
  }

  /**
   * Read a reservation by id.
   * @param reservationId - reservation to read.
   * @returns the reservation, including hold details when held.
   * @throws System1Error CORRUPT_RECORD when unknown.
   */
  getReservation(reservationId: string): Reservation {
    const row = this.db
      .prepare(
        `SELECT reservation_id, tenant_id, pool_name, task_id, units, status,
                deadline_at, claimed_units, hold_reason
         FROM reservations WHERE reservation_id = ?`,
      )
      .get(reservationId) as
      | {
          reservation_id: string
          tenant_id: string
          pool_name: string
          task_id: string
          units: number
          status: Reservation['status']
          deadline_at: number | null
          claimed_units: number | null
          hold_reason: string | null
        }
      | undefined
    if (!row) {
      throw system1Error('CORRUPT_RECORD', `Unknown reservation ${reservationId}`, { reservationId })
    }
    return {
      reservationId: row.reservation_id,
      tenantId: row.tenant_id,
      poolName: row.pool_name,
      taskId: row.task_id,
      units: row.units,
      status: row.status,
      deadlineAt: row.deadline_at,
      claimedUnits: row.claimed_units,
      holdReason: row.hold_reason,
    }
  }

  /**
   * Settle a reservation with actual usage. Reserved units are released and
   * actual units are charged to consumed.
   *
   * Fail-closed: usage must be a finite non-negative integer, so pool
   * `consumed` totals are monotonic and a settlement can never decrease
   * them. Usage above `units + maxOverrunUnits` is never silently absorbed:
   * it fails closed by default, or is retained as a reconciliation hold
   * with `onOverrun: 'hold'`.
   * @param reservationId - reservation to settle.
   * @param actualUnits - actual units consumed, from authoritative telemetry.
   * @param options - overrun handling.
   * @throws System1Error SCHEMA_VALIDATION_FAILED when usage is not a non-negative integer.
   * @throws System1Error RESERVATION_CONFLICT when the reservation is not active.
   * @throws System1Error BUDGET_EXHAUSTED when usage exceeds the reservation plus the overrun allowance.
   */
  settle(reservationId: string, actualUnits: number, options: SettleOptions = {}): void {
    validateSettlementUnits(actualUnits)
    this.transaction(() => {
      const row = this.activeReservation(reservationId)
      const cap = row.units + this.maxOverrunUnits
      if (actualUnits > cap) {
        if (options.onOverrun === 'hold') {
          this.markHeld(row, actualUnits, 'overrun')
          return
        }
        throw system1Error(
          'BUDGET_EXHAUSTED',
          `Usage ${actualUnits} exceeds reservation ${row.units} plus overrun allowance ${this.maxOverrunUnits}`,
          { reservationId, actualUnits, reservationUnits: row.units, maxOverrunUnits: this.maxOverrunUnits },
        )
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
   * Retain an active reservation as a reconciliation hold. The reserved
   * units stay encumbered on the pool — the hold is never released free —
   * until authoritative telemetry arrives via {@link reconcileHold} or the
   * hold is explicitly released.
   * @param reservationId - active reservation to hold.
   * @param claimedUnits - usage claimed so far (advisory, must still be a non-negative integer).
   * @param reason - why the spend is uncertain (e.g. 'child-drive-failed').
   * @throws System1Error SCHEMA_VALIDATION_FAILED when the claim or reason is invalid.
   * @throws System1Error RESERVATION_CONFLICT when the reservation is not active.
   */
  holdForReconciliation(reservationId: string, claimedUnits: number, reason: string): void {
    validateSettlementUnits(claimedUnits)
    if (reason.trim().length === 0) {
      throw system1Error('SCHEMA_VALIDATION_FAILED', 'holdForReconciliation requires a non-empty reason', {
        reservationId,
      })
    }
    this.transaction(() => {
      this.markHeld(this.activeReservation(reservationId), claimedUnits, reason)
    })
  }

  /**
   * Settle a held reservation from authoritative telemetry. The same
   * usage validation and overrun policy apply as in {@link settle}; usage
   * still above the reservation plus the overrun allowance leaves the
   * hold in place for a later reconciliation instead of failing.
   * @param reservationId - held reservation to reconcile.
   * @param actualUnits - authoritative actual units consumed.
   * @returns 'settled' when the hold settled, 'held' when the usage is
   * still above the allowance and the hold was kept.
   * @throws System1Error RESERVATION_CONFLICT when the reservation is not held.
   */
  reconcileHold(reservationId: string, actualUnits: number): 'settled' | 'held' {
    validateSettlementUnits(actualUnits)
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT tenant_id, pool_name, units, status FROM reservations WHERE reservation_id = ?')
        .get(reservationId) as
        | { tenant_id: string; pool_name: string; units: number; status: string }
        | undefined
      if (!row) {
        throw system1Error('CORRUPT_RECORD', `Unknown reservation ${reservationId}`, { reservationId })
      }
      if (row.status !== 'held') {
        throw system1Error('RESERVATION_CONFLICT', `Reservation ${reservationId} is not held`, {
          reservationId,
          status: row.status,
        })
      }
      const cap = row.units + this.maxOverrunUnits
      if (actualUnits > cap) {
        return 'held' as const
      }
      this.db
        .prepare(`UPDATE reservations SET status = 'settled', settled_units = ? WHERE reservation_id = ?`)
        .run(actualUnits, reservationId)
      this.db
        .prepare('UPDATE budget_pools SET reserved = reserved - ?, consumed = consumed + ? WHERE tenant_id = ? AND pool_name = ?')
        .run(row.units, actualUnits, row.tenant_id, row.pool_name)
      return 'settled' as const
    })
  }

  /**
   * Release a reservation without charging consumption (e.g. when no work
   * started). Accepts active and held reservations; releasing a hold means
   * reconciliation determined no spend. Cancellation releases the hold but
   * never resets consumed budget.
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
      if (row.status !== 'active' && row.status !== 'held') {
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

  /**
   * Load an active reservation row, or fail closed.
   * @param reservationId - reservation to load.
   */
  private activeReservation(reservationId: string): {
    reservationId: string
    tenant_id: string
    pool_name: string
    units: number
  } {
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
    return { reservationId, tenant_id: row.tenant_id, pool_name: row.pool_name, units: row.units }
  }

  /**
   * Mark an active reservation row as held. Must run inside a transaction.
   * The reserved units stay encumbered on the pool.
   * @param row - the active reservation row.
   * @param claimedUnits - advisory claimed usage.
   * @param reason - why the spend is uncertain.
   */
  private markHeld(
    row: { reservationId: string },
    claimedUnits: number,
    reason: string,
  ): void {
    this.db
      .prepare(
        `UPDATE reservations
         SET status = 'held', claimed_units = ?, hold_reason = ?, held_at = ?
         WHERE reservation_id = ?`,
      )
      .run(claimedUnits, reason, this.clock.now(), row.reservationId)
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

/**
 * Validate a settlement or claim unit count. Usage is denominated in whole
 * units and can never be negative: this is what keeps pool `consumed`
 * totals monotonic. A non-conforming value is a caller bug, so it fails
 * closed without touching the reservation or the pool.
 * @param actualUnits - units to validate.
 * @throws System1Error SCHEMA_VALIDATION_FAILED when not a non-negative integer.
 */
function validateSettlementUnits(actualUnits: number): void {
  if (!Number.isInteger(actualUnits) || actualUnits < 0) {
    throw system1Error(
      'SCHEMA_VALIDATION_FAILED',
      `Invalid settlement usage ${actualUnits}: must be a non-negative integer`,
      { actualUnits },
    )
  }
}
