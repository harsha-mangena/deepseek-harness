# @deepseek-ai/dsh-system1-delegation

DeepSeek handoff and delegation for System 1 (Jev-only).

## What it provides

- **DelegationManager**: creates delegated tasks with parent-child linkage, depth tracking, and budget requirements.
- **Depth limits**: default max depth 5; configurable. Prevents infinite delegation recursion.
- **Budget enforcement**: delegation requires positive budget units (allocated from parent's pool).

## Known Limitations and Deferred Work

- The actual handoff transport to DeepSeek (API call) is out of scope; this package manages the delegation protocol.
- Budget pool integration (reserving from parent) is Phase 10.
- Delegation is currently manual (System 1 decides to delegate); automatic delegation triggers are future work.
