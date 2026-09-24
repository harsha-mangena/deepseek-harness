/**
 * Round-2 actuation composition tests for the System 1 plugin.
 *
 * Round 2 adds three seams the repository actually provides (verified
 * against the harness source; plan-viability and tool-shortlist have no
 * such seam and stay out):
 *
 * - `tools/pre-execute` judge-before-act: in enforce mode a confident
 *   wrong-tool verdict denies the dispatch before it runs; in shadow/assist
 *   the same question is trace-only and never touches the dispatch.
 * - Bounded STOP: a hopeless trajectory (long deterministic identical-call
 *   streak plus Jev nearly certain the agent is stuck) ends the turn via
 *   pre-step `reject` instead of burning more tokens. Legitimate repetition
 *   (low stuck probability) and short streaks keep going.
 * - `agent/turn-stopping` final-answer check: observe-only in all modes —
 *   the turn is already over, so there is no veto; assist mode warns the
 *   operator when the closing answer clearly misses the request.
 *
 * Every test boots the real Loader composition with a stubbed Jev `fetch`
 * and dispatches the real waterfalls, proving judge-before-act ordering,
 * fail-open fallbacks, and that shadow mode never changes behavior.
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
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type {
  PostToolDecision,
  PreToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import * as System1Plugin from '../src/index.ts'

type PreStepPayload = Parameters<Events['agent/pre-step']>[0]
type TurnStoppingPayload = Parameters<Events['agent/turn-stopping']>[0]

/** Stub controls, reset before each test. */
let jevTriage: string
let jevNoul: number | null
let jevRetry: string
let jevDelegate: string
let jevToolChoice: string
let jevFinalAnswer: string
let jevConfidence: number
let jevFail: boolean
/** Every question kind the stubbed backend was asked, in order. */
let askedKinds: string[]

function answerFor(id: string, type: string): Record<string, unknown> {
  const kind = id.split('#')[0] ?? id
  askedKinds.push(kind)
  if (type === 'noul') {
    return jevNoul === null ? { confidence: jevConfidence } : { noul: jevNoul, confidence: jevConfidence }
  }
  let choice: string
  if (kind === 'triage') choice = jevTriage
  else if (kind === 'retry-judgment') choice = jevRetry
  else if (kind === 'delegation') choice = jevDelegate
  else if (kind === 'tool-choice') choice = jevToolChoice
  else if (kind === 'final-answer') choice = jevFinalAnswer
  else choice = 'retry'
  return { choice, confidence: jevConfidence }
}

