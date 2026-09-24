# @deepseek-ai/dsh-system1-contracts

Runtime-validating schemas, structured error taxonomy, schema migrations, and the workflow state-machine reducer for System 1 (Jev-only).

## What it provides

- **Schemas** (Zod): `DecisionInput`, `Candidate`, `NormalizedDecision`, `ExecutionOutcome`, `VerificationResult`, `RouteKind`, `Effect`, `TaskState`. Unknown fields are rejected at trust boundaries.
- **Error taxonomy**: `System1Error` with machine-readable codes, retry classes, and contract-violation flags.
- **Migrations**: versioned records with upgrade paths; unknown versions and failed migrations are contract violations.
- **Reducer**: the 13-state task lifecycle. Every transition validates the legal-transition table, expected workflow version, and fencing token. Illegal transitions and stale versions/tokens are rejected.
- **DecisionProvider**: the interface implemented by the Jev adapter (Phase 3) and recorded fixtures.

## Task states

`admitted` → `observing` → `deciding` → `executing` → `verifying` → `succeeded` (happy path), with `waiting_input`, `waiting_retry`, `escalated`, `reconciling`, `blocked`, `failed`, `cancelled` for the other paths. Terminal states: `succeeded`, `failed`, `blocked` (blocked can re-enter `reconciling`), `cancelled`.

## Known Limitations and Deferred Work

- Schema version 1 is current; no migrations are registered yet. The migration mechanism is tested via the injectable target version.
- The reducer is pure logic; durable event persistence is owned by the coordination package and the session log.
