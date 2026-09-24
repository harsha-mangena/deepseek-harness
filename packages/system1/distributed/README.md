# @deepseek-ai/dsh-system1-distributed

Distributed execution and operational recovery for System 1 (Jev-only).

## What it provides

- **WorkQueue**: in-memory work distribution with fencing tokens; bounded size; claim/release protocol.
- **CheckpointManager**: save/load/delete checkpoints with fencing token validation for recovery.

## Known Limitations and Deferred Work

- In-memory only; persistent queue/checkpoint storage is future work.
- No multi-node coordination; single-process only.
- Recovery orchestration (automatic resume) is not implemented.
