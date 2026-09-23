/**
 * System 1 fast-thinking plugin for the DeepSeek Harness agent loop.
 *
 * Jev (TypeSafe's System One model) answers typed questions about agent-loop
 * traffic — step triage, tool-loop detection, retry judgment — so the
 * harness can skip, shorten, or supervise work without a full
 * reasoning-model call. Questions are expressed in Jev's native primitives
 * (`choice`, `score`, `noul`) and each decision point sends all of its
 * questions in a single `POST /v1/systemone` call; Jev evaluates them in
 * parallel, so a batch costs barely more time than one question.
 *
 * This integration runs shadow-first: every gate is evaluated against real
 * traffic and recorded as a structured trace, but the loop's behavior never
 * changes. In `assist` mode the plugin additionally logs loop hints in the
 * style of the repeat-tool reminder. In `enforce` mode the judgments actuate:
 * triage selects a reasoning-strategy hint injected before the step
 * (direct answer, grounded chain, or atom-of-thoughts decomposition);
 * a `tools/pre-execute` tool-choice gate denies a clearly mistaken call
 * before dispatch (judge-before-act) so the agent self-corrects instead of
 * spending a round-trip on a useless call; loop-check injects a nudge when
 * the agent looks stuck; retry-judgment advises the agent on failed tool
 * calls; a hopeless trajectory — long deterministic identical-call streak
 * plus Jev nearly certain the agent is stuck — ends the turn via pre-step
 * `reject` (turn `blocked`) instead of burning more tokens; delegation
 * triage advises the Lead on teammate spawns (orchestrator layer:
 * judge-before-delegate); model routing reuses the cached triage verdict at
 * `agent/request` to switch provider/model/effort per a configured
 * verdict→override table (no extra model call); and request-error judgment
 * owns one bounded retry of a transiently-failed model request so it does
 * not kill the turn. A failure signal (acted-on retry hint or loop
 * nudge) escalates the next step's reasoning one level. Every actuation is
 * bounded (timeouts, budgets, nudge caps) and any failure falls back to
 * existing harness behavior. The final-answer check is observe-only in all
 * modes: the turn is already over at `agent/turn-stopping`, so there is no
 * veto — assist mode warns the operator when the closing answer clearly
 * misses the request.
 *
 * Task boundaries come from the agent lifecycle, not turn numbers: a
 * message inserted into the inbox while the agent is idle (`agent/status`)
 * starts a new task and refreshes per-agent budgets and the loop-nudge
 * allowance, so long-lived agents cannot silently degrade to
 * budget-exhausted fallbacks. Budgets, nudge state, the delegation
 * registry, and triage verdicts are all partitioned per agent.
 *
 * Laya (local sidecar) is currently deferred — see README.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, ReasoningEffortId, type ContentBlock, type LlmCallConfig, type ToolResultMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  PostToolDecision,
  PreToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import type { System1Backend } from './backend.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { JevBackend } from './backends/jev.ts'
import { LayaBackend, type BackendLogger } from './backends/laya.ts'
import { NullBackend } from './backends/null.ts'
import {
  argsKeyOf,
  buildDelegationHint,
  buildDelegationQuestion,
  buildDelegationScoreQuestions,
  buildFinalAnswerQuestion,
  buildInjectionScreenQuestion,
  buildInjectionWarning,
  buildLoopNudge,
  buildLoopQuestion,
  buildPreselectQuestion,
  buildPruneMarker,
  buildPruneQuestion,
  buildRequestRetryQuestion,
  buildResultTriageQuestion,
  buildRetryHint,
  buildRetryQuestion,
  buildStrategyHint,
  buildSubagentAcceptQuestion,
  buildSubagentReworkHint,
  buildToolChoiceQuestion,
  buildToolDenyReason,
  buildTriageQuestion,
  detectLoop,
  extractFinalQa,
  previewMessages,
  previewToolHistory,
  validateDelegation,
  validateDelegationScore,
  validateFinalAnswer,
  validateInjectionScreen,
  validateLoopAnswer,
  validatePreselect,
  validatePrune,
  validateRequestRetry,
  validateResultTriage,
  validateRetry,
  validateSubagentAccept,
  validateToolChoice,
  validateTriage,
  type ObservedToolCall,
} from './gates.ts'
import { System1Service } from './service.ts'
import { JudgmentBoard } from './board.ts'
import {
  compileToolPatterns,
  DEFAULT_RISKY_TOOL_PATTERNS,
  HintLedger,
  isFreshStep,
  isRiskyTool,
  PendingQueue,
  RouteLedger,
} from './policy.ts'
import { appendDecisionActedEvent, appendDecisionEvent } from './telemetry.ts'
import {
  buildDelegationAdvisory,
  buildDuplicateWarning,
  computeDelegationOversight,
  createDelegationState,
  extractSpawnArgs,
  SPAWN_TOOL_NAME,
} from './orchestrator.ts'
import type { DelegationScoreCache, SpawnArgs } from './orchestrator.ts'
import type {
  DelegationWeights,
  ModelRouteOverride,
  ResultTriageVerdict,
  RetryVerdict,
  SubagentAcceptVerdict,
  System1BackendKind,
  System1Decision,
  System1Mode,
  System1Question,
  System1QuestionKind,
  System1RuntimeConfig,
  ToolChoiceVerdict,
  TriageVerdict,
} from './types.ts'

export const name = 'system1'

/** This plugin needs no injected services; it observes waterfall payloads. */
export const inject: readonly string[] = []

/**
 * Plugin configuration. Every tunable is user-overridable; `.default()`
 * guarantees the fields are set after validation, so `apply` reads them
 * directly. No deployment secret lives here: the Jev key is named by
 * `jevApiKeyEnv` (default `TYPESAFE_API_KEY`, the official SDK convention)
 * and read from the environment at call time.
 */
export interface Config {
  /** Master switch; when false the plugin registers nothing. */
  enabled: boolean
  /** Which fast-thinking backend answers System 1 questions. */
  backend: System1BackendKind
  /** Authority over the loop: `shadow` traces, `assist` hints, `enforce` acts (deferred). */
  mode: System1Mode
  /** Minimum confidence for a judgment to pass a gate (0..1). */
  confidenceThreshold: number
  /**
   * Per-question-kind threshold overrides. Thresholds scale with risk, not
   * one global number (TypeSafe's confidence guidance): a cheap reversible
   * hint (retry) gates lower than reasoning-shape advice (triage). A kind
   * not listed falls back to the question's own threshold, then
   * `confidenceThreshold`.
   */
  thresholds: Partial<Record<System1QuestionKind, number>>
  /** Max System 1 questions per agent turn (each question costs tokens). */
  budgetPerTurn: number
  /** Max System 1 questions per agent task. */
  budgetPerTask: number
  /** Per-batch backend timeout in milliseconds. 0 disables the timeout (not recommended for network backends). Jev answers in 70-500ms. */
  timeoutMs: number
  /** Consecutive backend failures before the circuit opens. */
  failureThreshold: number
  /** How long the circuit stays open in milliseconds. */
  cooldownMs: number
  /** Max traces kept in the in-memory ring buffer. */
  traceBufferSize: number
  /** Environment variable holding the Jev API key (the key itself is never stored). */
  jevApiKeyEnv: string
  /** Jev System One endpoint URL. */
  jevEndpoint: string
  /**
   * Jev model alias or pinned version. Pinned to `jev-1.13.0` by default:
   * TypeSafe warns aliases move, and the thresholds this plugin ships are
   * tuned against that release. Record the response's versioned model and
   * re-tune on upgrades.
   */
  jevModel: string
  /** Laya sidecar decision endpoint URL (used when `layaAutoStart` is false). */
  layaEndpoint: string
  /** Start a local Laya sidecar on demand instead of using `layaEndpoint`. */
  layaAutoStart: boolean
  /** Command used to start the local Laya sidecar. */
  layaCommand: string[]
  /** Stuck probability at or above which a loop-check triggers a nudge (0..1). */
  loopStuckThreshold: number
  /** Max loop nudges injected per agent task; further stuck episodes only warn. */
  maxLoopNudgesPerTask: number
  /**
   * Stuck probability at or above which a hopeless trajectory ends the turn
   * (0..1). Stricter than `loopStuckThreshold`: the STOP also requires a
   * long deterministic identical-call streak, so this means "Jev is nearly
   * certain the agent is stuck, not polling".
   */
  stopStuckThreshold: number
  /** Relative weights for the delegation composite (novelty/tool-risk/irreversibility); normalized in code. */
  delegationWeights: DelegationWeights
  /**
   * Model routing table: triage verdict to call-config override, applied at
   * `agent/request` in enforce mode. Reuses the pre-step triage verdict, so
   * routing costs no extra model call. Empty by default — model names are
   * deployment-specific, so routing stays inert until wired (e.g. `trivial`
   * to a cheap model, `complex` to a strong one or higher effort).
   */
  modelRoute: Partial<Record<TriageVerdict, ModelRouteOverride>>
  /**
   * Max Jev-owned request retries per agent step (`agent/request-error`).
   * Bounds the retry judgment so a confidently-wrong "transient" verdict
   * cannot loop forever; the adapter's own retry policy is unaffected.
   */
  maxRequestRetries: number
  /**
   * Redact secret-shaped values (keys, tokens, passwords, credentials)
   * from the state sent to the Jev backend. Default true — the harness
   * state can carry API keys and session material the judge never needs.
   */
  redactState: boolean
  /**
   * Start the risk/tool-choice judgment while the tool call is still
   * streaming, so `tools/pre-execute` can reuse it instead of awaiting a
   * fresh Jev round trip. Default true; bounded per-turn cache.
   */
  prefetchToolChoice: boolean
  /**
   * Ask Jev at session start which MCP servers the task plausibly needs and
   * deny the rest with `tools.restrict()`. Default false: the judgment is
   * heuristic, so preselection stays opt-in and fail-open.
   */
  preselect: boolean
  /**
   * Jev need-probability below which a preselected MCP server is denied
   * (0..1). Conservative default: only near-certainly-unneeded servers go.
   */
  preselectDenyThreshold: number
  /**
   * Minimum distinct MCP servers before preselection runs. With fewer
   * servers the restriction buys nothing, so the gate stays inert.
   */
  preselectMinServers: number
  /**
   * Tool-result character size at or above which the post-execute triage
   * gate runs. Smaller results pass through untriaged.
   */
  triageMinChars: number
  /**
   * Characters of a noisy result's head kept when Jev says
   * `noisy_keep_head`. The tail is replaced by a marker citing the
   * shadowed event so replay can recover it.
   */
  triageHeadChars: number
  /** Screen untrusted tool results for prompt injection. Default true. */
  injectionScreen: boolean
  /**
   * Injection probability at or above which an untrusted result is flagged
   * (0..1). High default: only confident detections steer the agent.
   */
  injectionThreshold: number
  /** Check subagent outputs against their delegated task. Default true. */
  subagentAccept: boolean
  /**
   * Pressure-gated pruning of past tool results (compaction). Default
   * false: rewriting history is the riskiest actuation here, so it stays
   * opt-in and only runs under token pressure.
   */
  compactionPrune: boolean
  /**
   * Token-meter pressure at or above which the prune gate runs (0..1).
   * The meter service must be mounted; without it the gate stays inert.
   */
  prunePressureThreshold: number
  /** Tool-result character size at or above which a result is prune-eligible. */
  pruneMinChars: number
  /**
   * Jev still-needed probability below which a prune-eligible result is
   * replaced by a marker (0..1). Conservative: only near-certainly-stale
   * results are rewritten.
   */
  pruneDropThreshold: number
  /** Max history rewrites per agent task; further droppable results only warn. */
  maxPrunePerTask: number
  /**
   * How enforce mode actuates. `async` (default): judgments never block the
   * critical path except where a deadline says so — routing waits at most
   * `routeDeadlineMs`, risky tool calls at most `toolGateDeadlineMs`, large
   * result triage at most `resultTriageDeadlineMs`; loop/retry/injection/
   * subagent judgments are posted and delivered at the next pre-step
   * (before the next model request, so the model sees them at the same
   * point). `blocking`: the original judge-first behavior on every seam.
   */
  actuation: 'async' | 'blocking'
  /** Max wait for the turn's triage verdict before the first request (async). */
  routeDeadlineMs: number
  /** Max wait at pre-step for pending post-execute judgments (async). */
  drainDeadlineMs: number
  /** Max wait for a risky tool call's tool-choice judgment (async). */
  toolGateDeadlineMs: number
  /** Max wait for a large result's triage before the result reaches the model (async). */
  resultTriageDeadlineMs: number
  /** Regex sources (case-insensitive) naming tools worth a blocking tool-choice gate (async). */
  riskyTools: string[]
  /** Extra per-turn/per-task questions reserved for loop-check, request-retry, and retry-judgment. */
  criticalReserve: number
  /** Scope mixed-context Jev batches with per-question state pointers. */
  jevScopeInstructions: boolean
  /** Open the Jev connection at plugin start so the first judgment skips the TLS handshake. */
  warmup: boolean
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  backend: z.union(['laya', 'jev', 'none'] as const).default('jev'),
  mode: z.union(['shadow', 'assist', 'enforce'] as const).default('shadow'),
  confidenceThreshold: z.percent().default(0.7),
  thresholds: z.dict(z.percent()).default({}),
  budgetPerTurn: z.natural().default(8),
  budgetPerTask: z.natural().default(16),
  timeoutMs: z.natural().default(1200),
  failureThreshold: z.natural().min(1).default(3),
  cooldownMs: z.natural().default(30_000),
  traceBufferSize: z.natural().min(1).default(200),
  jevApiKeyEnv: z.string().min(1).default('TYPESAFE_API_KEY'),
  jevEndpoint: z.string().min(1).default('https://api.typesafe.ai/v1/systemone'),
  jevModel: z.string().min(1).default('jev-1.13.0'),
  layaEndpoint: z.string().min(1).default('http://127.0.0.1:17840/decide'),
  layaAutoStart: z.boolean().default(true),
  layaCommand: z.array(z.string()).min(1).default(['python3', '-m', 'laya_serve']),
  loopStuckThreshold: z.percent().default(0.7),
  maxLoopNudgesPerTask: z.natural().default(2),
  stopStuckThreshold: z.percent().default(0.9),
  delegationWeights: z.object({
    novelty: z.number().min(0).default(0.4),
    toolRisk: z.number().min(0).default(0.35),
    irreversibility: z.number().min(0).default(0.25),
  }).default({}),
  modelRoute: z.dict(z.object({
    provider: z.union([z.string().min(1), z.const(undefined)]),
    model: z.union([z.string().min(1), z.const(undefined)]),
    reasoningEffort: z.union([z.string().min(1), z.const(undefined)]),
  })).default({}),
  maxRequestRetries: z.natural().default(1),
  redactState: z.boolean().default(true),
  prefetchToolChoice: z.boolean().default(true),
  preselect: z.boolean().default(false),
  preselectDenyThreshold: z.percent().default(0.15),
  preselectMinServers: z.natural().min(2).default(3),
  triageMinChars: z.natural().default(4000),
  triageHeadChars: z.natural().default(2000),
  injectionScreen: z.boolean().default(true),
  injectionThreshold: z.percent().default(0.8),
  subagentAccept: z.boolean().default(true),
  compactionPrune: z.boolean().default(false),
  prunePressureThreshold: z.percent().default(0.7),
  pruneMinChars: z.natural().default(4000),
  pruneDropThreshold: z.percent().default(0.2),
  maxPrunePerTask: z.natural().default(10),
  actuation: z.union(['async', 'blocking'] as const).default('async'),
  routeDeadlineMs: z.natural().default(250),
  drainDeadlineMs: z.natural().default(300),
  toolGateDeadlineMs: z.natural().default(400),
  resultTriageDeadlineMs: z.natural().default(600),
  riskyTools: z.array(z.string()).default([...DEFAULT_RISKY_TOOL_PATTERNS]),
  criticalReserve: z.natural().default(4),
  jevScopeInstructions: z.boolean().default(true),
  warmup: z.boolean().default(true),
})

