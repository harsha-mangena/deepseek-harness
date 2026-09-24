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

## Known Limitations and Deferred Work

- Read-only only. Controlled mutations (write effects) are Phase 7.
- The executor is injected by the host; this package does not implement tool execution.
- No delegation, MCP, or memory (Phases 6-8).
