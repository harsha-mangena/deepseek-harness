# System 1 (Jev) × DeepSeek Harness — Handoff: Missing Parts, End to End

Audience: the implementing agent (Muse) and the reviewer.
Scope: `packages/experimental/system1` on branch `system1-integration`, after
patches `0001-system1-async-actuation-for-enforce-mode` and
`0002-system1-jev-eval-and-handoff` are applied.
Status date: 2026-09-23.

---

## 0. Where things stand (read first)

### 0.1 What is implemented

| Capability | Where | Mode | Blocks the loop? |
|---|---|---|---|
| Turn triage (trivial / standard / complex), speculated at inbox insert | `index.ts` `judgeTurn`, `actStep` | enforce, `actuation: async` | ≤ `routeDeadlineMs` (250 ms) once per turn |
| Strategy hint (direct / grounded chain / atom-of-thoughts), once per turn | `actStep` + `HintLedger` | enforce | no (injected with the step) |
| Model routing from the triage verdict, sticky per turn, upgrade-only | `actRoute` + `RouteLedger` | enforce | no |
| Veto of a confidently wrong tool call (≥ 0.85), risky tools only | `actToolChoice` | enforce | ≤ `toolGateDeadlineMs` (400 ms), risky tools only |
| Loop nudge (deterministic streak + Jev stuck-probability) | `actToolCall` / `interpretPosted` | enforce | no (delivered next pre-step) |
| Retry advice for failed tools | `interpretPosted` | enforce | no |
| Owned retry of transient model-request errors (bounded) | `judgeRequestError` | enforce | error path only |
| Bounded STOP (5+ identical calls + stuck p ≥ 0.9) | `stopCheck` | enforce | only on a 5+ streak |
| Large tool-result triage (replace with head + marker) | `actToolCall` | enforce | ≤ `resultTriageDeadlineMs` (600 ms), results ≥ `triageMinChars` |
| Injection screen, subagent acceptance, delegation advisory | `interpretPosted` | enforce | no |
| Service: budgets (+ critical reserve), cancel ≠ failure, half-open breaker | `service.ts` | all | — |
| Jev wire: flat shared state / scoped mixed state, warm-up | `backends/jev.ts` | all | — |
| Telemetry: `system1/decision`, `system1/decision-acted` (ignorable) | `telemetry.ts` | all | — |
| Live eval + latency probe | `scripts/jev-eval.ts` | offline | — |

### 0.2 What is NOT proven

1. **Better choices.** No live Jev run has scored the production questions.
   The eval script exists and was dry-run only against a stub.
2. **Lower latency / cost.** Async actuation bounds the overhead. It does not
   by itself save anything. Savings require (a) `modelRoute` configured,
   (b) tasks where Jev can act (easy turns on an expensive default, loops,
   large outputs, failing requests), and (c) a benchmark that shows it.
3. **Upstream readiness.** Coverage gate, lint, repo-wide build, and the
   persistence-format check are not green (see P0).

### 0.3 Corrections to the Muse summary

- "Model routing — the cached triage verdict can override which model
  serves the turn": true only when `modelRoute` is configured. The default
  is `{}` → routing is inert. See G1.
- "Veto ≥ 0.85": in async mode only for tools matching `riskyTools`, and only
  if the verdict arrives within `toolGateDeadlineMs`; otherwise the call
  proceeds.
- "Stop … halts the loop": it halts silently. The pre-step `reject` opens no
  step, so the user gets no explanation. See G12.
- "Judgments are speculated early": true for turn triage (inbox) and risky
  tool-choice (stream prefetch). Post-execute judgments are posted, not
  speculated, and land at the next pre-step.

---

## 1. Method used for this audit

- **Atom of Thoughts.** The loop was decomposed into independent decision
  atoms (route, strategy, veto, retry, stop, triage, prune, verify, accept,
  delegate, budget, breaker, persistence, telemetry, benchmark). Each atom
  was checked for: input sufficiency, primitive fit, seam, fallback, latency
  on the critical path, test coverage, and live evidence.
