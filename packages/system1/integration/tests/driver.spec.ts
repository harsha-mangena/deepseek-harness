/** Production driver tests: one durable read-only turn through real composition.
 *
 * Boots a test-only `cordis.yml` through the real {@link Loader} — the same
 * entry path production uses — then creates a coordinator driven by the
 * {@link ReadOnlyProductionDriver}. The tool runtime, agent registry, and
 * coordinator are all real; only the Jev HTTP boundary is mocked (a fake
 * `decide` function, never a fake coordinator). Assertions target durable,
 * lifecycle-visible output: dispatched tool calls and `system1/terminal`
 * session events.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import * as WorkflowModule from '@deepseek-ai/dsh-system1-workflow'
import {
  System1RequestId,
  type HandoffBudgetLedger,
  type HandoffBundle,
  type HandoffHandler,
  type System1CoordinatorAgent,
  type System1Mode,
  type System1Workflows,
} from '@deepseek-ai/dsh-system1-workflow'
import {
  CoordinationStore,
  SequentialIdGenerator,
  SystemClock,
} from '@deepseek-ai/dsh-system1-coordination'
import {
  ReadOnlyProductionDriver,
  buildEscalationBundle,
  findStoredToolResult,
  hashEvidenceContent,
  loadStoredVerifications,
  resolveCheckEvidence,
  MAX_EVIDENCE_CHARS,
  type ProductionDriverConfig,
  type ToolVerificationContext,
} from '@deepseek-ai/dsh-system1-integration'
import { PolicyEngine } from '@deepseek-ai/dsh-system1-policy'
import type { CapabilityProfile } from '@deepseek-ai/dsh-system1-policy'
import { fitIsotonic } from '@deepseek-ai/dsh-system1-calibration'
import type { IsotonicCalibration } from '@deepseek-ai/dsh-system1-calibration'
import type { CatalogTool } from '@deepseek-ai/dsh-system1-observations'
import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type {
  DecisionProvider,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'

const MODULE_KEY = '__dshSystem1DriverModule'

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>)[MODULE_KEY]
})

const EXPECTED_MODEL = 'jev-test-v1'

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

const profile: CapabilityProfile = {
  tenantId: 'tenant-test',
  profileVersion: 'v1',
  allowedEffects: new Set(['read']),
  allowedRoutes: new Set(['tool', 'stop']),
  globalRequiredGuards: [],
}

/** Calibration bound to the test decision context. */
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
  policy.setEffectPolicy({ effect: 'stop', allowed: true, requiredGuards: [] })
  return policy
}

function userMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** Boot the workflow plugin through the real Loader. */
async function boot(mode: System1Mode = 'enforce'): Promise<{ ctx: Context; workflows: System1Workflows }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-system1-driver-'))
  tempRoots.push(dir)
  ;(globalThis as Record<string, unknown>)[MODULE_KEY] = WorkflowModule
  writeFileSync(
    join(dir, 'system1-entry.mjs'),
    [
      `const mod = globalThis[${JSON.stringify(MODULE_KEY)}]`,
      'export const { Config } = mod',
      'export default mod.default',
      '',
    ].join('\n'),
  )
  const fixtureUrl = pathToFileURL(join(dir, 'system1-entry.mjs')).href
  writeFileSync(
    join(dir, 'cordis.yml'),
    ['- id: system1', `  name: ${fixtureUrl}`, '  config:', `    mode: ${mode}`, ''].join(
      '\n',
    ),
  )
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
  })
  await ctx.loader.await()
  const workflows = ctx.get('system1Workflows') as System1Workflows
  return { ctx, workflows }
}

