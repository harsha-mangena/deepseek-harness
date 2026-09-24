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
import { afterAll, describe, expect, it } from 'vitest'
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
  type System1CoordinatorAgent,
  type System1Workflows,
} from '@deepseek-ai/dsh-system1-workflow'
import {
  ReadOnlyProductionDriver,
  type ProductionDriverConfig,
  type ToolVerificationContext,
} from '@deepseek-ai/dsh-system1-integration'
import { PolicyEngine } from '@deepseek-ai/dsh-system1-policy'
import type { CapabilityProfile } from '@deepseek-ai/dsh-system1-policy'
import { fitIsotonic } from '@deepseek-ai/dsh-system1-calibration'
import type { IsotonicCalibration } from '@deepseek-ai/dsh-system1-calibration'
import type { CatalogTool } from '@deepseek-ai/dsh-system1-observations'
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
  tenantId: 'default',
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
async function boot(): Promise<{ ctx: Context; workflows: System1Workflows }> {
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
    ['- id: system1', `  name: ${fixtureUrl}`, '  config:', '    mode: shadow', ''].join(
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

/** Create a coordinator with a real scoped tool and run one driver turn. */
async function runTurn(
  sessionId: string,
  driver: ReadOnlyProductionDriver,
): Promise<TurnSetup> {
  const { ctx, workflows } = await boot()
  const session = Session.create(SessionId(sessionId))
  const handle = await workflows.create(session, driver)
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