- **Tree of Thoughts.** For each gap, alternatives were generated and pruned;
  the chosen branch is stated with its reason ("Chosen / Rejected").
- **Chain of Thoughts.** The dependency chain across gaps is in §4: what must
  land before what, and why.

Evidence types used below: **[verified]** read in source or executed here;
**[measured]** from your shadow benchmark; **[external]** vendor or
third-party source; **[inferred]** reasoning, needs confirmation.

---

## 2. Gap list (prioritized)

P0 = blocks correctness claims or upstream merge. P1 = required for the
efficiency goal. P2 = polish, scale, and hygiene.

| ID | Pri | Gap | Evidence |
|---|---|---|---|
| G1 | P0 | `modelRoute` empty → routing does nothing | [verified] `Config.modelRoute` default `{}` |
| G2 | P0 | Jev judgment quality never measured live | [verified] only stubbed tests |
| G3 | P0 | Persistence check fails on `source.kind='system1'` | [verified] commit ec8a396 note; catalog lacks the kind |
| G4 | P0 | Coverage below the repo's 100%-per-file gate | [verified] index 89.9%, board 93.0%, policy 89.8%, service 97.1%, jev 94.4% statements |
| G5 | P0 | Lint and repo-wide build not run | [verified] could not run oxlint/tsgolint in sandbox |
| G6 | P1 | Result triage and prune judge "usefulness for the task" without the task in state; keep-head drops tails where errors live | [verified] `buildResultTriageQuestion` context has no task |
| G7 | P1 | Final-answer check is observe-only; no verify-then-escalate cascade | [verified] `observeFinalAnswer` |
| G8 | P1 | No end-to-end benchmark harness (wall time to turn end, tokens, $, cache hits) | [verified] |
| G9 | P1 | Telemetry lacks batch diagnostics (state bytes, batch size, late/deadline misses) | [verified] `System1Trace` fields |
| G10 | P1 | No client-side rate limiter for 1,200 req/min | [external] vendor limits; [verified] no limiter |
| G11 | P1 | Speculative inbox triage spends budget before the turn counter resets | [verified] `trackTurn` resets after inbox spend |
| G12 | P1 | Bounded STOP ends the turn silently | [verified] agent-loop: "A rejected decision … opens no step" |
| G13 | P1 | Routing asks "how much reasoning", not "can a fast model do this" | [inferred] question/decision mismatch |
| G14 | P1 | Strategy-hint text never A/B tested; "at most four steps" may cut long tasks short | [inferred] |
| G15 | P2 | Batch size not capped; accuracy reportedly drops beyond ~20–25 items per request | [external] pg-jev docs |
| G16 | P2 | Calibration label import + replay join missing | [verified] README "Deferred Work" |
| G17 | P2 | README / PR description stale; async mode undocumented | [verified] |
| G18 | P2 | Data-egress controls: only built-in redaction patterns | [verified] `redact.ts` |

---

## 3. Specifications

Each item: goal, chosen design (with rejected alternatives), implementation
steps, acceptance criteria.

### G1 — Configure `modelRoute` for DeepSeek (P0)

**Goal.** Make routing actually change the model/effort.

**Facts [verified].** Provider id `deepseek-official`; model ids
`deepseek-flash`, `deepseek-v4-pro`; `reasoningEffort` ∈ `off | low | high | max`
(`packages/llm/llm-deepseek/src/config.ts`, `model-info.ts`). With thinking
disabled at the connection, only `off` is accepted (config.ts:219).

**Tree.**
- A: route trivial down only (Flash, effort `off`). Lowest risk. **Chosen first.**
- B: route complex up (Pro, `high`). Raises cost and quality; enable only after
  G2/G8 show a net win.
- C: route everything by triage. Rejected until G13 lands (triage is not a
  routing question).

**Config (start here; tune after G8):**

