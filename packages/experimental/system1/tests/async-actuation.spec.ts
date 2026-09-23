/**
 * Async actuation (`mode: 'enforce'`, `actuation: 'async'`) tests.
 *
 * The blocking enforce path awaits a Jev round-trip on every seam, which at
 * live Jev latencies makes the harness slower than no System 1 at all. The
 * async path must keep the same judgments while proving:
 *
 * - turn triage is speculated at inbox insert and asked once per turn;
 * - continuation steps with nothing pending make no Jev call and add no wait;
 * - routing is sticky per turn and upgrade-only (prefix cache survives);
 * - every wait is bounded by its deadline; late judgments are still used
 *   when they settle (routing via peek, hints at the next pre-step);
 * - only risky tools wait for tool-choice; everything else dispatches now;
 * - post-execute guidance is delivered at the next pre-step;
 * - large-result triage replaces content within its deadline;
 * - service: caller aborts never trip the breaker, critical kinds keep a
 *   reserve, the half-open circuit admits one probe.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Events } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as System1Plugin from '../src/index.ts'
import { JudgmentBoard } from '../src/board.ts'
import {
  compileToolPatterns,
  DEFAULT_RISKY_TOOL_PATTERNS,
  HintLedger,
  isFreshStep,
  isRiskyTool,
  PendingQueue,
  RouteLedger,
} from '../src/policy.ts'
import { System1Service } from '../src/service.ts'
import { JevBackend } from '../src/backends/jev.ts'
import type { System1Backend } from '../src/backend.ts'
import type { System1Judgment, System1Question, System1RuntimeConfig } from '../src/types.ts'

type PreStepPayload = Parameters<Events['agent/pre-step']>[0]
type RequestPayload = Parameters<Events['agent/request']>[0]

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Unit: JudgmentBoard
// ---------------------------------------------------------------------------

describe('JudgmentBoard', () => {
  it('peek never waits; take waits at most the deadline', async () => {
    const board = new JudgmentBoard()
    board.post('a', sleep(40).then(() => 'late-value'))
    expect(board.peek('a')).toEqual({ status: 'late' })
    const started = Date.now()
    expect(await board.take('a', 10)).toEqual({ status: 'late' })
    expect(Date.now() - started).toBeLessThan(35)
    expect(await board.take('a', 200)).toEqual({ status: 'ready', value: 'late-value' })
    expect(board.peek('a')).toEqual({ status: 'ready', value: 'late-value' })
  })

  it('settles rejections as null and reports missing keys', async () => {
    const board = new JudgmentBoard()
    board.post('bad', Promise.reject(new Error('boom')))
    expect(await board.take('bad', 50)).toEqual({ status: 'ready', value: null })
    expect(board.peek('nope')).toEqual({ status: 'missing' })
    expect(await board.take('nope', 50)).toEqual({ status: 'missing' })
  })

  it('a replaced slot ignores the old promise; abort resolves late; capacity evicts oldest', async () => {
    const board = new JudgmentBoard(2)
    let release: (value: string) => void = () => {}
    board.post('k', new Promise<string>((resolve) => { release = resolve }))
    board.post('k', Promise.resolve('new'))
    release('old')
    await sleep(0)
    expect(board.peek('k')).toEqual({ status: 'ready', value: 'new' })
    const controller = new AbortController()
    board.post('slow', sleep(500).then(() => 'x'))
    const taking = board.take('slow', 1000, controller.signal)
    controller.abort()
    expect(await taking).toEqual({ status: 'late' })
    board.post('third', Promise.resolve('y'))
    expect(board.has('k')).toBe(false)
    expect(board.size).toBe(2)
    board.clear('th')
    expect(board.has('third')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unit: policies
// ---------------------------------------------------------------------------

describe('policies', () => {
  it('RouteLedger is sticky per turn and upgrade-only', () => {
    const ledger = new RouteLedger()
    expect(ledger.offer('a', 1, 'complex', 't1')).toEqual({ verdict: 'complex', changed: true })
    expect(ledger.offer('a', 1, 'trivial', 't2')).toEqual({ verdict: 'complex', changed: false })
    expect(ledger.get('a', 1)?.verdict).toBe('complex')
    expect(ledger.offer('a', 2, 'trivial', 't3')).toEqual({ verdict: 'trivial', changed: true })
    expect(ledger.offer('a', 2, 'standard', 't4').changed).toBe(true)
    expect(ledger.escalate('a', 2)).toBe('complex')
    expect(ledger.escalate('a', 2)).toBeNull()
    expect(ledger.escalate('a', 9)).toBeNull()
    ledger.reset('a')
    expect(ledger.get('a', 2)).toBeNull()
  })

  it('risky-tool patterns match shell/write/delete/mcp and skip reads; bad patterns are ignored', () => {
    const patterns = compileToolPatterns([...DEFAULT_RISKY_TOOL_PATTERNS, '(unclosed'])
    expect(patterns).toHaveLength(DEFAULT_RISKY_TOOL_PATTERNS.length)
    for (const name of ['bash', 'pwsh_persistent', 'write_file', 'delete_path', 'mcp__github__merge']) {
      expect(isRiskyTool(name, patterns)).toBe(true)
    }
    for (const name of ['read_file', 'grep', 'list_dir', 'web_search']) {
      expect(isRiskyTool(name, patterns)).toBe(false)
    }
  })

  it('fresh steps, hint dedupe, pending queue', () => {
    expect(isFreshStep(1, 0)).toBe(true)
    expect(isFreshStep(3, 0)).toBe(false)
    expect(isFreshStep(3, 1)).toBe(true)
    const hints = new HintLedger()
    expect(hints.admit('a', 1, 'x')).toBe(true)
    expect(hints.admit('a', 1, 'x')).toBe(false)
    expect(hints.admit('a', 2, 'x')).toBe(true)
    const queue = new PendingQueue(2)
    queue.push('a', 'k1')
    queue.push('a', 'k2')
    queue.push('a', 'k3')
    expect(queue.list('a')).toEqual(['k2', 'k3'])
    queue.retain('a', ['k3'])
    expect(queue.list('a')).toEqual(['k3'])
    queue.retain('a', [])
    expect(queue.list('a')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Unit: service fixes
// ---------------------------------------------------------------------------

function runtime(overrides: Partial<System1RuntimeConfig> = {}): System1RuntimeConfig {
  return {
    backend: 'jev', mode: 'enforce', enabled: true, confidenceThreshold: 0.7, thresholds: {},
    budgetPerTurn: 8, budgetPerTask: 16, timeoutMs: 1000, failureThreshold: 3, cooldownMs: 30,
    traceBufferSize: 200,
    ...overrides,
  } as System1RuntimeConfig
}

function question(kind: System1Question['kind']): System1Question {
  return { kind, primitive: 'choice', prompt: 'p', context: {}, options: { a: 'a' } }
}

const okJudgment = (): System1Judgment => ({ answer: 'a', confidence: 0.95, latencyMs: 1, backend: 'jev', abstained: false })
const identity = (answer: unknown): unknown => answer

describe('System1Service', () => {
  it('a caller abort is cancelled, never a breaker failure', async () => {
    const hanging: System1Backend = {
      kind: 'jev',
      decide: async () => okJudgment(),
      decideMany: (_questions, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('This operation was aborted')) })
      }),
      dispose: async () => {},
    }
    const service = new System1Service(hanging, runtime())
    for (let i = 0; i < 4; i += 1) {
      const controller = new AbortController()
      setTimeout(() => { controller.abort() }, 5)
      const [decision] = await service.askMany([question('triage')], [identity], 'turn', controller.signal, 'a')
      expect(decision?.fallback).toBe('cancelled')
    }
    const aborted = new AbortController()
    aborted.abort()
    const [pre] = await service.askMany([question('triage')], [identity], 'turn', aborted.signal, 'a')
    expect(pre?.fallback).toBe('cancelled')
    // Four interrupts later the circuit is still closed and budget was refunded.
    const healthy = new System1Service({ ...hanging, decideMany: async qs => qs.map(okJudgment) }, runtime())
    const [ok] = await healthy.askMany([question('triage')], [identity], 'turn', new AbortController().signal, 'a')
    expect(ok?.fallback).toBeNull()
  })

  it('critical kinds keep a reserve after early questions spend the turn budget', async () => {
    const backend: System1Backend = { kind: 'jev', decide: async () => okJudgment(), decideMany: async qs => qs.map(okJudgment), dispose: async () => {} }
    const service = new System1Service(backend, runtime({ budgetPerTurn: 2, criticalReserve: 1 }))
    const signal = new AbortController().signal
    await service.askMany([question('triage'), question('delegation')], [identity, identity], 'turn', signal, 'a')
    const [triage] = await service.askMany([question('triage')], [identity], 'turn', signal, 'a')
    expect(triage?.fallback).toBe('budget-exceeded')
    const [loop] = await service.askMany([question('loop-check')], [identity], 'turn', signal, 'a')
    expect(loop?.fallback).toBeNull()
    const [again] = await service.askMany([question('loop-check')], [identity], 'turn', signal, 'a')
    expect(again?.fallback).toBe('budget-exceeded')
  })

  it('concurrent batches reserve budget before awaiting (no overspend)', async () => {
    const backend: System1Backend = {
      kind: 'jev', decide: async () => okJudgment(),
      decideMany: async (qs) => { await sleep(10); return qs.map(okJudgment) },
      dispose: async () => {},
    }
    const service = new System1Service(backend, runtime({ budgetPerTurn: 2, criticalReserve: 0 }))
    const signal = new AbortController().signal
    const results = await Promise.all([1, 2, 3].map(() => service.askMany([question('triage')], [identity], 'turn', signal, 'a')))
    const answered = results.flat().filter(decision => decision.fallback === null)
    expect(answered).toHaveLength(2)
  })

  it('half-open circuit admits one probe and reopens on its failure', async () => {
    let fail = true
    let calls = 0
    const backend: System1Backend = {
      kind: 'jev', decide: async () => okJudgment(),
      decideMany: async (qs) => { calls += 1; if (fail) throw new Error('down'); return qs.map(okJudgment) },
      dispose: async () => {},
    }
    const service = new System1Service(backend, runtime({ failureThreshold: 2, cooldownMs: 20 }))
    const signal = new AbortController().signal
    await service.askMany([question('triage')], [identity], 'turn', signal, 'a')
    await service.askMany([question('triage')], [identity], 'turn', signal, 'a')
    const [open] = await service.askMany([question('triage')], [identity], 'turn', signal, 'a')
    expect(open?.trace.note).toBe('circuit open')
    await sleep(25)
    await service.askMany([question('triage')], [identity], 'turn', signal, 'a') // probe fails
    const callsAfterProbe = calls
    const [reopened] = await service.askMany([question('triage')], [identity], 'turn', signal, 'a')
    expect(reopened?.trace.note).toBe('circuit open')
    expect(calls).toBe(callsAfterProbe)
    fail = false
    await sleep(25)
    const [probe] = await service.askMany([question('triage')], [identity], 'turn', signal, 'a')
    expect(probe?.fallback).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Unit: Jev wire format
// ---------------------------------------------------------------------------

describe('JevBackend wire', () => {
  it('sends a shared context flat, without state pointers; warm-up hits /models', async () => {
    const seen: Array<{ url: string; body: unknown }> = []
    vi.stubEnv('TYPESAFE_API_KEY', 'k')
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {} }), { status: 200 })
    })
    const backend = new JevBackend(runtime({
      jevApiKeyEnv: 'TYPESAFE_API_KEY', jevEndpoint: 'https://api.typesafe.ai/v1/systemone', jevModel: 'jev-1.13.0', redactState: false,
    }))
    const shared = { messagePreview: 'hi' }
    await backend.decideMany([
      { ...question('triage'), prompt: 'Q1', context: shared },
      { ...question('delegation'), prompt: 'Q2', context: { ...shared } },
    ], new AbortController().signal)
    const body = seen[0]?.body as { state: unknown; questions: Record<string, { instructions: string }> }
    expect(body.state).toEqual({ messagePreview: 'hi' })
    expect(body.questions['triage#0']?.instructions).toBe('Q1')
    await backend.warm(new AbortController().signal)
    expect(seen[1]?.url).toBe('https://api.typesafe.ai/v1/models')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
})

// ---------------------------------------------------------------------------
// Composition: real Loader, stubbed Jev
// ---------------------------------------------------------------------------

let jevTriage: string
let jevToolChoice: string
let jevResultTriage: string
let jevRetry: string
let jevConfidence: number
let jevDelayMs: number
let batches: string[][]

beforeEach(() => {
  jevTriage = 'complex'
  jevToolChoice = 'proceed'
  jevResultTriage = 'useful'
  jevRetry = 'retry-different'
  jevConfidence = 0.95
  jevDelayMs = 0
  batches = []
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key')
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith('/models')) return new Response('{}', { status: 200 })
    if (typeof init?.body !== 'string') throw new Error('expected a JSON body')
    const body = JSON.parse(init.body) as { questions: Record<string, { type: string }> }
    const kinds: string[] = []
    const answers: Record<string, Record<string, unknown>> = {}
    for (const [id, q] of Object.entries(body.questions)) {
      const kind = id.split('#')[0] ?? id
      kinds.push(kind)
      if (q.type === 'noul') answers[id] = { noul: 0.1 }
      else if (q.type === 'score') answers[id] = { score: 0.2, confidence: jevConfidence }
      else {
        const choice = kind === 'triage' ? jevTriage
          : kind === 'delegation' ? 'keep'
            : kind === 'tool-choice' ? jevToolChoice
              : kind === 'result-triage' ? jevResultTriage
                : kind === 'retry-judgment' ? jevRetry
                  : 'retry'
        answers[id] = { choice, confidence: jevConfidence }
      }
    }
    batches.push(kinds)
    if (jevDelayMs > 0) await sleep(jevDelayMs)
    return new Response(JSON.stringify({ model: 'jev-test', answers }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
})

async function boot(system1Config: Record<string, unknown>): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-system1-async-'))
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
  const merged = { backend: 'jev', mode: 'enforce', actuation: 'async', ...system1Config }
  await writeFile(configPath, [...modules.keys()].flatMap(name => [
    `- name: '${name}'`,
    ...name === '@deepseek-ai/dsh-experimental-system1'
      ? ['  config:', ...Object.entries(merged).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`)]
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

function agentRef(context: Context, agentId: string): { id: string; sessionId: SessionId } {
  const id = SessionId(`agent:${agentId}`)
  return { id: agentId, sessionId: (context.sessions.get(id) ?? context.sessions.create(id)).id }
}

const userMessage = (text: string): UserMessage => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

function preStep(context: Context, agentId: string, step: number, messages: UserMessage[], turn = 1): PreStepPayload {
  return { agent: agentRef(context, agentId), messages, turn, step, signal: new AbortController().signal } as unknown as PreStepPayload
}

async function runPreStep(context: Context, payload: PreStepPayload): Promise<PreStepDecision> {
  return await context.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter' as const, messages: payload.messages }))
}

function request(context: Context, agentId: string, step: number, turn = 1): Promise<LlmCallConfig> {
  const payload = { agent: agentRef(context, agentId), turn, step, signal: new AbortController().signal } as unknown as RequestPayload
  return context.waterfall('agent/request', payload, async () => ({ provider: 'p', model: 'base-model' }))
}

function exec(
  context: Context, agentId: string, name: string, callId: string, args: unknown = { a: 1 },
): ToolExecution {
  const signal = new AbortController().signal
  return { agent: agentRef(context, agentId), name, callId, arguments: args, signal } as unknown as ToolExecution
}

function hintTexts(messages: readonly UserMessage[]): string[] {
  return messages
    .filter(message => (message.source as { kind?: string }).kind === 'system1')
    .flatMap(message => message.content.map(block => (block.type === 'text' ? block.text : '')))
}

function entered(decision: PreStepDecision): UserMessage[] {
  if (decision.kind !== 'enter') throw new Error('expected enter')
  return decision.messages
}

const accept = (): Promise<PostToolDecision> => Promise.resolve({ kind: 'accept' })

it('speculates triage at inbox insert and reuses it at step 1 (one triage batch)', async () => {
  const context = await boot({ modelRoute: { complex: { model: 'strong-model' } } })
  context.emit('agent/inbox/inserted', { agent: agentRef(context, 'a1'), message: userMessage('refactor the module') })
  const decision = await runPreStep(context, preStep(context, 'a1', 1, [userMessage('refactor the module')]))
  expect(hintTexts(entered(decision)).join('\n')).toContain('[System 1 triage: complex]')
  expect(batches.filter(kinds => kinds.includes('triage'))).toHaveLength(1)
  expect((await request(context, 'a1', 1)).model).toBe('strong-model')
})

it('continuation steps make no Jev call, add no hint, and keep the route', async () => {
  const context = await boot({ modelRoute: { complex: { model: 'strong-model' } } })
  await runPreStep(context, preStep(context, 'a2', 1, [userMessage('task')]))
  const before = batches.length
  const started = Date.now()
  const step2 = await runPreStep(context, preStep(context, 'a2', 2, []))
  expect(Date.now() - started).toBeLessThan(50)
  expect(batches.length).toBe(before)
  expect(hintTexts(entered(step2))).toHaveLength(0)
  expect((await request(context, 'a2', 2)).model).toBe('strong-model')
})

it('routing is sticky: a later trivial verdict in the same turn never downgrades', async () => {
  const context = await boot({ modelRoute: { complex: { model: 'strong-model' }, trivial: { model: 'cheap-model' } } })
  await runPreStep(context, preStep(context, 'a3', 1, [userMessage('hard task')]))
  jevTriage = 'trivial'
  const steer = await runPreStep(context, preStep(context, 'a3', 3, [userMessage('also rename x')]))
  expect(hintTexts(entered(steer))).toHaveLength(0)
  expect((await request(context, 'a3', 3)).model).toBe('strong-model')
  // A new turn starts clean.
  await runPreStep(context, preStep(context, 'a3', 1, [userMessage('what is 2+2')], 2))
  expect((await request(context, 'a3', 1, 2)).model).toBe('cheap-model')
})

it('a slow verdict never blocks past the deadline, then routes via peek once it lands', async () => {
  jevDelayMs = 150
  const context = await boot({ routeDeadlineMs: 30, modelRoute: { complex: { model: 'strong-model' } } })
  const started = Date.now()
  const decision = await runPreStep(context, preStep(context, 'a4', 1, [userMessage('task')]))
  expect(Date.now() - started).toBeLessThan(120)
  expect(hintTexts(entered(decision))).toHaveLength(0)
  expect((await request(context, 'a4', 1)).model).toBe('base-model')
  await sleep(200)
  expect((await request(context, 'a4', 2)).model).toBe('strong-model')
})

it('only risky tools wait for tool-choice; a confident wrong-tool on bash is denied', async () => {
  jevToolChoice = 'wrong-tool'
  const context = await boot({})
  await runPreStep(context, preStep(context, 'a5', 1, [userMessage('task')]))
  const before = batches.length
  const safe = await context.waterfall('tools/pre-execute', exec(context, 'a5', 'read_file', 'c1'), async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
  expect(safe.kind).toBe('allow')
  expect(batches.length).toBe(before)
  const risky = await context.waterfall('tools/pre-execute', exec(context, 'a5', 'bash', 'c2', { cmd: 'rm -rf build' }), async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
  expect(risky.kind).toBe('deny')
})

it('a slow risky-tool judgment proceeds after the deadline', async () => {
  jevToolChoice = 'wrong-tool'
  const context = await boot({ toolGateDeadlineMs: 20 })
  jevDelayMs = 200
  const started = Date.now()
  const decision = await context.waterfall('tools/pre-execute', exec(context, 'a6', 'bash', 'c1'), async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
  expect(decision.kind).toBe('allow')
  expect(Date.now() - started).toBeLessThan(150)
})

it('post-execute returns immediately; the retry hint arrives at the next pre-step', async () => {
  jevDelayMs = 40
  const context = await boot({ drainDeadlineMs: 200 })
  const failed = { isError: true, error: { message: 'ENOENT: no such file' } } as unknown as ToolExecutionResult
  const started = Date.now()
  const post = await context.waterfall('tools/post-execute', exec(context, 'a7', 'read_file', 'c1'), failed, accept)
  expect(Date.now() - started).toBeLessThan(30)
  expect(post.kind === 'accept' ? post.additionalContexts ?? [] : []).toHaveLength(0)
  const step2 = await runPreStep(context, preStep(context, 'a7', 2, []))
  const hints = hintTexts(entered(step2))
  expect(hints.join('\n')).toContain('[System 1 retry-judgment]')
})

it('large-result triage replaces content within its deadline', async () => {
  jevResultTriage = 'noisy_keep_head'
  const context = await boot({ triageMinChars: 100, triageHeadChars: 10, injectionScreen: false })
  const big = { isError: false, content: [{ type: 'text', text: 'x'.repeat(500) }] } as unknown as ToolExecutionResult
  const post = await context.waterfall('tools/post-execute', exec(context, 'a8', 'run_tests', 'c1'), big, async (): Promise<PostToolDecision> => ({ kind: 'accept' }))
  if (post.kind !== 'accept' || post.content === undefined) throw new Error('expected replaced content')
  const text = post.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  expect(text.startsWith('xxxxxxxxxx')).toBe(true)
  expect(text.length).toBeLessThan(500)
})

it('turn end drops undelivered judgments so they cannot leak into the next turn', async () => {
  jevDelayMs = 50
  const context = await boot({ drainDeadlineMs: 0 })
  const failed = { isError: true, error: { message: 'boom' } } as unknown as ToolExecutionResult
  await context.waterfall('tools/post-execute', exec(context, 'a9', 'read_file', 'c1'), failed, accept)
  await context.serial('agent/turn-stopping', { agent: agentRef(context, 'a9'), turn: 1 } as never)
  await sleep(80)
  const next = await runPreStep(context, preStep(context, 'a9', 2, [], 2))
  expect(hintTexts(entered(next)).join('\n')).not.toContain('retry-judgment')
})
