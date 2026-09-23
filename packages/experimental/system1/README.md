# @deepseek-ai/dsh-experimental-system1

System 1 fast-thinking for the DeepSeek Harness agent loop: a small local (or hosted) model answers typed questions about agent traffic — step triage, tool-loop detection, retry judgment — so the harness can skip, shorten, or supervise work without paying for a full reasoning-model call.

This package is **experimental**. Its public contract may change, and it ships shadow-first: gates are evaluated against real traffic and recorded as structured traces, but loop behavior never changes.

## Purpose

Reasoning-model calls are expensive. Many loop decisions are small and typed ("is this step trivial?", "is this tool call looping?", "should this failure retry?"). System 1 answers those with a cheap fast-thinking backend behind confidence gates, per-turn/per-task budgets, timeouts, and a circuit breaker. Anything uncertain falls back to existing harness behavior.

## How it works

The plugin observes two documented waterfall extension points and always delegates first:

- `agent/pre-step` → builds a **triage** question from the incoming messages.
- `tools/post-execute` → tracks recent tool calls per agent, runs a **deterministic** loop check, and asks **loop-check** / **retry-judgment** questions for ambiguous patterns.

`System1Service.ask()` runs every question through the same gates:

1. **Disabled** → fallback when the plugin is off.
2. **Circuit** → fallback while the backend is failing repeatedly.
3. **Budget** → fallback when the per-turn/per-task budget is spent.
4. **Backend** → timeout converts to a fallback; errors never throw.
5. **Abstention** → the backend may decline to answer.
6. **Confidence** → judgments below `confidenceThreshold` are dropped.
7. **Validation** → the raw answer must parse into the expected typed shape.

Every evaluation appends a `System1Trace` to an in-memory ring buffer for replay and tuning.

### Backends

- **Laya** (default): zero-configuration local fast-thinking model. The plugin starts a local sidecar on demand (`layaAutoStart`, via `layaCommand`) and stops it on disposal. No API key needed.
- **Jev** (opt-in): hosted fast-thinking API. Bring your own key via the environment variable named by `jevApiKeyEnv` (default `JEV_API_KEY`); the key itself is never stored in config or memory.
- **none**: always abstains. Every gate falls back; useful for measuring baseline behavior.

### Modes

- `shadow` (default): trace only. The loop never changes.
- `assist`: trace plus `warn`-level loop hints in the style of the repeat-tool reminder when the deterministic loop check fires.
- `enforce`: currently behaves as `assist` with a one-time warning — actuation is deferred (see below).

## Configuration

All tunables are Schemastery-validated with safe defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `backend` | `'laya'` | `'laya' \| 'jev' \| 'none'` |
| `mode` | `'shadow'` | `'shadow' \| 'assist' \| 'enforce'` |
| `confidenceThreshold` | `0.7` | Minimum judgment confidence (0..1) |
| `budgetPerTurn` / `budgetPerTask` | `4` / `12` | Max System 1 calls |
| `timeoutMs` | `150` | Per-call backend timeout |
| `failureThreshold` / `cooldownMs` | `3` / `30000` | Circuit breaker |
| `traceBufferSize` | `200` | In-memory trace ring buffer |
| `jevApiKeyEnv` | `'JEV_API_KEY'` | Env var naming the Jev key |
| `jevEndpoint` | `'https://api.jev.ai/v1/systemone'` | Jev endpoint |
| `layaEndpoint` / `layaAutoStart` / `layaCommand` | see `src/index.ts` | Laya sidecar wiring |

## Known Limitations

- **Jev wire shape is provisional.** The `/v1/systemone` request/response fields in `src/backends/jev.ts` are marked for verification against Jev's current API documentation.
- **Laya sidecar shape is provisional.** The `/health` + `POST /decide` contract in `src/sidecar.ts` must be verified against the installed Laya version. If Laya is not installed, the backend reports unavailable and every gate falls back.
- **Tool shortlist is not wired.** Hierarchical tool selection needs the tool-catalog access point identified; only triage, loop-check, and retry-judgment run in this change.
- **No session events.** Traces live in a per-plugin in-memory ring buffer and do not survive restarts. Durable `system1/*` session events are deferred (they carry persistence/versioning requirements).
- **Budgets are guardrails, not accounting.** Per-agent turn tracking resets on observed turn changes; concurrent agents share the service counters.

## Deferred Work

- `enforce`-mode actuation (e.g. pre-step reject on high-confidence trivial triage, loop interruption) behind evaluation evidence.
- Wiring the tool-shortlist gate into request preparation.
- Secure Vault settings UI for the Jev API key (currently env-var only).
- Durable trace persistence and a shadow-replay benchmark harness.
- Supervisor policy for the Laya sidecar (restarts, resource limits).

## Safety invariants

- System 1 can never bypass destructive-action approval; it produces typed judgments, not tool calls.
- JSON Schema validation of tool arguments stays deterministic and untouched.
- A failing, slow, or missing backend is indistinguishable from "no opinion": the loop continues exactly as before.
