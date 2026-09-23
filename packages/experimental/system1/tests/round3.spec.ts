/**
 * Round-3 tests for the System 1 plugin.
 *
 * Round 3 closes the lifecycle seams the committed plugin left open and
 * wires the two remaining harness seams that genuinely exist (verified
 * against the harness source):
 *
 * - B1 — task-boundary reset: `agent/inbox/inserted` while the agent is
 *   `idle` starts a new task and refreshes per-agent budgets and the
 *   loop-nudge allowance; insertions while `running` are steering and do
 *   not reset. Long-lived agents can no longer silently degrade to
 *   budget-exhausted fallbacks.
 * - B2 — delegation bookkeeping is deterministic and runs before the loop
 *   early return, so a repeated `spawn_teammate` cannot dodge the registry
 *   or the duplicate-purpose warning by looking like a loop.
 * - B7 — `argsKeyOf` canonicalizes nested key order, so identical calls
 *   with different key order are detected as repeats.
 * - Per-agent isolation: budgets, delegation registry, and `teamToolsSeen`
 *   are partitioned per agent instead of shared globally.
 * - `agent/request` model routing (enforce only): the cached triage verdict
 *   may replace the call config per a configured verdict→override table.
 *   No extra model call; stale or missing verdicts leave config unchanged.
 * - `agent/request-error` retry judgment (enforce only): a confident
 *   transient verdict owns one bounded retry; anything else delegates to
 *   the loop default. Shadow/assist only observe.
 *
 * Every composition test boots the real Loader composition with a stubbed
 * Jev `fetch` and dispatches the real waterfalls, following the round-2
 * pattern.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context, type Events } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type {
  PostToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import * as System1Plugin from '../src/index.ts'
import { argsKeyOf, buildRequestRetryQuestion, validateRequestRetry } from '../src/gates.ts'
import type { System1Backend } from '../src/backend.ts'
import { System1Service } from '../src/service.ts'
import type { System1Judgment, System1Question, System1RuntimeConfig } from '../src/types.ts'

// ---------------------------------------------------------------------------
// Unit: gates (B7, request-retry)
// ---------------------------------------------------------------------------

it('B7: argsKeyOf sorts object keys recursively', () => {
  expect(argsKeyOf({ b: 2, a: 1 })).toBe(argsKeyOf({ a: 1, b: 2 }))
  expect(argsKeyOf({ outer: { z: 1, a: { d: 4, c: 3 } } }))
    .toBe(argsKeyOf({ outer: { a: { c: 3, d: 4 }, z: 1 } }))
})

it('B7: argsKeyOf preserves array order and distinguishes values', () => {
  expect(argsKeyOf([1, 2, 3])).not.toBe(argsKeyOf([3, 2, 1]))
  expect(argsKeyOf({ a: 1 })).not.toBe(argsKeyOf({ a: 2 }))
  expect(argsKeyOf(null)).toBe(argsKeyOf(null))
})

it('request-retry question carries the failure facts and a bounded threshold', () => {
  const question = buildRequestRetryQuestion(
    { message: 'upstream timeout', code: 'timeout', status: 503 },
    'test-provider',
    1,
  )
  expect(question.kind).toBe('request-retry')
  expect(question.primitive).toBe('choice')
  expect(question.options).toBeDefined()
  expect(typeof question.options?.retry).toBe('string')
  expect(typeof question.options?.fail).toBe('string')
  expect(question.context).toMatchObject({ provider: 'test-provider', code: 'timeout', attempt: 1 })
  expect(question.context['status']).toBe(503)
  expect(question.threshold).toBe(0.7)
  // The status field is omitted when the provider reports none.
  const noStatus = buildRequestRetryQuestion({ message: 'reset', code: 'reset' }, 'test-provider', 2)
  expect('status' in noStatus.context).toBe(false)
  expect(validateRequestRetry('retry')).toBe('retry')
  expect(validateRequestRetry('fail')).toBe('fail')
  expect(validateRequestRetry('maybe')).toBeNull()
  expect(validateRequestRetry({ choice: 'retry', confidence: 0.9 })).toBeNull()
})

// ---------------------------------------------------------------------------
// Unit: per-agent service budgets
// ---------------------------------------------------------------------------

function runtimeConfig(overrides: Partial<System1RuntimeConfig> = {}): System1RuntimeConfig {
  return {
    backend: 'none',
    mode: 'shadow',
    enabled: true,
    confidenceThreshold: 0.7,
    thresholds: {},
    budgetPerTurn: 2,
    budgetPerTask: 4,
    timeoutMs: 150,
    failureThreshold: 3,
    cooldownMs: 30_000,
    traceBufferSize: 200,
    delegationWeights: { novelty: 0.4, toolRisk: 0.35, irreversibility: 0.25 },
    jevApiKeyEnv: 'TYPESAFE_API_KEY',
    jevEndpoint: 'https://api.typesafe.ai/v1/systemone',
    jevModel: 'jev-latest',
    layaEndpoint: 'http://127.0.0.1:17840/decide',
    layaAutoStart: true,
    layaCommand: ['python3', '-m', 'laya_serve'],
    loopStuckThreshold: 0.7,
    maxLoopNudgesPerTask: 2,
    ...overrides,
  }
}

const unitQuestion: System1Question = {
  kind: 'triage',
  primitive: 'choice',
  prompt: 'Classify.',
  context: {},
  options: { trivial: 'no reasoning needed', complex: 'full reasoning' },
}

function answeringBackend(): System1Backend {
  const judgment: System1Judgment = {
    answer: { choice: 'trivial', confidence: 0.9 },
    confidence: 0.9,
    latencyMs: 1,
    backend: 'none',
    abstained: false,
  }
  return {
    kind: 'none',
    async decide(): Promise<System1Judgment> { return judgment },
    async decideMany(questions: readonly System1Question[]): Promise<System1Judgment[]> {
      return questions.map(() => judgment)
    },
    async dispose(): Promise<void> {},
  }
}

it('service budgets are partitioned per agent', async () => {
  const service = new System1Service(answeringBackend(), runtimeConfig())
  const signal = new AbortController().signal
  const validate = (a: unknown): string | null =>
    typeof a === 'object' && a !== null && 'choice' in a && typeof a.choice === 'string' ? a.choice : null
  // Agent A exhausts its per-task budget (4).
  for (let i = 0; i < 4; i += 1) {
    expect((await service.ask(unitQuestion, 'task', signal, validate, 'agent-a')).fallback).toBeNull()
  }
  expect((await service.ask(unitQuestion, 'task', signal, validate, 'agent-a')).fallback).not.toBeNull()
  // Agent B is unaffected.
  expect((await service.ask(unitQuestion, 'task', signal, validate, 'agent-b')).fallback).toBeNull()
  // Resetting one agent does not reset the other.
  service.resetTask('agent-a')
  expect((await service.ask(unitQuestion, 'task', signal, validate, 'agent-a')).fallback).toBeNull()
  expect((await service.ask(unitQuestion, 'task', signal, validate, 'agent-b')).fallback).toBeNull()
})

// ---------------------------------------------------------------------------
// Composition: boot harness (round-2 pattern)
// ---------------------------------------------------------------------------

type PreStepPayload = Parameters<Events['agent/pre-step']>[0]
type RequestPayload = Parameters<Events['agent/request']>[0]
type RequestErrorPayload = Parameters<Events['agent/request-error']>[0]

let jevTriage: string
let jevNoul: number | null
let jevScore: number | null
let jevRetry: string
let jevRequestRetry: string
let jevConfidence: number
let jevFail: boolean
let askedKinds: string[]

function answerFor(id: string, type: string): Record<string, unknown> {
  const kind = id.split('#')[0] ?? id
  askedKinds.push(kind)
  if (type === 'noul') {
    return jevNoul === null ? { confidence: jevConfidence } : { noul: jevNoul, confidence: jevConfidence }
  }
  if (type === 'score') {
    // Delegation scores run 0..3; 0.5 lands 'low' oversight and stays silent.
    return jevScore === null ? { confidence: jevConfidence } : { score: jevScore, confidence: jevConfidence }
  }
  let choice: string
  if (kind === 'triage') choice = jevTriage
  else if (kind === 'retry-judgment') choice = jevRetry
  else if (kind === 'request-retry') choice = jevRequestRetry
  else choice = 'retry'
  return { choice, confidence: jevConfidence }
}

beforeEach(() => {
  jevTriage = 'trivial'
  jevNoul = 0.12
  jevScore = 0.5
  jevRetry = 'give-up'
  jevRequestRetry = 'fail'
  jevConfidence = 0.9
  jevFail = false
  askedKinds = []
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key')
  vi.stubGlobal('fetch', async (url: string, init: RequestInit): Promise<Response> => {
    if (jevFail) throw new Error('backend down')
    if (typeof init.body !== 'string') throw new Error('test stub expects a string request body')
    const body = JSON.parse(init.body) as {
      questions: Record<string, { type: string }>
    }
    const answers: Record<string, Record<string, unknown>> = {}
    for (const [id, question] of Object.entries(body.questions)) {
      answers[id] = answerFor(id, question.type)
    }
    return new Response(JSON.stringify({ model: 'jev-test-1.0', answers }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
})

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
})

async function boot(system1Config: Record<string, unknown>): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-system1-round3-'))
  const configPath = join(root, 'cordis.yml')
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-experimental-system1', System1Plugin],
  ])
  await writeFile(configPath, [...modules.keys()].flatMap(name => [
    `- name: '${name}'`,
    ...name === '@deepseek-ai/dsh-experimental-system1'
      ? ['  config:', ...Object.entries({ actuation: 'blocking', ...system1Config }).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`)]
      : [],
  ]).join('\n') + '\n')

  const context = ctx = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  return context
}

function liveSession(context: Context, agentId: string): SessionId {
  const id = SessionId(`agent:${agentId}`)
  return (context.sessions.get(id) ?? context.sessions.create(id)).id
}

function agentRef(context: Context, agentId: string): { id: string; sessionId: SessionId } {
  return { id: agentId, sessionId: liveSession(context, agentId) }
}

function preStepPayload(context: Context, agentId: string, step: number): PreStepPayload {
  return {
    agent: agentRef(context, agentId),
    messages: [createUserMessage({ content: [{ type: 'text', text: 'do the thing' }], source: { kind: 'user' } })],
    turn: 1,
    step,
    signal: new AbortController().signal,
  } as unknown as PreStepPayload
}

function toolExec(context: Context, agentId: string, name: string, args: unknown): ToolExecution {
  return {
    agent: agentRef(context, agentId),
    name,
    arguments: args,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function toolResult(isError: boolean): ToolExecutionResult {
  return (isError
    ? { isError: true, error: { message: 'boom' } }
    : { isError: false }) as ToolExecutionResult
}

const acceptNext = (): Promise<PostToolDecision> => Promise.resolve({ kind: 'accept' })

async function failedToolCall(context: Context, agentId: string, n: number): Promise<void> {
  await context.waterfall(
    'tools/post-execute',
    toolExec(context, agentId, 'probe_tool', { x: n }),
    toolResult(true),
    acceptNext,
  )
}

function requestPayload(context: Context, agentId: string, step: number): RequestPayload {
  return {
    agent: agentRef(context, agentId),
    turn: 1,
    step,
    signal: new AbortController().signal,
  } as unknown as RequestPayload
}

function requestErrorPayload(context: Context, agentId: string, step: number): RequestErrorPayload {
  return {
    agent: agentRef(context, agentId),
    turn: 1,
    step,
    provider: 'test-provider',
    failure: { message: 'upstream timeout', code: 'timeout', status: 503 },
    retryPolicy: undefined,
    signal: new AbortController().signal,
  } as unknown as RequestErrorPayload
}

const baseConfig: LlmCallConfig = { provider: 'test-provider', model: 'base-model' }

// ---------------------------------------------------------------------------
// Composition: D2 model routing
// ---------------------------------------------------------------------------

async function triageThenRequest(
  context: Context,
  agentId: string,
  step: number,
): Promise<LlmCallConfig> {
  const payload = preStepPayload(context, agentId, step)
  await context.waterfall('agent/pre-step', payload, async () => ({
    kind: 'enter' as const,
    messages: payload.messages,
  }))
  return await context.waterfall(
    'agent/request',
    requestPayload(context, agentId, step),
    async () => ({ ...baseConfig }),
  )
}

it('D2: enforce routes the call config from the cached triage verdict', async () => {
  jevTriage = 'complex'
  const context = await boot({
    backend: 'jev',
    mode: 'enforce',
    modelRoute: { complex: { model: 'strong-model' } },
  })
  const routed = await triageThenRequest(context, 'route-agent', 1)
  expect(routed.model).toBe('strong-model')
  // Unspecified fields are preserved.
  expect(routed.provider).toBe('test-provider')
  // The triage verdict was reused — no extra question at request time.
  expect(askedKinds).toContain('triage')
  expect(askedKinds.filter(kind => kind === 'triage')).toHaveLength(1)
})

it('D2: no route configured for the verdict leaves the config unchanged', async () => {
  jevTriage = 'trivial'
  const context = await boot({
    backend: 'jev',
    mode: 'enforce',
    modelRoute: { complex: { model: 'strong-model' } },
  })
  const routed = await triageThenRequest(context, 'route-unmapped', 1)
  expect(routed).toEqual(baseConfig)
})

it('D2: a verdict for another step leaves the config unchanged', async () => {
  jevTriage = 'complex'
  const context = await boot({
    backend: 'jev',
    mode: 'enforce',
    modelRoute: { complex: { model: 'strong-model' } },
  })
  // Verdict cached for step 1; the request is for a step that was never triaged.
  await triageThenRequest(context, 'route-stale', 1)
  const routed = await context.waterfall(
    'agent/request',
    requestPayload(context, 'route-stale', 2),
    async () => ({ ...baseConfig }),
  )
  expect(routed).toEqual(baseConfig)
})

it('D2: a route that changes nothing leaves the config untouched and unmarked', async () => {
  jevTriage = 'complex'
  const context = await boot({
    backend: 'jev',
    mode: 'enforce',
    modelRoute: { complex: { model: 'base-model' } },
  })
  const routed = await triageThenRequest(context, 'route-noop', 1)
  expect(routed).toEqual(baseConfig)
})

it('D2: shadow mode never routes, even with a route table configured', async () => {
  jevTriage = 'complex'
  const context = await boot({
    backend: 'jev',
    mode: 'shadow',
    modelRoute: { complex: { model: 'strong-model' } },
  })
  const payload = preStepPayload(context, 'route-shadow', 1)
  await context.waterfall('agent/pre-step', payload, async () => ({
    kind: 'enter' as const,
    messages: payload.messages,
  }))
  const routed = await context.waterfall(
    'agent/request',
    requestPayload(context, 'route-shadow', 1),
    async () => ({ ...baseConfig }),
  )
  expect(routed).toEqual(baseConfig)
})

// ---------------------------------------------------------------------------
// Composition: D3 request-error retry judgment
// ---------------------------------------------------------------------------

it('D3: enforce owns one retry on a confident transient verdict', async () => {
  jevRequestRetry = 'retry'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const next = vi.fn(async () => ({ kind: 'close' as const }))
  const action = await context.waterfall('agent/request-error', requestErrorPayload(context, 'req-agent', 1), next)
  expect(action).toEqual({ kind: 'retry' })
  expect(next).not.toHaveBeenCalled()
  expect(askedKinds).toContain('request-retry')
})

it('D3: the retry is bounded — the second failure on the same step delegates', async () => {
  jevRequestRetry = 'retry'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const next = vi.fn(async () => ({ kind: 'close' as const }))
  await context.waterfall('agent/request-error', requestErrorPayload(context, 'req-bound', 1), next)
  const action = await context.waterfall('agent/request-error', requestErrorPayload(context, 'req-bound', 1), next)
  expect(action).toEqual({ kind: 'close' })
  expect(next).toHaveBeenCalledOnce()
  // Only one request-retry question: the second failure never asked.
  expect(askedKinds.filter(kind => kind === 'request-retry')).toHaveLength(1)
})

it('D3: a non-transient verdict delegates to the loop default', async () => {
  jevRequestRetry = 'fail'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const next = vi.fn(async () => ({ kind: 'close' as const }))
  const action = await context.waterfall('agent/request-error', requestErrorPayload(context, 'req-fail', 1), next)
  expect(next).toHaveBeenCalledOnce()
  expect(action).toEqual({ kind: 'close' })
})

it('D3: assist mode warns when the failed request looks transient', async () => {
  jevRequestRetry = 'retry'
  const context = await boot({ backend: 'jev', mode: 'assist' })
  const warn = vi.spyOn(context.logger, 'warn')
  const next = vi.fn(async () => ({ kind: 'close' as const }))
  const action = await context.waterfall('agent/request-error', requestErrorPayload(context, 'req-assist', 1), next)
  expect(next).toHaveBeenCalledOnce()
  expect(action).toEqual({ kind: 'close' })
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('looks transient'))
  })
})

it('D3: shadow mode delegates first and only observes', async () => {
  jevRequestRetry = 'retry'
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const next = vi.fn(async () => ({ kind: 'close' as const }))
  const action = await context.waterfall('agent/request-error', requestErrorPayload(context, 'req-shadow', 1), next)
  expect(next).toHaveBeenCalledOnce()
  expect(action).toEqual({ kind: 'close' })
  // The question is still asked (dataset), without delaying the waterfall.
  await vi.waitFor(() => {
    expect(askedKinds).toContain('request-retry')
  })
})

// ---------------------------------------------------------------------------
// Composition: B1 inbox-based task-boundary reset
// ---------------------------------------------------------------------------

it('B1: an inbox insert while idle refreshes the exhausted task budget', async () => {
  // The post-execute batch is turn-scoped; the reset refreshes both scopes.
  const context = await boot({ backend: 'jev', mode: 'enforce', budgetPerTurn: 2, criticalReserve: 0 })
  await failedToolCall(context, 'budget-agent', 1)
  await failedToolCall(context, 'budget-agent', 2)
  expect(askedKinds.filter(kind => kind === 'retry-judgment')).toHaveLength(2)
  // Budget exhausted: the third failure falls back without asking.
  await failedToolCall(context, 'budget-agent', 3)
  expect(askedKinds.filter(kind => kind === 'retry-judgment')).toHaveLength(2)
  // A fresh user message arrives while the agent is idle: new task.
  context.emit('agent/inbox/inserted', {
    agent: agentRef(context, 'budget-agent'),
    message: createUserMessage({ content: [{ type: 'text', text: 'new task' }], source: { kind: 'user' } }),
  })
  await failedToolCall(context, 'budget-agent', 4)
  expect(askedKinds.filter(kind => kind === 'retry-judgment')).toHaveLength(3)
})

it('B1: an inbox insert while running is steering and does not reset', async () => {
  const context = await boot({ backend: 'jev', mode: 'enforce', budgetPerTurn: 2, criticalReserve: 0 })
  context.emit('agent/status', { agent: agentRef(context, 'steer-agent'), status: 'running' })
  await failedToolCall(context, 'steer-agent', 1)
  await failedToolCall(context, 'steer-agent', 2)
  context.emit('agent/inbox/inserted', {
    agent: agentRef(context, 'steer-agent'),
    message: createUserMessage({ content: [{ type: 'text', text: 'steer' }], source: { kind: 'user' } }),
  })
  await failedToolCall(context, 'steer-agent', 3)
  // Still exhausted: the insert did not refresh the budget.
  expect(askedKinds.filter(kind => kind === 'retry-judgment')).toHaveLength(2)
})

// ---------------------------------------------------------------------------
// Composition: B2 delegation before the loop early return
// ---------------------------------------------------------------------------

const spawnArgs = {
  name: 'reviewer',
  description: 'review the code changes for correctness',
  prompt: 'review this diff carefully',
}

it('B2: a looping spawn_teammate still records and warns about duplicates', async () => {
  jevNoul = 0.5 // in-band abstention: no loop nudge; low delegation scores keep the advisory silent
  const context = await boot({ backend: 'jev', mode: 'assist' })
  const warn = vi.spyOn(context.logger, 'warn')
  for (let i = 0; i < 3; i += 1) {
    await context.waterfall(
      'tools/post-execute',
      toolExec(context, 'delegate-agent', 'spawn_teammate', { ...spawnArgs }),
      toolResult(false),
      acceptNext,
    )
  }
  // The third call is a deterministic loop (3 identical calls), yet the
  // duplicate-purpose warning still fired for it. Assist observations are
  // fire-and-forget, so wait for the scoring to settle.
  await vi.waitFor(() => {
    const duplicateWarns = warn.mock.calls.filter(([message]) =>
      typeof message === 'string' && message.includes('overlaps with'),
    )
    expect(duplicateWarns.length).toBeGreaterThanOrEqual(2)
  })
  // The composite was still scored on the non-loop calls.
  expect(askedKinds.filter(kind => kind === 'delegation-triage').length).toBeGreaterThanOrEqual(6)
})

it('B2: the delegation registry is partitioned per agent', async () => {
  jevNoul = 0.5
  const context = await boot({ backend: 'jev', mode: 'assist' })
  const warn = vi.spyOn(context.logger, 'warn')
  await context.waterfall(
    'tools/post-execute',
    toolExec(context, 'delegate-a', 'spawn_teammate', { ...spawnArgs }),
    toolResult(false),
    acceptNext,
  )
  await context.waterfall(
    'tools/post-execute',
    toolExec(context, 'delegate-b', 'spawn_teammate', { ...spawnArgs }),
    toolResult(false),
    acceptNext,
  )
  // Agent B's identical-purpose spawn is not a duplicate of agent A's.
  // Wait for both observations to settle before asserting the absence.
  await vi.waitFor(() => {
    expect(askedKinds.filter(kind => kind === 'delegation-triage')).toHaveLength(6)
  })
  const duplicateWarns = warn.mock.calls.filter(([message]) =>
    typeof message === 'string' && message.includes('overlaps with'),
  )
  expect(duplicateWarns).toHaveLength(0)
})

it('B2: confident delegation scores produce an oversight advisory in assist mode', async () => {
  jevScore = 2.5 // demanding subtask: high oversight
  const context = await boot({ backend: 'jev', mode: 'assist' })
  const warn = vi.spyOn(context.logger, 'warn')
  await context.waterfall(
    'tools/post-execute',
    toolExec(context, 'delegate-advisory', 'spawn_teammate', { ...spawnArgs }),
    toolResult(false),
    acceptNext,
  )
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('high oversight'))
  })
})

// ---------------------------------------------------------------------------
// Composition: B7 key-order canonicalization in the pre-execute gate
// ---------------------------------------------------------------------------

it('B7: identical calls with reordered keys skip the duplicate tool-choice question', async () => {
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const next = async (): Promise<PostToolDecision> => ({ kind: 'allow' })
  await context.waterfall(
    'tools/pre-execute',
    toolExec(context, 'keyorder-agent', 'probe_tool', { b: 2, a: 1 }),
    next,
  )
  await context.waterfall(
    'tools/pre-execute',
    toolExec(context, 'keyorder-agent', 'probe_tool', { a: 1, b: 2 }),
    next,
  )
  expect(askedKinds.filter(kind => kind === 'tool-choice')).toHaveLength(1)
})
