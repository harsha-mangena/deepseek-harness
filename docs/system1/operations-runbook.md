---
description: "Operating procedures for the System 1 integration: startup checks, mode operations, kill switch, rollback, monitoring, and incident response."
---

# System 1 operations runbook

## Summary

This runbook covers operating the System 1 integration (`@deepseek-ai/dsh-system1-workflow`, Jev-only) once deployed: pre-start checks, the `off`/`shadow`/`enforce` modes, the kill-switch and rollback procedures, what to monitor, and how to respond to the four failure classes the plan names (provider outage, unknown write outcome, budget exhaustion, verification failure loop). Every command below exists in this repository; nothing here invents tooling. Nothing in this runbook has been exercised in a production deployment yet.

## Startup checks

Run before enabling `shadow` or `enforce`. All checks fail loud; none are skipped silently.

1. **Dependencies.** `pnpm install --frozen-lockfile` (pnpm 11.7.0). The container caveat applies: if the pre-push hook's dependency-status check fails with EPERM, run the equivalent checks manually and record the bypass.
2. **Suite green.** `./node_modules/.bin/vitest run packages/system1/` must pass. For a timed manifest: `pnpm run system1:bench`, then `pnpm run system1:report`.
3. **Typecheck.** `./node_modules/.bin/tsc --noEmit -p packages/system1/workflow/tsconfig.json` (and the same for each modified package). `git diff --check` must be clean.
4. **Jev provider configuration.** `JevDecisionProvider` fails at construction, not at first call: it throws `PROVIDER_TRANSPORT_FAILED` when no API key is supplied and `PROVIDER_UNSUPPORTED_MODEL` when the model is missing or is a mutable alias instead of a pinned `jev-x.y.z` version. Verify the host supplies a pinned model id and a valid key before the plugin loads.
5. **Approved calibration.** The calibration gate treats a `null` calibrated correctness as ineligible — the route stays disabled. Confirm a frozen, versioned calibration artifact exists for every question family you intend to enforce; families without one cannot run in `enforce`.
6. **MCP availability.** Confirm the configured MCP servers answer and the catalog generation the deployment pinned is current. The adapter opens its circuit after 3 consecutive failures per tool and half-opens after 30 s (`failureThreshold`, `resetTimeoutMs`, `callTimeoutMs` on `McpAdapterConfig`); a cold start against a dead server means every first call waits out the per-call timeout (default 30 s).
7. **Storage.** The coordination store is SQLite (`node:sqlite`) for single-process deployment; the schema is created idempotently (`CREATE TABLE IF NOT EXISTS`) with uniqueness constraints on `(tenant_id, pool_name)`, `(tenant_id, idempotency_key)`, `(task_id, decision_id)`, `(task_id, attempt_id)`, and durable `lease_epochs`. Point it at a persistent path, not `:memory:`, or leases, budgets, and fencing epochs do not survive restart. PostgreSQL is the planned distributed backend and is not wired yet — do not run competing coordinators against one task across processes.

## Mode operations

The plugin is configured in `cordis.yml`:

```yaml
- name: '@deepseek-ai/dsh-system1-workflow'
  config:
    mode: 'off'      # off | shadow | enforce
    provider: 'jev'
    model: 'jev-1.13.0'
```

| Mode | Behavior |
|---|---|
| `off` | Default. Coordinator creation is refused; the standard DeepSeek path is untouched. |
| `shadow` | Coordinators run and record decisions; every decision is advisory. |
| `enforce` | Coordinators own routing and execution for admitted work. |

Change mode by reloading the plugin with new configuration. There is no hot mode toggle except the one-way rollback below.

## Kill switch

Setting the mode to `off` (config reload) is the kill switch. In-flight turns are cancelled and allowed to settle — the driver drains, receipts and unknown outcomes are written to the session log, and reconciliation state is preserved. No new Jev decisions are made: `create()` throws while the mode is `off`, so new work takes the standard DeepSeek path. In-flight work is never duplicated onto the baseline path; it settles or reconciles exactly once under its existing lease.

## Rollback

