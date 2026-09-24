/**
 * Harness v2 behavior (defaults): decomposed request triage, strategy hints
 * off, gated downgrades, verify-then-escalate, explaining STOP step,
 * task-aware result triage with head+tail and a never-drop tail guard.
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
import { buildTriageFeatureQuestions, combineTriage, requestText, validateTriageFeature } from '../src/triage.ts'
import { buildResultTriageQuestion, edgesPreview, tailReportsFailure } from '../src/gates.ts'

type PreStepPayload = Parameters<Events['agent/pre-step']>[0]
type RequestPayload = Parameters<Events['agent/request']>[0]

const user = (text: string): UserMessage => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

describe('decomposed triage', () => {
  it('combines literal features into a verdict with a support confidence', () => {
    expect(combineTriage({ answerable: 0.95, 'single-change': 0.1, investigation: 0.05, broad: 0.1 }))
      .toEqual({ verdict: 'trivial', confidence: 0.9 })
    expect(combineTriage({ answerable: 0.1, 'single-change': 0.1, investigation: 0.9, broad: 0.2 }).verdict).toBe('complex')
    expect(combineTriage({ answerable: 0.1, 'single-change': 0.2, investigation: 0.3, broad: 0.75 }).verdict).toBe('complex')
    expect(combineTriage({ answerable: 0.6, 'single-change': 0.5, investigation: 0.4, broad: 0.3 }).verdict).toBe('standard')
  })

  it('never produces trivial from missing answers', () => {
    expect(combineTriage({ answerable: 0.99, 'single-change': null, investigation: null, broad: null }).verdict).toBe('standard')
    expect(combineTriage({ answerable: null, 'single-change': null, investigation: null, broad: null }).verdict).toBe('standard')
  })

  it('judges request text only, and asks four nouls over one shared flat state', () => {
    expect(requestText([])).toBe('')
    expect(requestText([user('  '), user('fix the typo')])).toBe('fix the typo')
    const questions = buildTriageFeatureQuestions('fix the typo')
    expect(questions).toHaveLength(4)
    expect(new Set(questions.map(q => JSON.stringify(q.context))).size).toBe(1)
    expect(questions.every(q => q.primitive === 'noul' && q.kind === 'triage-feature')).toBe(true)
    expect(validateTriageFeature(0.4)).toBe(0.4)
    expect(validateTriageFeature(2)).toBeNull()
    expect(validateTriageFeature('x')).toBeNull()
  })
})

describe('result triage inputs', () => {
  it('previews head and tail, and guards failing tails', () => {
    const text = `${'a'.repeat(3000)}${'b'.repeat(3000)}`
    const preview = edgesPreview(text, 100, 100)
    expect(preview.startsWith('a'.repeat(100))).toBe(true)
    expect(preview.endsWith('b'.repeat(100))).toBe(true)
    expect(preview).toContain('chars omitted')
    expect(edgesPreview('short', 100, 100)).toBe('short')
    expect(edgesPreview(text, 100, 0).endsWith('\n')).toBe(true)
    expect(tailReportsFailure(`${'ok\n'.repeat(500)}FAIL test/parser.spec.ts`, 1500)).toBe(true)
    expect(tailReportsFailure(`${'ok\n'.repeat(500)}Traceback (most recent call last)`, 1500)).toBe(true)
    expect(tailReportsFailure(`FAIL early\n${'ok\n'.repeat(1000)}`, 1500)).toBe(false)
    const question = buildResultTriageQuestion('bash', 'x', 10, 'run the tests')
    expect(question.context).toMatchObject({ task: 'run the tests' })
    expect(buildResultTriageQuestion('bash', 'x', 10).context).toMatchObject({ task: '' })
  })
})

// ---------------------------------------------------------------------------
// Composition: real loader, stubbed Jev keyed by question content
// ---------------------------------------------------------------------------

let features: Record<string, number>
let choices: Record<string, string>
let nouls: Record<string, number>
let batches: string[][]

const FEATURE_KEYS: Array<[string, string]> = [
  ['general knowledge', 'answerable'],
  ['precisely specified change', 'single-change'],
  ['investigating an unknown cause', 'investigation'],
  ['several files or components', 'broad'],
]

beforeEach(() => {
  features = { answerable: 0.95, 'single-change': 0.1, investigation: 0.05, broad: 0.05 }
  choices = { 'final-answer': 'adequate', 'tool-choice': 'proceed', 'result-triage': 'useful' }
  nouls = { 'loop-check': 0.1 }
  batches = []
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key')
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith('/models')) return new Response('{}', { status: 200 })
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string; instructions: string; criteria?: Record<string, unknown> }> }
    const kinds: string[] = []
    const answers: Record<string, Record<string, unknown>> = {}
    for (const [id, q] of Object.entries(body.questions)) {
      const kind = id.split('#')[0] ?? id
      kinds.push(kind)
      if (q.type === 'noul') {
        const feature = FEATURE_KEYS.find(([needle]) => q.instructions.includes(needle))?.[1]
        answers[id] = { noul: feature !== undefined ? features[feature] : nouls[kind] ?? 0.1 }
      } else if (q.type === 'score') {
        answers[id] = { score: 0.2, confidence: 0.95 }
      } else {
        const options = Object.keys(q.criteria ?? {})
        answers[id] = { choice: choices[kind] ?? (kind === 'delegation' ? 'keep' : options[0]), confidence: 0.95 }
      }
    }
    batches.push(kinds)
    return new Response(JSON.stringify({ model: 'jev-test', answers }), { status: 200 })
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
  root = await mkdtemp(join(tmpdir(), 'dsh-system1-v2-'))
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
  const merged = { backend: 'jev', mode: 'enforce', ...system1Config }
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

async function preStep(context: Context, agentId: string, step: number, messages: UserMessage[], turn = 1): Promise<PreStepDecision> {
  const payload = { agent: agentRef(context, agentId), messages, turn, step, signal: new AbortController().signal } as unknown as PreStepPayload
  return await context.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter' as const, messages }))
}

function request(context: Context, agentId: string, step: number, turn = 1): Promise<LlmCallConfig> {
  const payload = { agent: agentRef(context, agentId), turn, step, signal: new AbortController().signal } as unknown as RequestPayload
  return context.waterfall('agent/request', payload, async () => ({ provider: 'p', model: 'base-model' }))
}

function exec(context: Context, agentId: string, name: string, callId: string, args: unknown = { a: 1 }): ToolExecution {
  return { agent: agentRef(context, agentId), name, callId, arguments: args, signal: new AbortController().signal } as unknown as ToolExecution
}

function system1Texts(decision: PreStepDecision): string[] {
  if (decision.kind !== 'enter') return []
  return decision.messages
    .filter(message => (message.source as { kind?: string }).kind === 'system1')
    .flatMap(message => message.content.map(block => (block.type === 'text' ? block.text : '')))
}

const ROUTES = { modelRoute: { trivial: { model: 'cheap-model' }, complex: { model: 'strong-model' } } }

for (const actuation of ['async', 'blocking'] as const) {
  describe(`defaults (${actuation})`, () => {
    it('routes a clearly trivial request down without injecting any hint', async () => {
      const context = await boot({ actuation, ...ROUTES })
      const decision = await preStep(context, 'a1', 1, [user('what does --no-open do?')])
      expect(system1Texts(decision)).toEqual([])
      expect((await request(context, 'a1', 1)).model).toBe('cheap-model')
      expect(batches.filter(kinds => kinds.includes('triage-feature'))).toHaveLength(1)
      expect(batches.find(kinds => kinds.includes('triage-feature'))).toHaveLength(5)
    })

    it('a weak trivial never downgrades; continuation steps are not triaged', async () => {
      features = { answerable: 0.82, 'single-change': 0.1, investigation: 0.25, broad: 0.1 }
      const context = await boot({ actuation, ...ROUTES })
      await preStep(context, 'a2', 1, [user('rename x to y')])
      expect((await request(context, 'a2', 1)).model).toBe('base-model')
      const before = batches.length
      await preStep(context, 'a2', 2, [])
      expect(batches.length).toBe(before)
    })

    it('complex requests route up and the turn stays routed', async () => {
      features = { answerable: 0.05, 'single-change': 0.05, investigation: 0.9, broad: 0.6 }
      const context = await boot({ actuation, ...ROUTES })
      await preStep(context, 'a3', 1, [user('find the deadlock')])
      await preStep(context, 'a3', 2, [])
      expect((await request(context, 'a3', 2)).model).toBe('strong-model')
    })

    it('verify-then-escalate: an inadequate cheap-route answer steers one more step on the default route', async () => {
      choices['final-answer'] = 'inadequate'
      const context = await boot({ actuation, ...ROUTES })
      await preStep(context, 'a4', 1, [user('what is 2+2?')])
      expect((await request(context, 'a4', 1)).model).toBe('cheap-model')
      const steer = vi.fn()
      const session = {
        deriveMessages: () => [
          { role: 'user', content: [{ type: 'text', text: 'what is 2+2?' }] },
          { role: 'assistant', content: [{ type: 'text', text: '5' }] },
        ],
      }
      await context.serial('agent/turn-stopping', { agent: { id: 'a4', session, steer }, turn: 1 } as never)
      expect(steer).toHaveBeenCalledTimes(1)
      expect((await request(context, 'a4', 2)).model).toBe('base-model')
      // Once per turn: a second stop in the same turn does not re-verify.
      await context.serial('agent/turn-stopping', { agent: { id: 'a4', session, steer }, turn: 1 } as never)
      expect(steer).toHaveBeenCalledTimes(1)
    })

    it('an adequate cheap-route answer ends the turn normally', async () => {
      const context = await boot({ actuation, ...ROUTES })
      await preStep(context, 'a5', 1, [user('what is 2+2?')])
      await request(context, 'a5', 1)
      const steer = vi.fn()
      const session = { deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'q' }] }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }] }
      await context.serial('agent/turn-stopping', { agent: { id: 'a5', session, steer }, turn: 1 } as never)
      expect(steer).not.toHaveBeenCalled()
    })

    it('STOP explains instead of ending silently, and denies tools in that step', async () => {
      nouls['loop-check'] = 0.97
      const context = await boot({ actuation, stopStuckThreshold: 0.9 })
      await preStep(context, 'a6', 1, [user('keep trying')])
      const failed = { isError: true, error: { message: 'boom' } } as unknown as ToolExecutionResult
      for (let i = 0; i < 5; i += 1) {
        await context.waterfall('tools/post-execute', exec(context, 'a6', 'bash', `c${i}`, { cmd: 'x' }), failed, async (): Promise<PostToolDecision> => ({ kind: 'accept' }))
      }
      const stop = await preStep(context, 'a6', 7, [])
      expect(stop.kind).toBe('enter')
      expect(system1Texts(stop).join('\n')).toContain('[System 1 stop]')
      const denied = await context.waterfall('tools/pre-execute', exec(context, 'a6', 'read_file', 'd1'), async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
      expect(denied.kind).toBe('deny')
      await context.serial('agent/turn-stopping', { agent: { id: 'a6' }, turn: 1 } as never)
      const allowed = await context.waterfall('tools/pre-execute', exec(context, 'a6', 'read_file', 'd2'), async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
      expect(allowed.kind).toBe('allow')
    })

    it('never asks to drop a result whose tail reports a failure; triage sees the task', async () => {
      const context = await boot({ actuation, triageMinChars: 100, injectionScreen: false })
      await preStep(context, 'a7', 1, [user('run the parser tests')])
      const failing = { isError: false, content: [{ type: 'text', text: `${'PASS ok\n'.repeat(300)}FAIL test/parser.spec.ts` }] } as unknown as ToolExecutionResult
      await context.waterfall('tools/post-execute', exec(context, 'a7', 'bash', 'r1'), failing, async (): Promise<PostToolDecision> => ({ kind: 'accept' }))
      expect(batches.some(kinds => kinds.includes('result-triage'))).toBe(false)
      const noisy = { isError: false, content: [{ type: 'text', text: 'npm WARN deprecated\n'.repeat(300) }] } as unknown as ToolExecutionResult
      await context.waterfall('tools/post-execute', exec(context, 'a7', 'bash', 'r2'), noisy, async (): Promise<PostToolDecision> => ({ kind: 'accept' }))
      await vi.waitFor(() => { expect(batches.some(kinds => kinds.includes('result-triage'))).toBe(true) })
    })
  })
}

it('shadow triages fresh input only, with the decomposed batch', async () => {
  const context = await boot({ mode: 'shadow' })
  await preStep(context, 's1', 1, [user('fix the typo in README')])
  await vi.waitFor(() => { expect(batches.filter(kinds => kinds.includes('triage-feature'))).toHaveLength(1) })
  await preStep(context, 's1', 2, [])
  await preStep(context, 's1', 3, [])
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(batches.filter(kinds => kinds.includes('triage-feature'))).toHaveLength(1)
})

it('strategyHints: complex injects only the decomposition hint', async () => {
  features = { answerable: 0.05, 'single-change': 0.05, investigation: 0.9, broad: 0.6 }
  const context = await boot({ strategyHints: 'complex' })
  const decision = await preStep(context, 'h1', 1, [user('find the deadlock')])
  expect(system1Texts(decision).join('\n')).toContain('[System 1 triage: complex]')
})

it('stopMode: reject keeps the legacy silent reject', async () => {
  nouls['loop-check'] = 0.97
  const context = await boot({ stopMode: 'reject', stopStuckThreshold: 0.9 })
  await preStep(context, 'r1', 1, [user('keep trying')])
  const failed = { isError: true, error: { message: 'boom' } } as unknown as ToolExecutionResult
  for (let i = 0; i < 5; i += 1) {
    await context.waterfall('tools/post-execute', exec(context, 'r1', 'bash', `c${i}`, { cmd: 'x' }), failed, async (): Promise<PostToolDecision> => ({ kind: 'accept' }))
  }
  expect((await preStep(context, 'r1', 7, [])).kind).toBe('reject')
})
