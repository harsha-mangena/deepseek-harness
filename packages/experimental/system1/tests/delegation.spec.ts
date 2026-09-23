/**
 * Delegation (orchestrator-level) composition tests for the System 1 plugin.
 *
 * Judge-before-delegate: when the Lead calls `spawn_teammate`, the plugin
 * triages the delegated subtask and advises the Lead through
 * `additionalContexts` on the spawn result — a strategy advisory for
 * standard/complex subtasks (the teammate itself gets the matching
 * atom/chain/tree-of-thoughts hint on its first pre-step via the
 * agent-level hook) and a deterministic warning for duplicate-purpose
 * spawns. Every test boots the real Loader composition with a stubbed Jev
 * `fetch` and dispatches the real `tools/post-execute` waterfall, proving:
 *
 * - confident triage verdicts produce advisories; trivial stays silent;
 * - any fallback (low confidence, backend error) resolves to "no injection";
 * - duplicate-purpose spawns warn even when the triage is trivial;
 * - failed spawns and malformed args fall back to normal handling;
 * - shadow mode traces the triage but never injects.
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
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as System1Plugin from '../src/index.ts'

/** Stub controls, reset before each test. */
let jevTriage: string
let jevConfidence: number
let jevFail: boolean
let askedKinds: string[]

function answerFor(id: string): Record<string, unknown> {
  const kind = id.split('#')[0]
  askedKinds.push(kind ?? id)
  const choice = kind === 'triage' || kind === 'delegation-triage' ? jevTriage : 'retry'
  return { choice, confidence: jevConfidence }
}

