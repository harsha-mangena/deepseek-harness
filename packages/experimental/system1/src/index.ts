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
 * `reject` (turn `blocked`) instead of burning more tokens; and delegation
 * triage advises the Lead on teammate spawns (orchestrator layer:
 * judge-before-delegate). A failure signal (acted-on retry hint or loop
 * nudge) escalates the next step's reasoning one level. Every actuation is
 * bounded (timeouts, budgets, nudge caps) and any failure falls back to
 * existing harness behavior. The final-answer check is observe-only in all
 * modes: the turn is already over at `agent/turn-stopping`, so there is no
 * veto — assist mode warns the operator when the closing answer clearly
 * misses the request.
 *
 * Laya (local sidecar) is currently deferred — see README.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  PostToolDecision,
  PreToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import type { System1Backend } from './backend.ts'
import { JevBackend } from './backends/jev.ts'
import { LayaBackend, type BackendLogger } from './backends/laya.ts'
import { NullBackend } from './backends/null.ts'
import {
  argsKeyOf,
  buildDelegationHint,
  buildDelegationQuestion,
  buildDelegationScoreQuestions,
  buildFinalAnswerQuestion,
  buildLoopNudge,
  buildLoopQuestion,
  buildRetryHint,
  buildRetryQuestion,
  buildStrategyHint,
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
  validateLoopAnswer,
  validateRetry,
  validateToolChoice,
  validateTriage,
  type ObservedToolCall,
} from './gates.ts'
import { System1Service } from './service.ts'
import {
  buildDelegationAdvisory,
  buildDuplicateWarning,
  computeDelegationOversight,
  createDelegationState,
  extractSpawnArgs,
  SPAWN_TOOL_NAME,
} from './orchestrator.ts'
import type {
  DelegationWeights,
  RetryVerdict,
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
})