function makeDriver(
  overrides: Partial<ProductionDriverConfig> = {},
): ReadOnlyProductionDriver {
  const provider: DecisionProvider =
    overrides.provider ?? {
      decide: async (input) => ({ ...testDecision('c1'), decisionId: input.decisionId }),
    }
  return new ReadOnlyProductionDriver({
    mode: 'enforce',
    policy: makePolicy(),
    capabilityProfile: profile,
    provider,
    catalog,
    calibration: testCalibration(),
    expectedModel: EXPECTED_MODEL,
    tenantId: 'tenant-test',
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

interface TurnSetup {
  ctx: Context
  session: Session
  coordinator: System1CoordinatorAgent
  toolRan: () => boolean
  dispose: () => Promise<void>
}

/** Register the real scoped CI tool fixture on the coordinator. */
function registerCiTool(
  coordinator: System1CoordinatorAgent,
  onExecute?: () => void,
): void {
  coordinator.ctx.tools.register(
    defineContentToolFixture({
      name: 'ci-status',
      description: 'CI status reader',
      parameters: {},
      async execute() {
        onExecute?.()
        return [{ type: 'text', text: 'CI is green' }]
      },
    }),
  )
}

/** Create a coordinator with a real scoped tool and run one driver turn. */
async function runTurn(
  sessionId: string,
  driver: ReadOnlyProductionDriver,
): Promise<TurnSetup> {
  const { ctx, workflows } = await boot()
  const session = Session.create(SessionId(sessionId))
  const handle = await workflows.create(session, driver)
  let ran = false
  registerCiTool(handle.coordinator, () => {
    ran = true
  })
  handle.coordinator.followup(userMessage('Check CI status'))
  await handle.coordinator.whenIdle()
  return {
    ctx,
    session,
    coordinator: handle.coordinator,
    toolRan: () => ran,
    dispose: async () => {
      await handle.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/** Terminal events recorded in the session log. */
function terminals(session: Session): Array<{ outcome: string; verifiedBy?: readonly string[] }> {
  return session
    .snapshotEvents()
    .filter((event) => event.type === 'system1/terminal')
    .map((event) => {
      const data = event.data as { outcome: string; verifiedBy?: readonly string[] }
      return { outcome: data.outcome, verifiedBy: data.verifiedBy }
    })
}

describe('ReadOnlyProductionDriver', () => {
  it('dispatches an admitted decision and finalizes success with real verification evidence', async () => {
    const seen: ToolVerificationContext[] = []
    const driver = makeDriver({
      verify: (ctx) => {
        seen.push(ctx)
        return {
          checkId: `verify:${ctx.receiptRef}`,
          passed: JSON.stringify(ctx.result.value).includes('green'),
        }
      },
    })
    const setup = await runTurn('s-driver-success', driver)
    try {
      expect(setup.toolRan()).toBe(true)
      // Verification observed the REAL tool result, not a fabrication.
      expect(seen).toHaveLength(1)
      expect(seen[0].candidate.id).toBe('c1')
      expect(JSON.stringify(seen[0].result.value)).toContain('green')
      expect(seen[0].receiptRef).toBe('tool-call:call-test')

      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('success')
      expect(recorded[0].verifiedBy).toEqual(['verify:tool-call:call-test'])

      // The verification evidence is durable in the session log.
      const verifications = setup.session
        .snapshotEvents()
        .filter((event) => event.type === 'system1/verification')
      expect(verifications).toHaveLength(1)
      expect(verifications[0].data.checkId).toBe('verify:tool-call:call-test')
      expect(verifications[0].data.passed).toBe(true)
    } finally {
      await setup.dispose()
    }
  })

  it('does not dispatch when the decision fails correlation admission', async () => {
    const driver = makeDriver({
      provider: {
        decide: async (input) => ({
          ...testDecision('c1'),
          decisionId: 'wrong-id',
          questionFamily: input.questionFamily,
          promptVersion: input.promptVersion,
        }),
      },
    })
    const setup = await runTurn('s-driver-correlation', driver)
    try {
      expect(setup.toolRan()).toBe(false)
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
      expect(recorded[0].verifiedBy).toBeUndefined()
    } finally {
      await setup.dispose()
    }
  })

  it('does not dispatch when policy denies the selection on the dispatch recheck', async () => {
    const policy = makePolicy()
    let evaluations = 0
    const innerEvaluate = policy.evaluate.bind(policy)
    policy.evaluate = (async (candidate, profileArg, ctxArg) => {
      evaluations += 1
      // The menu filter (first evaluation) allows; the dispatch recheck
      // (second evaluation) revokes the grant.
      if (evaluations >= 2) {
        return {
          allowed: false,
          reason: 'grant revoked before dispatch',
          code: 'EFFECT_NOT_ALLOWED',
          evaluatedGuards: [],
        }
      }
      return innerEvaluate(candidate, profileArg, ctxArg)
    }) as PolicyEngine['evaluate']
    const driver = makeDriver({ policy })
    const setup = await runTurn('s-driver-recheck', driver)
    try {
      expect(setup.toolRan()).toBe(false)
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
    } finally {
      await setup.dispose()
    }
  })

  it('finalizes escalation without dispatching', async () => {
    const driver = makeDriver({
      provider: {
        decide: async (input) => ({
          ...testDecision('escalate-none', null),
          decisionId: input.decisionId,
          probabilities: {},
          selectedProbability: 0,
        }),
      },
    })
    const setup = await runTurn('s-driver-escalate', driver)
    try {
      expect(setup.toolRan()).toBe(false)
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('escalated')
    } finally {
      await setup.dispose()
    }
  })

  it('stops the turn on abort without dispatching', async () => {
    let providerCalled = false
    const driver = makeDriver({
      provider: {
        decide: async (input) => {
          providerCalled = true
          return { ...testDecision('c1'), decisionId: input.decisionId }
        },
      },
    })
    const { ctx, workflows } = await boot()
    try {
      const session = Session.create(SessionId('s-driver-abort'))
      const handle = await workflows.create(session, driver)
      try {
        let ran = false
        handle.coordinator.ctx.tools.register(
          defineContentToolFixture({
            name: 'ci-status',
            description: 'CI status reader',
            parameters: {},
            async execute() {
              ran = true
              return [{ type: 'text', text: 'CI is green' }]
            },
          }),
        )
        const aborter = new AbortController()
        aborter.abort()
        await driver.run(handle.coordinator, aborter.signal)
        expect(providerCalled).toBe(false)
        expect(ran).toBe(false)
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('cancelled')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('finalizes failure when verification rejects the real tool result', async () => {
    const driver = makeDriver({
      verify: () => ({ checkId: 'verify:always-no', passed: false }),
    })
    const setup = await runTurn('s-driver-verify-fail', driver)
    try {
      // The tool ran, but the failed verification blocks a success claim.
      expect(setup.toolRan()).toBe(true)
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
      expect(recorded[0].verifiedBy).toBeUndefined()
    } finally {
      await setup.dispose()
    }
  })
})

describe('driver execution modes', () => {
  const counters = { system1Dispatches: 0, baselineRuns: 0 }
  beforeEach(() => {
    counters.system1Dispatches = 0
    counters.baselineRuns = 0
  })

  /** The read the CI tool performs. */
  async function ciStatusLogic(): Promise<Array<{ type: 'text'; text: string }>> {
    return [{ type: 'text', text: 'CI is green' }]
  }

  /** Baseline DeepSeek path: owns execution outside System 1. */
  async function baselineRunCI(): Promise<string> {
    counters.baselineRuns += 1
    const blocks = await ciStatusLogic()
    return blocks.map((block) => block.text).join('')
  }

  /** Register the CI tool so System 1 dispatches are observable. */
  function registerCITool(coordinator: System1CoordinatorAgent): void {
    coordinator.ctx.tools.register(
      defineContentToolFixture({
        name: 'ci-status',
        description: 'CI status reader',
        parameters: {},
        async execute() {
          counters.system1Dispatches += 1
          return ciStatusLogic()
        },
      }),
    )
  }

  /** Advisory suggestion events recorded by shadow turns. */
  function suggestions(session: Session): Array<{ candidateId?: string; model?: string }> {
    return session
      .snapshotEvents()
      .filter((event) => event.type === 'system1/decision')
      .map((event) => event.data as { candidateId?: string; model?: string })
  }

  it('off: coordinator creation is refused; the baseline path is untouched', async () => {
    const { ctx, workflows } = await boot('off')
    try {
      const session = Session.create(SessionId('s-mode-off'))
      const driver = makeDriver({ mode: 'enforce' })
      await expect(workflows.create(session, driver)).rejects.toThrow(/off/)
      // Baseline owns execution: unchanged output, no System 1 involved.
      expect(await baselineRunCI()).toBe('CI is green')
      expect(counters.system1Dispatches).toBe(0)
      expect(counters.baselineRuns).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a driver constructed with mode off', () => {
    expect(() => makeDriver({ mode: 'off' })).toThrow(/mode "off"/)
  })

  it('rejects a driver constructed without a mode', () => {
    expect(() => makeDriver({ mode: undefined })).toThrow(/explicit mode/)
  })

  it('shadow: an aborted turn finalizes cancelled without deciding or dispatching', async () => {
    let providerCalled = false
    const { ctx, workflows } = await boot('shadow')
    try {
      const driver = makeDriver({
        mode: 'shadow',
        provider: {
          decide: async (input) => {
            providerCalled = true
            return { ...testDecision('c1'), decisionId: input.decisionId }
          },
        },
      })
      const session = Session.create(SessionId('s-mode-shadow-abort'))
      const handle = await workflows.create(session, driver)
      try {
        registerCITool(handle.coordinator)
        const aborter = new AbortController()
        aborter.abort()
        await driver.run(handle.coordinator, aborter.signal)
        expect(providerCalled).toBe(false)
        expect(counters.system1Dispatches).toBe(0)
        expect(suggestions(session)).toHaveLength(0)
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0]?.outcome).toBe('cancelled')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('shadow: baseline executes with unchanged output; System 1 records a suggestion with zero dispatches', async () => {
    const { ctx, workflows } = await boot('shadow')
    try {
      const driver = makeDriver({ mode: 'shadow' })
      const session = Session.create(SessionId('s-mode-shadow'))
      const handle = await workflows.create(session, driver)
      try {
        registerCITool(handle.coordinator)
        const before = await baselineRunCI()
        handle.coordinator.followup(userMessage('Check CI status'))
        await handle.coordinator.whenIdle()
        const after = await baselineRunCI()
        // Baseline output is unchanged and System 1 dispatched nothing.
        expect(before).toBe('CI is green')
        expect(after).toBe('CI is green')
        expect(counters.baselineRuns).toBe(2)
        expect(counters.system1Dispatches).toBe(0)
        // The advisory suggestion is durable in the session log.
        const recorded = suggestions(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0]?.candidateId).toBe('c1')
        expect(recorded[0]?.model).toBe(EXPECTED_MODEL)
        const recordedTerminals = terminals(session)
        expect(recordedTerminals).toHaveLength(1)
        expect(recordedTerminals[0]?.outcome).toBe('escalated')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('shadow: an escalate-none decision records a suggestion without a candidate and never calls the handoff worker', async () => {
    let handoffCalls = 0
    const { ctx, workflows } = await boot('shadow')
    try {
      const driver = makeDriver({
        mode: 'shadow',
        provider: {
          decide: async (input) => ({
            ...testDecision('escalate-none', null),
            decisionId: input.decisionId,
            probabilities: {},
            selectedProbability: 0,
          }),
        },
        handoff: async () => {
          handoffCalls += 1
          return { kind: 'completed', artifacts: [], evidence: [], actualUnits: 0 }
        },
        handoffBudget: { poolName: 'pool-main', units: 10 },
      })
      const session = Session.create(SessionId('s-mode-shadow-escalate'))
      const handle = await workflows.create(session, driver)
      try {
        registerCITool(handle.coordinator)
        handle.coordinator.followup(userMessage('Check CI status'))
        await handle.coordinator.whenIdle()
        expect(counters.system1Dispatches).toBe(0)
        expect(handoffCalls).toBe(0)
        const recorded = suggestions(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0]?.candidateId).toBeUndefined()
        expect(terminals(session)[0]?.outcome).toBe('escalated')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('shadow: an unadmitted decision fails the turn with no suggestion and no dispatch', async () => {
    const { ctx, workflows } = await boot('shadow')
    try {
      const driver = makeDriver({
        mode: 'shadow',
        provider: {
          decide: async (input) => ({ ...testDecision('c1'), decisionId: 'wrong-id' }),
        },
      })
      const session = Session.create(SessionId('s-mode-shadow-denied'))
      const handle = await workflows.create(session, driver)
      try {
        registerCITool(handle.coordinator)
        handle.coordinator.followup(userMessage('Check CI status'))
        await handle.coordinator.whenIdle()
        expect(counters.system1Dispatches).toBe(0)
        expect(suggestions(session)).toHaveLength(0)
        const recordedTerminals = terminals(session)
        expect(recordedTerminals).toHaveLength(1)
        expect(recordedTerminals[0]?.outcome).toBe('failure')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('enforce: System 1 dispatches the admitted tool', async () => {
    const { ctx, workflows } = await boot('enforce')
    try {
      const driver = makeDriver({ mode: 'enforce' })
      const session = Session.create(SessionId('s-mode-enforce'))
      const handle = await workflows.create(session, driver)
      try {
        registerCITool(handle.coordinator)
        handle.coordinator.followup(userMessage('Check CI status'))
        await handle.coordinator.whenIdle()
        expect(counters.system1Dispatches).toBe(1)
        expect(terminals(session)[0]?.outcome).toBe('success')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('buildEscalationBundle', () => {
  it('builds an honest bundle from the turn observation and decision', () => {
    const bundle = buildEscalationBundle({
      requestId: System1RequestId('req-7'),
      observations: [
        { provenance: { kind: 'user-input' }, content: 'Check CI status', timestampMs: 1 },
        { provenance: { kind: 'user-input' }, content: 'Use the main branch', timestampMs: 2 },
      ],
      decision: testDecision('escalate-none', null),
      reason: 'Coordinator selected escalate-none',
      budget: { poolName: 'pool-main', units: 100 },
      tenantId: 'tenant-test',
    })
    expect(bundle.schemaVersion).toBe(1)
    expect(bundle.taskId).toBe('req-7-escalation')
    expect(bundle.objective).toBe('Check CI status\nUse the main branch')
    expect(bundle.constraints.join(' ')).toContain('tenant-test')
    // Escalation dispatches nothing: no completed effects, no fresh evidence.
    expect(bundle.completedEffects).toEqual([])
    expect(bundle.unknownEffects).toEqual([])
    expect(bundle.failedChoices).toEqual([
      { choice: 'escalate-none', reason: 'Coordinator selected escalate-none' },
    ])
    expect(bundle.remainingBudget).toEqual({ poolName: 'pool-main', units: 100 })
  })

  it('falls back to the decision when there are no observations', () => {
    const bundle = buildEscalationBundle({
      requestId: System1RequestId('req-8'),
      observations: [],
      decision: testDecision('escalate-none', null),
      reason: 'no executable outcome',
      budget: { poolName: 'pool-main', units: 25 },
      tenantId: 'tenant-test',
    })
    expect(bundle.objective).toContain('d1')
    expect(bundle.objective).toContain('no executable outcome')
  })
})

describe('driver escalation handoff', () => {
  function escalatingDriver(overrides: Partial<ProductionDriverConfig> = {}) {
    return makeDriver({
      provider: {
        decide: async (input) => ({
          ...testDecision('escalate-none', null),
          decisionId: input.decisionId,
          probabilities: {},
          selectedProbability: 0,
        }),
      },
      ...overrides,
    })
  }

  it('keeps the fail-safe escalated terminal when no handoff handler is configured', async () => {
    const driver = escalatingDriver()
    const setup = await runTurn('s-driver-escalate-default', driver)
    try {
      expect(setup.toolRan()).toBe(false)
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('escalated')
      // No handler ran: no handoff verification evidence was recorded.
      const verifications = setup.session
        .snapshotEvents()
        .filter((event) => event.type === 'system1/verification')
      expect(verifications).toHaveLength(0)
    } finally {
      await setup.dispose()
    }
  })

  it('invokes the handoff handler with the escalation bundle and records its evidence', async () => {
    const seen: HandoffBundle[] = []
    const handler: HandoffHandler = async (_coordinator, bundle, _signal) => {
      seen.push(bundle)
      return {
        kind: 'completed',
        artifacts: ['artifact:summary'],
        evidence: ['evidence:ci-log'],
        actualUnits: 12,
      }
    }
    const driver = escalatingDriver({
      handoff: handler,
      handoffBudget: { poolName: 'pool-main', units: 100 },
    })
    const setup = await runTurn('s-driver-escalate-handoff', driver)
    try {
      expect(setup.toolRan()).toBe(false)
      expect(seen).toHaveLength(1)
      expect(seen[0].taskId).toBe('req-test-escalation')
      expect(seen[0].objective).toContain('Check CI status')
      expect(seen[0].remainingBudget).toEqual({ poolName: 'pool-main', units: 100 })
      expect(seen[0].constraints.join(' ')).toContain('tenant-test')

      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('escalated')

      // The child's evidence is durable in the session log.
      const verifications = setup.session
        .snapshotEvents()
        .filter((event) => event.type === 'system1/verification')
      expect(verifications).toHaveLength(1)
      expect(verifications[0].data.checkId).toBe('deepseek-handoff')
      expect(verifications[0].data.evidence).toBe('evidence:ci-log')
    } finally {
      await setup.dispose()
    }
  })

  it('finalizes escalated when the handoff handler reports failure', async () => {
    const driver = escalatingDriver({
      handoff: async () => ({
        kind: 'failed',
        code: 'EXECUTION_FAILED',
        reason: 'child exploded',
      }),
      handoffBudget: { poolName: 'pool-main', units: 100 },
    })
    const setup = await runTurn('s-driver-escalate-failed', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('escalated')
      const summary = terminalSummary(setup.session)
      expect(summary).toContain('EXECUTION_FAILED')
      expect(summary).toContain('child exploded')
    } finally {
      await setup.dispose()
    }
  })

  it('finalizes escalated when the handoff handler throws', async () => {
    const driver = escalatingDriver({
      handoff: async () => {
        throw new Error('handler bug')
      },
      handoffBudget: { poolName: 'pool-main', units: 100 },
    })
    const setup = await runTurn('s-driver-escalate-threw', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('escalated')
      expect(terminalSummary(setup.session)).toContain('threw')
    } finally {
      await setup.dispose()
    }
  })

  it('rejects a handoff without a budget at construction', () => {
    expect(
      () =>
        makeDriver({
          handoff: async () => ({
            kind: 'failed',
            code: 'EXECUTION_FAILED',
            reason: 'unreachable',
          }),
        }),
    ).toThrow(/handoffBudget/)
  })

  it('rejects a non-positive handoff budget at construction', () => {
    expect(() =>
      makeDriver({
        handoff: async () => ({
          kind: 'failed',
          code: 'EXECUTION_FAILED',
          reason: 'unreachable',
        }),
        handoffBudget: { poolName: 'pool-main', units: 0 },
      }),
    ).toThrow(/positive/)
  })

  it('rejects invalid fallback bounds at construction', () => {
    expect(() =>
      makeDriver({
        handoff: async () => ({ kind: 'completed', artifacts: [], evidence: [], actualUnits: 0 }),
        handoffBudget: { poolName: 'pool-main', units: 10 },
        fallback: { timeoutMs: 0, maxConsecutiveFailures: 3, maxSteps: 10 },
      }),
    ).toThrow(/fallback\.timeoutMs/)
    expect(() =>
      makeDriver({
        handoff: async () => ({ kind: 'completed', artifacts: [], evidence: [], actualUnits: 0 }),
        handoffBudget: { poolName: 'pool-main', units: 10 },
        fallback: { timeoutMs: 1000, maxConsecutiveFailures: -1, maxSteps: 10 },
      }),
    ).toThrow(/fallback\.maxConsecutiveFailures/)
  })
})

describe('driver DeepSeek fallback bounds (N05)', () => {
  it('routes a low-confidence decision to the DeepSeek fallback and labels the terminal', async () => {
    let calls = 0
    const driver = makeDriver({
      provider: {
        decide: async (input) => ({
          ...testDecision('c1', 0.1),
          decisionId: input.decisionId,
        }),
      },
      handoff: async () => {
        calls += 1
        return { kind: 'completed', artifacts: ['a:1'], evidence: [], actualUnits: 5 }
      },
      handoffBudget: { poolName: 'pool-main', units: 100 },
    })
    const setup = await runTurn('s-fallback-lowconf', driver)
    try {
      expect(calls).toBe(1)
      expect(setup.toolRan()).toBe(false)
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('escalated')
      // Not System 1-verified: the fallback result carries no verification.
      expect(recorded[0].verifiedBy).toBeUndefined()
      const summary = terminalSummary(setup.session)
      expect(summary).toContain('DeepSeek fallback')
      // The fallback invocation is a durable session event, distinct
      // from System 1 verification.
      const fallbacks = eventData<{ outcome: string }>(setup.session, 'system1/fallback')
      expect(fallbacks).toHaveLength(1)
      expect(fallbacks[0].outcome).toBe('completed')
    } finally {
      await setup.dispose()
    }
  })

  it('routes a provider failure to the DeepSeek fallback with the failure reason', async () => {
    let calls = 0
    const seen: HandoffBundle[] = []
    const driver = makeDriver({
      provider: {
        decide: async () => {
          throw system1Error('PROVIDER_TIMEOUT', 'jev down', {})
        },
      },
      handoff: async (_coordinator, bundle) => {
        calls += 1
        seen.push(bundle)
        return { kind: 'completed', artifacts: [], evidence: [], actualUnits: 3 }
      },
      handoffBudget: { poolName: 'pool-main', units: 100 },
    })
    const setup = await runTurn('s-fallback-provider', driver)
    try {
      expect(calls).toBe(1)
      expect(seen[0].failedChoices).toEqual([])
      expect(seen[0].constraints.join(' ')).toContain('PROVIDER_TIMEOUT')
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('escalated')
    } finally {
      await setup.dispose()
    }
  })

  it('does not fall back when no handoff handler is configured', async () => {
    const driver = makeDriver({
      provider: {
        decide: async () => {
          throw system1Error('PROVIDER_TIMEOUT', 'jev down', {})
        },
      },
    })
    const setup = await runTurn('s-fallback-nohandler', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
      const fallbacks = eventData<unknown>(setup.session, 'system1/fallback')
      expect(fallbacks).toHaveLength(0)
    } finally {
      await setup.dispose()
    }
  })

  it('does not fall back on policy or admission security failures', async () => {
    let calls = 0
    const driver = makeDriver({
      provider: {
        decide: async (input) => ({
          ...testDecision('c1'),
          decisionId: 'wrong-id',
          questionFamily: input.questionFamily,
          promptVersion: input.promptVersion,
        }),
      },
      handoff: async () => {
        calls += 1
        return { kind: 'completed', artifacts: [], evidence: [], actualUnits: 0 }
      },
      handoffBudget: { poolName: 'pool-main', units: 100 },
    })
    const setup = await runTurn('s-fallback-correlation', driver)
    try {
      expect(calls).toBe(0)
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
    } finally {
      await setup.dispose()
    }
  })

  it('opens the circuit breaker after consecutive fallback failures and fails closed', async () => {
    let calls = 0
    const driver = makeDriver({
      provider: {
        decide: async (input) => ({
          ...testDecision('c1', 0.1),
          decisionId: input.decisionId,
        }),
      },
      handoff: async () => {
        calls += 1
        return { kind: 'failed', code: 'EXECUTION_FAILED', reason: 'fallback down' }
      },
      handoffBudget: { poolName: 'pool-main', units: 100 },
      fallback: { timeoutMs: 5000, maxConsecutiveFailures: 2, maxSteps: 5 },
    })
    // First two turns: the handler runs and fails.
    for (const sessionId of ['s-breaker-1', 's-breaker-2']) {
      const setup = await runTurn(sessionId, driver)
      try {
        const recorded = terminals(setup.session)
        expect(recorded[0].outcome).toBe('escalated')
      } finally {
        await setup.dispose()
      }
    }
    expect(calls).toBe(2)
    // The breaker opens on the second consecutive failure: the third
    // turn fails closed without invoking the handler.
    const setup = await runTurn('s-breaker-3', driver)
    try {
      expect(calls).toBe(2)
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
      expect(terminalSummary(setup.session)).toContain('circuit breaker open')
      const breakerEvents = eventData<{ state: string }>(
        setup.session,
        'system1/fallback-breaker',
      )
      expect(breakerEvents.some((event) => event.state === 'open')).toBe(true)
    } finally {
      await setup.dispose()
    }
  })

  it('abandons a fallback that exceeds its per-call timeout', async () => {
    const driver = makeDriver({
      provider: {
        decide: async (input) => ({
          ...testDecision('c1', 0.1),
          decisionId: input.decisionId,
        }),
      },
      handoff: async (_coordinator, _bundle, signal) => {
        // Hang until the driver aborts the signal.
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { kind: 'completed', artifacts: [], evidence: [], actualUnits: 0 }
      },
      handoffBudget: { poolName: 'pool-main', units: 100 },
      fallback: { timeoutMs: 50, maxConsecutiveFailures: 3, maxSteps: 5 },
    })
    const setup = await runTurn('s-fallback-timeout', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('escalated')
      expect(terminalSummary(setup.session)).toContain('timed out')
      const fallbacks = eventData<{ outcome: string }>(setup.session, 'system1/fallback')
      expect(fallbacks).toHaveLength(1)
      expect(fallbacks[0].outcome).toBe('timeout')
    } finally {
      await setup.dispose()
    }
  })
})

/** Summary of the single terminal event in a session. */
function terminalSummary(session: Session): string {
  const event = session
    .snapshotEvents()
    .find((candidate) => candidate.type === 'system1/terminal')
  const data = event?.data as { summary?: string } | undefined
  return data?.summary ?? ''
}

/** Payloads of every event of one type, in log order. */
function eventData<T>(session: Session, type: string): T[] {
  return session
    .snapshotEvents()
    .filter((event) => event.type === type)
    .map((event) => event.data as T)
}

describe('ReadOnlyProductionDriver evidence (N06)', () => {
  it('records pre-dispatch evidence and the real tool/result before verification', async () => {
    const driver = makeDriver({})
    const setup = await runTurn('s-evidence-predispatch', driver)
    try {
      expect(setup.toolRan()).toBe(true)

      // Pre-dispatch: admission, decision identity, the approved
      // operation/argument digest, the attempt, and execution intent.
      const plans = eventData<{
        decisionId: string
        admission: string
        candidateId: string
        operationRef: string
        argumentDigest: string
        attempt: number
      }>(setup.session, 'system1/dispatch-plan')
      expect(plans).toHaveLength(1)
      expect(plans[0]).toMatchObject({
        admission: 'admit',
        candidateId: 'c1',
        operationRef: 'op:ci-runs:read:v1',
        attempt: 1,
      })
      expect(typeof plans[0]?.decisionId).toBe('string')
      expect(plans[0]?.argumentDigest).toBe(hashEvidenceContent([{ type: 'text', text: '{}' }]))

      // The real tool result is persisted before verification (reviewer probe V11).
      const calls = eventData<{ callId: string }>(setup.session, 'tool/call')
      const results = eventData<{ message: { toolCallId: string } }>(
        setup.session,
        'tool/result',
      )
      expect(calls).toHaveLength(1)
      expect(results).toHaveLength(1)
      expect(results[0]?.message.toolCallId).toBe('call-test')

      // Verification cites the bare receipt (no double prefix) and the
      // binding names the verifier version and checked resource versions.
      const verifications = eventData<{ evidence: string }>(
        setup.session,
        'system1/verification',
      )
      expect(verifications[0]?.evidence).toBe('tool-call:call-test')
      const bindings = eventData<{
        verifierVersion: string
        resourceVersions: Record<string, string>
      }>(setup.session, 'system1/evidence-binding')
      expect(bindings).toHaveLength(1)
      expect(bindings[0]?.verifierVersion).toBe('verify:ci:v1')
      expect(Object.keys(bindings[0]?.resourceVersions ?? {})).toEqual([
        'tool-call:call-test',
      ])
    } finally {
      await setup.dispose()
    }
  })

  it('resolves finalization evidence from a restarted session log', async () => {
    const driver = makeDriver({})
    const setup = await runTurn('s-evidence-restart', driver)
    try {
      expect(setup.toolRan()).toBe(true)
      const requestId = System1RequestId('req-test')
      const restarted = Session.create(
        SessionId('s-evidence-restart'),
        setup.session.snapshotEvents(),
      )
      // The finalizer's stored projection survives the restart.
      const stored = loadStoredVerifications(restarted, requestId)
      expect(stored).toHaveLength(1)
      const storedResult = findStoredToolResult(restarted, ToolCallId('call-test'))
      if (storedResult === undefined) throw new Error('expected a stored tool/result')
      const check = stored[0]
      if (check === undefined) throw new Error('expected a stored verification')
      const resolution = resolveCheckEvidence(restarted, requestId, [
        {
          checkId: check.checkId,
          expectedReceiptRef: 'tool-call:call-test',
          expectedHash: hashEvidenceContent(storedResult.data.message.content),
        },
      ])
      expect(resolution.ok).toBe(true)
    } finally {
      await setup.dispose()
    }
  })

  it('finalizes a repeated request id exactly once', async () => {
    const requestIds = ['req-a', 'req-b', 'req-a']
    let next = 0
    const driver = makeDriver({
      newRequestId: () => System1RequestId(requestIds[next++] ?? 'req-fallback'),
    })
    const { ctx, workflows } = await boot()
    try {
      const session = Session.create(SessionId('s-evidence-idempotent'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        for (let turn = 0; turn < 3; turn++) {
          handle.coordinator.followup(userMessage('Check CI status'))
          await handle.coordinator.whenIdle()
        }
        const recorded = terminals(session)
        expect(recorded).toHaveLength(2)
        expect(recorded.every((terminal) => terminal.outcome === 'success')).toBe(true)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed when the candidate has no verification policy', async () => {
    const noPolicyCatalog: CatalogTool[] = [
      {
        toolId: 'ci-runs',
        label: 'Read CI runs',
        route: 'tool',
        effect: 'read',
        operationRef: 'op:ci-runs:read:v1',
        preconditions: {},
        verificationPolicyId: '',
      },
    ]
    const driver = makeDriver({ catalog: noPolicyCatalog })
    const setup = await runTurn('s-evidence-no-policy', driver)
    try {
      expect(setup.toolRan()).toBe(true)
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0]?.outcome).toBe('failure')
      expect(terminalSummary(setup.session)).toContain('No verification policy')
    } finally {
      await setup.dispose()
    }
  })

  it('records unresolved handoff evidence as failed verification', async () => {
    const driver = makeDriver({
      provider: {
        decide: async (input) => ({
          ...testDecision('escalate-none', null),
          decisionId: input.decisionId,
          probabilities: {},
          selectedProbability: 0,
        }),
      },
      handoff: async () => ({
        kind: 'completed',
        artifacts: [],
        evidence: [''],
        actualUnits: 3,
      }),
      handoffBudget: { poolName: 'pool-main', units: 100 },
    })
    const setup = await runTurn('s-evidence-handoff-unresolved', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0]?.outcome).toBe('escalated')
      const verifications = eventData<{ checkId: string; passed: boolean }>(
        setup.session,
        'system1/verification',
      )
      expect(verifications).toHaveLength(1)
      expect(verifications[0]).toMatchObject({ checkId: 'deepseek-handoff', passed: false })
      expect(terminalSummary(setup.session)).toContain('unresolved')
    } finally {
      await setup.dispose()
    }
  })

  it('spills an oversized tool result by reference and still finalizes success', async () => {
    const driver = makeDriver({})
    const { ctx, workflows } = await boot()
    try {
      // Best-effort spill store on the coordinator context; the driver
      // reads it opportunistically, so a plain structural stub suffices.
      ctx.provide('spillStore', {
        saveText: (input: { content: string }) =>
          Promise.resolve({ locator: 'spill://tenant-test/big', bytes: input.content.length }),
      })
      const session = Session.create(SessionId('s-evidence-spill'))
      const handle = await workflows.create(session, driver)
      try {
        const bigText = `CI is green ${'x'.repeat(MAX_EVIDENCE_CHARS)}`
        handle.coordinator.ctx.tools.register(
          defineContentToolFixture({
            name: 'ci-status',
            description: 'CI status reader',
            parameters: {},
            async execute() {
              return [{ type: 'text', text: bigText }]
            },
          }),
        )
        handle.coordinator.followup(userMessage('Check CI status'))
        await handle.coordinator.whenIdle()
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0]?.outcome).toBe('success')

        // The binding records the spill reference with the driver tenant.
        const bindings = eventData<{
          verifierVersion: string
          spill?: { locator: string; contentHash: string; tenantId: string; sessionId: string }
        }>(session, 'system1/evidence-binding')
        expect(bindings).toHaveLength(1)
        expect(bindings[0]?.spill?.locator).toBe('spill://tenant-test/big')
        expect(bindings[0]?.spill?.tenantId).toBe('tenant-test')
        expect(bindings[0]?.spill?.sessionId).toBe('s-evidence-spill')
        expect(bindings[0]?.spill?.contentHash).toBe(
          hashEvidenceContent([{ type: 'text', text: bigText }]),
        )

        // The inline tool/result stays bounded: a pointer, not the result.
        const stored = findStoredToolResult(session, ToolCallId('call-test'))
        if (stored === undefined) throw new Error('expected a stored tool/result')
        const inline = stored.data.message.content
          .filter((block) => block.type === 'text')
          .map((block) => (block as { text: string }).text)
          .join('\n')
        expect(inline.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS)
        expect(inline).toContain('spilled to spill://tenant-test/big')
        expect(inline).not.toContain(bigText)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('driver budget accounting', () => {
  interface BudgetFixture {
    store: CoordinationStore
    ledger: HandoffBudgetLedger
    /** Reservation task ids in reservation order. */
    taskIds: string[]
  }

  function budgetFixture(): BudgetFixture {
    const store = new CoordinationStore({
      clock: new SystemClock(),
      ids: new SequentialIdGenerator(),
    })
    store.createBudgetPool('tenant-test', 'pool-budget', 1000)
    const taskIds: string[] = []
    const ledger: HandoffBudgetLedger = {
      reserve: (tenantId, poolName, taskId, units, deadlineAt) => {
        taskIds.push(taskId)
        return store.reserve(tenantId, poolName, taskId, units, deadlineAt)
      },
      settle: (reservationId, actualUnits) => {
        store.settle(reservationId, actualUnits)
      },
      release: (reservationId, cancelled) => {
        store.release(reservationId, cancelled)
      },
      holdForReconciliation: (reservationId, claimedUnits, reason) => {
        store.holdForReconciliation(reservationId, claimedUnits, reason)
      },
    }
    return { store, ledger, taskIds }
  }

  function meteredProvider(): DecisionProvider {
    return {
      decide: async (input) => ({
        ...testDecision('c1'),
        decisionId: input.decisionId,
        usage: { inputTokens: 30, outputTokens: 20 },
      }),
    }
  }

  it('reserves before and settles the Jev decision from host-observed usage', async () => {
    const { store, ledger, taskIds } = budgetFixture()
    const driver = makeDriver({
      provider: meteredProvider(),
      budget: {
        ledger,
        poolName: 'pool-budget',
        jevRequestUnits: 100,
        toolCallUnits: 10,
      },
    })
    const turn = await runTurn('s-budget-metered', driver)
    try {
      expect(turn.toolRan()).toBe(true)
      // Jev usage settled from metered tokens (30 + 20); the tool call
      // settled its full unit charge.
      expect(store.getPoolUtilization('tenant-test', 'pool-budget')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 60,
      })
      // Reservations link to stable per-operation ids, not the bare request id.
      expect(taskIds).toHaveLength(2)
      expect(taskIds[0]).toMatch(/^req-test:jev-decide:dec-/)
      expect(taskIds[1]).toBe('call-test')
    } finally {
      await turn.dispose()
    }
  })

  it('retains a reconciliation hold when the provider reports no usage', async () => {
    const { store, ledger } = budgetFixture()
    // The default test decision reports null token counts: usage is
    // unknown, so the reservation must hold, never settle at 0.
    const driver = makeDriver({
      budget: {
        ledger,
        poolName: 'pool-budget',
        jevRequestUnits: 100,
        toolCallUnits: 10,
      },
    })
    const turn = await runTurn('s-budget-unmetered', driver)
    try {
      expect(turn.toolRan()).toBe(true)
      // The Jev reservation stays encumbered as a hold; only the tool
      // call consumed.
      expect(store.getPoolUtilization('tenant-test', 'pool-budget')).toEqual({
        capacity: 1000,
        reserved: 100,
        consumed: 10,
      })
      const held = store.getReservation('res-000001')
      expect(held.status).toBe('held')
    } finally {
      await turn.dispose()
    }
  })

  it('retains a hold when metered usage exceeds the reservation', async () => {
    const { store, ledger } = budgetFixture()
    const driver = makeDriver({
      provider: {
        decide: async (input) => ({
          ...testDecision('c1'),
          decisionId: input.decisionId,
          // 90 + 80 = 170 units against a 100-unit reservation.
          usage: { inputTokens: 90, outputTokens: 80 },
        }),
      },
      budget: {
        ledger,
        poolName: 'pool-budget',
        jevRequestUnits: 100,
        toolCallUnits: 10,
      },
    })
    const turn = await runTurn('s-budget-overrun', driver)
    try {
      expect(turn.toolRan()).toBe(true)
      // Over-reservation usage is never absorbed silently: the Jev
      // reservation holds while the tool call settles normally.
      expect(store.getPoolUtilization('tenant-test', 'pool-budget')).toEqual({
        capacity: 1000,
        reserved: 100,
        consumed: 10,
      })
    } finally {
      await turn.dispose()
    }
  })

  it('retains a hold when the usage meter throws', async () => {    const { store, ledger } = budgetFixture()
    const driver = makeDriver({
      provider: meteredProvider(),
      budget: {
        ledger,
        poolName: 'pool-budget',
        jevRequestUnits: 100,
        toolCallUnits: 10,
        meterJevUsage: () => {
          throw new Error('meter bug')
        },
      },
    })
    const turn = await runTurn('s-budget-meter-throws', driver)
    try {
      expect(turn.toolRan()).toBe(true)
      expect(store.getPoolUtilization('tenant-test', 'pool-budget')).toEqual({
        capacity: 1000,
        reserved: 100,
        consumed: 10,
      })
    } finally {
      await turn.dispose()
    }
  })
})