beforeEach(() => {
  jevTriage = 'complex'
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
    for (const id of Object.keys(body.questions)) {
      answers[id] = answerFor(id)
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
  root = await mkdtemp(join(tmpdir(), 'dsh-system1-delegation-'))
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

function spawnExec(context: Context, agentId: string, args: unknown): ToolExecution {
  return {
    agent: { id: agentId, sessionId: liveSession(context, agentId) },
    name: 'spawn_teammate',
    arguments: args,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function spawnArgs(name: string, description: string): Record<string, string> {
  return {
    name,
    description,
    prompt: `You are ${name}. ${description}.`,
    context: 'fresh',
  }
}

function spawnResult(isError: boolean): ToolExecutionResult {
  return (isError
    ? { isError: true, error: { message: 'provisioning failed' } }
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

async function spawn(
  context: Context,
  agentId: string,
  name: string,
  description: string,
): Promise<PostToolDecision> {
  return await context.waterfall(
    'tools/post-execute' as keyof Events,
    spawnExec(context, agentId, spawnArgs(name, description)),
    spawnResult(false),
    acceptNext,
  ) as PostToolDecision
}

it('injects a delegation advisory for a complex subtask', async () => {
  jevTriage = 'complex'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await spawn(context, 'lead-1', 'architect', 'Design the new billing pipeline end to end')
  expect(askedKinds).toContain('delegation-triage')
  const texts = contextTexts(decision)
  expect(texts).toHaveLength(1)
  expect(texts[0]).toContain('[System 1 delegation triage: complex]')
  expect(texts[0]).toContain('"architect"')
  expect(texts[0]).toContain('tree-of-thoughts')
})

it('injects a chain-of-thoughts advisory for a standard subtask', async () => {
  jevTriage = 'standard'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await spawn(context, 'lead-2', 'researcher', 'Summarize the API docs for the payments endpoint')
  const texts = contextTexts(decision)
  expect(texts).toHaveLength(1)
  expect(texts[0]).toContain('[System 1 delegation triage: standard]')
  expect(texts[0]).toContain('chain-of-thoughts')
})

it('stays silent on a trivial delegation', async () => {
  jevTriage = 'trivial'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await spawn(context, 'lead-3', 'helper', 'Echo the build status back')
  // The triage was still asked and traced; nothing worth telling the Lead.
  expect(askedKinds).toContain('delegation-triage')
  expect(contextTexts(decision)).toHaveLength(0)
})

it('injects nothing on a low-confidence delegation triage', async () => {
  jevConfidence = 0.5 // below the 0.7 threshold: gate falls back
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await spawn(context, 'lead-4', 'architect', 'Design the new billing pipeline end to end')
  expect(askedKinds).toContain('delegation-triage')
  expect(contextTexts(decision)).toHaveLength(0)
})

it('passes the spawn through untouched when the backend is down', async () => {
  jevFail = true
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await spawn(context, 'lead-5', 'architect', 'Design the new billing pipeline end to end')
  expect(decision.kind).toBe('accept')
  expect(contextTexts(decision)).toHaveLength(0)
})

it('warns on a duplicate-purpose spawn even when the triage is trivial', async () => {
  jevTriage = 'trivial' // isolate the deterministic warning from the advisory
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const first = await spawn(context, 'lead-6', 'code-reviewer', 'Review pull request code for bugs and style')
  expect(contextTexts(first)).toHaveLength(0)
  const second = await spawn(context, 'lead-6', 'pr-reviewer', 'Review pull request code for bugs and issues')
  const texts = contextTexts(second)
  expect(texts).toHaveLength(1)
  expect(texts[0]).toContain('[System 1 delegation]')
  expect(texts[0]).toContain('"pr-reviewer"')
  expect(texts[0]).toContain('"code-reviewer"')
})

it('does not warn for distinct purposes', async () => {
  jevTriage = 'trivial'
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  await spawn(context, 'lead-7', 'code-reviewer', 'Review pull request code for bugs and style')
  const second = await spawn(context, 'lead-7', 'db-migrator', 'Write postgres migration scripts for billing')
  expect(contextTexts(second)).toHaveLength(0)
})

it('does not judge a failed spawn', async () => {
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await context.waterfall(
    'tools/post-execute' as keyof Events,
    spawnExec(context, 'lead-8', spawnArgs('architect', 'Design the billing pipeline')),
    spawnResult(true),
    acceptNext,
  ) as PostToolDecision
  expect(askedKinds).not.toContain('delegation-triage')
  // The existing retry-judgment path still handles the failure; nothing
  // delegation-shaped is injected.
  const texts = contextTexts(decision)
  expect(texts).toHaveLength(1)
  expect(texts[0]).toContain('[System 1 retry-judgment]')
  expect(texts[0]).not.toContain('delegation')
})

it('falls back to normal handling for malformed spawn arguments', async () => {
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await context.waterfall(
    'tools/post-execute' as keyof Events,
    spawnExec(context, 'lead-9', { name: 'architect' }), // missing description/prompt
    spawnResult(false),
    acceptNext,
  ) as PostToolDecision
  expect(decision.kind).toBe('accept')
  expect(askedKinds).not.toContain('delegation-triage')
  expect(contextTexts(decision)).toHaveLength(0)
})

it('shadow mode asks the delegation triage but never injects', async () => {
  jevTriage = 'complex'
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const decision = await spawn(context, 'lead-10', 'architect', 'Design the new billing pipeline end to end')
  // Shadow observations are fire-and-forget; give the observation a beat to
  // run before asserting (and before disposal in afterEach).
  await new Promise(resolve => setTimeout(resolve, 250))
  expect(askedKinds).toContain('delegation-triage')
  expect(contextTexts(decision)).toHaveLength(0)
})

it('leaves blocked spawn decisions untouched', async () => {
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await context.waterfall(
    'tools/post-execute' as keyof Events,
    spawnExec(context, 'lead-11', spawnArgs('architect', 'Design the billing pipeline')),
    spawnResult(false),
    (): Promise<PostToolDecision> => Promise.resolve({ kind: 'block', feedback: [] }),
  ) as PostToolDecision
  expect(decision.kind).toBe('block')
})