```yaml
- name: '@deepseek-ai/dsh-experimental-system1'
  config:
    backend: jev
    mode: enforce
    actuation: async
    jevModel: jev-1.13.0
    modelRoute:
      trivial:  { model: deepseek-flash, reasoningEffort: 'off' }
      # enable after G2/G8 evidence:
      # complex: { model: deepseek-v4-pro, reasoningEffort: high }
    thresholds:
      triage: 0.9          # downgrade only on high confidence
```

**Acceptance.** A trivial prompt in a live run logs
`system1: routing agent … to deepseek-official/deepseek-flash (triage: trivial)`;
the request's `LlmCallConfig` shows the override; a later step in the same
turn keeps it (sticky).

---

### G2 — Live quality evaluation (P0)

**Goal.** Know, per question kind, whether Jev's answers are right and its
confidences calibrated, before letting any of them act.

**Implemented in 0002:** `packages/experimental/system1/scripts/jev-eval.ts`.
It calls the production question builders through `JevBackend`, reports per
kind: coverage, accuracy on answered cases, ECE, p50/p95; plus a latency
probe (cold first call, warm by batch size 1/2/4/8). Exit code 1 if any kind
misses the gate. Dry-run against a stub succeeded here; live Jev and
DeepSeek hosts are blocked from this sandbox.

**Run (locally, key in env, never in chat or git):**

```sh
export TYPESAFE_API_KEY=...
pnpm exec tsx packages/experimental/system1/scripts/jev-eval.ts --repeat 3 --concurrency 4 --json .artifacts/jev-eval.json
```

**Muse tasks.**
1. Grow golden cases to 30–50 per kind. Source them from real
   `system1/decision` traces (shadow runs) and label them by hand. Keep
   labels in `packages/experimental/system1/eval/golden.jsonl`
   (`{kind, name, input, expect}`) and have the script load them.
2. Add a `--thresholds` sweep: for each kind, print accuracy/coverage at
   thresholds 0.6–0.95 and recommend the lowest threshold meeting
   accuracy ≥ 0.9 for actuating kinds (tool-choice, triage-downgrade,
   result-triage drop) and ≥ 0.8 for advisory kinds.
3. Write the chosen thresholds into `thresholds` config and the README.

**Gate (per kind).** accuracy ≥ 0.80 answered (≥ 0.90 for kinds that deny,
drop, or downgrade), ECE ≤ 0.15, p95 ≤ 800 ms. A kind that fails stays in
`shadow` for that kind (see G2b).

**G2b — per-kind enable switch.** Add `enforceKinds: string[]` (default: all
kinds). A kind not listed is judged and traced but never actuates. This lets
failing kinds stay observational without turning the plugin off.

---

### G3 — Persistence: make `system1` guidance messages format-safe (P0)

**Problem [verified].** Guidance messages are model-visible user messages
with `source: { kind: 'system1' }`. The persistence check reports
`finalized-format-changed` because the new source kind is not acknowledged.
Sessions containing them may be unreadable by stock builds.

**Tree.**
- A: reuse an existing source kind. Rejected: loses attribution in telemetry
  and UI.
- B: follow the established pattern used by `repeat-tool-reminder`
  (`packages/guard/repeat-tool-reminder/src/index.ts:14-18`): declare the
  kind with `ContextFormed`, stamp `form: 'notice'` and a `summary`, and
  record the change through the persistence tooling. **Chosen.**

**Steps.**
1. In `src/types.ts`, change the declaration to:
   ```ts
   import type { ContextFormed } from '@deepseek-ai/dsh-llm'  // same import repeat-tool-reminder uses
   declare module '@deepseek-ai/dsh-llm' {
     interface MessageSourceMap {
       system1: { kind: 'system1' } & ContextFormed
     }
   }
   ```
2. In `guidance()` (`src/index.ts`), stamp
   `source: { kind: 'system1', form: 'notice', summary: <hint label> }`
   (label: `triage:complex`, `loop-check`, `retry`, …).
