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
  /** Per-batch backend timeout in milliseconds. Jev answers in 70-500ms. */
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

/**
 * Install System 1 shadow observers on the agent loop. Listeners always
 * delegate first (`next()`) and observe afterwards, so a slow or failing
 * backend can never change or delay loop behavior.
 *
 * @param ctx - plugin context that owns the listeners and backend lifetime.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const runtime = toRuntimeConfig(config)
  const backend = createBackend(runtime, ctx.logger)
  const service = new System1Service(backend, runtime)
  const recentCalls = new Map<string, ObservedToolCall[]>()
  const lastTurn = new Map<string, number>()

  if (config.mode === 'enforce') {
    ctx.logger.warn('system1: enforce-mode actuation is deferred; running with assist behavior')
  }

  /** Classify the incoming step; shadow only, the decision always passes through. */
  async function observeStep(payload: PreStepPayload): Promise<void> {
    const agentId = payload.agent.id
    if (lastTurn.get(agentId) !== payload.turn) {
      lastTurn.set(agentId, payload.turn)
      service.resetTurn()
    }
    const question = buildTriageQuestion(payload.messages)
    await service.ask(question, 'turn', payload.signal, validateTriage)
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
    const history = recentCalls.get(agentId) ?? []
    history.push(entry)
    while (history.length > 12) history.shift()
    recentCalls.set(agentId, history)

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

    const decisions = await service.askMany(questions, validators, 'turn', exec.signal)
    const loopDecision = decisions[0]
    if (
      questions[0]?.kind === 'loop-check'
      && typeof loopDecision?.value === 'number'
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
    void observeStep(payload).catch(() => undefined)
    return decision
  })

  const disposeTools = ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    void observeToolCall(exec, result).catch(() => undefined)
    return decision
  })

  ctx.effect(() => () => {
    disposeTriage()
    disposeTools()
    void backend.dispose().catch(() => undefined)
  }, 'system1: dispose listeners and backend')
}