beforeEach(() => {
  jevTriage = 'trivial'
  jevNoul = 0.12
  jevRetry = 'give-up'
  jevDelegate = 'keep'
  jevToolChoice = 'proceed'
  jevFinalAnswer = 'adequate'
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
  root = await mkdtemp(join(tmpdir(), 'dsh-system1-round2-'))
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
      ? ['  config:', ...Object.entries({ actuation: 'blocking', triageStyle: 'single', strategyHints: 'all', stopMode: 'reject', ...system1Config }).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`)]
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

function preStepPayload(context: Context, agentId: string): PreStepPayload {
  return {
    agent: { id: agentId, sessionId: liveSession(context, agentId) },
    messages: [createUserMessage({ content: [{ type: 'text', text: 'do the thing' }], source: { kind: 'user' } })],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  } as unknown as PreStepPayload
}

function toolExec(context: Context, agentId: string, args: unknown): ToolExecution {
  return {
    agent: { id: agentId, sessionId: liveSession(context, agentId) },
    name: 'probe_tool',
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

it('denies a confidently wrong tool call before dispatch in enforce mode', async () => {
  jevToolChoice = 'wrong-tool'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const downstream = vi.fn(async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
  const decision = await context.waterfall('tools/pre-execute', toolExec(context, 'gate-deny', { x: 1 }), downstream)
  expect(decision.kind).toBe('deny')
  if (decision.kind !== 'deny') return
  expect(decision.reason).toContain('probe_tool')
  expect(decision.reason).toContain('[System 1 tool-choice]')
  // Judge-before-act: the dispatch never ran.
  expect(downstream).not.toHaveBeenCalled()
  expect(askedKinds).toContain('tool-choice')
})

it('allows the call when Jev says proceed', async () => {
  jevToolChoice = 'proceed'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const downstream = vi.fn(async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
  const decision = await context.waterfall('tools/pre-execute', toolExec(context, 'gate-allow', { x: 1 }), downstream)
  expect(decision).toEqual({ kind: 'allow' })
  expect(downstream).toHaveBeenCalledOnce()
})

it('allows on a low-confidence wrong-tool fallback', async () => {
  jevToolChoice = 'wrong-tool'
  jevConfidence = 0.5 // below the 0.85 tool-choice threshold: gate falls back
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await context.waterfall(
    'tools/pre-execute',
    toolExec(context, 'gate-fallback', { x: 1 }),
    async (): Promise<PreToolDecision> => ({ kind: 'allow' }),
  )
  expect(decision).toEqual({ kind: 'allow' })
})

it('skips the question for exact consecutive duplicate calls', async () => {
  jevToolChoice = 'proceed'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const next = async (): Promise<PreToolDecision> => ({ kind: 'allow' })
  await context.waterfall('tools/pre-execute', toolExec(context, 'gate-dupe', { x: 1 }), next)
  await context.waterfall('tools/pre-execute', toolExec(context, 'gate-dupe', { x: 1 }), next)
  expect(askedKinds.filter(kind => kind === 'tool-choice')).toHaveLength(1)
})

it('never denies in shadow mode — the same question is trace-only', async () => {
  jevToolChoice = 'wrong-tool'
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const decision = await context.waterfall(
    'tools/pre-execute',
    toolExec(context, 'gate-shadow', { x: 1 }),
    async (): Promise<PreToolDecision> => ({ kind: 'allow' }),
  )
  // The dispatch decision passes through untouched.
  expect(decision).toEqual({ kind: 'allow' })
  // The question was still asked (dataset), without delaying the dispatch.
  await vi.waitFor(() => {
    expect(askedKinds).toContain('tool-choice')
  })
})

async function repeatTool(context: Context, agentId: string, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await context.waterfall('tools/post-execute', toolExec(context, agentId, { x: 1 }), toolResult(false), acceptNext)
  }
}

function stopStep(
  context: Context,
  agentId: string,
): Promise<{ decision: PreStepDecision; next: ReturnType<typeof vi.fn> }> {
  const payload = { ...preStepPayload(context, agentId), step: 2 }
  const next = vi.fn(async (): Promise<PreStepDecision> => ({
    kind: 'enter',
    messages: payload.messages,
  }))
  return context.waterfall('agent/pre-step', payload, next).then(decision => ({ decision, next }))
}

it('stops a hopeless trajectory: long identical streak plus high stuck probability', async () => {
  jevNoul = 0.95 // at/above the 0.9 stopStuckThreshold
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  await repeatTool(context, 'stop-agent', 5)
  const { decision, next } = await stopStep(context, 'stop-agent')
  expect(decision.kind).toBe('reject')
  // The turn ends before downstream pre-step work and the triage batch.
  expect(next).not.toHaveBeenCalled()
})

it('keeps going when Jev is unsure the streak is stuck', async () => {
  jevNoul = 0.5 // abstains: in the ±0.1 band around 0.5
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  await repeatTool(context, 'stop-unsure', 5)
  const { decision } = await stopStep(context, 'stop-unsure')
  expect(decision.kind).toBe('enter')
})

it('keeps going below the deterministic streak length', async () => {
  jevNoul = 0.95
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  await repeatTool(context, 'stop-short', 4)
  const { decision } = await stopStep(context, 'stop-short')
  expect(decision.kind).toBe('enter')
})

function turnStoppingPayload(messages: unknown[]): TurnStoppingPayload {
  const agent = {
    id: 'final-answer-agent',
    session: { deriveMessages: () => messages },
  }
  return { agent, turn: 1, signal: new AbortController().signal } as unknown as TurnStoppingPayload
}

const turnMessages = [
  { role: 'user', content: [{ type: 'text', text: 'write a haiku about the sea' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'here is your haiku: ...' }] },
]

it('warns in assist mode when the final answer clearly misses the request', async () => {
  jevFinalAnswer = 'inadequate'
  const context = await boot({ backend: 'jev', mode: 'assist' })
  const warn = vi.spyOn(context.logger, 'warn')
  context.emit('agent/turn-stopping', turnStoppingPayload(turnMessages))
  await vi.waitFor(() => {
    expect(askedKinds).toContain('final-answer')
  })
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('final answer'))
  })
})

it('stays silent in assist mode when the final answer is adequate', async () => {
  jevFinalAnswer = 'adequate'
  const context = await boot({ backend: 'jev', mode: 'assist' })
  const warn = vi.spyOn(context.logger, 'warn')
  context.emit('agent/turn-stopping', turnStoppingPayload(turnMessages))
  await vi.waitFor(() => {
    expect(askedKinds).toContain('final-answer')
  })
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('final answer'))
})

it('skips the final-answer question when the turn has no request or answer', async () => {
  const context = await boot({ backend: 'jev', mode: 'assist' })
  context.emit('agent/turn-stopping', turnStoppingPayload([
    { role: 'user', content: [{ type: 'text', text: 'hello?' }] },
  ]))
  // Let the fire-and-forget observation settle, then assert nothing was asked.
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(askedKinds).not.toContain('final-answer')
})