3. Follow `docs/cookbook/reviewing-persistence-type-changes.md`:
   ```sh
   pnpm --silent run verify-persistence-changes --json      # inspect
   pnpm --silent run persistence-changes --record 2026-09-xx-system1-guidance-source \
     --prose .artifacts/persistence-change.prose.json --json
   pnpm run verify-persistence-changes
   ```
   The prose file needs `en` and `zh` `summary` / `compatibility` /
   `verification`. If the tool infers a required version bump, follow
   `docs/cookbook/adding-a-session-format-version.md` first.
4. Update tests that assert `source.kind === 'system1'` if the shape changes.

**Acceptance.** `pnpm run verify-persistence-changes` and
`verify-persistence-catalog` pass; a session log written with system1
guidance reopens in a build without the plugin (extend the existing
foreign-reader proof from your screenshot to include guidance messages, not
only `system1/decision` events).

---

### G4 — Coverage back to 100% per file (P0)

**Measured here** (v8, system1 suite only): `index.ts` 89.9% statements,
80.1% branches; `board.ts` 93.0%; `policy.ts` 89.8%; `service.ts` 97.1%;
`jev.ts` 94.4%. The repo gate is 100% per file.

**Tests to add (async path):**
- `actStep`: preselect await; STOP inside async; delegation hint when team
  tools seen; late turn judgment (status `late`) then adoption at request;
  escalation with no verdict (route stays null).
- `actToolCall`: deterministic loop branch with cached delegation advisory;
  spawn with cached scores; late result-triage path that later yields an
  error hint; accept with `additionalContexts` + replacement.
- `interpretPosted`: every kind branch including `partial`, `fails`,
  injection below threshold, three-score delegation composite.
- `JudgmentBoard`: `isSettled`, `ageMs`, `delete`.
- `policy.ts`: capacity eviction branches of `RouteLedger`, `HintLedger`,
  `PendingQueue`.
- `service.ts`: probe-in-flight branch; dropped-question refund.
- `jev.ts`: `warm()` with missing key and with a fetch that throws;
  `jevScopeInstructions: false`.

Use `/* v8 ignore next -- reason */` only for defensive code the repo
already treats that way; do not ignore reachable logic.

**Acceptance.** `pnpm exec vitest run --coverage` passes the per-file gate
for all changed files.

---

### G5 — Lint and repo-wide build (P0)

```sh
pnpm install
pnpm exec oxlint packages/experimental/system1
pnpm run build:lib:host
pnpm exec vitest run packages/experimental/system1
```

Fix findings in place. Expected hot spots: `noUnusedLocals` on helper
types, sonarjs cognitive-complexity on `actToolCall` (split the
large-result branch into `triageLargeResult()`), and non-null assertions
in tests.

---

### G6 — Give result triage the task; keep the tail (P1)

**Problem [verified].** `buildResultTriageQuestion` and `buildPruneQuestion`
ask whether a result is useful "for the agent's ongoing task", but the state
contains only `toolName`, `resultPreview`, `resultChars`. Jev cannot know the
task, so a drop verdict is a guess. Separately, `noisy_keep_head` keeps the
opening; test runners and compilers print the decisive failure at the end.

**Design.**
1. Add `taskPreview` (≤ 800 chars) to both builders' context. Source: the
   turn's first user message, already captured by `noteStepState` into
   `stepPreviews` (async mode keeps the last non-empty preview).
2. Send a head+tail preview: first 1,500 chars + last 1,500 chars, with a
   `…[N chars omitted]…` marker, instead of the first 3,000.
3. Replace `noisy_keep_head` with `noisy_keep_edges` in the options and in
   the replacement logic: keep `triageHeadChars` from the start and
   `triageTailChars` (new, default 1,500) from the end.
4. Deterministic guard before asking Jev: if the tail matches
   `/(FAIL|Error|error:|Traceback|panic|✗|×)/`, never drop — skip the
   question and keep the result.

