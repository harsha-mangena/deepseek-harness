# @deepseek-ai/dsh-experimental-system1

System 1 fast-thinking for the DeepSeek Harness agent loop: Jev (TypeSafe's System One model) answers typed questions about agent traffic — step triage, tool-loop detection, retry judgment — so the harness can skip, shorten, or supervise work without paying for a full reasoning-model call.

This package is **experimental**. Its public contract may change, and it ships shadow-first: gates are evaluated against real traffic and recorded as structured traces, but loop behavior never changes.

## Purpose

Reasoning-model calls are expensive. Many loop decisions are small and typed ("is this step trivial?", "is this tool call looping?", "should this failure retry?"). System 1 answers those with Jev's fast typed decisions behind confidence gates, per-turn/per-task budgets, timeouts, and a circuit breaker. Anything uncertain falls back to existing harness behavior.

## How it works

The plugin observes two documented waterfall extension points and always delegates first:

- `agent/pre-step` → builds a **triage** `choice` question from the incoming messages.
- `tools/post-execute` → tracks recent tool calls per agent, runs a **deterministic** loop check in code, and — only for ambiguous patterns — asks **loop-check** (`noul`) and **retry-judgment** (`choice`) questions.

Efficiency is structural, not aspirational:

- **One request per decision point.** `System1Service.askMany()` funnels every question for a step into a single `POST /v1/systemone` call; Jev evaluates them in parallel, so a batch costs barely more time than one question.
- **Code does what code can compute.** Exact tool-call repetition is detected by `detectLoop()` locally — Jev is never asked to count. State sent per question is scoped to what that question needs.
- **Timeouts abort the socket.** A timed-out batch aborts the underlying HTTP request instead of letting it linger.
- **Budgets count questions, not batches**, because each question costs input tokens (output is free).
- **Observations outlive the turn.** Shadow observations run on the plugin's own lifetime signal, not the step/tool signals handed to the listeners — those may abort after the waterfall settles while a fire-and-forget observation is still in flight. Letting them cancel the observation would poison the circuit breaker with backend errors that say nothing about backend health.
- **Agent tracking is bounded.** Loop history and turn markers are kept for at most 64 distinct agents; noting a new agent past the bound evicts the oldest agent's state, so long-running hosts cannot grow these maps without bound.
- Node's global fetch keeps connections alive, so repeated calls reuse the TLS session.

`System1Service` runs every question through the same gates:

1. **Disabled** → fallback when the plugin is off.
2. **Circuit** → fallback while the backend is failing repeatedly (HTTP 429s included). A batch that comes back short — fewer judgments than questions — fills the gaps with `backend-error` fallbacks and counts once toward the failure threshold, so a silently dropping backend still trips the breaker.
3. **Budget** → fallback when the per-turn/per-task question budget is spent.
4. **Backend** → timeout converts to a fallback; errors never throw.
5. **Abstention** → the backend may decline to answer. A `noul` judgment that is missing, non-numeric, or non-finite is also an abstention — it never degrades into a fully-confident "not stuck" answer.
6. **Confidence** → judgments below `confidenceThreshold` are dropped. For `noul` answers the confidence is `max(p, 1-p)`, so fence-sitting probabilities near 0.5 fail the gate.
7. **Validation** → the raw answer must parse into the expected typed shape. A throwing validator is contained: it produces a `backend-error` fallback instead of rejecting the batch.

Every evaluation appends a `System1Trace` to an in-memory ring buffer for replay and tuning. The trace records the versioned `model` id Jev reports (e.g. `jev-1.13.0`), so threshold tuning can be pinned to a model version.

### Backends

- **Jev** (default): TypeSafe's hosted System One model. Bring your own key via the environment variable named by `jevApiKeyEnv` (default `TYPESAFE_API_KEY`, the official SDK convention); the key itself is never stored in config or memory. Endpoint defaults to `https://api.typesafe.ai/v1/systemone`, model to `jev-latest`.
- **Laya** (deferred): local fast-thinking sidecar. Kept compiling for a future local-first pass; not the current focus.
- **none**: always abstains. Every gate falls back; useful for measuring baseline behavior.

### Modes

- `shadow` (default): trace only. The loop never changes.
- `assist`: trace plus `warn`-level loop hints — both from the deterministic loop check and from high-probability Jev loop judgments.
- `enforce`: currently behaves as `assist` with a one-time warning — actuation is deferred (see below).

## Configuration

All tunables are Schemastery-validated with safe defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `backend` | `'jev'` | `'jev' \| 'laya' \| 'none'` |
| `mode` | `'shadow'` | `'shadow' \| 'assist' \| 'enforce'` |
| `confidenceThreshold` | `0.7` | Minimum judgment confidence (0..1) |
| `budgetPerTurn` / `budgetPerTask` | `4` / `12` | Max System 1 questions |
| `timeoutMs` | `1200` | Per-batch backend timeout (Jev answers in 70–500ms). `0` disables the timeout (not recommended for network backends) |
| `failureThreshold` / `cooldownMs` | `3` / `30000` | Circuit breaker |
| `traceBufferSize` | `200` | In-memory trace ring buffer |
| `jevApiKeyEnv` | `'TYPESAFE_API_KEY'` | Env var naming the Jev key |
| `jevEndpoint` | `'https://api.typesafe.ai/v1/systemone'` | Jev endpoint |
| `jevModel` | `'jev-latest'` | Model alias; pin (e.g. `jev-1.13.0`) once thresholds are tuned |
| `layaEndpoint` / `layaAutoStart` / `layaCommand` | see `src/index.ts` | Laya sidecar wiring (deferred) |

### Getting a Jev key

Jev is in early access behind a waitlist: sign up at typesafe.ai, create a key at console.typesafe.ai/settings/keys (or use the Vercel AI Gateway), then:

```sh
export TYPESAFE_API_KEY=<your key>
```

Pin `jevModel` to the versioned id from your traces once you tune `confidenceThreshold`, because `jev-latest` moves and answers change under you.

## Known Limitations

- **No live verification yet.** The wire format matches TypeSafe's documented `POST /v1/systemone` shape (`model` + `state` + typed `questions`; per-question `answers`; `model` echo), but it has not been exercised against the real API — that needs a waitlisted `TYPESAFE_API_KEY`.
- **Laya sidecar shape is provisional and deferred.** The `/health` + `POST /decide` contract in `src/sidecar.ts` is unverified; Laya is not the current focus.
- **Tool shortlist is not wired.** Hierarchical tool selection needs the tool-catalog access point identified; only triage, loop-check, and retry-judgment run in this change.
- **No session events.** Traces live in a per-plugin in-memory ring buffer and do not survive restarts. Durable `system1/*` session events are deferred (they carry persistence/versioning requirements).
- **Budgets are guardrails, not accounting.** Per-agent turn tracking resets on observed turn changes; concurrent agents share the service counters.

## Deferred Work

- `enforce`-mode actuation (e.g. pre-step reject on high-confidence trivial triage, loop interruption) behind evaluation evidence.
- Wiring the tool-shortlist gate into request preparation.
- Secure Vault settings UI for the Jev API key (currently env-var only).
- Durable trace persistence and a shadow-replay benchmark harness.
- Laya local-first pass: verify the sidecar contract, supervisor policy (restarts, resource limits).

## Safety invariants

- System 1 can never bypass destructive-action approval; it produces typed judgments, not tool calls.
- JSON Schema validation of tool arguments stays deterministic and untouched.
- A failing, slow, or missing backend is indistinguishable from "no opinion": the loop continues exactly as before.
