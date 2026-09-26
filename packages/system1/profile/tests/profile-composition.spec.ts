/** System 1 supported profile: real Loader composition test.
 *
 * Exercises the shipped `profiles/system1/` files on disk — not an inlined
 * copy — through the real profile discovery (`loadProfile`), the real patch
 * composition (`composeEntries`), and the real {@link Loader} with the real
 * `Include` plugin.
 *
 * Three proofs:
 * 1. The profile composes to exactly the supported entry: id
 *    `system1-workflow`, name `@deepseek-ai/dsh-system1-workflow`, config
 *    `{ mode: 'enforce', provider: 'jev' }`.
 * 2. The composed entries boot through the real Loader and the enforced
 *    coordinator completes a real read-only tool turn with durable
 *    `system1/terminal` success evidence and nonempty `verifiedBy`.
 * 3. A forced escalation runs the real {@link handoffToDeepSeek}, which
 *    creates a real standard DeepSeek child through the coordinator's own
 *    registered AgentLoop factory, reserves and settles a real budget from a
 *    real {@link CoordinationStore} ledger, and disposes the child. The
 *    terminal is the fallback-labeled `escalated` record — never a
 *    System 1-verified success.
 *
 * What is stubbed: only the Jev network/model generation boundary. The
 * decision provider is a deterministic in-process stub (the same seam the
 * integration tests use), and the fallback child's model calls are served by
 * a scripted in-process LLM adapter whose usage telemetry is recorded by the
 * real agent loop and folded by the real `foldChildSessionUsage`. This is
 * keyless fixture evidence for the composition wiring — not live Jev
 * validation, and not production certification.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as WorkflowModule from '@deepseek-ai/dsh-system1-workflow'
import {
  System1RequestId,
  handoffToDeepSeek,
  type System1Workflows,
} from '@deepseek-ai/dsh-system1-workflow'
import {
  CoordinationStore,
  SequentialIdGenerator,
  SystemClock,
} from '@deepseek-ai/dsh-system1-coordination'
import {
  ReadOnlyProductionDriver,
  type ProductionDriverConfig,
} from '@deepseek-ai/dsh-system1-integration'
import { PolicyEngine, type CapabilityProfile } from '@deepseek-ai/dsh-system1-policy'
import { fitIsotonic, type IsotonicCalibration } from '@deepseek-ai/dsh-system1-calibration'
import type { CatalogTool } from '@deepseek-ai/dsh-system1-observations'
import type {
  DecisionProvider,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'
import { composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { foldChildSessionUsage } from '../../workflow/src/handoff.ts'

const MODULE_KEY = '__dshSystem1ProfileModule'
const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..')
const SHIPPED_PROFILE_DIR = join(REPO_ROOT, 'packages/system1/profile/profiles/system1')

const tempRoots: string[] = []
afterAll(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
  delete (globalThis as Record<string, unknown>)[MODULE_KEY]
})

const EXPECTED_MODEL = 'jev-test-v1'
const TENANT_ID = 'tenant-test'
const POOL_NAME = 'pool-main'

const catalog: CatalogTool[] = [
  {
    toolId: 'ci-runs',
    label: 'Read CI runs',
    route: 'tool',
    effect: 'read',
    operationRef: 'op:ci-runs:read:v1',
    preconditions: {},
    verificationPolicyId: 'verify:ci:v1',
  },
]

const capabilityProfile: CapabilityProfile = {
  tenantId: TENANT_ID,
  profileVersion: 'v1',
  allowedEffects: new Set(['read']),
  allowedRoutes: new Set(['tool', 'stop']),
  globalRequiredGuards: [],
}

function testCalibration(): IsotonicCalibration {
  return fitIsotonic(
    [
      { vendorConfidence: 0.1, correct: 0 },
      { vendorConfidence: 0.9, correct: 1 },
    ],
    'cal-v1',
    {
      model: EXPECTED_MODEL,
      promptVersion: 'p1',
      questionFamily: 'select-candidate',
    },
  )
}

function testDecision(
  selectedId: string,
  vendorConfidence: number | null = 0.9,
): NormalizedDecision {
  return {
    decisionId: 'd1',
    questionFamily: 'select-candidate',
    promptVersion: 'p1',
    selectedId,
    probabilities: { [selectedId]: 0.8 },
    selectedProbability: 0.8,
    vendorConfidence,
    calibratedCorrectness: null,
    calibrationVersion: null,
    modelRequested: EXPECTED_MODEL,
    modelResolved: EXPECTED_MODEL,
    requestId: null,
    usage: { inputTokens: null, outputTokens: null },
    reasonCode: 'accepted',
  }
}

function makePolicy(): PolicyEngine {
  const policy = new PolicyEngine()
  policy.setEffectPolicy({ effect: 'read', allowed: true, requiredGuards: [] })
  return policy
}

function userMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function makeDriver(overrides: Partial<ProductionDriverConfig> = {}): ReadOnlyProductionDriver {
  const provider: DecisionProvider =
    overrides.provider ?? {
      decide: async (input) => ({ ...testDecision('c1'), decisionId: input.decisionId }),
    }
  return new ReadOnlyProductionDriver({
    mode: 'enforce',
    policy: makePolicy(),
    capabilityProfile,
    provider,
    catalog,
    calibration: testCalibration(),
    expectedModel: EXPECTED_MODEL,
    tenantId: TENANT_ID,
    resolveCall: () => ({ name: 'ci-status', arguments: {} }),
    verify: (ctx) => ({
      checkId: `verify:${ctx.receiptRef}`,
      passed: JSON.stringify(ctx.result.value).includes('green'),
    }),
    newRequestId: () => System1RequestId('req-test'),
    newCallId: () => ToolCallId('call-test'),
    ...overrides,
  })
}

/** Copy the shipped profile files into a fresh temporary $DSH_HOME. */
async function stageProfileHome(): Promise<string> {
  const home = join(tmpdir(), `dsh-profile-home-${process.pid}-${Date.now()}`)
  await rm(home, { recursive: true, force: true })
  const profileDir = join(home, 'profiles', 'system1')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'package.json'),
    await readFile(join(SHIPPED_PROFILE_DIR, 'package.json')),
  )
  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    await readFile(join(SHIPPED_PROFILE_DIR, 'cordis.patch.yml')),
  )
  tempRoots.push(home)
  return home
}