type PreStepPayload = Parameters<Events['agent/pre-step']>[0]
type PreStepNext = Parameters<Events['agent/pre-step']>[1]
type PreStepDecision = Awaited<ReturnType<PreStepNext>>
type PreExecuteNext = Parameters<Events['tools/pre-execute']>[1]
type PostExecuteNext = Parameters<Events['tools/post-execute']>[2]

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
} {
  const histories = new Map<string, ObservedToolCall[]>()
  const turns = new Map<string, number>()
  const loopNudges = new Map<string, number>()
  const lastNudgeKey = new Map<string, string>()
  const escalations = new Map<string, boolean>()
  return {
    histories,
    turns,
    loopNudges,
    lastNudgeKey,
    escalations,
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
      }
      const history: ObservedToolCall[] = []
      histories.set(agentId, history)
      return history
    },
    resetTask(agentId: string): void {
      loopNudges.delete(agentId)
      lastNudgeKey.delete(agentId)
      escalations.delete(agentId)
    },
    noteEscalation(agentId: string): void {
      escalations.set(agentId, true)
    },
    consumeEscalation(agentId: string): boolean {
      const escalated = escalations.get(agentId) === true
      escalations.delete(agentId)
      return escalated
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
  /**
   * Orchestrator-level delegation memory: recent `spawn_teammate` calls for
   * duplicate-purpose detection. Only consulted for that tool, which exists
   * solely when the agent-team packages are installed — otherwise inert.
   */
  const delegations = createDelegationState()
  /**
   * Whether this session has shown team tooling (`spawn_teammate`
   * observed). The pre-step delegation hint only fires when true, so agents
   * without teammates never see delegation noise.
   */
  let teamToolsSeen = false
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

  /** Cap a map at `cap` entries, evicting the oldest first. */
  function capMap(map: Map<string, unknown>, cap: number): void {
    while (map.size > cap) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  /**
   * Track the agent's turn; a new agent or a turn-number reset starts a new
   * task, which refreshes budgets and the loop-nudge allowance. Also wires
   * the service's per-task reset, which previously never fired.
   */
  function trackTurn(agentId: string, turn: number): void {
    agents.note(agentId)
    const prev = agents.turns.get(agentId)
    agents.turns.set(agentId, turn)
    if (prev === undefined || turn < prev) {
      service.resetTask()
      agents.resetTask(agentId)
    } else if (turn !== prev) {
      service.resetTurn()
    }
  }

  /** One System 1 guidance message, sourced so the agent knows who is talking. */
  function guidance(text: string): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'system1' },
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
    stepPreviews.set(payload.agent.id, previewMessages(payload.messages).join('\n'))
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
   * Shared tool-choice judge: one Jev `choice` per proposed tool call —
   * should this call proceed, or is it clearly the wrong tool for the
   * step's apparent goal? Skips exact consecutive duplicates (the loop
   * machinery owns repetition). Returns the verdict with its confidence
   * and trace id, or null when there is no confident wrong-tool verdict.
   * Never rejects; budget exhaustion and backend failure read as null.
   */
  async function askToolChoice(
    exec: ToolExecution,
    signal: AbortSignal,
  ): Promise<{ verdict: ToolChoiceVerdict; confidence: number; traceId: string } | null> {
    const agentId = exec.agent?.id ?? ''
    const argsKey = argsKeyOf(exec.arguments)
    const last = lastPreExecute.get(agentId)
    if (last !== undefined && last.name === exec.name && last.argsKey === argsKey) return null
    lastPreExecute.set(agentId, { name: exec.name, argsKey })
    capMap(lastPreExecute, 128)
    const history = agents.histories.get(agentId) ?? []
    const question = buildToolChoiceQuestion(
      exec.name,
      argsKey,
      previewToolHistory(history),
      stepPreviews.get(agentId) ?? '',
    )
    const [decision] = await service.askMany([question], [validateToolChoice], 'turn', signal)
    if (decision === undefined || decision.value === null || decision.value === 'proceed') return null
    return {
      verdict: decision.value as ToolChoiceVerdict,
      confidence: decision.judgment?.confidence ?? 0,
      traceId: decision.trace.id,
    }
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
    const history = agents.histories.get(agentId) ?? []
    if (!detectLoop(history, 5).looping) return false
    const [decision] = await service.askMany(
      [buildLoopQuestion(history)],
      [validateLoopAnswer],
      'turn',
      signal,
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
    const qa = extractFinalQa(offset !== undefined ? messages.slice(offset) : messages)
    if (qa === null) return
    const [decision] = await service.askMany(
      [buildFinalAnswerQuestion(qa.request, qa.answer)],
      [validateFinalAnswer],
      'turn',
      lifetime.signal,
    )
    if (decision === undefined || decision.value !== 'inadequate') return
    service.markActed(decision.trace.id)
    if (config.mode === 'assist') {
      ctx.logger.warn(
        `system1: final answer for agent ${agent.id} looks inadequate (confidence ${(decision.judgment?.confidence ?? 0).toFixed(2)})`,
      )
    }
  }

  /** Classify the incoming step; shadow only, the decision always passes through. */
  async function observeStep(payload: PreStepPayload): Promise<void> {
    trackTurn(payload.agent.id, payload.turn)
    noteStepState(payload)
    // Triage and delegability travel in one batch — Jev evaluates questions
    // in parallel, so the delegation question costs barely more than triage
    // alone, and the delegability answers accumulate a shadow-mode dataset.
    const questions = [buildTriageQuestion(payload.messages), buildDelegationQuestion(payload.messages)]
    const validators: Array<(answer: unknown) => unknown> = [validateTriage, validateDelegation]
    await service.askMany(questions, validators, 'turn', lifetime.signal)
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
    noteStepState(payload)
    // Bounded STOP first: a hopeless trajectory (long identical-call streak
    // plus Jev nearly certain the agent is stuck) ends here instead of
    // spending another model call and tool round-trip on it.
    if (await stopCheck(payload.agent.id, payload.signal)) {
      ctx.logger.warn(`system1: stopping hopeless turn for agent ${payload.agent.id} (stuck trajectory)`)
      return { kind: 'reject' }
    }
    const questions = [buildTriageQuestion(payload.messages), buildDelegationQuestion(payload.messages)]
    const validators: Array<(answer: unknown) => unknown> = [validateTriage, validateDelegation]
    const judged = service.askMany(questions, validators, 'turn', payload.signal)
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
        ? verdict === 'trivial' ? 'standard' : 'complex'
        : verdict
      service.markActed(triage.trace.id)
      messages.push(guidance(buildStrategyHint(effective, escalated)))
    }
    const delegation = decisions[1]
    if (delegation !== undefined && delegation.value === true && teamToolsSeen) {
      // The delegation validator passed, so the value is a boolean.
      service.markActed(delegation.trace.id)
      messages.push(guidance(buildDelegationHint()))
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

    const loop = detectLoop(history)
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

    // Orchestrator layer: delegation observation is independent of the
    // loop/retry batch below, so it runs before the empty-batch early return.
    await observeDelegation(exec, result)

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
    if (questions.length === 0) return

    const decisions = await service.askMany(questions, validators, 'turn', lifetime.signal)
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
      ctx.logger.warn(
        `system1: jev judges agent ${agentId} stuck (p=${loopDecision.value.toFixed(2)}, model=${loopDecision.trace.model ?? 'unknown'})`,
      )
    }
  }

  /**
   * Orchestrator layer, shadow/assist: judge the delegation itself. The
   * spawn is recorded for duplicate detection in every mode; the composite
   * (novelty/tool-risk/irreversibility) is traced always and additionally
   * warned in assist. Never injects.
   */
  async function observeDelegation(exec: ToolExecution, result: ToolExecutionResult): Promise<void> {
    if (exec.name !== SPAWN_TOOL_NAME || result.isError) return
    const spawn = extractSpawnArgs(exec.arguments)
    if (spawn === null) return
    teamToolsSeen = true
    const duplicate = delegations.findDuplicate(spawn.name, spawn.description)
    delegations.noteSpawn(spawn.name, spawn.description)
    // Composite scoring (TypeSafe's pattern): three atomic scores, combined
    // with weights in code — one Choice hiding several judgments is an
    // anti-pattern.
    const scoreQuestions = buildDelegationScoreQuestions(spawn.name, spawn.description, spawn.prompt)
    const decisions = await service.askMany(
      scoreQuestions,
      [validateDelegationScore, validateDelegationScore, validateDelegationScore],
      'turn',
      lifetime.signal,
    )
    if (config.mode === 'shadow') return
    if (duplicate !== null) {
      ctx.logger.warn(`system1: ${buildDuplicateWarning(spawn.name, duplicate)}`)
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

    const contexts: UserMessage[] = []
    const loop = detectLoop(history)
    if (loop.looping) {
      // Deterministic signal: nudge without spending a model call.
      if (admitNudge(agentId, `${entry.name}:${entry.argsKey}#${loop.repetitions}`)) {
        contexts.push(guidance(buildLoopNudge(entry.name, loop.repetitions, null, loop.suggestion)))
        agents.noteEscalation(agentId)
      }
      ctx.logger.warn(
        `system1: possible tool loop for agent ${agentId}: "${entry.name}" repeated ${loop.repetitions}x (suggestion: ${loop.suggestion})`,
      )
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
    // questions alone. The duplicate check is deterministic and runs before
    // the spawn is recorded, so the candidate never matches itself.
    const spawn = exec.name === SPAWN_TOOL_NAME && !result.isError
      ? extractSpawnArgs(exec.arguments)
      : null
    let duplicateWarning: string | null = null
    if (spawn !== null) {
      teamToolsSeen = true
      const duplicate = delegations.findDuplicate(spawn.name, spawn.description)
      delegations.noteSpawn(spawn.name, spawn.description)
      if (duplicate !== null) {
        duplicateWarning = buildDuplicateWarning(spawn.name, duplicate)
        ctx.logger.warn(`system1: ${duplicateWarning}`)
      }
      const scoreQuestions = buildDelegationScoreQuestions(spawn.name, spawn.description, spawn.prompt)
      for (const scoreQuestion of scoreQuestions) {
        questions.push(scoreQuestion)
        validators.push(validateDelegationScore)
        kinds.push('delegation-triage')
      }
    }
    const decisions = questions.length > 0
      ? await service.askMany(questions, validators, 'turn', exec.signal)
      : []

    const decision = await next()
    // The duplicate warning is the most urgent guidance: it leads.
    if (duplicateWarning !== null) contexts.push(guidance(duplicateWarning))
    // Delegation scores accumulate across the three composite questions;
    // they resolve after the per-question loop below.
    const delegationScores: number[] = []
    const delegationScoreTraces: Array<{ trace: { id: string } }> = []
    decisions.forEach((judged, index) => {
      const kind = kinds[index]
      if (judged.value === null || kind === undefined) return
      if (kind === 'delegation-triage' && typeof judged.value === 'number') {
        delegationScores.push(judged.value)
        delegationScoreTraces.push(judged)
        return
      }
      if (kind === 'loop-check' && typeof judged.value === 'number' && judged.value >= config.loopStuckThreshold) {
        ctx.logger.warn(
          `system1: jev judges agent ${agentId} stuck (p=${judged.value.toFixed(2)}, model=${judged.trace.model ?? 'unknown'})`,
        )
        if (admitNudge(agentId, `${entry.name}:${entry.argsKey}#stuck:${judged.value.toFixed(2)}`)) {
          contexts.push(guidance(buildLoopNudge(entry.name, loop.repetitions, judged.value, 'interrupt')))
          service.markActed(judged.trace.id)
          agents.noteEscalation(agentId)
        }
        return
      }
      if (kind === 'retry-judgment' && typeof judged.value === 'string') {
        // The retry validator passed, so the string is a RetryVerdict.
        const verdict = judged.value as RetryVerdict
        contexts.push(guidance(buildRetryHint(verdict, entry.name)))
        service.markActed(judged.trace.id)
        // A failure the harness acted on arms one level of deeper reasoning
        // for the next step: same failure, harder thinking.
        agents.noteEscalation(agentId)
      }
    })
    if (spawn !== null && delegationScores.length === 3) {
      const [novelty, toolRisk, irreversibility] = delegationScores as [number, number, number]
      const oversight = computeDelegationOversight({ novelty, toolRisk, irreversibility }, config.delegationWeights)
      const advisory = buildDelegationAdvisory(spawn.name, oversight)
      if (advisory !== null) {
        ctx.logger.warn(`system1: ${advisory}`)
        contexts.push(guidance(advisory))
        delegationScoreTraces.forEach((traced) => { service.markActed(traced.trace.id) })
      }
    }
    return withContexts(decision, contexts)
  }

  /** Fold injected guidance into an accepted tool decision; blocks pass through untouched. */
  function withContexts(decision: PostToolDecision, contexts: UserMessage[]): PostToolDecision {
    if (decision.kind === 'block' || contexts.length === 0) return decision
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), ...contexts] }
  }

  const disposeTriage = ctx.on('agent/pre-step', async (payload, next) => {
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
    /* v8 ignore next -- defensive: System1Service.askMany never rejects */
    void observeFinalAnswer(payload.agent, payload.turn).catch(() => undefined)
  })

  ctx.effect(() => () => {
    lifetime.abort(new Error('system1: plugin disposed'))
    disposeTriage()
    disposeTools()
    disposePreExecute()
    disposeTurnStopping()
    // Backend teardown is best-effort; a failure here must not break disposal.
    /* v8 ignore next -- defensive: teardown failures must not break disposal */
    void backend.dispose().catch(() => undefined)
  }, 'system1: dispose listeners and backend')
}
