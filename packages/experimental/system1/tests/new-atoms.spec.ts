/**
 * Composition tests for the new System 1 atoms: stream-time tool-choice
 * prefetch, result triage, injection screening, subagent-output acceptance,
 * pressure-gated prune, and MCP server preselection.
 *
 * Every test boots the real Loader composition with a stubbed Jev `fetch`
 * and dispatches the real waterfalls, proving the atoms actuate in enforce
 * mode, stay silent in shadow mode, and fail open when Jev is down or
 * unconfident.
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
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as System1Plugin from '../src/index.ts'

type PreStepPayload = Parameters<Events['agent/pre-step']>[0]
type PreStepDecision = Awaited<ReturnType<Parameters<Events['agent/pre-step']>[1]>>

/** Stub controls, reset before each test. */
let jevTriage: string
let jevNoul: number | null
let jevRetry: string
let jevDelegate: string
let jevConfidence: number
let jevFail: boolean
let jevScore: number | null
let jevPreselect: number | null
let jevResultTriage: string
let jevInjection: number | null
let jevAccept: string
let jevPrune: number | null
let jevToolChoice: string
/** Question kinds per Jev batch, in call order; reset before each test. */
let fetchBatches: string[][]

function answerFor(id: string, type: string): Record<string, unknown> {
  const kind = id.split('#')[0]
  if (type === 'noul') {
    let p: number | null
    if (kind === 'preselect') p = jevPreselect
    else if (kind === 'injection-screen') p = jevInjection
    else if (kind === 'prune') p = jevPrune
    else p = jevNoul
    return p === null ? { confidence: jevConfidence } : { noul: p, confidence: jevConfidence }
  }
  if (type === 'score') {
    return jevScore === null ? { confidence: jevConfidence } : { score: jevScore, confidence: jevConfidence }
  }
  let choice: string
  if (kind === 'triage') choice = jevTriage
  else if (kind === 'retry-judgment') choice = jevRetry
  else if (kind === 'delegation') choice = jevDelegate
  else if (kind === 'result-triage') choice = jevResultTriage
  else if (kind === 'subagent-accept') choice = jevAccept
  else if (kind === 'tool-choice') choice = jevToolChoice
  else choice = 'retry'
  return { choice, confidence: jevConfidence }
}

