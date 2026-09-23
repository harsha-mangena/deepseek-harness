/**
 * Delegation (orchestrator-level) composition tests for the System 1 plugin.
 *
 * Judge-before-delegate: when the Lead calls `spawn_teammate`, the plugin
 * judges the delegated subtask with three atomic scores (novelty, tool
 * risk, irreversibility), combines them with weights into an oversight
 * judgment, and advises the Lead through `additionalContexts` on the spawn
 * result — standard/high oversight advisories (the teammate itself gets the
 * matching strategy hint on its first pre-step via the agent-level hook) and
 * a deterministic warning for duplicate-purpose spawns. Every test boots
 * the real Loader composition with a stubbed Jev `fetch` and dispatches
 * the real `tools/post-execute` waterfall, proving:
 *
 * - confident score composites produce advisories; low oversight stays silent;
 * - any fallback (low confidence, backend error) resolves to "no injection";
 * - duplicate-purpose spawns warn even when the scores are low;
 * - failed spawns and malformed args fall back to normal handling;
 * - shadow mode traces the composite but never injects.
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
let jevScores: [number, number, number]
let jevConfidence: number
let jevFail: boolean
let askedKinds: string[]

function answerFor(id: string, type: string): Record<string, unknown> {
  const kind = id.split('#')[0]
  askedKinds.push(kind ?? id)
  if (type === 'score') {
    // The three delegation scores go out in builder order: novelty,
    // tool-risk, irreversibility; the just-pushed entry makes `seen` 0-based.
    const seen = askedKinds.filter(k => k === 'delegation-triage').length - 1
    return { score: jevScores[seen % 3] ?? 0, confidence: jevConfidence }
  }
  return { choice: 'retry', confidence: jevConfidence }
}

beforeEach(() => {
  jevScores = [2.8, 2.6, 2.9] // default: high oversight composite
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

it('injects a high-oversight advisory for a demanding subtask', async () => {
  jevScores = [2.8, 2.6, 2.9] // composite ~0.92 → high
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await spawn(context, 'lead-1', 'architect', 'Design the new billing pipeline end to end')
  // Three atomic scores in one batch, not one choice.
  expect(askedKinds.filter(kind => kind === 'delegation-triage')).toHaveLength(3)
  const texts = contextTexts(decision)
  expect(texts).toHaveLength(1)
  expect(texts[0]).toContain('[System 1 delegation: high oversight]')
  expect(texts[0]).toContain('"architect"')
  expect(texts[0]).toContain('atomic-decomposition')
})

it('injects a standard-oversight advisory for a moderate subtask', async () => {
  jevScores = [1.6, 1.5, 1.4] // composite ~0.51 → standard
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await spawn(context, 'lead-2', 'researcher', 'Summarize the API docs for the payments endpoint')
  const texts = contextTexts(decision)
  expect(texts).toHaveLength(1)
  expect(texts[0]).toContain('[System 1 delegation: standard oversight]')
  expect(texts[0]).toContain('chain-of-thought')
})

it('stays silent on a low-oversight delegation', async () => {
  jevScores = [0.3, 0.2, 0.4] // composite ~0.10 → low
  const context = await boot({ backend: 'jev', mode: 'enforce' })
  const decision = await spawn(context, 'lead-3', 'helper', 'Echo the build status back')
  // The composite was still asked and traced; nothing worth telling the Lead.
  expect(askedKinds.filter(kind => kind === 'delegation-triage')).toHaveLength(3)
  expect(contextTexts(decision)).toHaveLength(0)
})

it('injects nothing on low-confidence delegation scores', async () => {
  jevConfidence = 0.5 // below the 0.6 score threshold: gate falls back
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

it('warns on a duplicate-purpose spawn even when the scores are low', async () => {
  jevScores = [0.3, 0.2, 0.4] // low oversight: isolate the deterministic warning from the advisory
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
  jevScores = [0.3, 0.2, 0.4]
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

it('shadow mode asks the delegation composite but never injects', async () => {
  jevScores = [2.8, 2.6, 2.9]
  const context = await boot({ backend: 'jev', mode: 'shadow' })
  const decision = await spawn(context, 'lead-10', 'architect', 'Design the new billing pipeline end to end')
  // Shadow observations are fire-and-forget; give the observation a beat to
  // run before asserting (and before disposal in afterEach).
  await new Promise(resolve => setTimeout(resolve, 250))
  expect(askedKinds.filter(kind => kind === 'delegation-triage')).toHaveLength(3)
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
