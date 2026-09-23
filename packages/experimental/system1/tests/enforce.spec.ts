/**
 * Enforce-mode composition tests for the System 1 plugin.
 *
 * In `enforce` mode Jev's judgments actuate: triage selects a
 * reasoning-strategy hint (atom/chain/tree of thoughts) injected before the
 * step, loop-check injects a nudge when the agent looks stuck, and
 * retry-judgment advises on failed tool calls. Every test boots the real
 * Loader composition with a stubbed Jev `fetch` and dispatches the real
 * waterfalls, proving:
 *
 * - judgments are awaited BEFORE delegation (judge-first, not observe-after);
 * - any fallback (low confidence, abstention, backend error, timeout)
 *   resolves to "no injection" with existing behavior untouched;
 * - loop nudges are bounded per task and per episode;
 * - shadow mode never injects.
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
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as System1Plugin from '../src/index.ts'

type PreStepPayload = Parameters<Events['agent/pre-step']>[0]

/** Stub controls, reset before each test. */
let jevTriage: string
let jevNoul: number | null
let jevRetry: string
let jevConfidence: number
let jevFail: boolean

function answerFor(id: string, type: string): Record<string, unknown> {
  const kind = id.split('#')[0]
  if (type === 'noul') {
    return jevNoul === null ? { confidence: jevConfidence } : { noul: jevNoul, confidence: jevConfidence }
  }
  const choice = kind === 'triage' ? jevTriage : kind === 'retry-judgment' ? jevRetry : 'retry'
  return { choice, confidence: jevConfidence }
}