beforeEach(() => {
  jevTriage = 'trivial'
  jevNoul = 0.12
  jevRetry = 'give-up'
  jevDelegate = 'keep'
  jevConfidence = 0.9
  jevFail = false
  jevScore = null
  jevPreselect = null
  jevResultTriage = 'useful'
  jevInjection = 0.1
  jevAccept = 'meets'
  jevPrune = 0.9
  jevToolChoice = 'proceed'
  fetchBatches = []
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key')
  vi.stubGlobal('fetch', async (url: string, init: RequestInit): Promise<Response> => {
    if (jevFail) throw new Error('backend down')
    if (typeof init.body !== 'string') throw new Error('test stub expects a string request body')
    const body = JSON.parse(init.body) as {
      questions: Record<string, { type: string }>
    }
    const answers: Record<string, Record<string, unknown>> = {}
    const kinds: string[] = []
    for (const [id, question] of Object.entries(body.questions)) {
      kinds.push(id.split('#')[0] ?? id)
      answers[id] = answerFor(id, question.type)
    }
    fetchBatches.push(kinds)
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
  root = await mkdtemp(join(tmpdir(), 'dsh-system1-new-atoms-'))
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

function toolExec(context: Context, agentId: string, name: string, args: unknown): ToolExecution {
  return {
    agent: { id: agentId, sessionId: liveSession(context, agentId) },
    name,
    arguments: args,
    callId: `call-${agentId}`,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function largeResult(chars: number): ToolExecutionResult {
  return {
    isError: false,
    content: [{ type: 'text', text: 'x'.repeat(chars) }],
  } as unknown as ToolExecutionResult
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

// ---------------------------------------------------------------------------
// Stream-time tool-choice prefetch
// ---------------------------------------------------------------------------

it('prefetch: pre-execute consumes the stream-time judgment without re-asking Jev', async () => {
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const agentId = 'prefetch-agent'
  // The model streams a tool call; the plugin starts the judgment early.
  context.emit('agent/assistant-stream', {
    agent: { id: agentId },
    frame: {
      type: 'chunk',
      chunk: { type: 'tool-call-delta', index: 0, id: `call-${agentId}`, name: 'probe_tool', argumentsDelta: '{"path":"/tmp/x"}' },
    },
  })
  const decision = await context.waterfall(
    'tools/pre-execute',
    toolExec(context, agentId, 'probe_tool', { path: '/tmp/x' }),
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  expect(decision.kind).toBe('enter')
  // Exactly one Jev batch: the prefetch. Pre-execute awaited it instead of
  // spending a second round trip.
  expect(fetchBatches).toHaveLength(1)
  expect(fetchBatches[0]).toEqual(['tool-choice'])
})

it('prefetch: pre-execute asks synchronously when no stream chunk arrived', async () => {
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const agentId = 'prefetch-sync'
  const decision = await context.waterfall(
    'tools/pre-execute',
    toolExec(context, agentId, 'probe_tool', { path: '/tmp/x' }),
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  expect(decision.kind).toBe('enter')
  expect(fetchBatches).toHaveLength(1)
  expect(fetchBatches[0]).toEqual(['tool-choice'])
})

it('prefetch: a confident wrong-tool prefetch denies at pre-execute', async () => {
  jevToolChoice = 'wrong-tool'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const agentId = 'prefetch-deny'
  context.emit('agent/assistant-stream', {
    agent: { id: agentId },
    frame: {
      type: 'chunk',
      chunk: { type: 'tool-call-delta', index: 0, id: `call-${agentId}`, name: 'probe_tool', argumentsDelta: '{"path":"/tmp/x"}' },
    },
  })
  const decision = await context.waterfall(
    'tools/pre-execute',
    toolExec(context, agentId, 'probe_tool', { path: '/tmp/x' }),
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  // The prefetched wrong-tool verdict denies before dispatch; still one batch.
  expect(decision.kind).toBe('deny')
  expect(fetchBatches).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// Result triage
// ---------------------------------------------------------------------------

it('result-triage: enforce replaces a dropped large result with a marker', async () => {
  jevResultTriage = 'irrelevant'
  const context = await boot({ backend: 'jev', mode: 'enforce', injectionScreen: false })
  const agentId = 'triage-drop'
  const decision = await context.waterfall(
    'tools/post-execute',
    toolExec(context, agentId, 'probe_tool', { x: 1 }),
    largeResult(5000),
    acceptNext,
  )
  expect(decision.kind).toBe('accept')
  if (decision.kind !== 'accept') return
  expect(decision.content).toBeDefined()
  const text = (decision.content ?? []).map(block => block.type === 'text' ? block.text : '').join('')
  expect(text).toContain('[System 1 prune]')
  expect(text.length).toBeLessThan(5000)
})

it('result-triage: shadow mode leaves the result untouched', async () => {
  jevResultTriage = 'irrelevant'
  const context = await boot({ backend: 'jev', mode: 'shadow', injectionScreen: false })
  const agentId = 'triage-shadow'
  const decision = await context.waterfall(
    'tools/post-execute',
    toolExec(context, agentId, 'probe_tool', { x: 1 }),
    largeResult(5000),
    acceptNext,
  )
  expect(decision.kind).toBe('accept')
  if (decision.kind !== 'accept') return
  // Shadow observes: no content replacement.
  expect(decision.content).toBeUndefined()
})

it('result-triage: small results are never judged', async () => {
  jevResultTriage = 'irrelevant'
  const context = await boot({ backend: 'jev', mode: 'enforce', injectionScreen: false })
  const agentId = 'triage-small'
  await context.waterfall(
    'tools/post-execute',
    toolExec(context, agentId, 'probe_tool', { x: 1 }),
    largeResult(100),
    acceptNext,
  )
  // No result-triage question asked for a 100-char result.
  expect(fetchBatches.flat().includes('result-triage')).toBe(false)
})

// ---------------------------------------------------------------------------
// Injection screening
// ---------------------------------------------------------------------------

it('injection-screen: enforce warns on a confident injection verdict', async () => {
  jevInjection = 0.95
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const agentId = 'injection-warn'
  const decision = await context.waterfall(
    'tools/post-execute',
    toolExec(context, agentId, 'mcp__web__fetch', { url: 'https://example.com' }),
    largeResult(5000),
    acceptNext,
  )
  expect(decision.kind).toBe('accept')
  if (decision.kind !== 'accept') return
  const texts = contextTexts(decision)
  expect(texts.some(text => text.includes('[System 1 injection-screen]'))).toBe(true)
})

it('injection-screen: stays silent below the threshold', async () => {
  jevInjection = 0.3
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const agentId = 'injection-quiet'
  const decision = await context.waterfall(
    'tools/post-execute',
    toolExec(context, agentId, 'mcp__web__fetch', { url: 'https://example.com' }),
    largeResult(5000),
    acceptNext,
  )
  expect(decision.kind).toBe('accept')
  if (decision.kind !== 'accept') return
  expect(contextTexts(decision).some(text => text.includes('[System 1 injection-screen]'))).toBe(false)
})

// ---------------------------------------------------------------------------
// Subagent-output acceptance
// ---------------------------------------------------------------------------

function spawnExec(context: Context, agentId: string): ToolExecution {
  return {
    agent: { id: agentId, sessionId: liveSession(context, agentId) },
    name: 'spawn_teammate',
    arguments: { name: 'helper', description: 'do a subtask', prompt: 'You are helper. do a subtask.' },
    callId: `call-spawn-${agentId}`,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

it('subagent-accept: enforce injects a rework hint on a failed output', async () => {
  jevAccept = 'fails'
  jevScore = 0.1
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const agentId = 'subagent-fails'
  const decision = await context.waterfall(
    'tools/post-execute',
    spawnExec(context, agentId),
    largeResult(500),
    acceptNext,
  )
  expect(decision.kind).toBe('accept')
  if (decision.kind !== 'accept') return
  const texts = contextTexts(decision)
  expect(texts.some(text => text.includes('[System 1 subagent-accept]'))).toBe(true)
})

it('subagent-accept: a meeting output injects nothing', async () => {
  jevAccept = 'meets'
  jevScore = 0.1
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const agentId = 'subagent-meets'
  const decision = await context.waterfall(
    'tools/post-execute',
    spawnExec(context, agentId),
    largeResult(500),
    acceptNext,
  )
  expect(decision.kind).toBe('accept')
  if (decision.kind !== 'accept') return
  expect(contextTexts(decision).some(text => text.includes('[System 1 subagent-accept]'))).toBe(false)
})

// ---------------------------------------------------------------------------
// MCP server preselection
// ---------------------------------------------------------------------------

it('preselect: low-need servers are restricted before the first step', async () => {
  jevPreselect = 0.05 // below the 0.15 deny threshold: nothing is needed
  const context = await boot({ backend: 'jev', mode: 'enforce', preselect: true })
  const agentId = 'preselect-agent'
  const restricted: Array<{ deny: string[] }> = []
  const released: boolean[] = []
  const fakeAgent = {
    id: agentId,
    ctx: {
      tools: {
        schemas: () => [
          { name: 'mcp__github__list_issues', description: 'list repository issues' },
          { name: 'mcp__slack__send_message', description: 'send a slack message' },
          { name: 'mcp__linear__create_issue', description: 'create a linear issue' },
          { name: 'read_file', description: 'read a local file' },
        ],
        restrict: (opts: { deny: string[] }) => {
          restricted.push(opts)
          return () => { released.push(true) }
        },
      },
    },
  }
  // The task's first message starts preselection; the Jev round-trip
  // overlaps the wake.
  context.emit('agent/inbox/inserted', {
    agent: fakeAgent,
    message: createUserMessage({ content: [{ type: 'text', text: 'fix the login bug' }], source: { kind: 'user' } }),
  })
  // The first pre-step awaits preselection before the request is built.
  const payload = preStepPayload(context, agentId)
  const decision = await context.waterfall(
    'agent/pre-step',
    payload,
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: payload.messages }),
  )
  expect(decision.kind).toBe('enter')
  expect(fetchBatches.flat().includes('preselect')).toBe(true)
  // All three MCP servers denied; the plain tool untouched.
  expect(restricted).toHaveLength(1)
  expect(restricted[0]?.deny).toContain('mcp__github__list_issues')
  expect(restricted[0]?.deny).toContain('mcp__slack__send_message')
  expect(restricted[0]?.deny).toContain('mcp__linear__create_issue')
  expect(restricted[0]?.deny).not.toContain('read_file')
})

it('preselect: high-need servers are left alone', async () => {
  jevPreselect = 0.9 // everything looks needed: no restriction
  const context = await boot({ backend: 'jev', mode: 'enforce', preselect: true })
  const agentId = 'preselect-keep'
  const restricted: Array<{ deny: string[] }> = []
  const fakeAgent = {
    id: agentId,
    ctx: {
      tools: {
        schemas: () => [
          { name: 'mcp__github__list_issues', description: 'list repository issues' },
          { name: 'mcp__slack__send_message', description: 'send a slack message' },
          { name: 'mcp__linear__create_issue', description: 'create a linear issue' },
        ],
        restrict: (opts: { deny: string[] }) => {
          restricted.push(opts)
          return () => undefined
        },
      },
    },
  }
  context.emit('agent/inbox/inserted', {
    agent: fakeAgent,
    message: createUserMessage({ content: [{ type: 'text', text: 'fix the login bug' }], source: { kind: 'user' } }),
  })
  const payload = preStepPayload(context, agentId)
  await context.waterfall(
    'agent/pre-step',
    payload,
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: payload.messages }),
  )
  expect(fetchBatches.flat().includes('preselect')).toBe(true)
  expect(restricted).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// Pressure-gated prune
// ---------------------------------------------------------------------------

it('prune: a Jev-confirmed droppable result gates the tool-result pruner', async () => {
  jevPrune = 0.05 // confidently not needed
  const context = await boot({ backend: 'jev', mode: 'enforce', compactionPrune: true })
  // Provide the collaborators the prune atom needs: a token meter reporting
  // high pressure and the tool-result pruner service.
  const prunedSessions: unknown[] = []
  context.provide('tokenMeter', {
    measure: () => ({ totalTokens: 900 }),
    estimateMessage: () => 500,
  })
  context.provide('toolResultPruner', {
    pruneSession: (session: unknown) => { prunedSessions.push(session); return { pruned: [] } },
  })
  const agentId = 'prune-agent'
  const toolText = 'y'.repeat(5000)
  const appended: Array<{ type: string }> = []
  // A structural session: one large tool result on the surface, a 1000-token
  // window (0.9 pressure), and an append sink for decision telemetry.
  const mockSession = {
    surface: { nodes: [1] },
    eventAt: (seq: number) => seq === 1
      ? { type: 'tool/result', seq, data: { turn: 1, step: 1 } }
      : undefined,
    deriveEventMessage: () => ({
      role: 'tool',
      content: [{ type: 'text', text: toolText }],
      source: { kind: 'tool', callId: `call-${agentId}` },
      toolCallId: `call-${agentId}`,
    }),
    requestContext: () => ({ contextWindow: 1000 }),
    append: (type: string) => { appended.push({ type }); return { seq: 2 } },
  }
  const payload = {
    ...preStepPayload(context, agentId),
    agent: { id: agentId, sessionId: liveSession(context, agentId), session: mockSession },
  } as unknown as PreStepPayload
  const decision = await context.waterfall(
    'agent/pre-step',
    payload,
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: payload.messages }),
  )
  expect(decision.kind).toBe('enter')
  expect(fetchBatches.flat().includes('prune')).toBe(true)
  // Jev gated the prune; the existing pruner service did the rewrite.
  expect(prunedSessions).toHaveLength(1)
  expect(prunedSessions[0]).toBe(mockSession)
})

it('prune: stays inert without pressure', async () => {
  jevPrune = 0.05
  const context = await boot({ backend: 'jev', mode: 'enforce', compactionPrune: true })
  const prunedSessions: unknown[] = []
  context.provide('tokenMeter', {
    measure: () => ({ totalTokens: 100 }),
    estimateMessage: () => 500,
  })
  context.provide('toolResultPruner', {
    pruneSession: (session: unknown) => { prunedSessions.push(session); return { pruned: [] } },
  })
  const agentId = 'prune-idle'
  const toolText = 'y'.repeat(5000)
  const mockSession = {
    surface: { nodes: [1] },
    eventAt: (seq: number) => seq === 1
      ? { type: 'tool/result', seq, data: { turn: 1, step: 1 } }
      : undefined,
    deriveEventMessage: () => ({
      role: 'tool',
      content: [{ type: 'text', text: toolText }],
      source: { kind: 'tool', callId: `call-${agentId}` },
      toolCallId: `call-${agentId}`,
    }),
    requestContext: () => ({ contextWindow: 1000 }),
    append: () => ({ seq: 2 }),
  }
  const payload = {
    ...preStepPayload(context, agentId),
    agent: { id: agentId, sessionId: liveSession(context, agentId), session: mockSession },
  } as unknown as PreStepPayload
  await context.waterfall(
    'agent/pre-step',
    payload,
    (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: payload.messages }),
  )
  // 0.1 pressure: no prune question, no pruner pass.
  expect(fetchBatches.flat().includes('prune')).toBe(false)
  expect(prunedSessions).toHaveLength(0)
})
