/**
 * Real Loader composition for the System 1 plugin (F7).
 *
 * The agent loop, tool runtime, and System 1 all boot from a `cordis.yml`
 * through the real Loader — no hand-built `ctx.plugin(...)` — and a
 * scripted model plus a stubbed Jev `fetch` drive real turns. This proves
 * the integration wiring:
 *
 * - listeners delegate via `next()` first and observe afterwards, so a slow
 *   or failing backend can never change or delay loop behavior;
 * - shadow observations run on the plugin's own lifetime signal, surviving
 *   an already-aborted step signal (F2);
 * - disposing the plugin entry aborts in-flight observations and removes
 *   the listeners (HMR-safe).
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
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as System1Plugin from '../src/index.ts'

type PreStepPayload = Parameters<Events['agent/pre-step']>[0]

interface JevWireQuestion {
  type: string
  instructions: string
  criteria?: unknown
}

interface JevCall {
  url: string
  /** Wire question id (`${kind}#${index}`) -> wire question. */
  questions: Record<string, JevWireQuestion>
  /** Set when the request's signal aborts (proves lifetime-signal cancellation). */
  aborted: boolean
  resolvedAt: number
}

/** Stub controls, reset before each test. */
let jevCalls: JevCall[]
let jevDelayMs: number
let jevNoul: number | null
let jevModel: string | undefined
/** Records 'next' vs 'fetch' ordering for the delegation-first assertion. */
let order: string[]

/** Kinds asked in a call, in wire order (ids are `${kind}#${index}`). */
function askedKinds(call: JevCall): string[] {
  return Object.keys(call.questions).map(id => id.split('#')[0] as string)
}

function answerFor(id: string, type: string): Record<string, unknown> {
  const kind = id.split('#')[0]
  if (type === 'score') return { score: 0.95, confidence: 0.95 }
  if (type === 'noul') {
    // jevNoul === null: the stub omits `noul`, so Jev abstains (F1).
    return jevNoul === null ? { confidence: 0.9 } : { noul: jevNoul, confidence: 0.9 }
  }
  return { choice: kind === 'triage' ? 'trivial' : 'retry', confidence: 0.9 }
}

