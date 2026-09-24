# @deepseek-ai/dsh-system1-coordination

Shared coordination for System 1: budget reservations, task leases, deduplication, and deterministic test fixtures (Jev-only).

## What it provides

- **CoordinationStore** (SQLite via `node:sqlite`): transactional store for single-process deployment. All mutations run in `IMMEDIATE` transactions.
  - **Budget pools**: capacity, reserved, consumed. `reserve()` is atomic — the race for the last unit is decided in the transaction. `settle()` charges actual usage; `release()` returns the hold without touching consumed (cancellation never resets budgets).
  - **Leases**: one per task, with a durable monotonically increasing fencing epoch (`lease_epochs`). The epoch survives release, expiry, and process restart (it is persisted in the same SQLite file): releasing a lease relinquishes ownership without resetting the epoch, so the next acquisition continues the sequence and a stale worker can never be mistaken for the current holder. Stale tokens are rejected on renew/release. Live leases block other holders; expired leases allow takeover (token keeps increasing). Tenant identity is bound to the epoch, so cross-tenant acquisition is denied even after release.
  - **Deduplication**: `(tenant_id, idempotency_key)`, `(task_id, decision_id)`, `(task_id, attempt_id)` uniqueness.
- **Deterministic fixtures**: `ManualClock`, `SequentialIdGenerator` for replay tests; `SystemClock`, `RandomIdGenerator` for production.
- **RecordedDecisionProvider**: replays pre-recorded decisions; injects transport/timeout/malformed faults; honors abort signals.

## Exit-gate properties tested

- Deterministic replay reproduces terminal state and cost ledger.
- Concurrent coordinators cannot duplicate dispatch (atomic reservations, fencing tokens).
- Cancellation releases holds without resetting consumed budget.
- Cross-tenant operations are denied.

## Known Limitations and Deferred Work

- SQLite covers single-process deployment. PostgreSQL provides the distributed implementation (Phase 10).
- The store is not yet wired to the session log outbox; cross-store atomicity uses idempotent application (Phase 10).
