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
| R01 | refuses execution without approved calibration | B (F02) | open |
| R02 | refuses an empirically zero-correctness route | B (F02) | open |
| R03 | rechecks policy after a provider call | B (F04) | open |
| R04 | sends the actual tenant to guards | B (F04) | open |
| R05 | forbidden menu option must not block an allowed selection | B (F04) | open |
| R06 | rejects a decision correlated to a different request | B (F02) | open |
| R07 | rejects a missing probability distribution | B (F10) | open |
| R08 | rejects probabilities whose sum is not one | B (F10) | open |
| R09 | rejects unknown probability options | B (F10) | open |
| R10 | rejects a Noul response to a Choice request | B (F10) | open |
| R11 | does not retry invalid API credentials | B (F15) | open |
| R12 | enforces the advertised immutable-model requirement | B (F15) | open |
| R13 | pools identical confidence values regardless of sample order | B (F12) | open |
| R14 | isolates shadow sink failures from production | B (F14) | open |
| R15 | establishes itself as initiator when woken outside an agent | B (F06) | open |
| R16 | creates private tool registrations for each coordinator | B (F03) | open |
| R17 | runs follow-up work submitted during the active turn | B (F06) | open |
| R18 | rejects maintenance while a driver is active | B (F06) | open |
| R19 | writes inbox changes into durable session events | C (F05) | open |
| R20 | rejects a successful terminal with no verified evidence | A (F05) | **done** — `finalizeTerminal` enforces; see `workflow/tests/regression-fixtures.spec.ts` |
| R21 | never reuses a released fencing token | B (F07) | open |
| R22 | stale owner cannot release a replacement lease | B (F07) | open |
| R23 | duplicate delivery cannot be claimed by two workers | B (F08) | open |
| R24 | validates the token of a claimed item on release | B (F08) | open |
| R25 | preserves checkpoint state when caller mutates its object | B (F08) | open |
| R26 | never dispatches an already-cancelled MCP call | B (F09) | open |
| R27 | rejects write dispatch without verification policy | B (F09) | open |
| R28 | rejects invalid MCP arguments before dispatch | B (F09) | open |
| R29 | keeps a single large context entry within its budget | B (F13) | open |
| R30 | keeps working memory within its character budget | B (F13) | open |
| R31 | bounds observations including markers and separators | B (F13) | open |
| R32 | filters common JSON-formatted secrets | B (F11) | open |
| R33 | cancellation aborts an active maintenance task | B (F06) | open |
| R34 | disposal awaits asynchronous coordinator effects | B (F06) | open |

Full probe source: PR #2 review, Appendix B (2026-09-24).