**Acceptance.** New golden cases in G2 (`result/tail-error`,
`result/noise`, `result/irrelevant-for-task`) pass; a unit test proves a
tail error is never dropped.

---

### G7 — Verify-then-escalate cascade (P1)

**Why.** Downgrading to Flash is where the money is, but a wrong downgrade
costs quality. The standard fix is a cascade: the cheap model answers, a
verifier checks, only failures escalate. TypeSafe publishes this pattern as
a "Jev-verified cascade" [external]. It makes aggressive downgrades safe.

**Design.**
- At `agent/turn-stopping` (serial), when the turn was routed down
  (`routes.get(agent, turn).verdict === 'trivial'` and a `trivial` route
  override exists), run `buildFinalAnswerQuestion(request, answer)` with a
  bounded wait (`verifyDeadlineMs`, default 800).
- If the verdict is `inadequate` with confidence ≥ `thresholds['final-answer']`
  (default 0.85) and this turn has not escalated before:
  1. `routes.offer(agent, turn, 'complex', traceId)` — forces an upgrade.
  2. `agent.steer(guidance('[System 1 verify] The previous answer does not
     fully address the request. Re-answer carefully.'))` — the machine runs
     one more step, now on the upgraded route.
- Bound: one escalation per turn (`HintLedger` key `verify-escalate`).
- Non-trivial turns: keep observe-only.

**Tree.** Rejected: verifying every turn (latency on every turn end);
rejected: verifying with DeepSeek (cost of a second LLM call).

**Acceptance.** Composition test: trivial route + `inadequate` verdict →
exactly one steer, next request uses the `complex` route; `adequate` →
no steer; late verdict → no steer.

---

### G8 — End-to-end benchmark harness (P1)

**Goal.** Decide with numbers whether Jev improves latency, cost, and
quality. The earlier shadow benchmark (n=3, one 3-step task) could not show
a gain by construction.

**Design: three tiers.**

| Tier | LLM | Jev | Purpose | Where |
|---|---|---|---|---|
| T1 | scripted (`dsh-llm-replay` / mock server) | stub | deterministic regression of actuation logic | CI |
| T2 | scripted with a fixed latency profile | **live** | pure System 1 overhead and judgment quality per scenario | local, key in env |
| T3 | **live DeepSeek** | **live** | real latency, tokens, $, cache hits, success | local, keys in env |

**Conditions (paired, same task and seed):**
`baseline` (plugin off) · `shadow` · `enforce+blocking` · `enforce+async`.

**Suites (n ≥ 20 per cell):**

| Suite | Content | Where Jev can win |
|---|---|---|
| S1 | trivial questions on a Pro-thinking default | routing down (G1, G7) |
| S2 | injected failing tool (same error repeated) | loop nudge / STOP |
| S3 | multi-file edit, 10+ steps | escalation, retry advice |
| S4 | large noisy tool outputs (logs, installs) | result triage (G6) |
| S5 | your current 3-step task | control: overhead only |

**Metrics.** Wall time measured to `agent/turn-stopping` (not process exit);
DeepSeek input/output tokens and cache-hit ratio (from `ctx.tokenMeter` /
provider usage); $ per task at DeepSeek list prices; task success (scripted
checks per task); Jev calls, p50/p95 latency, timeouts, `late` count.

**Statistics.** Report medians and p95, not means. Wilcoxon signed-rank on
paired time and $; McNemar on success.

**Go/no-go for `enforce+async` as the default.** S1 $ −30% or better, S2
steps −30% or better, S5 median overhead ≤ 0.25 s, success non-inferior
(−2 pp margin) on every suite.

**Implementation.** `benchmarks/system1/` with a runner that boots the
headless profile programmatically (or drives the Python SDK
`python/sdk/examples/minimal.py` per task with isolated workspace and
`--dsh-home`), writes one JSONL row per run, and a `report.ts` that prints
the table above.

---

### G9 — Batch diagnostics in telemetry (P1)