beforeEach(() => {
  jevCalls = []
  jevDelayMs = 0
  jevNoul = 0.12
  jevModel = 'jev-test-1.0'
  order = []
  // The backend refuses to call without a key; the stubbed fetch never sees
  // this value, it only unlocks the request path.
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key')
  vi.stubGlobal('fetch', async (url: string, init: RequestInit): Promise<Response> => {
    if (typeof init.body !== 'string') throw new Error('test stub expects a string request body')
    const body = JSON.parse(init.body) as { model: string; questions: Record<string, JevWireQuestion> }
    const call: JevCall = { url, questions: body.questions, aborted: false, resolvedAt: 0 }
    init.signal?.addEventListener('abort', () => { call.aborted = true }, { once: true })
    jevCalls.push(call)
    order.push('fetch')
    if (jevDelayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, jevDelayMs)
        init.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          },
          { once: true },
        )
      })
    }
    call.resolvedAt = Date.now()
    const answers: Record<string, Record<string, unknown>> = {}
    for (const [id, question] of Object.entries(body.questions)) {
      answers[id] = answerFor(id, question.type)
    }
    return new Response(JSON.stringify({ model: jevModel, answers }), {
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

/** First model response calls the fixture tool; the second ends the turn. */
class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: ToolCallId('call-1'), name: 'probe_tool', arguments: '{}' },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Boot the full stack from a `cordis.yml` through the real Loader.
 * `onContext` runs after `new Context()` but before any plugin loads, so
 * tests can spy on the root logger before System 1's apply runs.
 */
async function boot(
  system1Config: Record<string, unknown>,
  onContext?: (context: Context) => void,
): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-system1-composition-'))
  const configPath = join(root, 'cordis.yml')
  const modules = new Map<string, unknown>([
    // Note: the loader and include plugins are wired manually below (like the
    // reference loader-composition test); listing them in cordis.yml would
    // instantiate a second Loader on the same root.
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
      ? ['  config:', ...Object.entries(system1Config).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`)]
      : [],
  ]).join('\n') + '\n')

  const context = ctx = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  onContext?.(context)
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

function system1Entry(context: Context) {
  const entry = [...context.loader.entries()]
    .find(candidate => candidate.options.name === '@deepseek-ai/dsh-experimental-system1')
  if (!entry) throw new Error('System 1 loader entry not found')
  return entry
}

function liveSession(context: Context, agentId: string): SessionId {
  const id = SessionId(`agent:${agentId}`)
  // Idempotent: several dispatches in one test share the agent's session.
  return (context.sessions.get(id) ?? context.sessions.create(id)).id
}

function preStepPayload(context: Context, agentId: string, signal: AbortSignal): PreStepPayload {
  return {
    agent: { id: agentId, sessionId: liveSession(context, agentId) },
    messages: [],
    turn: 1,
    step: 1,
    signal,
  } as unknown as PreStepPayload
}

const acceptNext = (): Promise<PostToolDecision> => Promise.resolve({ kind: 'accept' })

function toolExec(context: Context, agentId: string | undefined, args: unknown, signal: AbortSignal): ToolExecution {
  return {
    agent: agentId === undefined ? undefined : { id: agentId, sessionId: liveSession(context, agentId) },
    name: 'probe_tool',
    arguments: args,
    signal,
  } as unknown as ToolExecution
}

function toolResult(isError: boolean): ToolExecutionResult {
  return (isError
    ? { isError: true, error: { message: 'boom' } }
    : { isError: false }) as ToolExecutionResult
}

it('consults Jev on real turns without changing or delaying loop behavior', async () => {
  // A slow backend: if the turn ever waited on the observation, the timing
  // assertion below fails.
  jevDelayMs = 500
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  context.tools.register(defineContentToolFixture({
    name: 'probe_tool',
    description: 'fixture probe',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'probe ok' }] },
  }))
  const model = new ScriptedModel()
  context.llm.registerAdapter(['system1-fixture'], model)
  const agent = await context.agentLoop.create(SessionId('system1-turn'), { provider: 'system1-fixture', model: 'scripted' })
  const idle = Promise.withResolvers<undefined>()
  const stop = context.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') idle.resolve()
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Probe the fixture tool.' }], source: { kind: 'user' } }))
  await idle.promise
  const turnDoneAt = Date.now()
  stop()

  // The turn ran model → tool → final text, unperturbed by the observer.
  expect(model.requests).toHaveLength(2)
  expect(agent.session.deriveMessages().some(message => message.role === 'tool')).toBe(true)

  // Shadow observations reached Jev on the real wire format...
  await vi.waitFor(() => {
    expect(jevCalls).toHaveLength(3)
  })
  for (const call of jevCalls) {
    expect(call.url).toBe('https://api.typesafe.ai/v1/systemone')
  }
  // The two pre-step batches ask triage and step delegability together; the
  // delegation *hint* is only injected once team tooling has been seen.
  const batches = jevCalls.filter(call => askedKinds(call).includes('triage'))
  expect(batches).toHaveLength(2)
  for (const call of batches) {
    expect(Object.keys(call.questions)).toHaveLength(2)
    expect(call.questions['triage#0']).toMatchObject({ type: 'choice' })
    expect(call.questions['delegation#1']).toMatchObject({ type: 'choice' })
  }
  // ...plus the tool-choice observation for the probe_tool call, asked
  // without delaying the dispatch.
  const toolChoices = jevCalls.filter(call => askedKinds(call).includes('tool-choice'))
  expect(toolChoices).toHaveLength(1)
  expect(Object.keys(toolChoices[0]!.questions)).toEqual(['tool-choice#0'])
  // ...without the turn ever waiting for them: the turn finished while the
  // 500ms observations were still in flight.
  await vi.waitFor(() => {
    for (const call of jevCalls) expect(call.resolvedAt).toBeGreaterThan(0)
  })
  expect(turnDoneAt).toBeLessThan(jevCalls[0]!.resolvedAt)
}, 30000)

it('delegates via next() before the observation starts', async () => {
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const next = (): Promise<PreStepDecision> => {
    order.push('next')
    return Promise.resolve({ kind: 'enter', messages: [] })
  }
  await context.waterfall('agent/pre-step', preStepPayload(context, 'synthetic-order', new AbortController().signal), next)
  // The listener awaited next() before kicking off the observation, so the
  // fetch can only ever follow the delegation — never precede or block it.
  await vi.waitFor(() => {
    expect(jevCalls).toHaveLength(1)
  })
  expect(order).toEqual(['next', 'fetch'])
  expect(jevCalls[0]!.questions['triage#0']).toMatchObject({ type: 'choice' })
})

it('observes on the plugin lifetime signal, not the aborted step signal (F2)', async () => {
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const before = jevCalls.length
  // The turn is already over: the payload signal is aborted before dispatch.
  const stepSignal = new AbortController()
  stepSignal.abort(new Error('turn over'))
  await context.waterfall(
    'agent/pre-step',
    preStepPayload(context, 'synthetic-f2', stepSignal.signal),
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  // The observation still ran to completion on the plugin lifetime signal.
  await vi.waitFor(() => {
    expect(jevCalls).toHaveLength(before + 1)
  })
  expect(jevCalls[before]!.questions['triage#0']).toMatchObject({ type: 'choice' })
})

it('disposing the plugin entry stops observations and removes its listeners', async () => {
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const signal = new AbortController().signal
  const next = (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] })
  await context.waterfall('agent/pre-step', preStepPayload(context, 'synthetic-live', signal), next)
  await vi.waitFor(() => {
    expect(jevCalls).toHaveLength(1)
  })

  await system1Entry(context).fiber?.dispose()

  const count = jevCalls.length
  await context.waterfall('agent/pre-step', preStepPayload(context, 'synthetic-dead', signal), next)
  await context.waterfall('tools/post-execute', toolExec(context, 'synthetic-dead', {}, signal), toolResult(true), acceptNext)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(jevCalls).toHaveLength(count)
})

it('aborts an in-flight observation when the plugin entry is disposed', async () => {
  jevDelayMs = 5000
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  await context.waterfall(
    'agent/pre-step',
    preStepPayload(context, 'synthetic-abort', new AbortController().signal),
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  await vi.waitFor(() => {
    expect(jevCalls).toHaveLength(1)
  })
  const call = jevCalls[0]!

  await system1Entry(context).fiber?.dispose()

  await vi.waitFor(() => {
    expect(call.aborted).toBe(true)
  })
}, 30000)

it('batches loop-check and retry questions for failing repeated tool calls', async () => {
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const signal = new AbortController().signal
  const before = jevCalls.length

  // One failure: only the retry question goes out.
  await context.waterfall('tools/post-execute', toolExec(context, 'synthetic-batch', { x: 1 }, signal), toolResult(true), acceptNext)
  await vi.waitFor(() => {
    expect(jevCalls).toHaveLength(before + 1)
  })
  expect(askedKinds(jevCalls[before]!)).toEqual(['retry-judgment'])

  // A second identical failure: loop-check and retry go out in ONE call.
  await context.waterfall('tools/post-execute', toolExec(context, 'synthetic-batch', { x: 1 }, signal), toolResult(true), acceptNext)
  await vi.waitFor(() => {
    expect(jevCalls).toHaveLength(before + 2)
  })
  const batch = jevCalls[before + 1]!
  expect(askedKinds(batch)).toEqual(['loop-check', 'retry-judgment'])
  expect(Object.values(batch.questions).map(q => q.type)).toEqual(['noul', 'choice'])
})

it('handles a loop-check abstention without throwing', async () => {
  // jevNoul = null: the stub omits `noul`, Jev abstains, the decision value
  // is null instead of a number.
  jevNoul = null
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const signal = new AbortController().signal
  const before = jevCalls.length
  await context.waterfall('tools/post-execute', toolExec(context, 'synthetic-abstain', { x: 1 }, signal), toolResult(true), acceptNext)
  await context.waterfall('tools/post-execute', toolExec(context, 'synthetic-abstain', { x: 1 }, signal), toolResult(true), acceptNext)
  await vi.waitFor(() => {
    expect(jevCalls).toHaveLength(before + 2)
  })
  expect(askedKinds(jevCalls[before + 1]!)).toEqual(['loop-check', 'retry-judgment'])
})

it('warns in assist mode when Jev judges the agent stuck or looping', async () => {
  jevNoul = 0.85
  // No model echo: exercises the `?? 'unknown'` fallback in the warn line.
  jevModel = undefined
  const context = await boot({ backend: 'jev', mode: 'assist' })
  const warn = vi.spyOn(context.logger, 'warn')
  const signal = new AbortController().signal

  await context.waterfall('tools/post-execute', toolExec(context, 'synthetic-assist', { x: 1 }, signal), toolResult(true), acceptNext)
  await context.waterfall('tools/post-execute', toolExec(context, 'synthetic-assist', { x: 1 }, signal), toolResult(true), acceptNext)
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('system1: jev judges agent'))
  })

  // Third identical failure: deterministic loop, no model call needed.
  await context.waterfall('tools/post-execute', toolExec(context, 'synthetic-assist', { x: 1 }, signal), toolResult(true), acceptNext)
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('system1: possible tool loop'))
  })
})

it('stays silent in shadow mode even for deterministic loops', async () => {
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const warn = vi.spyOn(context.logger, 'warn')
  const signal = new AbortController().signal
  for (let i = 0; i < 3; i += 1) {
    await context.waterfall('tools/post-execute', toolExec(context, 'synthetic-shadow', { x: 1 }, signal), toolResult(true), acceptNext)
  }
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('system1: possible tool loop'))
})

it('tracks tool calls without an agent id and trims long histories', async () => {
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const signal = new AbortController().signal
  const before = jevCalls.length

  // No agent on the exec: tracked under 'unknown-agent', no questions, no fetch.
  await context.waterfall('tools/post-execute', toolExec(context, undefined, {}, signal), toolResult(false), acceptNext)
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(jevCalls).toHaveLength(before)

  // Thirteen distinct successful calls: history exceeds the 12-entry bound
  // and the oldest entry is dropped; nothing loops, so no fetch.
  for (let i = 0; i < 13; i += 1) {
    await context.waterfall('tools/post-execute', toolExec(context, 'synthetic-trim', { n: i }, signal), toolResult(false), acceptNext)
  }
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(jevCalls).toHaveLength(before)
})

it('registers no listeners when disabled', async () => {
  const context = await boot({ backend: 'jev', mode: 'shadow', enabled: false })
  await context.waterfall(
    'agent/pre-step',
    preStepPayload(context, 'synthetic-disabled', new AbortController().signal),
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(jevCalls).toHaveLength(0)
})

it('actuates in enforce mode instead of warning that actuation is deferred', async () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = []
  const context = await boot(
    { backend: 'jev', mode: 'enforce' },
    (fresh) => { spies.push(vi.spyOn(fresh.logger, 'warn')) },
  )
  expect(spies[0]).not.toHaveBeenCalledWith(expect.stringContaining('enforce-mode actuation is deferred'))
  const base = preStepPayload(context, 'synthetic-enforce', new AbortController().signal)
  const userMessage = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  const payload = { ...base, messages: [userMessage] }
  const decision = await context.waterfall(
    'agent/pre-step',
    payload,
    () => Promise.resolve({ kind: 'enter', messages: payload.messages }),
  )
  // The stubbed triage answers 'trivial': the step enters with a strategy hint.
  await vi.waitFor(() => {
    expect(jevCalls).toHaveLength(1)
  })
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') return
  expect(decision.messages.length).toBeGreaterThan(payload.messages.length)
})

it('supports the none backend without any network call', async () => {
  const context = await boot({ backend: 'none', mode: 'shadow' })
  await context.waterfall(
    'agent/pre-step',
    preStepPayload(context, 'synthetic-none', new AbortController().signal),
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(jevCalls).toHaveLength(0)
})

it('short-circuits the laya backend on a zero turn budget without spawning', async () => {
  const context = await boot({ backend: 'laya', mode: 'shadow', budgetPerTurn: 0 })
  await context.waterfall(
    'agent/pre-step',
    preStepPayload(context, 'synthetic-laya', new AbortController().signal),
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  await new Promise(resolve => setTimeout(resolve, 200))
  // The budget short-circuit fires before any backend call; Jev's fetch was
  // never touched and no sidecar spawn was attempted.
  expect(jevCalls).toHaveLength(0)
})
