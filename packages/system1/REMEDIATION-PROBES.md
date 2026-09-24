# Reviewer Probe Tracker

Independent review of PR #2 (head `cacdaeb`) produced 34 failing probes
(R01–R34) and 3 passing positive controls (C01–C03). The controls are pinned
as owner-package regressions:

- C01, C03 → `packages/system1/jev/tests/positive-controls.spec.ts`
- C02 → `packages/system1/policy/tests/positive-controls.spec.ts`

Each failing probe below is an acceptance criterion for its owning
remediation phase. Add the probe as an owner-package regression test when its
fix lands; preserve the intent and adapt interfaces when implementing missing
features; do not weaken the assertions.

| Probe | Finding | Phase | Status |
|-------|---------|-------|--------|
| R01 | refuses execution without approved calibration | B (F02) | **done** — `admitDecision` requires bound calibration; see `integration/tests/coordinator.spec.ts` |
| R02 | refuses an empirically zero-correctness route | B (F02) | **done** — calibration gate rejects sub-threshold; see `integration/tests/coordinator.spec.ts` |
| R03 | rechecks policy after a provider call | B (F04) | **done** — dispatch-time policy recheck; see `integration/tests/coordinator.spec.ts` |
| R04 | sends the actual tenant to guards | B (F04) | **done** — `tenantId` required, no default; see `integration/tests/coordinator.spec.ts` |
| R05 | forbidden menu option must not block an allowed selection | B (F04) | **done** — policy filters before prediction; see `integration/tests/coordinator.spec.ts` |
| R06 | rejects a decision correlated to a different request | B (F02) | **done** — exact decisionId/questionFamily/promptVersion match; see `integration/tests/coordinator.spec.ts` |
| R07 | rejects a missing probability distribution | B (F10) | **done** — see `jev/tests/jev.spec.ts` |
| R08 | rejects probabilities whose sum is not one | B (F10) | **done** — see `jev/tests/jev.spec.ts` |
| R09 | rejects unknown probability options | B (F10) | **done** — see `jev/tests/jev.spec.ts` |
| R10 | rejects a Noul response to a Choice request | B (F10) | **done** — typed Noul throws; see `jev/tests/jev.spec.ts` |
| R11 | does not retry invalid API credentials | B (F15) | **done** — 401/403 never retried; see `jev/tests/jev.spec.ts` |
| R12 | enforces the advertised immutable-model requirement | B (F15) | **done** — pinned model IDs enforced; see `jev/tests/jev.spec.ts` |
| R13 | pools identical confidence values regardless of sample order | B (F12) | **done** — tied pooling before PAVA; see `calibration/tests/calibration.spec.ts` |
| R14 | isolates shadow sink failures from production | B (F14) | **done** — onError isolation, failures recorded; see `calibration/tests/calibration.spec.ts` |
| R15 | establishes itself as initiator when woken outside an agent | B (F06) | **done** — see `workflow/tests/lifecycle-invariants.spec.ts` |
| R16 | creates private tool registrations for each coordinator | B (F03) | **done** — per-coordinator scope; see `workflow/tests/lifecycle-invariants.spec.ts` |
| R17 | runs follow-up work submitted during the active turn | B (F06) | **done** — wake latch; see `workflow/tests/lifecycle-invariants.spec.ts` |
| R18 | rejects maintenance while a driver is active | B (F06) | **done** — see `workflow/tests/lifecycle-invariants.spec.ts` |
| R19 | writes inbox changes into durable session events | D (F05) | open |
| R20 | rejects a successful terminal with no verified evidence | A (F05) | **done** — `finalizeTerminal` enforces; see `workflow/tests/regression-fixtures.spec.ts` |
| R21 | never reuses a released fencing token | B (F07) | **done** — durable monotonic epochs; see `coordination/tests/coordination.spec.ts` |
| R22 | stale owner cannot release a replacement lease | B (F07) | **done** — stale-release rejection; see `coordination/tests/coordination.spec.ts` |
| R23 | duplicate delivery cannot be claimed by two workers | B (F08) | **done** — atomic deduplicated claims; see `distributed/tests/distributed.spec.ts` |
| R24 | validates the token of a claimed item on release | B (F08) | **done** — see `distributed/tests/distributed.spec.ts` |
| R25 | preserves checkpoint state when caller mutates its object | B (F08) | **done** — immutable copies; see `distributed/tests/distributed.spec.ts` |
| R26 | never dispatches an already-cancelled MCP call | B (F09) | **done** — pre-dispatch cancellation; see `mcp/tests/mcp.spec.ts` |
| R27 | rejects write dispatch without verification policy | B (F09) | **done** — see `mcp/tests/mcp.spec.ts` |
| R28 | rejects invalid MCP arguments before dispatch | B (F09) | **done** — schema validation; see `mcp/tests/mcp.spec.ts` |
| R29 | keeps a single large context entry within its budget | B (F13) | **done** — see `observations/tests/observations.spec.ts` |
| R30 | keeps working memory within its character budget | B (F13) | **done** — see `memory/tests/memory.spec.ts` |
| R31 | bounds observations including markers and separators | B (F13) | **done** — see `observations/tests/observations.spec.ts` |
| R32 | filters common JSON-formatted secrets | B (F11) | **done** — recursive redaction; see `observations/tests/observations.spec.ts` |
| R33 | cancellation aborts an active maintenance task | B (F06) | **done** — see `workflow/tests/lifecycle-invariants.spec.ts` |
| R34 | disposal awaits asynchronous coordinator effects | B (F06) | **done** — see `workflow/tests/lifecycle-invariants.spec.ts` |

Full probe source: PR #2 review, Appendix B (2026-09-24).