**Why.** Your shadow run measured a bimodal Jev latency (clusters near
0.2–0.8 s and 1.7–2.7 s, mean 1.66 s) [measured]; vendor-reported latency is
70–500 ms [external]. Without batch-level fields you cannot tell whether the
slow cluster is batch size, state size, cold connections, concurrency, or
region.

**Add to `System1Trace` (and the `system1/decision` payload):**
`batchId`, `batchSize`, `stateBytes`, `sharedState` (flat vs namespaced),
`connWarm` (first call after warm-up?), `concurrentBatches` (in flight at
send), and a `late: boolean` + `deadlineMs` when a consumer's `take`
missed its deadline (record via a new `service.markLate(traceId)`).

**Acceptance.** `jev-eval.ts` and T2 runs can group latency by each field;
the doc gets a one-paragraph diagnosis of the slow cluster.

---

### G10 — Client-side rate limiting (P1)

**Facts [external].** 1,200 requests/min and 250,000 tokens/s per key,
subject to change during early access.

**Design.** Token bucket in `JevBackend.decideMany` (requests/min and
estimated tokens/s from `JSON.stringify(state).length / 4`). When the
bucket is empty, fail fast with a transient error (the service already
treats `transient` as pacing, not breaker failure). Config:
`jevRequestsPerMinute` (default 1,000), `jevTokensPerSecond` (default
200,000).

**Acceptance.** Unit test: 1,001st request in a minute resolves as a
transient fallback without a network call.

---

### G11 — Budget accounting for speculative triage (P1)

**Problem [verified].** `judgeTurn` from `agent/inbox/inserted` spends from
the turn counter before `trackTurn` sees the new turn and calls
`resetTurn`, which then wipes that spend. Result: speculative questions are
free, and per-turn budgets are slightly wrong.

**Fix.** Spend inbox speculation against the *task* budget only
(`scope: 'task'`), and in `trackTurn` do not reset the turn counter when
the new turn's first step adopts a speculative slot; or simpler, have
`askMany` accept `{ scope, countTurn: false }`. Add a test that the turn
budget after step 1 equals the questions actually asked in that turn.

---

### G12 — Bounded STOP must tell the user (P1)

**Problem [verified].** Pre-step `reject` opens no step, so the turn ends
without any message.

**Design (Chosen: "stop step").** Instead of `reject`:
1. Enter the step with guidance: `[System 1 stop] You have repeated
   "<tool>" N times without progress. Do not call tools. Tell the user what
   you tried, what failed, and what you need from them.`
2. Set a per-agent `stopStep` flag for this step; `actToolChoice` (and the
   blocking path) deny every tool call while it is set, with the same reason.
3. Clear the flag at the next pre-step or turn end.

Rejected: silent reject (current); rejected: steering without a tool deny
(the model may keep looping).

**Acceptance.** Composition test: 5-streak + stuck p ≥ 0.9 → one step
entered with the stop guidance; any tool call in that step is denied; the
turn then ends normally with an assistant message.

---

### G13 — A real routing question (P1)

