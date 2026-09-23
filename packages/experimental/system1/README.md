# @deepseek-ai/dsh-experimental-system1

System 1 fast-thinking for the DeepSeek Harness agent loop: Jev (TypeSafe's System One model) answers typed questions about agent traffic — step triage, tool-loop detection, retry judgment — so the harness can skip, shorten, or supervise work without paying for a full reasoning-model call.

This package is **experimental**. Its public contract may change, and it ships shadow-first: gates are evaluated against real traffic and recorded as structured traces, but loop behavior never changes.

## Purpose

Reasoning-model calls are expensive. Many loop decisions are small and typed ("is this step trivial?", "is this tool call looping?", "should this failure retry?"). System 1 answers those with Jev's fast typed decisions behind confidence gates, per-turn/per-task budgets, timeouts, and a circuit breaker. Anything uncertain falls back to existing harness behavior.

## How it works

The plugin observes six documented extension points:

- `agent/pre-step` → asks **triage** (`choice`) and step **delegability** (`choice`) in one batch, from the incoming messages.
- `tools/pre-execute` → asks **tool-choice** (`choice`): should this call proceed, or is it clearly the wrong tool for the step's apparent goal?
- `tools/post-execute` → tracks recent tool calls per agent, runs a **deterministic** loop check in code (tool arguments are canonicalized — nested key order does not hide a repeat), and — only for ambiguous patterns — asks **loop-check** (`noul`) and **retry-judgment** (`choice`).
- `agent/request` (enforce only) → **model routing**: the cached triage verdict from pre-step may replace the call config per the `modelRoute` table. No extra model call.
- `agent/request-error` → asks **request-retry** (`choice`): does the failed model request look transient? Enforce owns one bounded retry; other modes delegate first and only observe.
- `agent/turn-stopping` → asks **final-answer** (`choice`): does the closing answer address the request? Observe-only — the turn is already over, so there is no veto.

Task boundaries come from the agent lifecycle, not turn numbers: a message inserted into the inbox (`agent/inbox/inserted`) while the agent is idle (`agent/status`) starts a new task and refreshes per-agent budgets and the loop-nudge allowance. Insertions while the agent is running are steering, not new tasks. This keeps long-lived agents from silently degrading to budget-exhausted fallbacks.

Shadow/assist listeners always delegate first (`next()`) and observe afterwards, so a slow or failing backend can never change or delay loop behavior. Enforce listeners judge first (bounded by the service timeout; the service never rejects) and inject guidance, then delegate.

Efficiency is structural, not aspirational:

- **One request per decision point.** `System1Service.askMany()` funnels every question for a step into a single `POST /v1/systemone` call; Jev evaluates them in parallel, so a batch costs barely more time than one question.
- **Code does what code can compute.** Exact tool-call repetition is detected by `detectLoop()` locally — Jev is never asked to count. State sent per question is scoped to what that question needs.
- **Timeouts abort the socket.** A timed-out batch aborts the underlying HTTP request instead of letting it linger.
- **Budgets count questions, not batches**, because each question costs input tokens (output is free).
- **Budgets are partitioned per agent.** Turn/task counters, loop history, the delegation registry, and cached triage verdicts are keyed by agent id — one chatty agent cannot starve another. The circuit breaker stays global: it represents backend health, not agent behavior.
- **Observations outlive the turn.** Shadow observations run on the plugin's own lifetime signal, not the step/tool signals handed to the listeners — those may abort after the waterfall settles while a fire-and-forget observation is still in flight. Letting them cancel the observation would poison the circuit breaker with backend errors that say nothing about backend health.
- **Agent tracking is bounded.** Loop history and turn markers are kept for at most 64 distinct agents; noting a new agent past the bound evicts the oldest agent's state, so long-running hosts cannot grow these maps without bound.
- Node's global fetch keeps connections alive, so repeated calls reuse the TLS session.

`System1Service` runs every question through the same gates:

1. **Disabled** → fallback when the plugin is off.
2. **Circuit** → fallback while the backend is failing repeatedly. HTTP 429 (rate limit) is marked transient and does *not* count toward the failure threshold — the client backs off via `retry-after` instead. A batch that comes back short — fewer judgments than questions — fills the gaps with `backend-error` fallbacks and counts once toward the failure threshold, so a silently dropping backend still trips the breaker.
3. **Budget** → fallback when the per-turn/per-task question budget is spent.
4. **Backend** → timeout converts to a fallback; errors never throw.
5. **Abstention** → the backend may decline to answer. A `noul` judgment that is missing, non-numeric, or non-finite is also an abstention — it never degrades into a fully-confident "not stuck" answer.
6. **Confidence** → judgments below the applicable threshold are dropped. Thresholds are risk-scaled per question kind: a kind listed in `thresholds` wins, then the question's own threshold, then `confidenceThreshold`. Denying a tool dispatch (tool-choice, 0.85) gates higher than advisory hints (retry-judgment, 0.6); shaping reasoning (triage, 0.7) sits between. For `noul` answers the semantics are abstain-in-band: probabilities within ±0.1 of 0.5 abstain with confidence 0 (never a confident "not stuck"), decided probabilities carry confidence 1, and action code thresholds the probability directly.
7. **Validation** → the raw answer must parse into the expected typed shape. A throwing validator is contained: it produces a `backend-error` fallback instead of rejecting the batch.

Every evaluation appends a `System1Trace` to an in-memory ring buffer for replay and tuning. The trace records the versioned `model` id Jev reports (e.g. `jev-1.13.0`), so threshold tuning can be pinned to a model version.

### Backends

- **Jev** (default): TypeSafe's hosted System One model. Bring your own key via the environment variable named by `jevApiKeyEnv` (default `TYPESAFE_API_KEY`, the official SDK convention); the key itself is never stored in config or memory. Endpoint defaults to `https://api.typesafe.ai/v1/systemone`, model to `jev-1.13.0` (pinned: TypeSafe warns aliases move, and the shipped thresholds are tuned against that release — record the versioned model from your traces and re-tune on upgrades).
- **Laya** (deferred): local fast-thinking sidecar. Kept compiling for a future local-first pass; not the current focus.
- **none**: always abstains. Every gate falls back; useful for measuring baseline behavior.

### Modes

- `shadow` (default): trace only. The loop never changes.
- `assist`: trace plus `warn`-level hints — loop hints (deterministic and high-probability Jev judgments), wrong-tool-call warnings from the tool-choice gate, and final-answer warnings when the closing answer clearly misses the request.
- `enforce`: judgments actuate.
  - **Triage** injects a reasoning-strategy hint before each step: trivial → direct short answer, no extended deliberation; standard → one grounded chain (one hypothesis, one tool call, verify, at most four steps); complex → atom-of-thoughts decomposition (dependency-ordered atomic sub-questions, discard resolved context). A failure signal (an acted-on retry hint or loop nudge) escalates the *next* step's reasoning one level, consumed once.
  - **Tool-choice** is judge-before-act: a confident (≥ 0.85) wrong-tool verdict denies the dispatch with a model-facing reason so the agent self-corrects instead of spending a round-trip on a useless call. Anything else continues the waterfall untouched.
  - **Loop-check** injects a nudge when the agent looks stuck (bounded per task and per episode); **retry-judgment** advises on failed tool calls (`retry`, `retry-different`, `replan`, or `give-up`).
  - **Bounded STOP**: a hopeless trajectory — 5+ identical calls in a row *plus* Jev's stuck probability at/above `stopStuckThreshold` — ends the turn via pre-step `reject` instead of burning more tokens. Legitimate repetition (polling, retries) with a low stuck probability keeps going.
  - **Model routing** reuses the cached triage verdict at `agent/request`: a configured `modelRoute` entry (e.g. `complex → { model: 'strong-model' }`) replaces that call's provider/model/reasoning-effort without spending another model call. Stale or missing verdicts, and unmapped verdicts, leave the config untouched. Shadow/assist never route.
  - **Request-error recovery**: a confident (≥ 0.7) transient verdict on `agent/request-error` owns the retry — `{kind:'retry'}` without delegating — so a flaky provider does not kill the turn. Bounded by `maxRequestRetries` per step; anything else delegates to the loop default. Shadow/assist only observe.
  - **Delegation triage** advises the Lead on teammate spawns (see Orchestrator layer below).
  - The final-answer check stays observe-only in every mode.

  Any fallback — abstention, low confidence, timeout, backend error, exhausted budget — injects nothing (and denies nothing) and the loop continues unchanged.

### Orchestrator layer: judge-before-delegate

When the agent-team packages are installed, the Lead can delegate via the `spawn_teammate` tool. System 1 judges the delegation itself — an orchestration concern the per-step hooks cannot see:

- **Delegation triage** (one Jev `delegation-triage` question per spawn, joining the post-execute batch): `complex`/`standard` verdicts advise the Lead through `additionalContexts` — which strategy the subtask deserves (the teammate, being an agent, receives the matching atom/chain/tree-of-thoughts hint on its own first step) and proportionate oversight. `trivial` stays silent; the Lead's context stays clean. The scored composite is cached per agent under the spawn's canonical args key: an identical repeat reuses the advisory instead of re-asking Jev byte-identical questions.
- **Duplicate-purpose detection** (deterministic, no model call): a bounded registry of recent spawns flags same-name or similar-purpose teammates (Jaccard ≥ 0.5 within 30 minutes) so the Lead can interrupt or merge before two teammates burn tokens on the same work. Registry writes and duplicate warnings run before the loop early-return, so a repeated `spawn_teammate` cannot dodge bookkeeping by looking like a loop — and a looping spawn still receives the cached delegation advisory, so it never skips Jev oversight either.

Shadow traces the triage; assist warns; enforce injects. The branch only fires for `spawn_teammate`, so without the agent-team packages it is inert — no config flag needed. Delegations are never denied: the plugin advises, the Lead decides.

## Configuration

All tunables are Schemastery-validated with safe defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `backend` | `'jev'` | `'jev' \| 'laya' \| 'none'` |
| `mode` | `'shadow'` | `'shadow' \| 'assist' \| 'enforce'` |
| `confidenceThreshold` | `0.7` | Minimum judgment confidence (0..1); overridden per kind by `thresholds` |
| `thresholds` | `{}` | Per-question-kind confidence overrides, e.g. `{ 'tool-choice': 0.9 }`. Precedence: per-kind override → question's own threshold → `confidenceThreshold` |
| `budgetPerTurn` / `budgetPerTask` | `8` / `16` | Max System 1 questions per turn / per task; every question counts against both budgets |
| `timeoutMs` | `1200` | Per-batch backend timeout (Jev answers in 70–500ms). `0` disables the timeout (not recommended for network backends) |
| `failureThreshold` / `cooldownMs` | `3` / `30000` | Circuit breaker (HTTP 429s are transient and do not count) |
| `traceBufferSize` | `200` | In-memory trace ring buffer |
| `jevApiKeyEnv` | `'TYPESAFE_API_KEY'` | Env var naming the Jev key |
| `jevEndpoint` | `'https://api.typesafe.ai/v1/systemone'` | Jev endpoint |
| `jevModel` | `'jev-1.13.0'` | Pinned model version; TypeSafe warns aliases move |
| `layaEndpoint` / `layaAutoStart` / `layaCommand` | see `src/index.ts` | Laya sidecar wiring (deferred) |
| `loopStuckThreshold` | `0.7` | Stuck probability at/above which a loop-check nudges (enforce) |
| `maxLoopNudgesPerTask` | `2` | Max loop nudges injected per agent task (enforce) |
| `stopStuckThreshold` | `0.9` | Stuck probability at/above which a hopeless trajectory ends the turn (enforce). Stricter than `loopStuckThreshold`: the STOP also requires a 5+ identical-call streak |
| `delegationWeights` | `{ novelty: 0.4, toolRisk: 0.35, irreversibility: 0.25 }` | Relative weights for the delegation composite (normalized in code; individual weights may be zero, the total must be positive) |
| `modelRoute` | `{}` | Verdict→override table for model routing (enforce), e.g. `{ complex: { model: 'strong-model' } }`. Each override may set `provider`, `model`, and/or `reasoningEffort`; unset fields keep the loop's config. Inert by default: provider/model names are deployment-specific |
| `maxRequestRetries` | `1` | Max System 1-owned retries per failed model request per step (enforce); further failures delegate to the loop default |

### Getting a Jev key

Jev is in early access behind a waitlist: sign up at typesafe.ai, create a key at console.typesafe.ai/settings/keys (or use the Vercel AI Gateway), then:

```sh
export TYPESAFE_API_KEY=<your key>
```

`jevModel` ships pinned to the versioned release the thresholds were tuned against. If you upgrade it, record the versioned model id from your traces and re-tune — aliases move and answers change under you.

## Known Limitations

- **Live verification done (2026-09-23).** The wire format was exercised against the real `POST /v1/systemone` API: 6/6 direct judgments sensible (triage trivial/standard, loop stuck-p 0.86 on x4-identical history vs 0.15 healthy, retry→retry on timeout, give-up on bad args), plus real-model E2E benchmarks with/without Jev. See `~/workspace/system1-jev-validation-results.md`.
- **Laya sidecar shape is provisional and deferred.** The `/health` + `POST /decide` contract in `src/sidecar.ts` is unverified; Laya is not the current focus.
- **Tool shortlist is not wired.** Hierarchical tool selection needs a tool-catalog seam the harness does not expose (verified against the tools package source); the dead `tool-shortlist` question kind was removed rather than left as a stub.
- **Plan viability is not judged.** Plan mode is user-interactive (propose → human review → approve); there is no machine-judgment seam for plan viability, so none is invented.
- **No session events.** Traces live in a per-plugin in-memory ring buffer and do not survive restarts. Durable `system1/*` session events are deferred (they carry persistence/versioning requirements).
- **Budgets are guardrails, not accounting.** Task boundaries are detected from inbox insertions while the agent is idle; an agent that never goes idle keeps one task budget, by design.
- **Model routing is only as good as the route table.** The plugin ships no provider/model names — routing is inert until the operator configures `modelRoute` for their deployment.

## Deferred Work

- Wiring the tool-shortlist gate into request preparation (blocked: no tool-catalog seam in the harness).
- Secure Vault settings UI for the Jev API key (currently env-var only).
- Durable trace persistence and a shadow-replay benchmark harness.
- Laya local-first pass: verify the sidecar contract, supervisor policy (restarts, resource limits).

## Safety invariants

- System 1 can never bypass destructive-action approval; it produces typed judgments, not tool calls.
- JSON Schema validation of tool arguments stays deterministic and untouched.
- A failing, slow, or missing backend is indistinguishable from "no opinion": the loop continues exactly as before.
