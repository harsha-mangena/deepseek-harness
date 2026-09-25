# @deepseek-ai/dsh-system1-integration

End-to-end read-only coordinator for System 1 (Jev-only).

## What it provides

- **ReadOnlyCoordinator**: orchestrates the full decision loop:
  1. Synthesize observations (provenance-labelled, bounded, secret-filtered)
  2. Generate candidate menu (filtered to `effect: 'read'`)
  3. Policy check (all candidates must be allowed)
  4. Jev decision via DecisionProvider
  5. Calibration (if available)
  6. Read-only execution via injected executor
- **Defense in depth**: write/mutate candidates are filtered from the menu; a second check rejects non-read effects at execution (guards against filter regressions).
- Escalation (`escalate-none`) results in no execution.

## Production driver

`ReadOnlyProductionDriver` implements the workflow package's `CoordinatorDriver`: one durable read-only turn per coordinator wake.

The driver takes an explicit `mode` (`ProductionDriverConfig.mode`), threaded from the workflow plugin's resolved mode (`workflows.config.mode`); it never reads ambient plugin state. Constructing a driver with mode `off` throws: while the plugin is off, coordinator creation is refused and no driver should exist.

- `enforce`: the turn below runs in full; admitted decisions dispatch.
- `shadow`: the driver runs the decision pipeline over the drained observations and records the admitted decision as an advisory `system1/decision` suggestion event. The shadow path has no execution capability — no tool is dispatched, no handoff worker is spawned, and the turn finalizes `escalated` with a shadow summary. The baseline DeepSeek path owns execution.

Turn lifecycle (enforce mode):

1. Drain the coordinator inbox (next-step before next-turn) into provenance-labelled observations.
2. Run the real `ReadOnlyCoordinator` decision loop: policy filter → Jev decision → `admitDecision` (correlation, model pinning, menu membership, calibration gate) → dispatch recheck.
3. Dispatch the admitted read-only candidate through the coordinator's **scoped** tool runtime (`coordinator.ctx.tools`), so the call runs under the coordinator's private registrations and initiator.
4. Verify the real tool result with the host-supplied `verify` hook, then record the outcome with the shipped `finalizeTerminal` finalizer:
   - `success` only with a passing verification record backing `verifiedBy` (the check observes the real `ToolExecutionSuccess`, never a fabricated receipt).
   - `escalated` when the decision is `escalate-none`.
   - `failure` on admission rejection, policy denial, provider error, unresolvable tool mapping, tool failure, or failed verification.
   - `cancelled` when the turn aborts.

Fail-closed guarantees: nothing executes on an unadmitted decision; `resolveCall` returning `undefined` fails the turn instead of dispatching; the driver additionally refuses non-`read` candidates even if the menu filter regresses.

## Known Limitations and Deferred Work

- Read-only only. Controlled mutations (write effects) are Phase 7.
- The executor is injected by the host; this package does not implement tool execution.
- No delegation, MCP, or memory (Phases 6-8).