**Problem [inferred].** Routing reuses triage ("how much reasoning does
this step need?"). The routing decision is different: "will a fast,
non-thinking model answer this correctly on the first try?"

**Design.** New kind `route` (noul): *"A fast model without extended
reasoning will answer this request correctly on the first try."* Asked in
the same speculative batch as triage (no extra round-trip; shared state →
flat). Downgrade only when `route ≥ 0.85` **and** triage is `trivial`.
Triage keeps driving the strategy hint.

**Acceptance.** G2 golden set gets `route/*` cases; S1 in G8 shows fewer
wrong downgrades than triage-only routing.

---

### G14 — A/B the strategy hint itself (P1)

**Problem [inferred].** The hints are prescriptive ("at most four steps",
"single short step"). If they are wrong, they cost quality on exactly the
tasks where the model needs room.

**Design.** Config `strategyHints: 'on' | 'off'` (default `on`) and add it
as an ablation axis in G8. Soften the `standard` hint: drop the hard
"at most four steps" cap; keep "one hypothesis, verify with evidence".

**Acceptance.** G8 reports success and steps with hints on vs off; keep
whichever is non-inferior on success and better on steps/$.

---

### G15 — Cap questions per request (P2)

**Fact [external].** A PostgreSQL integration reports measurably lower
accuracy above ~20–25 items per Jev request.

**Design.** `maxQuestionsPerBatch` (default 12) in `JevBackend.decideMany`:
split larger batches into parallel requests and merge results in order.

---

### G16 — Calibration loop (P2)

Implement the deferred pieces named in the README:
`scripts/system1-calibrate.ts` reads session JSONL, extracts
`system1/decision` events, joins a labels CSV (`traceId,label`), and prints
`summarizeCalibration` + `calibrationVerdict` per kind and per `model`.
Re-run on every Jev or DeepSeek model change.

---

### G17 — Docs (P2)

Update `packages/experimental/system1/README.md`: document `actuation`,
all deadline keys, `riskyTools`, `criticalReserve`, `jevScopeInstructions`,
`warmup`, the DeepSeek `modelRoute` example (G1), and the blocking-point
table from §0.1. Update the PR description (it still says `jev-latest`,
50 tests, enforce deferred).

---

### G18 — Data egress (P2)

Every Jev call sends previews of user text, tool arguments, and tool output
to a US-hosted third party. Add `redactPatterns: string[]` (extra regexes)
and `egressKinds: string[]` (kinds allowed to send tool output). Document
the retention/ZDR status you have confirmed with the vendor.

---

## 4. Chain: dependency order

```
G5 lint/build ─┐
G4 coverage ───┼─► upstreamable PR
G3 persistence ┘
G2 live eval ──► G2b per-kind enable ──► G1 routing (trivial-down only)
G6 task-aware triage ──► G2 golden cases for result-triage
G13 route question ──┐
G7 verify cascade ───┼─► safe aggressive downgrade ──► G8 benchmark (S1)
G1 routing ──────────┘
G9 diagnostics ──► explains Jev latency ──► tune deadlines
G12 STOP UX, G11 budget, G10 limiter ──► independent, any time
G8 benchmark ──► decide default: enforce+async on/off per kind
```

Reasoning: nothing should actuate in production before G2 says the kind is
right (G2b). Downgrades are the main saving, but are only safe with G13
(right question) and G7 (catch the misses). Only G8 can show the net effect;
G9 makes G8's latency numbers explainable.

---

## 5. Suggested PR sequence for Muse

1. **PR-A (unblock):** G5, G4, G3, G17.
2. **PR-B (quality):** G2 golden set + threshold sweep, G2b, G6.
3. **PR-C (efficiency):** G13, G7, G1 config docs, G14 switch.
4. **PR-D (measurement):** G9, G8 harness and report.
5. **PR-E (hardening):** G12, G11, G10, G15, G16, G18.

Each PR: `pnpm exec vitest run packages/experimental/system1 --coverage`,
oxlint clean, `build:lib:host` clean, persistence checks clean.

---

## 6. Runbook: live dry run and benchmark (for the human)

Never paste keys into chats or commit them. Use your shell environment.

```sh
# 1. Quality + latency of Jev alone (2–3 minutes)
export TYPESAFE_API_KEY=...
pnpm exec tsx packages/experimental/system1/scripts/jev-eval.ts --repeat 3 --json .artifacts/jev-eval.json

# 2. Shadow traces on real work (collect G2 golden cases)
#    mode: shadow, run your normal tasks for a day, export session logs.

# 3. Enforce A/B (after PR-B, PR-C)
export DEEPSEEK_API_KEY=...
#    run benchmarks/system1 (G8) for baseline / shadow / enforce+blocking / enforce+async
```

Share `.artifacts/jev-eval.json` and the G8 report (no keys, no raw
prompts if sensitive) for review.
