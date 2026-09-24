# @deepseek-ai/dsh-system1-policy

Policy engine for System 1: capability profiles, effect policies, and required-guard evaluation (Jev-only).

## What it provides

- **PolicyEngine**: evaluates whether a candidate operation may be dispatched.
- **CapabilityProfile**: what a tenant/workload may do (allowed effects, routes, global required guards).
- **EffectPolicy**: per-effect-class rules (allowed, required guards).
- **Guards**: named, dynamically registered checks. The engine compiles the explicit required-guard list per operation (global + effect-specific) and evaluates ALL of them.

## Enforcement rules

- A `false`, missing, or `unknown` required guard blocks dispatch.
- Guards are registered dynamically; the engine never hardcodes a fixed gate list. Newly registered guards participate immediately.
- A throwing guard is treated as `unknown` (blocks).
- Policy is independent of model output: the model proposes candidates; policy decides admissibility.

## Known Limitations and Deferred Work

- Guard implementations (tenant isolation, catalog freshness, etc.) are provided by the host integration, not this package.
- Calibration thresholds and routing policy (Phase 4) build on these primitives.