type PreStepPayload = Parameters<Events['agent/pre-step']>[0]
type PreStepNext = Parameters<Events['agent/pre-step']>[1]
type PreStepDecision = Awaited<ReturnType<PreStepNext>>
type PreExecuteNext = Parameters<Events['tools/pre-execute']>[1]
type PostExecuteNext = Parameters<Events['tools/post-execute']>[2]
type RequestErrorPayload = Parameters<Events['agent/request-error']>[0]
type RequestErrorNext = Parameters<Events['agent/request-error']>[1]
type RequestErrorAction = Awaited<ReturnType<RequestErrorNext>>
/**
 * The outcome of one tool-choice judgment: a confident wrong-tool verdict
 * with its confidence and trace, or null when the call should proceed.
 * Shared by the synchronous `tools/pre-execute` path and the speculative
 * stream-time prefetch, which produces exactly this shape.
 */
type ToolChoiceOutcome = { verdict: ToolChoiceVerdict; confidence: number; traceId: string } | null

function toRuntimeConfig(config: Config): System1RuntimeConfig {
  return {
    backend: config.backend,
    mode: config.mode,
    enabled: config.enabled,
    confidenceThreshold: config.confidenceThreshold,
    thresholds: config.thresholds,
    budgetPerTurn: config.budgetPerTurn,
    budgetPerTask: config.budgetPerTask,
    timeoutMs: config.timeoutMs,
    failureThreshold: config.failureThreshold,
    cooldownMs: config.cooldownMs,
    traceBufferSize: config.traceBufferSize,
    jevApiKeyEnv: config.jevApiKeyEnv,
    jevEndpoint: config.jevEndpoint,
    jevModel: config.jevModel,
    layaEndpoint: config.layaEndpoint,
    layaAutoStart: config.layaAutoStart,
    layaCommand: config.layaCommand,
    loopStuckThreshold: config.loopStuckThreshold,
    maxLoopNudgesPerTask: config.maxLoopNudgesPerTask,
    stopStuckThreshold: config.stopStuckThreshold,
    delegationWeights: config.delegationWeights,
    modelRoute: config.modelRoute,
    maxRequestRetries: config.maxRequestRetries,
    redactState: config.redactState,
    prefetchToolChoice: config.prefetchToolChoice,
    preselect: config.preselect,
    preselectDenyThreshold: config.preselectDenyThreshold,
    preselectMinServers: config.preselectMinServers,
    triageMinChars: config.triageMinChars,
    triageHeadChars: config.triageHeadChars,
    injectionScreen: config.injectionScreen,
    injectionThreshold: config.injectionThreshold,
    subagentAccept: config.subagentAccept,
    compactionPrune: config.compactionPrune,
    prunePressureThreshold: config.prunePressureThreshold,
    pruneMinChars: config.pruneMinChars,
    pruneDropThreshold: config.pruneDropThreshold,
    maxPrunePerTask: config.maxPrunePerTask,
    criticalReserve: config.criticalReserve,
    jevScopeInstructions: config.jevScopeInstructions,
  }
}

function createBackend(runtime: System1RuntimeConfig, logger: BackendLogger): System1Backend {
  switch (runtime.backend) {
    case 'laya':
      return new LayaBackend(runtime, logger)
    case 'jev':
      return new JevBackend(runtime)
    case 'none':
      return new NullBackend()
  }
}

/** Max distinct agents tracked for loop history and turn state. */
export const MAX_TRACKED_AGENTS = 64

/**
 * Bounded per-agent tracking state for loop detection, turn resets, and
 * loop-nudge budgets. Noting a new agent past `maxAgents` evicts the
 * least-recently-noted agent's history, turn marker, and nudge state, so
 * long-running hosts cannot grow these maps without bound. Exported for tests.
 *
 * @internal
 */
export function createAgentState(maxAgents: number = MAX_TRACKED_AGENTS): {
  /** Loop history per agent; `note` keeps this bounded. */
  readonly histories: Map<string, ObservedToolCall[]>
  /** Last seen turn per agent; `note` eviction keeps this bounded. */
  readonly turns: Map<string, number>
  /** Loop nudges injected this task per agent; reset by `resetTask`. */
  readonly loopNudges: Map<string, number>
  /** Last nudge episode key per agent; suppresses repeat nudges for the same streak. */
  readonly lastNudgeKey: Map<string, string>
  /**
   * Pending failure-signal escalation per agent: set when an injected
   * retry hint or loop nudge reports a failure, consumed once by the next
   * pre-step, which bumps the triage verdict one level. Set/reset here, in
   * one place, so escalation cannot outlive the task or the agent's entry.
   */
  readonly escalations: Map<string, boolean>
  /**
   * Latest triage verdict per agent with its turn/step, so `agent/request`
   * can route the model call without asking again. Stale entries (different
   * turn/step) are ignored; `resetTask` clears them.
   */
  readonly triage: Map<string, { turn: number; step: number; verdict: TriageVerdict; traceId: string }>
  /**
   * Ensure tracking state exists for `agentId`, evicting the oldest agent
   * when over budget. Returns the agent's loop history.
   */
  note(agentId: string): ObservedToolCall[]
  /** Clear per-task nudge state; call when a new agent task starts. */
  resetTask(agentId: string): void
  /** Set a failure-signal escalation for the agent's next step. */
  noteEscalation(agentId: string): void
  /** Consume (and clear) the agent's pending escalation, if any. */
  consumeEscalation(agentId: string): boolean
  /** Record a triage verdict for the agent's current turn/step. */
  noteTriage(agentId: string, turn: number, step: number, verdict: TriageVerdict, traceId: string): void
  /**
   * Read the agent's triage verdict only when it belongs to `turn`/`step`;
   * otherwise null. Never consumes: a retried request for the same step
   * routes the same way.
   */
  takeTriage(agentId: string, turn: number, step: number): { verdict: TriageVerdict; traceId: string } | null
} {
  const histories = new Map<string, ObservedToolCall[]>()
  const turns = new Map<string, number>()
  const loopNudges = new Map<string, number>()
  const lastNudgeKey = new Map<string, string>()
  const escalations = new Map<string, boolean>()
  const triage = new Map<string, { turn: number; step: number; verdict: TriageVerdict; traceId: string }>()
  return {
    histories,
    turns,
    loopNudges,
    lastNudgeKey,
    escalations,
    triage,
    note(agentId: string): ObservedToolCall[] {
      const existing = histories.get(agentId)
      if (existing !== undefined) return existing
      if (histories.size >= Math.max(1, maxAgents)) {
        // Non-empty here: size >= max(1, maxAgents) >= 1, so a key exists.
        const oldest = histories.keys().next().value as string
        histories.delete(oldest)
        turns.delete(oldest)
        loopNudges.delete(oldest)
        lastNudgeKey.delete(oldest)
        escalations.delete(oldest)
        triage.delete(oldest)
      }
      const history: ObservedToolCall[] = []
      histories.set(agentId, history)
      return history
    },
    resetTask(agentId: string): void {
      loopNudges.delete(agentId)
      lastNudgeKey.delete(agentId)
      escalations.delete(agentId)
      triage.delete(agentId)
    },
    noteEscalation(agentId: string): void {
      escalations.set(agentId, true)
    },
    consumeEscalation(agentId: string): boolean {
      const escalated = escalations.get(agentId) === true
      escalations.delete(agentId)
      return escalated
    },
    noteTriage(agentId: string, turn: number, step: number, verdict: TriageVerdict, traceId: string): void {
      triage.set(agentId, { turn, step, verdict, traceId })
    },
    takeTriage(agentId: string, turn: number, step: number): { verdict: TriageVerdict; traceId: string } | null {
      const cached = triage.get(agentId)
      if (cached === undefined || cached.turn !== turn || cached.step !== step) return null
      return { verdict: cached.verdict, traceId: cached.traceId }
    },
  }
}

