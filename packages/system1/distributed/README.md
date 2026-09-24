# @deepseek-ai/dsh-system1-distributed

Distributed execution and operational recovery for System 1 (Jev-only).

## What it provides

- **WorkQueue**: in-memory work distribution. Deliveries are deduplicated per task ID: a redelivery while a task is actively claimed is dropped, so two workers can never claim the same task concurrently. `claim()` records an atomic ownership record (task ID, worker, fencing token, lease expiry, settlement status); `release()`/`settle()` validate the fencing token against that record and reject stale tokens. Bounded size; configurable claim TTL for worker-crash recovery.
- **CheckpointManager**: save/load/delete checkpoints with fencing token validation for recovery. State is deep-copied with `structuredClone` on save and on load, so caller mutation can never corrupt a saved checkpoint; state must be structured-cloneable.

## Known Limitations and Deferred Work

- In-memory only; persistent queue/checkpoint storage is future work.
- No multi-node coordination; single-process only. Ownership records live in this process: a second process (or a second queue instance) cannot observe or respect claims, so this queue must not be deployed across processes expecting shared ownership.
- Released/settled claim records are retained for the process lifetime (no eviction yet).
- Recovery orchestration (automatic resume) is not implemented.