/** Minimal YAML writer for the asserted flat-string entry shape of this profile. */
function yamlScalar(value: unknown): string {
  if (typeof value === 'string') {
    return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value)
  }
  return JSON.stringify(value)
}

/** Serialize composed Loader entries to a cordis.yml, substituting entry names. */
function toCordisYml(
  entries: Array<{ id: string; name: string; config?: unknown }>,
  nameById: Map<string, string>,
): string {
  const lines: string[] = []
  for (const entry of entries) {
    lines.push(`- id: ${entry.id}`)
    lines.push(`  name: ${yamlScalar(nameById.get(entry.id) ?? entry.name)}`)
    if (entry.config !== undefined && entry.config !== null) {
      lines.push('  config:')
      for (const [key, value] of Object.entries(entry.config as Record<string, unknown>)) {
        lines.push(`    ${key}: ${yamlScalar(value)}`)
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Scripted deterministic LLM adapter: each model call streams the next script
 * entry. The usage chunk is host-recorded telemetry the real agent loop
 * attaches to the assistant message — the child's real spend signal.
 */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(
    provider: string,
    model: string,
  ): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const chunks = this.script[Math.min(this.calls, this.script.length - 1)]
    this.calls += 1
    if (chunks !== undefined) {
      yield* chunks
    }
  }
}

/** A valid handoff child result: no artifacts, no evidence, no claimed units. */
function childResultChunks(): StreamChunk[] {
  const text = JSON.stringify({
    schemaVersion: 1,
    artifacts: [],
    evidence: [],
    actualUnits: 0,
  })
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 24 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Boot the composed profile entries through the real Loader and Include.
 * The entry's package name is replaced with a fixture file URL so Node
 * resolves the workspace source of the workflow plugin (never a stale
 * `lib/` build); the entry id, patch order, and config stay as composed.
 */
async function bootComposedEntries(
  entries: Array<{ id: string; name: string; config?: unknown }>,
): Promise<{ ctx: Context; workflows: System1Workflows; dispose: () => Promise<void> }> {
  const dir = join(tmpdir(), `dsh-profile-boot-${process.pid}-${Date.now()}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  tempRoots.push(dir)
  ;(globalThis as Record<string, unknown>)[MODULE_KEY] = WorkflowModule
  await writeFile(
    join(dir, 'system1-entry.mjs'),
    [
      `const mod = globalThis[${JSON.stringify(MODULE_KEY)}]`,
      'export const { Config } = mod',
      'export default mod.default',
      '',
    ].join('\n'),
  )
  const fixtureUrl = pathToFileURL(join(dir, 'system1-entry.mjs')).href
  await writeFile(
    join(dir, 'cordis.yml'),
    toCordisYml(
      entries,
      new Map(entries.map((entry) => [entry.id, fixtureUrl])),
    ),
  )
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  // Children created through the real AgentLoop factory get a deterministic
  // in-process route; only network/model generation is stubbed.
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([childResultChunks()]))
  ctx.on('agent/request', async (_payload, next) => ({
    ...(await next()),
    provider: 'mock',
    model: 'mock',
  }))
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
  })
  await ctx.loader.await()
  const workflows = ctx.get('system1Workflows') as System1Workflows | undefined
  if (workflows === undefined) {
    throw new Error('system1Workflows service missing after profile boot')
  }
  return {
    ctx,
    workflows,
    dispose: async () => {
      await ctx.fiber.dispose()
    },
  }
}

/** Terminal records in a session log. */
function terminals(
  session: Session,
): Array<{ outcome: string; summary: string; verifiedBy?: readonly string[] }> {
  return session
    .snapshotEvents()
    .filter((event) => event.type === 'system1/terminal')
    .map(
      (event): { outcome: string; summary: string; verifiedBy?: readonly string[] } => {
        const data = event.data as {
          outcome: string
          summary: string
          verifiedBy?: readonly string[]
        }
        return data.verifiedBy === undefined
          ? { outcome: data.outcome, summary: data.summary }
          : { outcome: data.outcome, summary: data.summary, verifiedBy: data.verifiedBy }
      },
    )
}

describe('dsh --profile system1', () => {
  it('loads the shipped profile and composes the one supported Loader entry', async () => {
    const home = await stageProfileHome()
    // Real profile discovery against the staged $DSH_HOME; the repo-root
    // package.json is the install anchor, as in production.
    const profile = loadProfile('dsh', 'system1', join(REPO_ROOT, 'package.json'), home)
    expect(profile.name).toBe('system1')
    // The manifest declares no bundles: the whole composition comes from the
    // patch layer, so no bundle resolution is ever needed.
    expect(profile.layers).toHaveLength(0)
    expect(profile.patches.length).toBeGreaterThan(0)

    const entries = composeEntries([profile.patches])
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    if (entry === undefined) {
      throw new Error('expected exactly one composed entry')
    }
    expect(entry.id).toBe('system1-workflow')
    expect(entry.name).toBe('@deepseek-ai/dsh-system1-workflow')
    expect(entry.config).toEqual({ mode: 'enforce', provider: 'jev' })
  })

  it('boots the composed entries through the real Loader and completes a verified turn', async () => {
    const home = await stageProfileHome()
    const profile = loadProfile('dsh', 'system1', join(REPO_ROOT, 'package.json'), home)
    const entries = composeEntries([profile.patches])
    const booted = await bootComposedEntries(entries)
    try {
      // The enforced coordinator runs the real read-only driver; only the
      // Jev decision boundary is a deterministic stub, as in the driver tests.
      const driver = makeDriver()
      const session = Session.create(SessionId('s-profile-verified'))
      const handle = await booted.workflows.create(session, driver)
      try {
        let toolRan = false
        handle.coordinator.ctx.tools.register(
          defineContentToolFixture({
            name: 'ci-status',
            description: 'CI status reader',
            parameters: {},
            async execute() {
              toolRan = true
              return [{ type: 'text', text: 'CI is green' }]
            },
          }),
        )
        handle.coordinator.followup(userMessage('Check CI status'))
        await handle.coordinator.whenIdle()

        expect(toolRan).toBe(true)
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        const terminal = recorded[0]
        if (terminal === undefined) {
          throw new Error('expected one terminal record')
        }
        expect(terminal.outcome).toBe('success')
        expect(terminal.verifiedBy).toEqual(['verify:tool-call:call-test'])
      } finally {
        await handle.dispose()
      }
    } finally {
      await booted.dispose()
    }
  })

  it('escalates through the real handoffToDeepSeek into a real standard DeepSeek child', async () => {
    const home = await stageProfileHome()
    const profile = loadProfile('dsh', 'system1', join(REPO_ROOT, 'package.json'), home)
    const entries = composeEntries([profile.patches])
    const booted = await bootComposedEntries(entries)
    try {
      // Real budget ledger for the handoff; in-memory SQLite, owned by this test.
      const store = new CoordinationStore({
        clock: new SystemClock(),
        ids: new SequentialIdGenerator(),
      })
      store.createBudgetPool(TENANT_ID, POOL_NAME, 1000)

      // Low confidence forces escalation; the driver's handoff calls the
      // real handoffToDeepSeek — not a stub handler — with the supported
      // production wiring: real tenant, real ledger, small child limits with
      // a future deadline, host-observed usage metering (never the child's
      // self-reported units), and evidence resolution against stored records.
      const driver = makeDriver({
        provider: {
          decide: async (input) => ({
            ...testDecision('escalate-none', null),
            decisionId: input.decisionId,
            probabilities: {},
            selectedProbability: 0,
          }),
        },
        handoff: (coordinator, bundle, signal) =>
          handoffToDeepSeek(coordinator, bundle, signal, {
            tenantId: TENANT_ID,
            ledger: store,
            childLimits: {
              maxTokens: 64,
              maxSteps: 3,
              deadlineAt: Date.now() + 30_000,
            },
            // Host-observed usage meter: folds the provider usage telemetry the
            // real agent loop recorded on the child's assistant messages —
            // never the child's self-reported units.
            measureChildUsage: (childSession) => foldChildSessionUsage(childSession),
            resolveEvidence: (reference: string): boolean => {
              // The bundle's return contract requires no evidence, so the
              // child returns no refs and this check never fires in this
              // test; it stays wired to the parent session's stored
              // verification records for the general case.
              return coordinator.session
                .snapshotEvents()
                .some(
                  (event) =>
                    event.type === 'system1/verification' &&
                    (event.data as { checkId?: unknown }).checkId === reference,
                )
            },
          }),
        handoffBudget: { poolName: POOL_NAME, units: 100 },
      })
      const session = Session.create(SessionId('s-profile-fallback'))
      const handle = await booted.workflows.create(session, driver)
      try {
        handle.coordinator.followup(userMessage('Check CI status'))
        await handle.coordinator.whenIdle()

        // The fallback turn terminated with the fallback-labeled terminal:
        // escalated, DeepSeek-completed, and NOT a System 1-verified success.
        // (The finalizer omits verification claims entirely for non-success
        // outcomes, so the durable record has no verifiedBy field at all.)
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        const terminal = recorded[0]
        if (terminal === undefined) {
          throw new Error('expected one terminal record')
        }
        expect(terminal.outcome).toBe('escalated')
        expect(terminal.summary.startsWith('DeepSeek fallback completed;')).toBe(true)
        expect(terminal.verifiedBy ?? []).toEqual([])

        // The driver recorded the fallback invocation in the durable log.
        const fallbacks = session
          .snapshotEvents()
          .filter((event) => event.type === 'system1/fallback')
        expect(fallbacks).toHaveLength(1)
        const fallback = fallbacks[0]
        if (fallback === undefined) {
          throw new Error('expected one fallback record')
        }
        expect((fallback.data as { outcome: string }).outcome).toBe('completed')

        // The real ledger reserved and settled from host-observed usage:
        // inputTokens 12 + outputTokens 24 folded at one unit per token.
        const utilization = store.getPoolUtilization(TENANT_ID, POOL_NAME)
        expect(utilization.consumed).toBe(36)
        expect(utilization.reserved).toBe(0)
      } finally {
        await handle.dispose()
      }
    } finally {
      await booted.dispose()
    }
  })
})
