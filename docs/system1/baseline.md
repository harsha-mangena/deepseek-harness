---
description: "Phase 0 runtime-integration baseline: System 1 lifecycle, guarded tools, and hazard fixtures before the Jev provider exists."
---

# System 1 Phase 0 baseline

English | [中文](baseline.zh.md)

## Summary

This baseline freezes the Phase 0 integration surface of System 1 in DeepSeek Harness: the coordinator lifecycle, the guarded tool entry point, the session event vocabulary, and the two hazard regression fixtures. It was captured on 2026-09-24. Every measurement below comes from offline probes against the workspace sources; no Jev network call was made and no live validation is claimed.

## Lifecycle probes

Eleven contract probes in `packages/system1/workflow/tests/lifecycle-probe.spec.ts` exercise the coordinator as a custom `AgentRegistry` runtime root: kill-switch refusal in `off` mode, coexistence with the single DeepSeek factory, id/session collision boundaries, `agent/created` veto rollback, status transitions and lifecycle events, cancellation and inbox clearing, initiator propagation, application-root lifecycle visibility, session-event snapshot integrity, teardown order (driver drain, owned effects, unregister), and contained non-abort driver failure.

Result on 2026-09-24: 11 passed, 0 failed, in the Phase 0 sandbox (`/tmp/sys1-sandbox`) against the workspace sources. Repository-native execution is pending dependency installation.

## Guarded-tool probes

Three probes in `packages/system1/workflow/tests/guarded-tool-probe.spec.ts` exercise the guarded tool entry point exactly as production callers use it: a real `Context`, a real `ToolRuntime`, a real `SystemPrompt`, `ToolRuntime.execute(ToolExecutionInput)` with a caller-owned `AbortSignal`, and a real `tools/pre-execute` guard waterfall. The probes assert that a denying guard stops the tool body, an allowing guard permits execution, and a caller abort cancels execution.

Result on 2026-09-24: 3 passed, 0 failed, in the Phase 0 sandbox. No policy engine is in scope for this baseline; the probes pin the entry point, not any policy.

## Hazard regression fixtures

Two reference-controller hazards from the offline SystemOneHarness research are recorded as runnable local contracts. `packages/system1/workflow/tests/fixtures/false-guard-blocks.json` pins the rule that an arbitrary required guard returning false blocks its candidate; `packages/system1/workflow/tests/fixtures/repeated-finish-unmet-goal.json` pins the rule that repeated FINISH with an unmet goal never succeeds. The `system1/terminal` success branch requires `verifiedBy` evidence at the type level, so an unevidenced success is unrepresentable.

Both fixtures round-trip through a real `Session` in `packages/system1/workflow/tests/regression-fixtures.spec.ts`. Result on 2026-09-24: 5 passed, 0 failed, in the Phase 0 sandbox.

## Scope limits of this baseline

This baseline measures the coordinator lifecycle, the guarded tool entry point, and the two hazard fixtures. Jev call latency, decision accuracy, calibration, and budget consumption under a real model are outside this baseline: there is no provider to measure them through. The baseline traces are session-event traces of the probes themselves, recorded in the sandbox.

## How to reproduce

Install dependencies (`pnpm install`), then run the focused suites with the repository-native runner: `pnpm exec vitest run packages/system1/workflow/tests/lifecycle-probe.spec.ts packages/system1/workflow/tests/guarded-tool-probe.spec.ts packages/system1/workflow/tests/regression-fixtures.spec.ts`. The sandbox evidence above used the same sources with a throwaway alias map; it must be re-run natively before Phase 0 certification.
