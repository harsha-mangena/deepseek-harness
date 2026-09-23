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
 * style of the repeat-tool reminder; `enforce` actuation is deferred (see
 * README "Deferred Work").
 *
 * Laya (local sidecar) is currently deferred — see README.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { System1Backend } from './backend.ts'
import { JevBackend } from './backends/jev.ts'
import { LayaBackend, type BackendLogger } from './backends/laya.ts'
import { NullBackend } from './backends/null.ts'
import {
  argsKeyOf,
  buildLoopQuestion,
  buildRetryQuestion,
  buildTriageQuestion,
  detectLoop,
  validateLoopAnswer,
  validateRetry,
  validateTriage,
  type ObservedToolCall,
} from './gates.ts'
import { System1Service } from './service.ts'
import type {
  System1BackendKind,
  System1Decision,
  System1Mode,
  System1Question,
  System1RuntimeConfig,
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
  /** Jev model alias or pinned version. Pin (e.g. `jev-1.13.0`) once thresholds are tuned. */
  jevModel: string
  /** Laya sidecar decision endpoint URL (used when `layaAutoStart` is false). */
  layaEndpoint: string
  /** Start a local Laya sidecar on demand instead of using `layaEndpoint`. */
  layaAutoStart: boolean
  /** Command used to start the local Laya sidecar. */
  layaCommand: string[]
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  backend: z.union(['laya', 'jev', 'none'] as const).default('jev'),
  mode: z.union(['shadow', 'assist', 'enforce'] as const).default('shadow'),
  confidenceThreshold: z.percent().default(0.7),
  budgetPerTurn: z.natural().default(4),
  budgetPerTask: z.natural().default(12),
  timeoutMs: z.natural().default(1200),
  failureThreshold: z.natural().min(1).default(3),
  cooldownMs: z.natural().default(30_000),
  traceBufferSize: z.natural().min(1).default(200),
  jevApiKeyEnv: z.string().min(1).default('TYPESAFE_API_KEY'),
  jevEndpoint: z.string().min(1).default('https://api.typesafe.ai/v1/systemone'),
  jevModel: z.string().min(1).default('jev-latest'),
  layaEndpoint: z.string().min(1).default('http://127.0.0.1:17840/decide'),
  layaAutoStart: z.boolean().default(true),
  layaCommand: z.array(z.string()).min(1).default(['python3', '-m', 'laya_serve']),
})

type PreStepPayload = Parameters<Events['agent/pre-step']>[0]

/** Probability above which a loop-check noul counts as "stuck". Lives in code, not the prompt. */
const LOOP_STUCK_THRESHOLD = 0.7

function toRuntimeConfig(config: Config): System1RuntimeConfig {
  return {
    backend: config.backend,
    mode: config.mode,
    enabled: config.enabled,
    confidenceThreshold: config.confidenceThreshold,
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
 * Bounded per-agent tracking state for loop detection and turn resets.
 * Noting a new agent past `maxAgents` evicts the least-recently-noted
 * agent's history and turn marker, so long-running hosts cannot grow these
 * maps without bound. Exported for tests.
 *
 * @internal
 */
export function createAgentState(maxAgents: number = MAX_TRACKED_AGENTS): {
  /** Loop history per agent; `note` keeps this bounded. */
  readonly histories: Map<string, ObservedToolCall[]>
  /** Last seen turn per agent; `note` eviction keeps this bounded. */
  readonly turns: Map<string, number>
  /**
   * Ensure tracking state exists for `agentId`, evicting the oldest agent
   * when over budget. Returns the agent's loop history.
   */
  note(agentId: string): ObservedToolCall[]
} {
  const histories = new Map<string, ObservedToolCall[]>()
  const turns = new Map<string, number>()
  return {
    histories,
    turns,
    note(agentId: string): ObservedToolCall[] {
      const existing = histories.get(agentId)
      if (existing !== undefined) return existing
      if (histories.size >= Math.max(1, maxAgents)) {
        // Non-empty here: size >= max(1, maxAgents) >= 1, so a key exists.
        const oldest = histories.keys().next().value as string
        histories.delete(oldest)
        turns.delete(oldest)
      }
      const history: ObservedToolCall[] = []
      histories.set(agentId, history)
      return history
    },
  }
}

/**
 * Install System 1 shadow observers on the agent loop. Listeners always
 * delegate first (`next()`) and observe afterwards, so a slow or failing
 * backend can never change or delay loop behavior.
 *
 * Shadow observations run on the plugin's own lifetime signal, bounded by
 * the service timeout — not on the step/tool signals handed to the
 * listeners. Those belong to the turn and the tool execution and may be
 * aborted after the waterfall settles while a fire-and-forget observation
 * is still in flight; letting them cancel the observation would poison the
 * circuit breaker with backend-error fallbacks that say nothing about
 * backend health.
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

  if (config.mode === 'enforce') {
    ctx.logger.warn('system1: enforce-mode actuation is deferred; running with assist behavior')
  }

  /** Classify the incoming step; shadow only, the decision always passes through. */
  async function observeStep(payload: PreStepPayload): Promise<void> {
    const agentId = payload.agent.id
    agents.note(agentId)
    if (agents.turns.get(agentId) !== payload.turn) {
      agents.turns.set(agentId, payload.turn)
      service.resetTurn()
    }
    const question = buildTriageQuestion(payload.messages)
    await service.ask(question, 'turn', lifetime.signal, validateTriage)
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
      && loopDecision.value >= LOOP_STUCK_THRESHOLD
      && config.mode !== 'shadow'
    ) {
      ctx.logger.warn(
        `system1: jev judges agent ${agentId} stuck (p=${loopDecision.value.toFixed(2)}, model=${loopDecision.trace.model ?? 'unknown'})`,
      )
    }
  }

  const disposeTriage = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    // Observation runs after delegation and never feeds back into the decision.
    // The service never rejects, so the catch is purely defensive: a
    // fire-and-forget observation must not surface an unhandled rejection.
    /* v8 ignore next -- defensive: System1Service.ask/askMany never reject */
    void observeStep(payload).catch(() => undefined)
    return decision
  })

  const disposeTools = ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    /* v8 ignore next -- defensive: System1Service.askMany never rejects */
    void observeToolCall(exec, result).catch(() => undefined)
    return decision
  })

  ctx.effect(() => () => {
    lifetime.abort(new Error('system1: plugin disposed'))
    disposeTriage()
    disposeTools()
    // Backend teardown is best-effort; a failure here must not break disposal.
    /* v8 ignore next -- defensive: teardown failures must not break disposal */
    void backend.dispose().catch(() => undefined)
  }, 'system1: dispose listeners and backend')
}