`System1Workflows.rollbackToBaseline()` is the supported rollback, for use when the integration must be removed from the serving path immediately (bad calibration, provider incident, suspected unsafe behavior). Every live coordinator is drained and unregistered: in-flight turns are cancelled, the driver settles (`whenIdle`), owned Cordis effects unwind in reverse order, and the agent is removed from the registry — the same teardown as the coordinator handle's `dispose()`. Nothing is deleted: inbox appends, receipts, verification evidence, unknown outcomes, and terminal records stay in the durable session log, and budget reservations and fencing epochs stay in the coordination store, so a later investigation can replay the full history. The plugin mode is then latched to `'off'` — one-way. Coordinator creation is refused from that point on, and new work goes to the baseline DeepSeek path. Re-enabling requires reloading the plugin with a new configuration. Rollback is idempotent and safe to call with no live coordinators. It is covered by `packages/system1/workflow/tests/rollback.spec.ts`: event preservation, in-flight cancellation and unregistration, the one-way mode latch, and idempotency. After a rollback, do not re-enable `enforce` until the cause is understood and the startup checks above pass again on the exact commit being deployed.

## Monitoring

Watch these signals; each maps to a concrete failure class below.

- **Budget exhaustion.** Track `budget_pools.reserved` against `capacity` per `(tenant_id, pool_name)`, and the rate of reservation rejections. A rising rejection rate means the workload no longer fits its pools — resize the pools or reduce admitted work, never reset budgets mid-flight.
- **Calibration drift.** Compare accepted-decision accuracy against the frozen calibration's promised correctness per question family. Drift means the calibration artifact is stale: freeze a new one from held-out data, or drop the family back to `shadow` until it is re-evaluated.
- **Verification failures.** Track `system1/verification` events by `checkId` and `passed`. A rising failure rate on one check is either a broken verifier or a genuinely failing tool — distinguish them before acting (see incident response).
- **Provider health.** Track Jev transport errors by class (`PROVIDER_TRANSPORT_FAILED`, 429, timeout, 5xx). Sustained errors mean the provider path is degraded; the driver fails closed, but latency and escalation rates will climb.
- **Unknown outcomes.** Any `unknown` execution outcome must reconcile to settled or stay explicitly `blocked`. Unknown outcomes that linger are the highest-severity item on this list: they mean an effect happened whose result is not known.

## Incident response

### Provider outage (Jev unreachable, sustained 429s, repeated 5xx)

Jev failures never execute an unvalidated choice: the driver fails the turn or escalates, and the MCP adapter's circuit breaker stops calling a dead tool after 3 consecutive failures. Confirm the outage is on the provider side (transport error classes in the session log, not schema rejections, which indicate our bug). If the outage is prolonged, use the kill switch (`off`) or `rollbackToBaseline()`; in-flight turns settle, and new work takes the DeepSeek path. Do not retry through a different identity or an unevaluated fallback model.

### Unknown write outcome

Writes are disabled in the initial release, but any `unknown` outcome — a dispatch whose receipt never arrived — must be treated as "the effect may have happened." Reconcile by reading resource state or receipts with read-only calls before any further mutation. Never blindly repeat the write. If reconciliation cannot determine the outcome, leave the task `blocked` with the evidence attached; a blocked task with evidence is the correct terminal state, not a failure to retry harder.

### Budget exhaustion

When reservations are rejected, the affected work stops with an explicit limit outcome and its checkpoint is returned. Do not reset budgets on retry, handoff, worker creation, or restart — the store enforces this. The operational fix is to resize the pool for the tenant or shed load (kill switch for the affected workflow class), then investigate why consumption exceeded the plan: a leak (reservations never settled) is a bug; genuinely higher demand is a capacity decision.

### Verification failure loop

If the same check fails repeatedly and the task keeps re-observing and retrying, the no-progress limit stops the local loop and the task escalates or fails explicitly — repeated FINISH never overrides a failed verifier (`finalizeTerminal` throws `TerminalInvariantError` on unevidenced success). On call: read the failing `system1/verification` events for the request via `getEvidence(requestId)` to see whether the tool result or the verifier is wrong. Fix the broken side; do not lower the check to make the loop stop.

## Known limits of this runbook

These procedures are implemented and tested locally (rollback) or described from the shipped code (kill switch, circuit breaker, fail-closed driver), but no production deployment has exercised them. The benchmark scripts (`system1:bench`, `system1:report`) measure local test-suite timing only — they are not production latency or cost evidence.