beforeEach(() => {
  jevTriage = 'complex'
  jevNoul = 0.12
  jevRetry = 'give-up'
  jevConfidence = 0.9
  jevFail = false
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
  root = await mkdtemp(join(tmpdir(), 'dsh-system1-enforce-'))
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
      ? ['  config:', ...Object.entries(system1Config).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`)]
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

function hintTexts(messages: readonly UserMessage[]): string[] {
  return messages
    .filter(message => (message.source as { kind?: string }).kind === 'system1')
    .flatMap(message => message.content.map(block => block.type === 'text' ? block.text : ''))
}

function contextTexts(decision: PostToolDecision): string[] {
  if (decision.kind !== 'accept' || decision.additionalContexts === undefined) return []
  return hintTexts(decision.additionalContexts)
}

it('injects a strategy hint for a complex triage verdict', async () => {
  jevTriage = 'complex'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const payload = preStepPayload(context, 'enforce-hint')
  const next = (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: payload.messages })
  const decision = await context.waterfall('agent/pre-step', payload, next)
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') return
  // Original message preserved, hint appended.
  expect(decision.messages).toHaveLength(payload.messages.length + 1)
  const hints = hintTexts(decision.messages)
  expect(hints).toHaveLength(1)
  expect(hints[0]).toContain('[System 1 triage: complex]')
  expect(hints[0]).toContain('atomic sub-steps')
  expect(hints[0]).toContain('2–3 alternative')
})

it('injects a direct-answer hint for a trivial triage verdict', async () => {
  jevTriage = 'trivial'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const payload = preStepPayload(context, 'enforce-trivial')
  const next = (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: payload.messages })
  const decision = await context.waterfall('agent/pre-step', payload, next)
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') return
  const hints = hintTexts(decision.messages)
  expect(hints).toHaveLength(1)
  expect(hints[0]).toContain('[System 1 triage: trivial]')
  expect(hints[0]).toContain('minimal deliberation')
})

it('injects nothing on a low-confidence triage fallback', async () => {
  jevConfidence = 0.5 // below the 0.7 threshold: gate falls back
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const payload = preStepPayload(context, 'enforce-fallback')
  const next = (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: payload.messages })
  const decision = await context.waterfall('agent/pre-step', payload, next)
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') return
  expect(decision.messages).toHaveLength(payload.messages.length)
  expect(hintTexts(decision.messages)).toHaveLength(0)
})

it('passes a rejected step through untouched', async () => {
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await context.waterfall(
    'agent/pre-step',
    preStepPayload(context, 'enforce-reject'),
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'reject' }),
  )
  expect(decision).toEqual({ kind: 'reject' })
})

it('skips the hint on an empty first step (no-step turn)', async () => {
  jevTriage = 'complex'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const payload = { ...preStepPayload(context, 'enforce-empty-first'), step: 1 }
  const decision = await context.waterfall(
    'agent/pre-step',
    payload,
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') return
  // The loop discards an empty first-step decision: no model call to guide.
  expect(decision.messages).toHaveLength(0)
})

it('injects the hint on an empty later step (tool continuation)', async () => {
  jevTriage = 'trivial'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const payload = { ...preStepPayload(context, 'enforce-empty-later'), step: 2 }
  const decision = await context.waterfall(
    'agent/pre-step',
    payload,
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') return
  // Mid-turn steps legitimately claim nothing new; the hint still reaches the
  // model because the loop appends decision messages to the session.
  expect(decision.messages).toHaveLength(1)
  expect(hintTexts(decision.messages)[0]).toContain('[System 1 triage: trivial]')
})

it('nudges via additionalContexts on a deterministic loop', async () => {
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const agentId = 'enforce-loop'
  let decision: PostToolDecision = { kind: 'accept' }
  for (let i = 0; i < 3; i += 1) {
    decision = await context.waterfall('tools/post-execute', toolExec(context, agentId, { x: 1 }), toolResult(true), acceptNext)
  }
  // Third identical call: deterministic loop, nudge injected, call still accepted.
  expect(decision.kind).toBe('accept')
  const texts = contextTexts(decision)
  expect(texts).toHaveLength(1)
  expect(texts[0]).toContain('[System 1 loop-check]')
  expect(texts[0]).toContain('"probe_tool" ×3')
})

it('nudges when Jev judges the agent stuck', async () => {
  jevNoul = 0.85
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const agentId = 'enforce-stuck'
  // Two identical failures: repetitions reach 2, so the loop-check question
  // goes out in the batch (deterministic loop needs 3).
  await context.waterfall('tools/post-execute', toolExec(context, agentId, { x: 1 }), toolResult(true), acceptNext)
  const decision = await context.waterfall('tools/post-execute', toolExec(context, agentId, { x: 1 }), toolResult(true), acceptNext)
  const texts = contextTexts(decision)
  expect(texts.some(text => text.includes('[System 1 loop-check]') && text.includes('0.85'))).toBe(true)
})

it('does not repeat a nudge for the same stuck episode', async () => {
  jevNoul = 0.85
  // Five dispatches ask up to 7 questions; raise the turn budget so the
  // test exercises nudge dedupe rather than budget exhaustion.
  const context = await boot({ backend: 'jev', mode: 'enforce', budgetPerTurn: 20 })
  const agentId = 'enforce-dedupe'
  const args = { x: 1 }
  await context.waterfall('tools/post-execute', toolExec(context, agentId, args), toolResult(true), acceptNext)
  let decision = await context.waterfall('tools/post-execute', toolExec(context, agentId, args), toolResult(true), acceptNext)
  expect(contextTexts(decision).some(text => text.includes('[System 1 loop-check]'))).toBe(true)
  // Break the streak, then rebuild it to repetitions=2 with the same args:
  // the stuck-episode key recurs, so no second nudge (the retry hint still fires).
  await context.waterfall('tools/post-execute', toolExec(context, agentId, { x: 2 }), toolResult(true), acceptNext)
  await context.waterfall('tools/post-execute', toolExec(context, agentId, args), toolResult(true), acceptNext)
  decision = await context.waterfall('tools/post-execute', toolExec(context, agentId, args), toolResult(true), acceptNext)
  const texts = contextTexts(decision)
  expect(texts.some(text => text.includes('[System 1 loop-check]'))).toBe(false)
  expect(texts.some(text => text.includes('[System 1 retry-judgment]'))).toBe(true)
})

it('advises give-up on a retry verdict without blocking the call', async () => {
  jevRetry = 'give-up'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await context.waterfall(
    'tools/post-execute', toolExec(context, 'enforce-retry', { x: 1 }), toolResult(true), acceptNext,
  )
  expect(decision.kind).toBe('accept')
  const texts = contextTexts(decision)
  expect(texts).toHaveLength(1)
  expect(texts[0]).toContain('[System 1 retry-judgment]')
  expect(texts[0]).toContain('do not retry')
})

it('bounds loop nudges per task and per episode', async () => {
  const context = await boot({ backend: 'jev', mode: 'enforce', maxLoopNudgesPerTask: 1 })
  const agentId = 'enforce-budget'
  // Episode one: deterministic loop on {x:1} → nudge admitted.
  let decision: PostToolDecision = { kind: 'accept' }
  for (let i = 0; i < 3; i += 1) {
    decision = await context.waterfall('tools/post-execute', toolExec(context, agentId, { x: 1 }), toolResult(false), acceptNext)
  }
  expect(contextTexts(decision)).toHaveLength(1)
  // Fourth identical call: still looping, but the per-task budget is spent.
  decision = await context.waterfall('tools/post-execute', toolExec(context, agentId, { x: 1 }), toolResult(false), acceptNext)
  expect(contextTexts(decision)).toHaveLength(0)
  // A new episode ({x:2} ×3): per-task budget exhausted → warn only, no nudge.
  for (let i = 0; i < 3; i += 1) {
    decision = await context.waterfall('tools/post-execute', toolExec(context, agentId, { x: 2 }), toolResult(false), acceptNext)
  }
  expect(contextTexts(decision)).toHaveLength(0)
})

it('passes a blocked tool decision through untouched', async () => {
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await context.waterfall(
    'tools/post-execute',
    toolExec(context, 'enforce-block', { x: 1 }),
    toolResult(true),
    (): Promise<PostToolDecision> => Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'denied' }] }),
  )
  expect(decision).toEqual({ kind: 'block', feedback: [{ type: 'text', text: 'denied' }] })
})

it('falls back to plain behavior when the backend fails', async () => {
  jevFail = true
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const payload = preStepPayload(context, 'enforce-down')
  const stepDecision = await context.waterfall(
    'agent/pre-step', payload,
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: payload.messages }),
  )
  expect(stepDecision.kind).toBe('enter')
  if (stepDecision.kind !== 'enter') return
  expect(stepDecision.messages).toHaveLength(payload.messages.length)

  const toolDecision = await context.waterfall(
    'tools/post-execute', toolExec(context, 'enforce-down', { x: 1 }), toolResult(true), acceptNext,
  )
  expect(toolDecision).toEqual({ kind: 'accept' })
})

it('never injects in shadow mode', async () => {
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const payload = preStepPayload(context, 'shadow-clean')
  const stepDecision = await context.waterfall(
    'agent/pre-step', payload,
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: payload.messages }),
  )
  expect(stepDecision.kind).toBe('enter')
  if (stepDecision.kind !== 'enter') return
  expect(stepDecision.messages).toHaveLength(payload.messages.length)

  let toolDecision: PostToolDecision = { kind: 'accept' }
  for (let i = 0; i < 3; i += 1) {
    toolDecision = await context.waterfall('tools/post-execute', toolExec(context, 'shadow-clean', { x: 1 }), toolResult(true), acceptNext)
  }
  expect(toolDecision).toEqual({ kind: 'accept' })
})