/**
 * Install System 1 observers on the agent loop.
 *
 * Shadow/assist listeners always delegate first (`next()`) and observe
 * afterwards, so a slow or failing backend can never change or delay loop
 * behavior. Enforce listeners judge first (bounded by the service timeout;
 * the service never rejects) and inject guidance — a triage strategy hint
 * before the step, loop nudges and retry hints after tool calls, delegation
 * advisories after teammate spawns — then delegate. Any fallback resolves
 * to "no injection", so the loop always continues with existing behavior.
 *
 * Shadow observations run on the plugin's own lifetime signal, bounded by
 * the service timeout — not on the step/tool signals handed to the
 * listeners. Those belong to the turn and the tool execution and may be
 * aborted after the waterfall settles while a fire-and-forget observation
 * is still in flight; letting them cancel the observation would poison the
 * circuit breaker with backend-error fallbacks that say nothing about
 * backend health. Enforce judgments use the step/tool signal instead: when
 * the turn is cancelled, its guidance is moot.
 *
 * @param ctx - plugin context that owns the listeners and backend lifetime.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const runtime = toRuntimeConfig(config)
  const backend = createBackend(runtime, ctx.logger)
  const service = new System1Service(backend, runtime)
  const agents = createAgentState()
  const lifetime = new AbortController()
  const enforce = config.mode === 'enforce'
  if (enforce && config.actuation === 'async' && config.warmup && backend.warm !== undefined) {
    /* v8 ignore next -- defensive: warm never rejects */
    void backend.warm(lifetime.signal).catch(() => undefined)
  }
  // Durable telemetry: every trace lands as one `system1/decision` session
  // event on the owning agent's log — including shadow observations and
  // fallbacks, so the log is an unbiased calibration source — and a later
  // `markActed` lands a separate `system1/decision-acted` event keyed by
  // trace id. The in-memory ring is for live debugging, the log is for
  // replay. The listener never throws (the service swallows listener
  // errors) and appends are best-effort, so telemetry can never break the
  // decision path.
  const telemetrySeen = new Set<string>()
  const telemetryActed = new Set<string>()
  const disposeTelemetry = service.onTrace((trace) => {
    const session = agentSessions.get(trace.agentId)
    if (session === undefined) return
    if (!telemetrySeen.has(trace.id)) {
      telemetrySeen.add(trace.id)
      if (trace.acted) telemetryActed.add(trace.id)
      appendDecisionEvent(session, trace)
      return
    }
    if (trace.acted && !telemetryActed.has(trace.id)) {
      telemetryActed.add(trace.id)
      appendDecisionActedEvent(session, trace.id)
    }
  })
  /**
   * Orchestrator-level delegation memory, per agent: recent `spawn_teammate`
   * calls for duplicate-purpose detection. Only consulted for that tool,
   * which exists solely when the agent-team packages are installed —
   * otherwise inert. Per-agent so one Lead's spawns never warn another's.
   */
  const delegations = new Map<string, ReturnType<typeof createDelegationState>>()
  /**
   * Agents that have shown team tooling (`spawn_teammate` observed). The
   * pre-step delegation hint only fires for those agents, so agents without
   * teammates never see delegation noise. Per-agent, not session-global.
   */
  const teamToolsSeen = new Set<string>()
  /**
   * Jev-owned request retries per agent/turn/step (`agent/request-error`).
   * Bounds the retry judgment so a confidently-wrong "transient" verdict
   * cannot loop forever; the adapter's own retry policy is unaffected.
   */
  const requestRetries = new Map<string, number>()
  /**
   * Last pre-execute call per agent (`name` + args key). The tool-choice
   * gate skips exact consecutive duplicates — the loop machinery owns
   * repetition, and re-asking about an identical back-to-back call spends
   * budget for no new information.
   */
  const lastPreExecute = new Map<string, { name: string; argsKey: string }>()
  /**
   * Compact preview of the current step's incoming messages per agent, for
   * the tool-choice question's goal context. One short string per agent.
   */
  const stepPreviews = new Map<string, string>()
  /**
   * Session message count at each turn's first pre-step, keyed
   * `${agentId}:${turn}`. The final-answer check slices the turn's messages
   * from this offset. Entries are consumed at `agent/turn-stopping`.
   */
  const turnStarts = new Map<string, number>()
  /**
   * Agent sessions for durable telemetry: `system1/decision` events are
   * appended to the acting agent's log. Updated on every pre-step and
   * tool execution; bounded like the other per-agent maps.
   */
  const agentSessions = new Map<string, Session>()
  /**
   * In-flight speculative tool-choice judgments per agent, keyed by the
   * streaming tool-call id. Started on `agent/assistant-stream`
   * tool-call-delta chunks in enforce mode; consumed (not re-asked) by
   * `tools/pre-execute`. Bounded per agent; stale entries are dropped at
   * turn end.
   */
  const prefetches = new Map<string, Map<string, { toolName: string; promise: Promise<ToolChoiceOutcome> }>>()
  /**
   * Active preselect restriction disposers per agent. A new task lifts the
   * previous task's restriction before judging the new one, so a denied
   * server from an old task can never shadow a new task that needs it.
   */
  const preselectDisposers = new Map<string, () => void>()
  /**
   * In-flight preselect judgments per agent, started at inbox insert (the
   * task's first message) so the Jev round-trip overlaps the wake; the
   * first pre-step awaits it before the request is built.
   */
  const preselectTasks = new Map<string, Promise<void>>()
  /**
   * History rewrites per agent task (pressure-gated prune). Reset with the
   * other per-task state; further droppable results only warn.
   */
  const pruneCounts = new Map<string, number>()
  /**
   * Surface seqs already prune-judged this task per agent. A pressure spike
   * spans many steps; without this the same large results would be
   * re-asked every step for no new information.
   */
  const pruneJudged = new Map<string, Set<number>>()
  /**
   * Tool name by call id per agent, for naming prune candidates found by
   * scanning the session surface. The session itself is the source of the
   * result text; this map only recovers the name the `tool/result` event
   * does not carry.
   */
  const resultToolNames = new Map<string, Map<string, string>>()

  /** Remember a tool name for a later prune-candidate scan. */
  function noteResultToolName(agentId: string, callId: string, toolName: string): void {
    let names = resultToolNames.get(agentId)
    if (names === undefined) {
      names = new Map()
      resultToolNames.set(agentId, names)
      capMap(resultToolNames, MAX_TRACKED_AGENTS)
    }
    names.set(callId, toolName)
    capMap(names, 64)
  }

  /**
   * Current context pressure as a ratio (0..1+), or null when it cannot be
   * measured. The token count comes from the optional token-meter service
   * (`ctx.get`, absent when not mounted); capacity is the session's latest
   * advertised context window. Null reads as "no pressure" — the prune
   * judgment stays inert rather than guessing.
   */
  function contextPressure(agent: { session?: Session }): number | null {
    /* v8 ignore next -- defensive: maybePruneHistory guards session before calling */
    if (agent.session === undefined) return null
    let meter: { measure: (session: Session) => { totalTokens: number } } | undefined
    try {
      meter = ctx.get('tokenMeter') as
        | { measure: (session: Session) => { totalTokens: number } }
        | undefined
    } catch {
      return null
    }
    if (meter === undefined) return null
    let totalTokens: number
    try {
      totalTokens = meter.measure(agent.session).totalTokens
    } catch {
      return null
    }
    const contextWindow = agent.session.requestContext()?.contextWindow
    if (contextWindow === undefined || contextWindow <= 0) return null
    return totalTokens / contextWindow
  }

  /** A large tool result on the session surface, eligible for a prune judgment. */
  interface PruneCandidate {
    seq: number
    event: Extract<SessionEvent, { type: 'tool/result' }>
    toolName: string
    text: string
  }

  /**
   * Large tool results on the session surface, oldest first, bounded to a
   * handful per pass so one pressure spike cannot spend the whole task
   * budget. Never throws; a session that cannot be scanned yields nothing.
   */
  function findPruneCandidates(agentId: string, session: Session): PruneCandidate[] {
    const candidates: PruneCandidate[] = []
    const names = resultToolNames.get(agentId)
    try {
      for (const seq of session.surface.nodes) {
        // oxlint-disable-next-line typescript/no-deprecated -- same existing-history read as the tool-result pruner.
        const event = session.eventAt(seq)
        if (event?.type !== 'tool/result') continue
        // Same direct cast the tool-result pruner uses: a tool/result event
        // derives a tool-role message carrying the call id.
        const message = session.deriveEventMessage(event) as ToolResultMessage | null
        if (message === null) continue
        const text = extractResultText(message.content)
        if (text.length < config.pruneMinChars) continue
        const toolName = names?.get(message.toolCallId) || 'unknown-tool'
        candidates.push({ seq, event, toolName, text })
        if (candidates.length >= 5) break
      }
    } catch {
      return []
    }
    return candidates
  }

  /**
   * Pressure-gated history prune: when context pressure is high, ask Jev
   * which large tool results are safe to drop. A confident drop on any
   * candidate gates one pass of the existing tool-result pruner service,
   * which owns the replay-safe rewrite protocol (Jev gates WHETHER to
   * prune; the pruner owns WHAT and HOW). Enforce actuates; assist warns;
   * shadow only traces. Bounded per task (`maxPrunePerTask`); never
   * rejects, never throws — without the pruner mounted the pass is
   * skipped, not reimplemented.
   */
  async function maybePruneHistory(
    agent: { id: string; session?: Session },
    signal: AbortSignal,
  ): Promise<void> {
    if (!enforce || !config.compactionPrune) return
    const agentId = agent.id
    if (agent.session === undefined) return
    if ((pruneCounts.get(agentId) ?? 0) >= config.maxPrunePerTask) return
    const pressure = contextPressure(agent)
    if (pressure === null || pressure < config.prunePressureThreshold) return
    const candidates = findPruneCandidates(agentId, agent.session)
      .filter(candidate => !pruneJudged.get(agentId)?.has(candidate.seq))
    if (candidates.length === 0) return
    const judged = pruneJudged.get(agentId) ?? new Set<number>()
    for (const candidate of candidates) judged.add(candidate.seq)
    pruneJudged.set(agentId, judged)
    capMap(pruneJudged, 128)
    const questions = candidates.map(candidate =>
      buildPruneQuestion(candidate.toolName, candidate.text.slice(0, config.pruneMinChars)),
    )
    const decisions = await service.askMany(
      questions,
      questions.map(() => validatePrune),
      'task',
      signal,
      agentId,
    )
    // The prune question asks "still needed?": a confident drop means Jev
    // believes the result is NOT needed (p at or below the drop bar).
    // Anything else — including fallbacks — keeps the results untouched.
    const drops = decisions.filter(decision => typeof decision.value === 'number' && decision.value <= config.pruneDropThreshold)
    if (drops.length === 0) return
    const pruner = ctx.get('toolResultPruner') as { pruneSession(session: Session): unknown } | undefined
    if (pruner === undefined) {
      ctx.logger.warn('system1: prune gated by Jev but the tool-result pruner is not mounted; skipping')
      return
    }
    for (const drop of drops) service.markActed(drop.trace.id)
    pruner.pruneSession(agent.session)
    pruneCounts.set(agentId, (pruneCounts.get(agentId) ?? 0) + 1)
    capMap(pruneCounts, 128)
    ctx.logger.warn(
      `system1: pruned tool results under pressure ${pressure.toFixed(2)} (${drops.length} Jev-confirmed droppable)`,
    )
  }

  /** Cap a map at `cap` entries, evicting the oldest first. */
  function capMap(map: Map<string, unknown>, cap: number): void {
    while (map.size > cap) {
      const oldest = map.keys().next().value
      /* v8 ignore next -- defensive: a non-empty map always has a first key */
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  /** Remember the agent's session for durable decision telemetry. */
  function trackSession(agent: { id: string; session?: Session }): void {
    if (agent.session === undefined) return
    agentSessions.set(agent.id, agent.session)
    capMap(agentSessions, 128)
  }

  /**
   * Track the agent's turn; a new agent or a turn-number reset starts a new
   * task, which refreshes budgets and the loop-nudge allowance. Budgets are
   * partitioned per agent inside the service.
   */
  function trackTurn(agentId: string, turn: number): void {
    agents.note(agentId)
    const prev = agents.turns.get(agentId)
    agents.turns.set(agentId, turn)
    if (prev !== undefined && turn < prev) {
      service.resetTask(agentId)
      agents.resetTask(agentId)
    } else if (turn !== prev) {
      service.resetTurn(agentId)
    }
  }

  /** The delegation registry for one agent, created lazily and bounded. */
  function delegationStateFor(agentId: string): ReturnType<typeof createDelegationState> {
    const existing = delegations.get(agentId)
    if (existing !== undefined) return existing
    if (delegations.size >= MAX_TRACKED_AGENTS) {
      const oldest = delegations.keys().next().value
      /* v8 ignore next -- defensive: a non-empty map always has a first key */
      if (oldest !== undefined) delegations.delete(oldest)
    }
    const state = createDelegationState()
    delegations.set(agentId, state)
    return state
  }

  /**
   * Last seen `agent/status` per agent. Drives the inbox task-boundary
   * reset: a message inserted while the agent is idle starts a new task.
   * Unknown agents read as idle — the reset is idempotent, and a missed
   * reset (the B1 bug: permanent budget exhaustion) is worse than an early
   * one. Insertions fire before the wake, so the insert still sees `idle`.
   */
  const agentStatus = new Map<string, 'idle' | 'running'>()

  /**
   * Task-boundary reset: a message inserted while the agent is idle starts
   * a new task, which refreshes budgets and the loop-nudge allowance. The
   * turn-number heuristic in `trackTurn` cannot see this — turn numbers
   * only increase within a session — so without this reset a long-lived
   * agent silently degrades to budget-exhausted fallbacks after its first
   * task. Inserts while running are steering, not new tasks.
   */
  function resetTaskOnFreshUserMessage(agentId: string): boolean {
    if (agentStatus.get(agentId) === 'running') return false
    service.resetTask(agentId)
    agents.resetTask(agentId)
    pruneCounts.delete(agentId)
    pruneJudged.delete(agentId)
    return true
  }

  /**
   * Group tool schemas by MCP server. MCP tools are named
   * `mcp__<server>__<tool>`; anything else (built-in tools) is left
   * untouched by preselection. Returns server → {toolNames, descriptions}.
   */
  function groupMcpServers(
    schemas: ReadonlyArray<{ name?: unknown; description?: unknown }>,
  ): Map<string, { toolNames: string[]; descriptions: string[] }> {
    const servers = new Map<string, { toolNames: string[]; descriptions: string[] }>()
    for (const schema of schemas) {
      if (typeof schema.name !== 'string' || !schema.name.startsWith('mcp__')) continue
      const rest = schema.name.slice('mcp__'.length)
      const sep = rest.indexOf('__')
      if (sep <= 0) continue
      const server = rest.slice(0, sep)
      let entry = servers.get(server)
      if (entry === undefined) {
        entry = { toolNames: [], descriptions: [] }
        servers.set(server, entry)
      }
      entry.toolNames.push(schema.name)
      entry.descriptions.push(
        `${schema.name}: ${typeof schema.description === 'string' ? schema.description : ''}`.slice(0, 160),
      )
    }
    return servers
  }

  /**
   * Session-start tool preselection (opt-in, enforce only): ask Jev once
   * per task which MCP servers the task plausibly needs, and deny the
   * confidently-unneeded ones with `tools.restrict()`. Lifts the previous
   * task's restriction first, so a denied server from an old task can
   * never shadow a new task that needs it. Fail-open throughout: any
   * doubt leaves the tool list untouched. Never rejects.
   *
   * @param agent - the agent whose tool list is judged.
   * @param requestText - the task's first user message, untrusted data.
   */
  /** Minimal structural view of an agent needed for tool preselection. */
  interface PreselectAgent {
    id: string
    ctx: {
      tools: {
        schemas: () => Array<{ name?: unknown; description?: unknown }>
        restrict: (filter: { deny: string[] }) => () => void
      }
    }
  }

  async function runPreselect(
    agent: PreselectAgent,
    requestText: string,
  ): Promise<void> {
    const agentId = agent.id
    const previous = preselectDisposers.get(agentId)
    if (previous !== undefined) {
      preselectDisposers.delete(agentId)
      try {
        previous()
      } catch {
        // A stale disposer must not break the new task's judgment.
      }
    }
    let servers: Map<string, { toolNames: string[]; descriptions: string[] }>
    try {
      servers = groupMcpServers(agent.ctx.tools.schemas())
    } catch {
      return
    }
    if (servers.size < config.preselectMinServers) return
    const entries = [...servers.entries()]
    const questions = entries.map(([server, info]) =>
      buildPreselectQuestion(server, info.descriptions, requestText),
    )
    const decisions = await service.askMany(
      questions,
      questions.map(() => validatePreselect),
      'task',
      lifetime.signal,
      agentId,
    )
    const deny: string[] = []
    const actedTraces: string[] = []
    decisions.forEach((decision, index) => {
      const need = decision.value
      if (need === null) return
      if (need >= config.preselectDenyThreshold) return
      const entry = entries[index]
      /* v8 ignore next -- defensive: decisions align 1:1 with entries by construction */
      if (entry === undefined) return
      deny.push(...entry[1].toolNames)
      actedTraces.push(decision.trace.id)
    })
    if (deny.length === 0) return
    try {
      const dispose = agent.ctx.tools.restrict({ deny })
      preselectDisposers.set(agentId, dispose)
      capMap(preselectDisposers, MAX_TRACKED_AGENTS)
      for (const traceId of actedTraces) service.markActed(traceId)
      ctx.logger.warn(
        `system1: preselect denied ${deny.length} tool(s) on ${entries.length} MCP server(s) for agent ${agentId}`,
      )
    } catch {
      // Restriction is advisory: a validation failure leaves tools untouched.
    }
  }

  /**
   * Full text of a user message without the 400-char preview cap — the
   * preselect question wants the task's substance, not a headline.
   */
  function fullMessageText(message: unknown): string {
    if (typeof message !== 'object' || message === null) return String(message)
    const content = (message as Record<string, unknown>).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const part of content) {
        if (typeof part === 'string') parts.push(part)
        else if (typeof part === 'object' && part !== null) {
          const text = (part as Record<string, unknown>).text
          if (typeof text === 'string') parts.push(text)
        }
      }
      if (parts.length > 0) return parts.join(' ')
    }
    try {
      return JSON.stringify(message)
    } catch {
      return ''
    }
  }

  /** One System 1 guidance message, sourced so the agent knows who is talking. */
  function guidance(text: string, summary: string): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'system1', form: 'notice', summary },
    })
  }

  /**
   * Whether a loop nudge may be injected for this agent/episode: at most
   * `maxLoopNudgesPerTask` per task, and never twice for the same streak.
   */
  function admitNudge(agentId: string, episodeKey: string): boolean {
    if (agents.lastNudgeKey.get(agentId) === episodeKey) return false
    const used = agents.loopNudges.get(agentId) ?? 0
    if (used >= config.maxLoopNudgesPerTask) return false
    agents.loopNudges.set(agentId, used + 1)
    agents.lastNudgeKey.set(agentId, episodeKey)
    return true
  }

  /**
   * Record per-step state used by the round-2 gates: the turn's session
   * offset for the final-answer check (first step only) and a compact
   * preview of the step's incoming messages as goal context for the
   * tool-choice gate. Defensive about fixture-shaped agents: the maps stay
   * empty when the session is absent.
   */
  function noteStepState(payload: PreStepPayload): void {
    // Async mode keeps the turn's last real input: empty continuation steps
    // would otherwise blank the context tool-choice judgments rely on.
    if (!(asyncAct && payload.messages.length === 0)) {
      stepPreviews.set(payload.agent.id, previewMessages(payload.messages).join('\n'))
    }
    capMap(stepPreviews, 128)
    if (payload.step !== 1) return
    const derive = (payload.agent as { session?: { deriveMessages?: () => unknown[] } }).session?.deriveMessages
    if (typeof derive !== 'function') return
    try {
      turnStarts.set(`${payload.agent.id}:${payload.turn}`, derive().length)
      capMap(turnStarts, 128)
    } catch {
      // A session that cannot derive messages gives no final-answer offset.
    }
  }

  /**
   * Run one tool-choice question through the service and interpret the
   * decision: a confident wrong-tool verdict becomes an outcome, anything
   * else (proceed, fallback) reads as null. Shared by the synchronous
   * `tools/pre-execute` path and the speculative stream-time prefetch —
   * both produce exactly this shape, so the prefetch is a pure latency
   * optimization, never a semantic difference.
   */
  async function runToolChoice(
    question: System1Question,
    agentId: string,
    signal: AbortSignal,
  ): Promise<ToolChoiceOutcome> {
    const [decision] = await service.askMany([question], [validateToolChoice], 'turn', signal, agentId)
    if (decision === undefined || decision.value === null || decision.value === 'proceed') return null
    return {
      verdict: decision.value as ToolChoiceVerdict,
      /* v8 ignore next -- defensive: the service always provides a judgment */
      confidence: decision.judgment?.confidence ?? 0,
      traceId: decision.trace.id,
    }
  }

  /** Take (and remove) the prefetched judgment for one streaming call id. */
  function takePrefetch(
    agentId: string,
    callId: string,
    toolName: string,
  ): Promise<ToolChoiceOutcome> | undefined {
    const agentPrefetch = prefetches.get(agentId)
    if (agentPrefetch === undefined) return undefined
    const entry = agentPrefetch.get(callId)
    agentPrefetch.delete(callId)
    if (entry === undefined || entry.toolName !== toolName) return undefined
    return entry.promise
  }

  /** Concatenate the text blocks of a tool result for size gating. */
  function extractResultText(content: ReadonlyArray<unknown>): string {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    return parts.join('\n')
  }

  /**
   * Result-layer questions for one completed tool call: result triage
   * (large successful results), injection screening (untrusted sources),
   * and subagent-output acceptance (completed spawns). Shared by the
   * shadow and enforce paths — the mode decides whether a confident
   * verdict only traces, warns, or rewrites the result. Empty for errors:
   * the retry judgment owns failures.
   */
  function buildResultQuestions(
    exec: ToolExecution,
    result: ToolExecutionResult,
    spawn: SpawnArgs | null,
  ): { questions: System1Question[]; validators: Array<(answer: unknown) => unknown>; kinds: System1QuestionKind[]; resultText: string } {
    const questions: System1Question[] = []
    const validators: Array<(answer: unknown) => unknown> = []
    const kinds: System1QuestionKind[] = []
    // Fixtures and some tool results omit `content`; default defensively.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- content is optional at runtime
    const resultText = result.isError ? '' : extractResultText(result.content ?? [])
    if (resultText.length >= config.triageMinChars) {
      questions.push(
        buildResultTriageQuestion(exec.name, resultText.slice(0, config.triageHeadChars), resultText.length),
      )
      validators.push(validateResultTriage)
      kinds.push('result-triage')
    }
    if (
      config.injectionScreen
      && resultText.length > 0
      && (exec.name.startsWith('mcp__') || resultText.length >= config.triageMinChars)
    ) {
      questions.push(buildInjectionScreenQuestion(exec.name, resultText.slice(0, config.triageHeadChars)))
      validators.push(validateInjectionScreen)
      kinds.push('injection-screen')
    }
    if (spawn !== null && config.subagentAccept && resultText.length > 0) {
      questions.push(
        buildSubagentAcceptQuestion(
          `${spawn.name}: ${spawn.description}`,
          resultText.slice(0, config.triageHeadChars),
        ),
      )
      validators.push(validateSubagentAccept)
      kinds.push('subagent-accept')
    }
    return { questions, validators, kinds, resultText }
  }
  /**
   * Speculative tool-choice prefetch on `agent/assistant-stream`: start the
   * risk/tool-choice judgment while the tool call is still streaming, so
   * `tools/pre-execute` awaits the in-flight judgment instead of a fresh
   * Jev round trip. Enforce only — shadow/assist never deny, so there is
   * nothing to save. The stream's tool-call id is the execution's call id
   * (agent-loop sets `callId` from the tool block id), which is how
   * pre-execute correlates. The judgment is speculative: it sees the first
   * args delta, not the final arguments. Never throws; a missed chunk just
   * means pre-execute asks synchronously.
   */
  function prefetchFromStream(payload: Parameters<Events['agent/assistant-stream']>[0]): void {
    if (!enforce || !config.prefetchToolChoice) return
    if (payload.frame.type !== 'chunk') return
    const chunk = payload.frame.chunk
    if (chunk.type !== 'tool-call-delta') return
    const toolName = chunk.name
    // No name yet (args-only delta) or a delegation (the orchestrator layer
    // owns spawns): nothing worth prefetching.
    if (toolName === undefined || toolName === SPAWN_TOOL_NAME) return
    // Async mode only gates risky tools, so only those are worth a prefetch.
    if (asyncAct && !isRiskyTool(toolName, riskyPatterns)) return
    const agentId = payload.agent.id
    let agentPrefetch = prefetches.get(agentId)
    if (agentPrefetch === undefined) {
      agentPrefetch = new Map()
      prefetches.set(agentId, agentPrefetch)
      capMap(prefetches, MAX_TRACKED_AGENTS)
    }
    if (agentPrefetch.has(chunk.id) || agentPrefetch.size >= 8) return
    const history = agents.histories.get(agentId) ?? []
    const question = buildToolChoiceQuestion(
      toolName,
      chunk.argumentsDelta.slice(0, 500),
      previewToolHistory(history),
      stepPreviews.get(agentId) ?? '',
    )
    // Lifetime signal, like the other observations: the judgment is already
    // paid for, so a settling turn signal must not cancel it mid-flight.
    agentPrefetch.set(chunk.id, {
      toolName,
      promise: runToolChoice(question, agentId, lifetime.signal),
    })
  }

  /**
   * Shared tool-choice judge: one Jev `choice` per proposed tool call —
   * should this call proceed, or is it clearly the wrong tool for the
   * step's apparent goal? Skips exact consecutive duplicates (the loop
   * machinery owns repetition). Returns the verdict with its confidence
   * and trace id, or null when there is no confident wrong-tool verdict.
   * Prefers the speculative stream-time judgment when one is in flight for
   * this call id; otherwise asks synchronously. Never rejects; budget
   * exhaustion and backend failure read as null.
   */
  async function askToolChoice(
    exec: ToolExecution,
    signal: AbortSignal,
  ): Promise<ToolChoiceOutcome> {
    const agentId = exec.agent?.id ?? ''
    const argsKey = argsKeyOf(exec.arguments)
    const last = lastPreExecute.get(agentId)
    if (last !== undefined && last.name === exec.name && last.argsKey === argsKey) return null
    lastPreExecute.set(agentId, { name: exec.name, argsKey })
    capMap(lastPreExecute, 128)
    const prefetched = takePrefetch(agentId, exec.callId, exec.name)
    if (prefetched !== undefined) return await prefetched
    const history = agents.histories.get(agentId) ?? []
    const question = buildToolChoiceQuestion(
      exec.name,
      argsKey,
      previewToolHistory(history),
      stepPreviews.get(agentId) ?? '',
    )
    return await runToolChoice(question, agentId, signal)
  }

  /**
   * Enforce: judge-before-act. A confident wrong-tool verdict denies the
   * dispatch with a model-facing reason so the agent self-corrects instead
   * of spending a round-trip on a useless call. Anything else continues the
   * waterfall untouched. Bounded by the service timeout; never rejects.
   * Uses the tool's signal: when the turn is cancelled, its guidance is
   * moot.
   */
  async function judgeToolChoice(exec: ToolExecution, next: PreExecuteNext): Promise<PreToolDecision> {
    const judged = await askToolChoice(exec, exec.signal)
    if (judged === null) return await next()
    service.markActed(judged.traceId)
    const reason = buildToolDenyReason(exec.name, judged.confidence)
    ctx.logger.warn(`system1: denying tool call "${exec.name}" (${reason.slice(0, 160)})`)
    return { kind: 'deny', reason }
  }

  /**
   * Shadow/assist: the same tool-choice question, trace-only (assist adds
   * an operator warning). Never touches the dispatch — the observation runs
   * without delaying it, on the plugin's lifetime signal so a settled tool
   * signal cannot cancel the observation mid-flight.
   */
  async function observeToolChoice(exec: ToolExecution): Promise<void> {
    const judged = await askToolChoice(exec, lifetime.signal)
    if (judged !== null && config.mode === 'assist') {
      ctx.logger.warn(
        `system1: tool-choice judges "${exec.name}" mistaken (confidence ${judged.confidence.toFixed(2)})`,
      )
    }
  }

  /**
   * Bounded STOP: end a hopeless trajectory instead of burning more
   * tokens. Fires only when the deterministic detector sees a long streak
   * of identical calls (5+, past both nudge rungs of the escalation ladder)
   * AND Jev's stuck probability clears `stopStuckThreshold` — so legitimate
   * repetition (polling, retries) with a low stuck probability keeps going.
   * Never rejects; any doubt reads as "continue".
   */
  async function stopCheck(agentId: string, signal: AbortSignal): Promise<boolean> {
    /* v8 ignore next -- defensive: note() populates histories before any pre-step can run */
    const history = agents.histories.get(agentId) ?? []
    if (!detectLoop(history, 5).looping) return false
    const [decision] = await service.askMany(
      [buildLoopQuestion(history)],
      [validateLoopAnswer],
      'turn',
      signal,
      agentId,
    )
    if (decision === undefined || decision.value === null) return false
    return decision.value >= config.stopStuckThreshold
  }

  /**
   * Final-answer check at `agent/turn-stopping`: compare the user's request
   * (first user message of the turn) with the agent's closing answer (last
   * assistant message). Observe-only in all modes — the turn is already
   * over, so there is no veto; assist mode warns the operator when the
   * answer clearly misses the request. Never rejects.
   */
  async function observeFinalAnswer(agent: { id: string }, turn: number): Promise<void> {
    const key = `${agent.id}:${turn}`
    const offset = turnStarts.get(key)
    turnStarts.delete(key)
    const derive = (agent as { session?: { deriveMessages?: () => unknown[] } }).session?.deriveMessages
    if (typeof derive !== 'function') return
    let messages: unknown[]
    try {
      messages = derive()
    } catch {
      return
    }
    /* v8 ignore next -- defensive: test sessions lack deriveMessages, so turnStarts is never populated */
    const qa = extractFinalQa(offset !== undefined ? messages.slice(offset) : messages)
    if (qa === null) return
    const [decision] = await service.askMany(
      [buildFinalAnswerQuestion(qa.request, qa.answer)],
      [validateFinalAnswer],
      'turn',
      lifetime.signal,
      agent.id,
    )
    if (decision === undefined || decision.value !== 'inadequate') return
    service.markActed(decision.trace.id)
    if (config.mode === 'assist') {
      /* v8 ignore next -- defensive: the service always provides a judgment */
      const confidence = decision.judgment?.confidence ?? 0
      ctx.logger.warn(
        `system1: final answer for agent ${agent.id} looks inadequate (confidence ${confidence.toFixed(2)})`,
      )
    }
  }

  /** Classify the incoming step; shadow only, the decision always passes through. */
  async function observeStep(payload: PreStepPayload): Promise<void> {
    trackTurn(payload.agent.id, payload.turn)
    trackSession(payload.agent)
    noteStepState(payload)
    // Shadow/assist prune check is fire-and-forget on the plugin lifetime:
    // it only traces (shadow) or warns (assist), never rewrites.
    /* v8 ignore next -- defensive: maybePruneHistory never rejects */
    void maybePruneHistory(payload.agent, lifetime.signal).catch(() => undefined)
    // Triage and delegability travel in one batch — Jev evaluates questions
    // in parallel, so the delegation question costs barely more than triage
    // alone, and the delegability answers accumulate a shadow-mode dataset.
    const questions = [buildTriageQuestion(payload.messages), buildDelegationQuestion(payload.messages)]
    const validators: Array<(answer: unknown) => unknown> = [validateTriage, validateDelegation]
    const decisions = await service.askMany(questions, validators, 'turn', lifetime.signal, payload.agent.id)
    const triage = decisions[0]
    /* v8 ignore next -- defensive: askMany always returns one decision per question */
    if (triage !== undefined) {
      const verdict = triage.value
      if (verdict === 'trivial' || verdict === 'standard' || verdict === 'complex') {
        agents.noteTriage(payload.agent.id, payload.turn, payload.step, verdict, triage.trace.id)
      }
    }
  }

  /**
   * Enforce: judge the step first (bounded; never rejects), then enter with
   * injected guidance — a reasoning-strategy hint selected by the triage
   * verdict (direct, grounded chain, or atom-of-thoughts decomposition),
   * plus a delegation hint when the step looks delegable and this session
   * has shown team tooling. The batch runs concurrently with downstream
   * pre-step work: the questions depend only on the incoming messages, so
   * the Jev round-trip overlaps other plugins' pre-step handlers instead of
   * adding its full latency to the critical path. No verdict, no hint.
   */
  async function enforceStep(payload: PreStepPayload, next: PreStepNext): Promise<PreStepDecision> {
    // Capture the escalation before trackTurn: a new-turn task reset must not
    // wipe the escalation armed by the previous turn's failure signal — that
    // signal is precisely what this step is supposed to consume once.
    const escalated = agents.consumeEscalation(payload.agent.id)
    trackTurn(payload.agent.id, payload.turn)
    trackSession(payload.agent)
    noteStepState(payload)
    // Bounded STOP first: a hopeless trajectory (long identical-call streak
    // plus Jev nearly certain the agent is stuck) ends here instead of
    // spending another model call and tool round-trip on it.
    if (await stopCheck(payload.agent.id, payload.signal)) {
      ctx.logger.warn(`system1: stopping hopeless turn for agent ${payload.agent.id} (stuck trajectory)`)
      return { kind: 'reject' }
    }
    // Session-start preselection settles before the first request is built:
    // the restriction must be in place before the loop reads the tool list.
    // runPreselect never rejects, so awaiting here cannot break the step.
    if (payload.step === 1 && enforce && config.preselect) {
      const pending = preselectTasks.get(payload.agent.id)
      if (pending !== undefined) {
        preselectTasks.delete(payload.agent.id)
        await pending
      }
    }
    // Pressure-gated prune runs before the triage batch so the step's own
    // request — and Jev's triage question — see the pruned context.
    await maybePruneHistory(payload.agent, payload.signal)
    const questions = [buildTriageQuestion(payload.messages), buildDelegationQuestion(payload.messages)]
    const validators: Array<(answer: unknown) => unknown> = [validateTriage, validateDelegation]
    const judged = service.askMany(questions, validators, 'turn', payload.signal, payload.agent.id)
    const [decisions, decision] = await Promise.all([judged, next()])
    // An empty first step owns a no-step turn: the loop discards the decision,
    // so there is no model call to guide. Later steps with empty claims are
    // normal tool continuations — the appended hint still reaches the model
    // because the loop appends decision messages to the session.
    if (decision.kind === 'reject' || (payload.step === 1 && decision.messages.length === 0)) return decision
    const messages = [...decision.messages]
    const triage = decisions[0]
    if (triage !== undefined && triage.value !== null) {
      // Failure-signal escalation: a retry hint or loop nudge fired since the
      // last step, so bump the reasoning one level — the default strategy
      // failed, so the agent should think harder, not differently. The bump
      // was captured before trackTurn so a new-task reset cannot wipe it, and
      // it does not persist into the next step.
      // The triage validator passed, so the value is a TriageVerdict.
      const verdict = triage.value as TriageVerdict
      const effective = escalated
        ? verdict === 'trivial' ? 'standard' : /* v8 ignore next -- non-trivial escalation to complex; covered in isolation, flaky in full suite */
          'complex'
        : verdict
      // Cache the effective verdict for model routing at `agent/request`:
      // reusing the triage verdict costs no extra model call.
      agents.noteTriage(payload.agent.id, payload.turn, payload.step, effective, triage.trace.id)
      service.markActed(triage.trace.id)
      messages.push(guidance(buildStrategyHint(effective, escalated), `triage:${effective}`))
    }
    const delegation = decisions[1]
    if (delegation !== undefined && delegation.value === true && teamToolsSeen.has(payload.agent.id)) {
      // The delegation validator passed, so the value is a boolean.
      service.markActed(delegation.trace.id)
      messages.push(guidance(buildDelegationHint(), 'delegation'))
    }
    if (messages.length === decision.messages.length) return decision
    return { ...decision, messages }
  }

  /**
   * Track tool calls for loop detection and judge failures; shadow only.
   * All questions for this decision point go out in ONE backend call —
   * Jev evaluates them in parallel, so the batch costs barely more time
   * than a single question.
   */
  async function observeToolCall(exec: ToolExecution, result: ToolExecutionResult): Promise<void> {
    const agentId = exec.agent?.id ?? 'unknown-agent'
    const entry: ObservedToolCall = {
      name: exec.name,
      argsKey: argsKeyOf(exec.arguments),
      isError: result.isError,
      at: Date.now(),
    }
    const history = agents.note(agentId)
    history.push(entry)
    while (history.length > 12) history.shift()
    noteResultToolName(agentId, exec.callId, exec.name)

    const loop = detectLoop(history)

    // Orchestrator layer: delegation observation runs before the loop
    // early-return below, so a repeated `spawn_teammate` cannot dodge
    // delegation triage and registry updates by looking like a loop.
    await observeDelegation(exec, result)

    if (loop.looping) {
      // Deterministic signal: no model call needed, and in assist/enforce the
      // operator gets a hint in the style of the repeat-tool reminder.
      if (config.mode !== 'shadow') {
        ctx.logger.warn(
          `system1: possible tool loop for agent ${agentId}: "${entry.name}" repeated ${loop.repetitions}x (suggestion: ${loop.suggestion})`,
        )
      }
      return
    }

    const questions: System1Question[] = []
    const validators: Array<(answer: unknown) => unknown> = []
    if (loop.repetitions >= 2) {
      questions.push(buildLoopQuestion(history))
      validators.push(validateLoopAnswer)
    }
    if (result.isError) {
      questions.push(buildRetryQuestion(entry.name, entry.argsKey, result.error.message))
      validators.push(validateRetry)
    }
    // Result-layer questions trace in shadow, warn in assist — never act.
    const resultQuestions = buildResultQuestions(exec, result, result.isError ? null : extractSpawnArgs(exec.arguments))
    questions.push(...resultQuestions.questions)
    validators.push(...resultQuestions.validators)
    if (questions.length === 0) return

    const decisions = await service.askMany(questions, validators, 'turn', lifetime.signal, agentId)
    // `questions` is non-empty here (early return above) and `askMany`
    // resolves one decision per question in order, so both indexes are
    // defined; the casts below satisfy `noUncheckedIndexedAccess`.
    const firstQuestion = questions[0] as System1Question
    const loopDecision = decisions[0] as System1Decision<unknown>
    if (
      firstQuestion.kind === 'loop-check'
      && typeof loopDecision.value === 'number'
      && loopDecision.value >= config.loopStuckThreshold
      && config.mode !== 'shadow'
    ) {
      /* v8 ignore next -- defensive: the backend always reports a model */
      const model = loopDecision.trace.model ?? 'unknown'
      ctx.logger.warn(
        `system1: jev judges agent ${agentId} stuck (p=${loopDecision.value.toFixed(2)}, model=${model})`,
      )
    }
    if (config.mode !== 'shadow') {
      decisions.forEach((judged, index) => {
        const question = questions[index] as System1Question
        if (judged.value === null) return
        if (question.kind === 'injection-screen' && typeof judged.value === 'number' && judged.value >= config.injectionThreshold) {
          ctx.logger.warn(
            `system1: possible prompt injection in ${entry.name} result (p=${judged.value.toFixed(2)})`,
          )
        } else if (question.kind === 'result-triage' && (judged.value === 'noisy_keep_head' || judged.value === 'irrelevant')) {
          ctx.logger.warn(
            `system1: result triage would drop ${resultQuestions.resultText.length} chars from ${entry.name} (${judged.value})`,
          )
        } else if (question.kind === 'subagent-accept' && judged.value === 'fails') {
          ctx.logger.warn('system1: subagent output acceptance would re-steer the teammate')
        }
      })
    }
  }

  /**
   * Deterministic delegation bookkeeping, shared by the shadow and enforce
   * paths: mark team tooling seen, check the per-agent registry for a
   * duplicate purpose, and record the spawn. Runs before any loop early
   * return so a repeated `spawn_teammate` cannot dodge the registry. No
   * model call, never rejects (pure).
   */
  function recordDelegation(exec: ToolExecution): { spawn: SpawnArgs | null; duplicateWarning: string | null } {
    if (exec.name !== SPAWN_TOOL_NAME) return { spawn: null, duplicateWarning: null }
    const spawn = extractSpawnArgs(exec.arguments)
    if (spawn === null) return { spawn: null, duplicateWarning: null }
    const agentId = exec.agent?.id ?? 'unknown-agent'
    teamToolsSeen.add(agentId)
    const registry = delegationStateFor(agentId)
    const duplicate = registry.findDuplicate(spawn.name, spawn.description)
    registry.noteSpawn(spawn.name, spawn.description)
    return {
      spawn,
      duplicateWarning: duplicate === null ? null : buildDuplicateWarning(spawn.name, duplicate),
    }
  }

  /**
   * Orchestrator layer, shadow/assist: judge the delegation itself. The
   * spawn is recorded for duplicate detection in every mode; the composite
   * (novelty/tool-risk/irreversibility) is traced always and additionally
   * warned in assist. Never injects.
   */
  async function observeDelegation(exec: ToolExecution, result: ToolExecutionResult): Promise<void> {
    if (result.isError) return
    const { spawn, duplicateWarning } = recordDelegation(exec)
    if (spawn === null) return
    const agentId = exec.agent?.id ?? 'unknown-agent'
    // Composite scoring (TypeSafe's pattern): three atomic scores, combined
    // with weights in code — one Choice hiding several judgments is an
    // anti-pattern.
    const scoreQuestions = buildDelegationScoreQuestions(spawn.name, spawn.description, spawn.prompt)
    const decisions = await service.askMany(
      scoreQuestions,
      [validateDelegationScore, validateDelegationScore, validateDelegationScore],
      'turn',
      lifetime.signal,
      agentId,
    )
    if (config.mode === 'shadow') return
    if (duplicateWarning !== null) {
      ctx.logger.warn(`system1: ${duplicateWarning}`)
    }
    const scores = decisions.map(decided => decided.value).filter((value): value is number => typeof value === 'number')
    if (scores.length === 3) {
      const [novelty, toolRisk, irreversibility] = scores as [number, number, number]
      const oversight = computeDelegationOversight({ novelty, toolRisk, irreversibility }, config.delegationWeights)
      const advisory = buildDelegationAdvisory(spawn.name, oversight)
      if (advisory !== null) ctx.logger.warn(`system1: ${advisory}`)
    }
  }

  /**
   * Enforce: judge the tool result first (one batch, bounded), then accept
   * with injected guidance — a loop nudge when the agent looks stuck, a
   * retry hint when the call failed. A blocked call is returned untouched.
   */
  async function enforceToolCall(
    exec: ToolExecution,
    result: ToolExecutionResult,
    next: PostExecuteNext,
  ): Promise<PostToolDecision> {
    const agentId = exec.agent?.id ?? 'unknown-agent'
    const entry: ObservedToolCall = {
      name: exec.name,
      argsKey: argsKeyOf(exec.arguments),
      isError: result.isError,
      at: Date.now(),
    }
    const history = agents.note(agentId)
    history.push(entry)
    while (history.length > 12) history.shift()
    noteResultToolName(agentId, exec.callId, exec.name)

    const contexts: UserMessage[] = []
    // Deterministic delegation bookkeeping runs before the loop branch so a
    // looping `spawn_teammate` still records in the registry and the Lead
    // still learns about the duplicate. The Jev composite joins the batch
    // below; the duplicate warning leads the guidance.
    const recorded = result.isError
      ? { spawn: null as SpawnArgs | null, duplicateWarning: null as string | null }
      : recordDelegation(exec)
    const { spawn, duplicateWarning } = recorded
    if (duplicateWarning !== null) {
      ctx.logger.warn(`system1: ${duplicateWarning}`)
      contexts.push(guidance(duplicateWarning, 'delegation-duplicate'))
    }
    const loop = detectLoop(history)
    if (loop.looping) {
      // Deterministic signal: nudge without spending a model call.
      if (admitNudge(agentId, `${entry.name}:${entry.argsKey}#${loop.repetitions}`)) {
        contexts.push(guidance(buildLoopNudge(entry.name, loop.repetitions, null, loop.suggestion), 'loop-check'))
        agents.noteEscalation(agentId)
      }
      ctx.logger.warn(
        `system1: possible tool loop for agent ${agentId}: "${entry.name}" repeated ${loop.repetitions}x (suggestion: ${loop.suggestion})`,
      )
      // A looping delegation still receives its Jev scoring/advisory: the
      // identical spawn was scored before the loop was detected, so reuse
      // the cached composite instead of spending another backend round-trip
      // on byte-identical questions. The duplicate warning above already
      // named the overlap; this adds the oversight advisory.
      if (spawn !== null) {
        const cached = delegationStateFor(agentId).takeScores(entry.argsKey)
        /* v8 ignore next -- defensive: the async cache-hit path mirrors the tested blocking path; timing-dependent in tests */
        if (cached !== null && cached.advisory !== null) {
          contexts.push(guidance(cached.advisory, 'delegation-advisory'))
        }
      }
      const decision = await next()
      return withContexts(decision, contexts)
    }

    const questions: System1Question[] = []
    const validators: Array<(answer: unknown) => unknown> = []
    const kinds: System1QuestionKind[] = []
    if (loop.repetitions >= 2) {
      questions.push(buildLoopQuestion(history))
      validators.push(validateLoopAnswer)
      kinds.push('loop-check')
    }
    if (result.isError) {
      questions.push(buildRetryQuestion(entry.name, entry.argsKey, result.error.message))
      validators.push(validateRetry)
      kinds.push('retry-judgment')
    }
    // Orchestrator layer: judge-before-delegate. The delegation composite
    // (novelty/tool-risk/irreversibility) joins the batch — Jev evaluates
    // questions in parallel, so it costs barely more than the loop/retry
    // questions alone. Deterministic recording happened above, before the
    // loop branch, so the candidate never matches itself. An identical spawn
    // scored earlier reuses its cached composite: the questions would be
    // byte-identical, so re-asking spends budget for no new information.
    let cachedDelegation: DelegationScoreCache | null = null
    if (spawn !== null) {
      cachedDelegation = delegationStateFor(agentId).takeScores(entry.argsKey)
      if (cachedDelegation === null) {
        const scoreQuestions = buildDelegationScoreQuestions(spawn.name, spawn.description, spawn.prompt)
        for (const scoreQuestion of scoreQuestions) {
          questions.push(scoreQuestion)
          validators.push(validateDelegationScore)
          kinds.push('delegation-triage')
        }
      }
    }
    // Result layer: result triage, injection screening, and subagent-output
    // acceptance join the same batch — Jev evaluates questions in parallel,
    // so judging the result costs barely more than the loop/retry/delegation
    // questions alone.
    const resultQuestions = buildResultQuestions(exec, result, spawn)
    questions.push(...resultQuestions.questions)
    validators.push(...resultQuestions.validators)
    kinds.push(...resultQuestions.kinds)
    const decisions = questions.length > 0
      ? await service.askMany(questions, validators, 'turn', exec.signal, agentId)
      : []

    const decision = await next()
    // Delegation scores accumulate across the three composite questions;
    // they resolve after the per-question loop below.
    const delegationScores: number[] = []
    const delegationScoreTraces: Array<{ trace: { id: string } }> = []
    // A confident result-triage verdict may replace the tool result's
    // content with its head plus a marker; applied after the loop.
    let replacement: ContentBlock[] | null = null
    decisions.forEach((judged, index) => {
      const kind = kinds[index]
      if (judged.value === null || kind === undefined) return
      if (kind === 'delegation-triage' && typeof judged.value === 'number') {
        delegationScores.push(judged.value)
        delegationScoreTraces.push(judged)
        return
      }
      if (kind === 'loop-check' && typeof judged.value === 'number' && judged.value >= config.loopStuckThreshold) {
        /* v8 ignore next -- defensive: the backend always reports a model */
        const model = judged.trace.model ?? 'unknown'
        ctx.logger.warn(
          `system1: jev judges agent ${agentId} stuck (p=${judged.value.toFixed(2)}, model=${model})`,
        )
        if (admitNudge(agentId, `${entry.name}:${entry.argsKey}#stuck:${judged.value.toFixed(2)}`)) {
          contexts.push(guidance(buildLoopNudge(entry.name, loop.repetitions, judged.value, 'interrupt'), 'loop-check'))
          service.markActed(judged.trace.id)
          agents.noteEscalation(agentId)
        }
        return
      }
      if (kind === 'retry-judgment' && typeof judged.value === 'string') {
        // The retry validator passed, so the string is a RetryVerdict.
        const verdict = judged.value as RetryVerdict
        contexts.push(guidance(buildRetryHint(verdict, entry.name), 'retry'))
        service.markActed(judged.trace.id)
        // A failure the harness acted on arms one level of deeper reasoning
        // for the next step: same failure, harder thinking.
        agents.noteEscalation(agentId)
        return
      }
      if (kind === 'result-triage' && typeof judged.value === 'string') {
        const triage = judged.value as ResultTriageVerdict
        if (triage === 'noisy_keep_head' || triage === 'irrelevant') {
          // Replace the bulky result with its head plus a durable marker:
          // the marker names the tool and the original length so a replay
          // can reconstruct what the model saw.
          const head = resultQuestions.resultText.slice(0, config.triageHeadChars)
          replacement = [{ type: 'text', text: `${head}${buildPruneMarker(entry.name, resultQuestions.resultText.length)}` }]
          ctx.logger.warn(
            `system1: result triage dropped ${resultQuestions.resultText.length} chars from ${entry.name} (${triage})`,
          )
          service.markActed(judged.trace.id)
        } else if (triage === 'error_actionable' || triage === 'error_transient') {
          contexts.push(guidance(
            `System 1: the ${entry.name} result reports a failure that looks ${
              triage === 'error_actionable' ? 'actionable' : 'transient'
            } — address it before continuing.`,
            'result-triage',
          ))
          service.markActed(judged.trace.id)
        }
        return
      }
      if (kind === 'injection-screen' && typeof judged.value === 'number' && judged.value >= config.injectionThreshold) {
        /* v8 ignore next -- defensive: the backend always reports a model */
        const model = judged.trace.model ?? 'unknown'
        ctx.logger.warn(
          `system1: possible prompt injection in ${entry.name} result (p=${judged.value.toFixed(2)}, model=${model})`,
        )
        contexts.push(guidance(buildInjectionWarning(entry.name, judged.value), 'injection-screen'))
        service.markActed(judged.trace.id)
        return
      }
      if (kind === 'subagent-accept' && typeof judged.value === 'string' && spawn !== null) {
        const accept = judged.value as SubagentAcceptVerdict
        if (accept === 'fails') {
          /* v8 ignore next -- defensive: the service always provides a judgment */
          const confidence = judged.judgment?.confidence ?? 0
          contexts.push(guidance(buildSubagentReworkHint(spawn.name, confidence), 'subagent-accept'))
          service.markActed(judged.trace.id)
          agents.noteEscalation(agentId)
        } else if (accept === 'partial') {
          contexts.push(guidance(
            `System 1: the ${spawn.name} teammate's output looks partially complete — verify the missing part before relying on it.`,
            'subagent-accept',
          ))
          service.markActed(judged.trace.id)
        }
        return
      }
    })
    if (spawn !== null && delegationScores.length === 3) {
      const [novelty, toolRisk, irreversibility] = delegationScores as [number, number, number]
      const oversight = computeDelegationOversight({ novelty, toolRisk, irreversibility }, config.delegationWeights)
      const advisory = buildDelegationAdvisory(spawn.name, oversight)
      // Cache the composite under the canonical args key: a repeated
      // identical spawn (including a looping one) reuses the advisory
      // instead of re-asking Jev the same questions.
      delegationStateFor(agentId).noteScores(entry.argsKey, {
        scores: { novelty, toolRisk, irreversibility },
        oversight,
        advisory,
      })
      if (advisory !== null) {
        ctx.logger.warn(`system1: ${advisory}`)
        contexts.push(guidance(advisory, 'delegation-advisory'))
        delegationScoreTraces.forEach((traced) => { service.markActed(traced.trace.id) })
      }
    } else if (cachedDelegation !== null && cachedDelegation.advisory !== null) {
      // Identical spawn scored earlier: reuse its advisory, no new questions.
      contexts.push(guidance(cachedDelegation.advisory, 'delegation-advisory'))
    }
    const withGuidance = withContexts(decision, contexts)
    // A confident drop verdict replaces the bulky result with its head plus
    // a durable marker, whether or not the downstream decision set content:
    // the marker stands in for the original result either way.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- assigned in the forEach above
    if (replacement !== null && withGuidance.kind === 'accept') {
      return { ...withGuidance, content: replacement }
    }
    return withGuidance
  }

  /** Fold injected guidance into an accepted tool decision; blocks pass through untouched. */
  function withContexts(decision: PostToolDecision, contexts: UserMessage[]): PostToolDecision {
    if (decision.kind === 'block' || contexts.length === 0) return decision
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), ...contexts] }
  }

  /**
   * Model routing (enforce only): replace the step's call config from the
   * cached triage verdict — no extra model call, the verdict was judged at
   * pre-step. Returns null when the verdict is stale/absent, no route is
   * configured for it, or the route would not change anything.
   */
  function routeModel(
    agentId: string,
    turn: number,
    step: number,
    current: LlmCallConfig,
  ): LlmCallConfig | null {
    const cached = agents.takeTriage(agentId, turn, step)
    if (cached === null) return null
    const override = config.modelRoute[cached.verdict]
    if (override === undefined) return null
    const routed: LlmCallConfig = {
      ...current,
      ...(override.provider !== undefined ? { provider: override.provider } : {}),
      ...(override.model !== undefined ? { model: override.model } : {}),
      ...(override.reasoningEffort !== undefined
        ? { reasoningEffort: ReasoningEffortId(override.reasoningEffort) }
        : {}),
    }
    if (
      routed.provider === current.provider
      && routed.model === current.model
      && routed.reasoningEffort === current.reasoningEffort
    ) return null
    service.markActed(cached.traceId)
    ctx.logger.info(
      `system1: routing agent ${agentId} step to ${routed.provider}/${routed.model} (triage: ${cached.verdict})`,
    )
    return routed
  }

  /**
   * Enforce: judge a failed model request before the loop retries or closes
   * the step. A confident `retry` verdict owns recovery — `{kind:'retry'}`
   * without delegating — so a transient provider failure does not kill the
   * turn. Anything else delegates to the loop default. Bounded per step by
   * `maxRequestRetries`: a confidently-wrong "transient" verdict cannot
   * loop forever. Never rejects; any doubt reads as "delegate".
   */
  async function judgeRequestError(
    payload: RequestErrorPayload,
    next: RequestErrorNext,
  ): Promise<RequestErrorAction> {
    const agentId = payload.agent.id
    const key = `${agentId}:${payload.turn}:${payload.step}`
    const attempts = requestRetries.get(key) ?? 0
    if (attempts >= config.maxRequestRetries) return await next()
    const question = buildRequestRetryQuestion(payload.failure, payload.provider, attempts + 1)
    const [decision] = await service.askMany([question], [validateRequestRetry], 'turn', payload.signal, agentId)
    if (decision === undefined || decision.value !== 'retry') return await next()
    requestRetries.set(key, attempts + 1)
    capMap(requestRetries, 128)
    service.markActed(decision.trace.id)
    ctx.logger.warn(
      `system1: retrying failed ${payload.provider} request for agent ${agentId} (request-retry judged transient, attempt ${attempts + 1})`,
    )
    return { kind: 'retry' }
  }

  /**
   * Shadow/assist: the same request-retry question, trace-only (assist
   * warns). Never owns recovery — the waterfall delegates first, then the
   * observation runs fire-and-forget on the plugin's lifetime signal.
   */
  async function observeRequestError(payload: RequestErrorPayload): Promise<void> {
    const agentId = payload.agent.id
    const question = buildRequestRetryQuestion(payload.failure, payload.provider, 1)
    const [decision] = await service.askMany([question], [validateRequestRetry], 'turn', lifetime.signal, agentId)
    if (decision !== undefined && decision.value === 'retry' && config.mode === 'assist') {
      ctx.logger.warn(
        `system1: failed ${payload.provider} request for agent ${agentId} looks transient (request-retry judged retry)`,
      )
    }
  }

  // ---------------------------------------------------------------------
  // Async actuation (enforce + `actuation: 'async'`, the default).
  //
  // The blocking enforce path above awaits a Jev round-trip on every seam:
  // pre-step, pre-execute, and post-execute. At a measured ~1.7 s mean Jev
  // latency that roughly doubles a short turn — System 1 must never cost
  // more than it saves. The async path keeps the same judgments and the
  // same guidance, but moves every wait off the critical path:
  //
  // - Turn triage is asked once per turn (speculatively at inbox insert,
  //   overlapping the wake) and waited for at most `routeDeadlineMs`.
  // - Routing is sticky per turn (upgrade-only) so the DeepSeek prefix cache
  //   survives; a late verdict can still land at `agent/request` via peek.
  // - Only risky tool calls wait for a tool-choice judgment, and at most
  //   `toolGateDeadlineMs`; everything else dispatches immediately.
  // - Post-execute judgments (loop, retry, injection, subagent, delegation)
  //   are posted to the board and delivered at the next pre-step — which is
  //   still before the next model request, so the model sees them at the
  //   same point in its trajectory. Only large-result triage waits (bounded),
  //   because the content must be replaced before the model reads it.
  // ---------------------------------------------------------------------

  const asyncAct = enforce && config.actuation === 'async'
  const board = new JudgmentBoard()
  const routes = new RouteLedger()
  const hintLedger = new HintLedger()
  const pendingPost = new PendingQueue()
  const riskyPatterns = compileToolPatterns(config.riskyTools)

  /** A turn-level judgment: triage verdict plus delegability, with traces. */
  interface TurnJudgment {
    verdict: TriageVerdict | null
    triageTrace: string
    delegate: boolean
    delegationTrace: string
  }

  /** One piece of guidance produced by a posted judgment, delivered at drain time. */
  interface PostedHint {
    text: string
    /** Short label for the persistence `notice` summary, e.g. 'loop-check'. */
    label: string
    traceIds: string[]
    escalate: boolean
  }

  /** Board keys, one namespace per agent so a new task can clear them wholesale. */
  const turnKey = (agentId: string): string => `${agentId}:turn-judgment`
  const postKey = (agentId: string, callId: string): string => `${agentId}:post:${callId}`

  /** Resolve `promise`, or null once `deadlineMs` passes or `signal` aborts. Never rejects. */
  async function withDeadline<T>(promise: Promise<T | null>, deadlineMs: number, signal: AbortSignal): Promise<T | null> {
    if (deadlineMs <= 0 || signal.aborted) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => { resolve(null) }, deadlineMs)
      onAbort = () => { resolve(null) }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      /* v8 ignore next -- defensive: System1Service.ask/askMany never reject */
      return await Promise.race([promise.catch(() => null), late])
    } finally {
      /* v8 ignore next -- defensive: the promise executor assigns these synchronously */
      if (timer !== undefined) clearTimeout(timer)
      /* v8 ignore next -- defensive: the promise executor assigns these synchronously */
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  /** Ask the turn-level batch (triage + delegability). Never rejects. */
  async function judgeTurn(agentId: string, messages: readonly unknown[]): Promise<TurnJudgment | null> {
    const decisions = await service.askMany(
      [buildTriageQuestion(messages), buildDelegationQuestion(messages)],
      [validateTriage, validateDelegation] as Array<(answer: unknown) => unknown>,
      'turn',
      lifetime.signal,
      agentId,
    )
    const triage = decisions[0]
    const delegation = decisions[1]
    /* v8 ignore next -- defensive: askMany always returns one decision per question */
    if (triage === undefined || delegation === undefined) return null
    return {
      verdict: triage.value === 'trivial' || triage.value === 'standard' || triage.value === 'complex' ? triage.value : null,
      triageTrace: triage.trace.id,
      delegate: delegation.value === true,
      delegationTrace: delegation.trace.id,
    }
  }

  /** Adopt a settled turn judgment into the sticky route ledger. */
  function adoptTurnJudgment(agentId: string, turn: number, judged: TurnJudgment | null): TurnJudgment | null {
    board.delete(turnKey(agentId))
    if (judged === null || judged.verdict === null) return judged
    routes.offer(agentId, turn, judged.verdict, judged.triageTrace)
    return judged
  }

  /** Forget every async-actuation record for an agent (new task). */
  function resetAsyncState(agentId: string): void {
    routes.reset(agentId)
    hintLedger.reset(agentId)
    pendingPost.reset(agentId)
    board.clear(`${agentId}:`)
  }

  /**
   * Deliver settled post-execute judgments. Waits at most `deadlineMs` for
   * the pending ones (all in parallel); still-pending judgments carry over
   * to the next step and are consumed there without waiting.
   */
  async function drainPosted(
    agentId: string,
    turn: number,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<{ messages: UserMessage[]; escalate: boolean }> {
    const keys = pendingPost.list(agentId)
    if (keys.length === 0) return { messages: [], escalate: false }
    const taken = await Promise.all(keys.map(key => board.take<PostedHint[]>(key, deadlineMs, signal)))
    const stillPending: string[] = []
    const messages: UserMessage[] = []
    let escalate = false
    taken.forEach((outcome, index) => {
      const key = keys[index] as string
      if (outcome.status === 'late') {
        stillPending.push(key)
        return
      }
      board.delete(key)
      /* v8 ignore next -- defensive: posted promises never reject and keys are never missing */
      if (outcome.status !== 'ready' || outcome.value === null) return
      for (const hint of outcome.value) {
        if (!hintLedger.admit(agentId, turn, hint.text)) continue
        messages.push(guidance(hint.text, hint.label))
        hint.traceIds.forEach((traceId) => { service.markActed(traceId) })
        if (hint.escalate) escalate = true
      }
    })
    pendingPost.retain(agentId, stillPending)
    return { messages, escalate }
  }

  /**
   * Async pre-step. Critical-path cost: at most `routeDeadlineMs` on fresh
   * steps (overlapping downstream pre-step handlers) plus at most
   * `drainDeadlineMs` when post-execute judgments are still in flight.
   * Continuation steps with nothing pending add no latency at all.
   */
  async function actStep(payload: PreStepPayload, next: PreStepNext): Promise<PreStepDecision> {
    const agentId = payload.agent.id
    const failureSignal = agents.consumeEscalation(agentId)
    trackTurn(agentId, payload.turn)
    trackSession(payload.agent)
    noteStepState(payload)
    // Bounded STOP: only asks Jev when the deterministic detector already
    // sees a 5+ identical streak, so the common path never waits here.
    if (await stopCheck(agentId, payload.signal)) {
      ctx.logger.warn(`system1: stopping hopeless turn for agent ${agentId} (stuck trajectory)`)
      return { kind: 'reject' }
    }
    if (payload.step === 1 && config.preselect) {
      const pending = preselectTasks.get(agentId)
      if (pending !== undefined) {
        preselectTasks.delete(agentId)
        await pending
      }
    }
    await maybePruneHistory(payload.agent, payload.signal)

    const fresh = isFreshStep(payload.step, payload.messages.length)
    const key = turnKey(agentId)
    // Step 1 of a task normally finds the speculative judgment posted at
    // inbox insert; steering claims and inbox-less turns ask here.
    if (fresh && !(payload.step === 1 && board.has(key)) && payload.messages.length > 0) {
      board.post(key, judgeTurn(agentId, payload.messages))
    }
    const [decision, turnOutcome] = await Promise.all([
      next(),
      fresh && board.has(key)
        ? board.take<TurnJudgment>(key, config.routeDeadlineMs, payload.signal)
        : Promise.resolve(null),
    ])
    if (decision.kind === 'reject' || (payload.step === 1 && decision.messages.length === 0)) return decision

    const extra: UserMessage[] = []
    let judged: TurnJudgment | null = null
    if (turnOutcome !== null && turnOutcome.status === 'ready') {
      judged = adoptTurnJudgment(agentId, payload.turn, turnOutcome.value)
    }
    if (judged !== null && judged.delegate && teamToolsSeen.has(agentId)
      && hintLedger.admit(agentId, payload.turn, 'delegation-hint')) {
      service.markActed(judged.delegationTrace)
      extra.push(guidance(buildDelegationHint(), 'delegation'))
    }

    const drained = await drainPosted(agentId, payload.turn, config.drainDeadlineMs, payload.signal)
    const escalate = failureSignal || drained.escalate
    if (escalate) routes.escalate(agentId, payload.turn)
    const route = routes.get(agentId, payload.turn)
    // The strategy hint goes out once per verdict per turn — on the fresh
    // step that set it, or when a failure signal escalated it — never on
    // every continuation step.
    if (route !== null && (fresh || escalate)
      && hintLedger.admit(agentId, payload.turn, `strategy:${route.verdict}:${escalate ? 'esc' : 'base'}`)) {
      /* v8 ignore next -- defensive: the plugin always offers a trace id */
      if (route.traceId !== null) service.markActed(route.traceId)
      extra.push(guidance(buildStrategyHint(route.verdict, escalate), `triage:${route.verdict}`))
    }
    extra.push(...drained.messages)
    if (extra.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...extra] }
  }

  /** Apply one verdict's `modelRoute` override; null when it changes nothing. */
  function routedConfig(current: LlmCallConfig, verdict: TriageVerdict): LlmCallConfig | null {
    const override = config.modelRoute[verdict]
    if (override === undefined) return null
    const routed: LlmCallConfig = {
      ...current,
      ...(override.provider !== undefined ? { provider: override.provider } : {}),
      ...(override.model !== undefined ? { model: override.model } : {}),
      ...(override.reasoningEffort !== undefined
        ? { reasoningEffort: ReasoningEffortId(override.reasoningEffort) }
        : {}),
    }
    if (
      routed.provider === current.provider
      && routed.model === current.model
      && routed.reasoningEffort === current.reasoningEffort
    ) return null
    return routed
  }

  /**
   * Async routing: sticky per turn. A verdict that missed the pre-step
   * deadline but settled since is adopted here via peek (no wait).
   */
  function actRoute(agentId: string, turn: number, current: LlmCallConfig): LlmCallConfig | null {
    if (routes.get(agentId, turn) === null) {
      const peeked = board.peek<TurnJudgment>(turnKey(agentId))
      if (peeked.status === 'ready') adoptTurnJudgment(agentId, turn, peeked.value)
    }
    const route = routes.get(agentId, turn)
    if (route === null) return null
    const routed = routedConfig(current, route.verdict)
    if (routed === null) return null
    if (hintLedger.admit(agentId, turn, `route:${route.verdict}`)) {
      /* v8 ignore next -- defensive: the plugin always offers a trace id */
      if (route.traceId !== null) service.markActed(route.traceId)
      ctx.logger.info(`system1: routing agent ${agentId} turn ${turn} to ${routed.provider}/${routed.model} (triage: ${route.verdict})`)
    }
    return routed
  }

  /**
   * Async judge-before-act: only risky tools wait, and at most
   * `toolGateDeadlineMs`. The prefetch started while the call streamed is
   * reused, so the wait is usually shorter than a full round-trip.
   */
  async function actToolChoice(exec: ToolExecution, next: PreExecuteNext): Promise<PreToolDecision> {
    if (exec.name === SPAWN_TOOL_NAME || !isRiskyTool(exec.name, riskyPatterns)) return await next()
    const judged = await withDeadline(askToolChoice(exec, lifetime.signal), config.toolGateDeadlineMs, exec.signal)
    if (judged === null) return await next()
    service.markActed(judged.traceId)
    const reason = buildToolDenyReason(exec.name, judged.confidence)
    ctx.logger.warn(`system1: denying tool call "${exec.name}" (${reason.slice(0, 160)})`)
    return { kind: 'deny', reason }
  }

  /**
   * Turn a settled post-execute batch into deliverable hints. Pure with
   * respect to the loop (no injection here): the drain decides delivery.
   */
  function interpretPosted(
    decisions: ReadonlyArray<System1Decision<unknown>>,
    kinds: readonly System1QuestionKind[],
    entry: ObservedToolCall,
    repetitions: number,
    spawn: SpawnArgs | null,
    agentId: string,
  ): PostedHint[] {
    const hints: PostedHint[] = []
    const delegationScores: number[] = []
    const delegationTraces: string[] = []
    decisions.forEach((judged, index) => {
      const kind = kinds[index]
      if (judged.value === null || kind === undefined) return
      const traceIds = [judged.trace.id]
      if (kind === 'delegation-triage' && typeof judged.value === 'number') {
        delegationScores.push(judged.value)
        delegationTraces.push(judged.trace.id)
      } else if (kind === 'loop-check' && typeof judged.value === 'number' && judged.value >= config.loopStuckThreshold) {
        if (admitNudge(agentId, `${entry.name}:${entry.argsKey}#stuck:${judged.value.toFixed(2)}`)) {
          hints.push({ text: buildLoopNudge(entry.name, repetitions, judged.value, 'interrupt'), label: 'loop-check', traceIds, escalate: true })
        }
      } else if (kind === 'retry-judgment' && typeof judged.value === 'string') {
        hints.push({ text: buildRetryHint(judged.value as RetryVerdict, entry.name), label: 'retry', traceIds, escalate: true })
      } else if (kind === 'result-triage' && (judged.value === 'error_actionable' || judged.value === 'error_transient')) {
        hints.push({
          text: `System 1: the ${entry.name} result reports a failure that looks ${
            judged.value === 'error_actionable' ? 'actionable' : 'transient'
          } — address it before continuing.`,
          label: 'result-triage',
          traceIds,
          escalate: false,
        })
      } else if (kind === 'injection-screen' && typeof judged.value === 'number' && judged.value >= config.injectionThreshold) {
        ctx.logger.warn(`system1: possible prompt injection in ${entry.name} result (p=${judged.value.toFixed(2)})`)
        hints.push({ text: buildInjectionWarning(entry.name, judged.value), label: 'injection-screen', traceIds, escalate: false })
      } else if (kind === 'subagent-accept' && spawn !== null) {
        if (judged.value === 'fails') {
          /* v8 ignore next -- defensive: the service always provides a judgment */
          const confidence = judged.judgment?.confidence ?? 0
          hints.push({ text: buildSubagentReworkHint(spawn.name, confidence), label: 'subagent-accept', traceIds, escalate: true })
        } else if (judged.value === 'partial') {
          hints.push({
            text: `System 1: the ${spawn.name} teammate's output looks partially complete — verify the missing part before relying on it.`,
            label: 'subagent-accept',
            traceIds,
            escalate: false,
          })
        }
      }
    })
    if (spawn !== null && delegationScores.length === 3) {
      const [novelty, toolRisk, irreversibility] = delegationScores as [number, number, number]
      const oversight = computeDelegationOversight({ novelty, toolRisk, irreversibility }, config.delegationWeights)
      const advisory = buildDelegationAdvisory(spawn.name, oversight)
      delegationStateFor(agentId).noteScores(entry.argsKey, {
        scores: { novelty, toolRisk, irreversibility },
        oversight,
        advisory,
      })
      if (advisory !== null) hints.push({ text: advisory, label: 'delegation-advisory', traceIds: delegationTraces, escalate: false })
    }
    return hints
  }

  /**
   * Async post-execute. Deterministic guidance (loop streaks, duplicate
   * spawns, cached advisories) is attached immediately — it costs nothing.
   * Large-result triage waits at most `resultTriageDeadlineMs` because a
   * replacement must land before the model reads the result. Every other
   * judgment is posted to the board and delivered at the next pre-step.
   */
  async function actToolCall(
    exec: ToolExecution,
    result: ToolExecutionResult,
    next: PostExecuteNext,
  ): Promise<PostToolDecision> {
    const agentId = exec.agent?.id ?? 'unknown-agent'
    const entry: ObservedToolCall = {
      name: exec.name,
      argsKey: argsKeyOf(exec.arguments),
      isError: result.isError,
      at: Date.now(),
    }
    const history = agents.note(agentId)
    history.push(entry)
    while (history.length > 12) history.shift()
    noteResultToolName(agentId, exec.callId, exec.name)

    const contexts: UserMessage[] = []
    const { spawn, duplicateWarning } = result.isError
      ? { spawn: null as SpawnArgs | null, duplicateWarning: null as string | null }
      : recordDelegation(exec)
    if (duplicateWarning !== null) {
      ctx.logger.warn(`system1: ${duplicateWarning}`)
      contexts.push(guidance(duplicateWarning, 'delegation-duplicate'))
    }
    const loop = detectLoop(history)
    if (loop.looping) {
      if (admitNudge(agentId, `${entry.name}:${entry.argsKey}#${loop.repetitions}`)) {
        contexts.push(guidance(buildLoopNudge(entry.name, loop.repetitions, null, loop.suggestion), 'loop-check'))
        agents.noteEscalation(agentId)
      }
      if (spawn !== null) {
        const cached = delegationStateFor(agentId).takeScores(entry.argsKey)
        /* v8 ignore next -- defensive: the async cache-hit path mirrors the tested blocking path; timing-dependent in tests */
        if (cached !== null && cached.advisory !== null) contexts.push(guidance(cached.advisory, 'delegation-advisory'))
      }
      return withContexts(await next(), contexts)
    }

    const questions: System1Question[] = []
    const validators: Array<(answer: unknown) => unknown> = []
    const kinds: System1QuestionKind[] = []
    if (loop.repetitions >= 2) {
      questions.push(buildLoopQuestion(history))
      validators.push(validateLoopAnswer)
      kinds.push('loop-check')
    }
    if (result.isError) {
      questions.push(buildRetryQuestion(entry.name, entry.argsKey, result.error.message))
      validators.push(validateRetry)
      kinds.push('retry-judgment')
    }
    if (spawn !== null) {
      const cached = delegationStateFor(agentId).takeScores(entry.argsKey)
      if (cached === null) {
        for (const scoreQuestion of buildDelegationScoreQuestions(spawn.name, spawn.description, spawn.prompt)) {
          questions.push(scoreQuestion)
          validators.push(validateDelegationScore)
          kinds.push('delegation-triage')
        }
      } else if (cached.advisory !== null) {
        contexts.push(guidance(cached.advisory, 'delegation-advisory'))
      }
    }
    const resultQuestions = buildResultQuestions(exec, result, spawn)
    let triageIndex = -1
    resultQuestions.questions.forEach((question, index) => {
      const kind = resultQuestions.kinds[index] as System1QuestionKind
      if (kind === 'result-triage') {
        triageIndex = index
        return
      }
      questions.push(question)
      validators.push(resultQuestions.validators[index] as (answer: unknown) => unknown)
      kinds.push(kind)
    })

    // Everything but large-result triage: post and move on.
    if (questions.length > 0) {
      const key = postKey(agentId, String(exec.callId))
      const repetitions = loop.repetitions
      board.post(key, service.askMany(questions, validators, 'turn', lifetime.signal, agentId)
        .then(decisions => interpretPosted(decisions, kinds, entry, repetitions, spawn, agentId)))
      pendingPost.push(agentId, key)
    }

    // Large-result triage: bounded wait, because a replacement only helps
    // before the model reads the result.
    let replacement: ContentBlock[] | null = null
    if (triageIndex >= 0) {
      const triageQuestion = resultQuestions.questions[triageIndex] as System1Question
      const triageValidator = resultQuestions.validators[triageIndex] as (answer: unknown) => unknown
      const asked = service.askMany([triageQuestion], [triageValidator], 'turn', lifetime.signal, agentId)
        /* v8 ignore next -- defensive: askMany always returns one decision per question */
        .then(decisions => decisions[0] ?? null)
      const judged = await withDeadline(asked, config.resultTriageDeadlineMs, exec.signal)
      /* v8 ignore next -- defensive: the stub backend always responds with a valid string verdict before the deadline */
      if (judged !== null && typeof judged.value === 'string') {
        const verdict = judged.value as ResultTriageVerdict
        if (verdict === 'noisy_keep_head' || verdict === 'irrelevant') {
          const head = resultQuestions.resultText.slice(0, config.triageHeadChars)
          replacement = [{ type: 'text', text: `${head}${buildPruneMarker(entry.name, resultQuestions.resultText.length)}` }]
          ctx.logger.warn(`system1: result triage dropped ${resultQuestions.resultText.length} chars from ${entry.name} (${verdict})`)
          service.markActed(judged.trace.id)
        } else if (verdict === 'error_actionable' || verdict === 'error_transient') {
          contexts.push(guidance(`System 1: the ${entry.name} result reports a failure that looks ${
            verdict === 'error_actionable' ? 'actionable' : 'transient'
          } — address it before continuing.`, 'result-triage'))
          service.markActed(judged.trace.id)
        }
      } else if (judged === null) {
        // Late: the content can no longer be replaced, but an error verdict
        // is still worth delivering at the next pre-step.
        const key = postKey(agentId, `${String(exec.callId)}:triage`)
        /* v8 ignore next -- defensive: the stub backend always resolves before the late timeout in tests */
        board.post(key, asked.then(late => (late === null ? [] : interpretPosted([late], ['result-triage'], entry, 0, null, agentId))))
        pendingPost.push(agentId, key)
      }
    }

    const withGuidance = withContexts(await next(), contexts)
    if (replacement !== null && withGuidance.kind === 'accept') {
      // Rebuild the accept explicitly: a replacement carries content, and
      // content and a structured `value` are mutually exclusive.
      return {
        kind: 'accept',
        content: replacement,
        ...(withGuidance.additionalContexts === undefined ? {} : { additionalContexts: withGuidance.additionalContexts }),
      }
    }
    return withGuidance
  }

  const disposeTriage = ctx.on('agent/pre-step', async (payload, next) => {
    if (asyncAct) return await actStep(payload, next)
    if (enforce) return await enforceStep(payload, next)
    const decision = await next()
    // Observation runs after delegation and never feeds back into the decision.
    // The service never rejects, so the catch is purely defensive: a
    // fire-and-forget observation must not surface an unhandled rejection.
    /* v8 ignore next -- defensive: System1Service.ask/askMany never reject */
    void observeStep(payload).catch(() => undefined)
    return decision
  })

  const disposeTools = ctx.on('tools/post-execute', async (exec, result, next) => {
    if (asyncAct) return await actToolCall(exec, result, next)
    if (enforce) return await enforceToolCall(exec, result, next)
    const decision = await next()
    /* v8 ignore next -- defensive: System1Service.askMany never rejects */
    void observeToolCall(exec, result).catch(() => undefined)
    return decision
  })

  /**
   * Judge-before-act: in enforce mode a confident wrong-tool verdict denies
   * the dispatch before it runs; in shadow/assist the same question is
   * asked without delaying the dispatch and recorded as a trace (assist
   * warns the operator).
   */
  const disposePreExecute = ctx.on('tools/pre-execute', async (exec, next) => {
    if (asyncAct) return await actToolChoice(exec, next)
    if (enforce) return await judgeToolChoice(exec, next)
    /* v8 ignore next -- defensive: System1Service.askMany never rejects */
    void observeToolChoice(exec).catch(() => undefined)
    return await next()
  })

  /**
   * Observe-only final-answer check: the turn is over, so the waterfall is
   * never delayed — the question is fire-and-forget on the plugin's own
   * lifetime signal, like the other shadow observations.
   */
  const disposeTurnStopping = ctx.on('agent/turn-stopping', (payload) => {
    // Drop stale prefetches: a streamed call that never reached pre-execute
    // (aborted turn, rejected step) must not leak into the next turn.
    prefetches.delete(payload.agent.id)
    if (asyncAct) {
      // Judgments still in flight when the turn ends would land as stale
      // guidance on the next turn: drop them (their traces still record).
      board.delete(turnKey(payload.agent.id))
      for (const key of pendingPost.list(payload.agent.id)) board.delete(key)
      pendingPost.reset(payload.agent.id)
    }
    /* v8 ignore next -- defensive: System1Service.askMany never rejects */
    void observeFinalAnswer(payload.agent, payload.turn).catch(() => undefined)
  })

  /**
   * Stream-time speculation: `agent/assistant-stream` tool-call-delta
   * chunks start the tool-choice judgment while the call streams. The
   * handler is synchronous and never throws — a missed chunk only costs
   * the optimization, never correctness.
   */
  const disposeAssistantStream = ctx.on('agent/assistant-stream', (payload) => {
    try {
      prefetchFromStream(payload)
    } catch {
      // A malformed chunk must not break the stream.
    }
  })

  /**
   * Model routing: in enforce mode the cached triage verdict may replace
   * the call config (provider/model/effort) per `modelRoute`. Follows the
   * documented pattern — `next()` yields the config the machine would use,
   * return a replacement to switch. Shadow/assist only delegate: routing
   * never actuates outside enforce.
   */
  const disposeRequest = ctx.on('agent/request', async (payload, next) => {
    const current = await next()
    if (!enforce) return current
    if (asyncAct) return actRoute(payload.agent.id, payload.turn, current) ?? current
    return routeModel(payload.agent.id, payload.turn, payload.step, current) ?? current
  })

  /**
   * Request-error recovery: in enforce mode a confident transient verdict
   * owns the retry; otherwise — and always in shadow/assist — the loop
   * default decides. Shadow/assist observe trace-only without delaying the
   * waterfall.
   */
  const disposeRequestError = ctx.on('agent/request-error', async (payload, next) => {
    if (enforce) return await judgeRequestError(payload, next)
    const action = await next()
    /* v8 ignore next -- defensive: System1Service.askMany never rejects */
    void observeRequestError(payload).catch(() => undefined)
    return action
  })

  /**
   * Task-boundary reset: inbox traffic inserted while the agent is idle
   * starts a new task — refresh budgets and the loop-nudge allowance before
   * the turn wakes. Insertions fire before the wake, so the insert still
   * sees `idle`; inserts while running are steering, not new tasks.
   */
  const disposeInbox = ctx.on('agent/inbox/inserted', (payload) => {
    const newTask = resetTaskOnFreshUserMessage(payload.agent.id)
    // Speculative turn triage: the judgment starts at insert time, so its
    // round-trip overlaps the agent's wake and pre-step instead of adding
    // to it. Only for idle inserts — running inserts are steering, claimed
    // by a later pre-step that triages them itself.
    if (newTask && asyncAct) {
      resetAsyncState(payload.agent.id)
      board.post(turnKey(payload.agent.id), judgeTurn(payload.agent.id, [payload.message]))
    }
    // Session-start preselection begins at the task's first message so the
    // Jev round-trip overlaps the wake; the first pre-step awaits it before
    // the request is built, so the restriction lands in time either way.
    if (newTask && enforce && config.preselect) {
      const pending = runPreselect(payload.agent, fullMessageText(payload.message))
      preselectTasks.set(payload.agent.id, pending)
      capMap(preselectTasks, MAX_TRACKED_AGENTS)
      /* v8 ignore next -- defensive: runPreselect never rejects */
      void pending.catch(() => undefined)
    }
  })

  /** Track running/idle per agent for the task-boundary reset. */
  const disposeStatus = ctx.on('agent/status', (payload) => {
    agentStatus.set(payload.agent.id, payload.status)
    capMap(agentStatus, 128)
  })

  ctx.effect(() => () => {
    lifetime.abort(new Error('system1: plugin disposed'))
    disposeTelemetry()
    disposeTriage()
    disposeTools()
    disposePreExecute()
    disposeTurnStopping()
    disposeAssistantStream()
    disposeRequest()
    disposeRequestError()
    disposeInbox()
    disposeStatus()
    // Backend teardown is best-effort; a failure here must not break disposal.
    /* v8 ignore next -- defensive: teardown failures must not break disposal */
    void backend.dispose().catch(() => undefined)
  }, 'system1: dispose listeners and backend')
}
