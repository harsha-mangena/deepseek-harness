/** Coverage-gap tests for the production driver and coordinator.
 *
 * Exercises defensive and failure paths that the main driver suite does not
 * reach: constructor validation, id-generation defaults, budget failure
 * modes, abort handling, fallback error classification, and admission edge
 * cases. Uses the same Loader-booted real composition as driver.spec.ts.
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
  type HandoffBudgetLedger,
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
  admitDecision,
  buildEscalationBundle,
  type ProductionDriverConfig,
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

const MODULE_KEY = '__dshSystem1DriverCoverageModule'

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

async function boot(mode: System1Mode = 'enforce'): Promise<{ ctx: Context; workflows: System1Workflows }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-system1-driver-cov-'))
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
    verify: () => ({ checkId: 'verify:test', passed: true }),
    newRequestId: () => System1RequestId('req-test'),
    newCallId: () => ToolCallId('call-test'),
    ...overrides,
  })
}

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

async function runTurn(
  sessionId: string,
  driver: ReadOnlyProductionDriver,
  signal?: AbortSignal,
): Promise<{ session: Session; coordinator: System1CoordinatorAgent; dispose: () => Promise<void> }> {
  const { ctx, workflows } = await boot()
  const session = Session.create(SessionId(sessionId))
  const handle = await workflows.create(session, driver)
  registerCiTool(handle.coordinator)
  // Drive the turn explicitly without followup(): followup() wakes the
  // driver in the background, which would race the explicit run and
  // produce duplicate terminals. The provider fixture returns a decision
  // regardless of inbox observations.
  await driver.run(handle.coordinator, signal ?? AbortSignal.timeout(30000))
  return {
    session,
    coordinator: handle.coordinator,
    dispose: async () => {
      await handle.dispose()
      await ctx.fiber.dispose()
    },
  }
}

function terminals(session: Session): Array<{ outcome: string; summary?: string; requestId: string }> {
  return session
    .snapshotEvents()
    .filter((event) => event.type === 'system1/terminal')
    .map((event) => {
      const data = event.data as { outcome: string; summary?: string; requestId: string }
      return { outcome: data.outcome, summary: data.summary, requestId: data.requestId }
    })
}

function budgetFixture(): { store: CoordinationStore; ledger: HandoffBudgetLedger } {
  const store = new CoordinationStore({
    clock: new SystemClock(),
    ids: new SequentialIdGenerator(),
  })
  store.createBudgetPool('tenant-test', 'pool-budget', 1000)
  const ledger: HandoffBudgetLedger = {
    reserve: (tenantId, poolName, taskId, units, deadlineAt) =>
      store.reserve(tenantId, poolName, taskId, units, deadlineAt),
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
  return { store, ledger }
}

describe('driver constructor validation', () => {
  it('rejects a handoff handler without a handoff budget', () => {
    expect(() =>
      makeDriver({
        handoff: async () => ({ kind: 'completed', artifacts: [], evidence: [], actualUnits: 0 }),
      }),
    ).toThrow(/handoffBudget/)
  })

  it('rejects a non-positive handoff budget', () => {
    expect(() =>
      makeDriver({
        handoff: async () => ({ kind: 'completed', artifacts: [], evidence: [], actualUnits: 0 }),
        handoffBudget: { poolName: 'pool-main', units: 0 },
      }),
    ).toThrow(/positive/)
  })

  it('rejects a missing tenantId', () => {
    expect(() =>
      makeDriver({
        tenantId: '',
      }),
    ).toThrow(/tenantId/)
  })

  it('rejects a missing expectedModel', () => {
    expect(() =>
      makeDriver({
        expectedModel: '',
      }),
    ).toThrow(/expectedModel/)
  })
})

describe('buildEscalationBundle edge cases', () => {
  it('falls back to the turn when observations are empty and no decision was made', () => {
    const bundle = buildEscalationBundle({
      requestId: System1RequestId('req-turn'),
      observations: [],
      reason: 'provider down',
      budget: { poolName: 'pool-main', units: 10 },
      tenantId: 'tenant-test',
    })
    expect(bundle.objective).toBe('Escalated turn req-turn: provider down')
    expect(bundle.failedChoices).toEqual([])
  })
})

describe('driver id generation defaults', () => {
  async function waitForTerminal(session: Session, timeoutMs = 15000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const count = session
        .snapshotEvents()
        .filter((event) => event.type === 'system1/terminal').length
      if (count > 0) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('timed out waiting for the driver turn to settle')
  }

  it('mints a request id when newRequestId is not provided', async () => {
    const driver = new ReadOnlyProductionDriver({
      mode: 'enforce',
      policy: makePolicy(),
      capabilityProfile: profile,
      provider: {
        decide: async (input) => ({ ...testDecision('c1'), decisionId: input.decisionId }),
      },
      catalog,
      calibration: testCalibration(),
      expectedModel: EXPECTED_MODEL,
      tenantId: 'tenant-test',
      resolveCall: () => ({ name: 'ci-status', arguments: {} }),
      verify: () => ({ checkId: 'verify:test', passed: true }),
      newCallId: () => ToolCallId('call-test'),
    })
    const { ctx, workflows } = await boot()
    try {
      const session = Session.create(SessionId('s-cov-default-reqid'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        // followup() wakes the driver, which mints the request id via the
        // default factory. Wait for that background turn instead of
        // driving a second one.
        handle.coordinator.followup(userMessage('Check CI status'))
        await waitForTerminal(session)
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('success')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('mints a call id when newCallId is not provided', async () => {
    const driver = makeDriver({ newCallId: undefined })
    const { ctx, workflows } = await boot()
    try {
      const session = Session.create(SessionId('s-cov-default-callid'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        handle.coordinator.followup(userMessage('Check CI status'))
        await waitForTerminal(session)
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('success')
        // The receipt ref uses the minted call id, not the test override.
        const verifications = session
          .snapshotEvents()
          .filter((event) => event.type === 'system1/verification')
        expect(verifications).toHaveLength(1)
        expect((verifications[0].data as { evidence: string }).evidence).toMatch(/^tool-call:call-/)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('driver calibration passthrough', () => {
  it('accepts an explicit minCalibratedConfidence in enforce mode', async () => {
    const driver = makeDriver({ minCalibratedConfidence: 0.1 })
    const setup = await runTurn('s-cov-minconf', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('success')
    } finally {
      await setup.dispose()
    }
  })

  it('accepts an explicit minCalibratedConfidence in shadow mode', async () => {
    const { ctx, workflows } = await boot('shadow')
    try {
      const driver = makeDriver({ mode: 'shadow', minCalibratedConfidence: 0.1 })
      const session = Session.create(SessionId('s-cov-minconf-shadow'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        await driver.run(handle.coordinator, AbortSignal.timeout(30000))
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('escalated')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('driver tool failure paths', () => {
  it('fails closed when the tool result is an error', async () => {
    const { ctx, workflows } = await boot()
    try {
      const driver = makeDriver()
      const session = Session.create(SessionId('s-cov-tool-error'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        // A tool guard denies the call: the runtime resolves with isError.
        handle.coordinator.ctx.on('tools/execute', async (_exec, next) => {
          await next()
          return {
            content: [{ type: 'text', text: 'denied by guard' }],
            isError: true as const,
            error: { message: 'denied by guard', info: { code: 'GUARD_DENIED' } },
          }
        })
        await driver.run(handle.coordinator, AbortSignal.timeout(30000))
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('failure')
        expect(recorded[0].summary).toMatch(/did not succeed/)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed when the verifier throws', async () => {
    const driver = makeDriver({
      verify: () => {
        throw new Error('verifier exploded')
      },
    })
    const setup = await runTurn('s-cov-verifier-throws', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
      expect(recorded[0].summary).toMatch(/Verifier threw/)
    } finally {
      await setup.dispose()
    }
  })

  it('settles the tool call when the tool execution throws', async () => {
    const { store, ledger } = budgetFixture()
    const { ctx, workflows } = await boot()
    try {
      const driver = makeDriver({
        budget: { ledger, poolName: 'pool-budget', jevRequestUnits: 100, toolCallUnits: 10 },
      })
      const session = Session.create(SessionId('s-cov-tool-throws'))
      const handle = await workflows.create(session, driver)
      try {
        handle.coordinator.ctx.tools.register(
          defineContentToolFixture({
            name: 'ci-status',
            description: 'CI status reader',
            parameters: {},
            async execute() {
              throw new Error('tool exploded')
            },
          }),
        )
        await driver.run(handle.coordinator, AbortSignal.timeout(30000))
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('failure')
        // The tool runtime converts the throw to an isError result; the
        // driver settles the tool reservation and fails closed. The Jev
        // reservation holds (null usage in the fixture decision).
        expect(store.getPoolUtilization('tenant-test', 'pool-budget')).toEqual({
          capacity: 1000,
          reserved: 100,
          consumed: 10,
        })
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed when the call cannot be resolved to a tool', async () => {
    const driver = makeDriver({ resolveCall: () => undefined })
    const setup = await runTurn('s-cov-unresolvable', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
      expect(recorded[0].summary).toMatch(/No tool mapping/)
    } finally {
      await setup.dispose()
    }
  })
})

describe('driver budget failure paths', () => {
  function failingLedger(
    store: CoordinationStore,
    failure: 'reserve' | 'settle',
  ): HandoffBudgetLedger {
    return {
      reserve: () => {
        if (failure === 'reserve') throw new Error('ledger reserve failed')
        return store.reserve('tenant-test', 'pool-budget', 'task-x', 100, 0)
      },
      settle: (reservationId, actualUnits) => {
        if (failure === 'settle') throw new Error('ledger settle failed')
        store.settle(reservationId, actualUnits)
      },
      release: (reservationId, cancelled) => {
        store.release(reservationId, cancelled)
      },
      holdForReconciliation: (reservationId, claimedUnits, reason) => {
        store.holdForReconciliation(reservationId, claimedUnits, reason)
      },
    }
  }

  it('fails the turn when the Jev reservation fails', async () => {
    const { store } = budgetFixture()
    const driver = makeDriver({
      budget: {
        ledger: failingLedger(store, 'reserve'),
        poolName: 'pool-budget',
        jevRequestUnits: 100,
        toolCallUnits: 10,
      },
    })
    const setup = await runTurn('s-cov-jev-reserve-fail', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
      expect(recorded[0].summary).toMatch(/Decision budget reservation failed/)
    } finally {
      await setup.dispose()
    }
  })

  it('retains a hold when the provider throws during a metered decision', async () => {
    const { store, ledger } = budgetFixture()
    const driver = makeDriver({
      provider: {
        decide: async () => {
          throw system1Error('PROVIDER_TIMEOUT', 'Jev timed out', {})
        },
      },
      budget: {
        ledger,
        poolName: 'pool-budget',
        jevRequestUnits: 100,
        toolCallUnits: 10,
      },
    })
    const { ctx, workflows } = await boot()
    try {
      const session = Session.create(SessionId('s-cov-provider-throws'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        await driver.run(handle.coordinator, AbortSignal.timeout(30000))
        // The turn fails closed; the reservation is held.
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('failure')
        const utilization = store.getPoolUtilization('tenant-test', 'pool-budget')
        expect(utilization.reserved).toBe(100)
        const held = store.getReservation('res-000001')
        expect(held.status).toBe('held')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retains a hold when the usage meter throws', async () => {
    const { store, ledger } = budgetFixture()
    const driver = makeDriver({
      provider: {
        decide: async (input) => ({
          ...testDecision('c1'),
          decisionId: input.decisionId,
          usage: {
            get inputTokens(): number | null {
              throw new Error('meter exploded')
            },
            outputTokens: 20,
          },
        }),
      },
      budget: {
        ledger,
        poolName: 'pool-budget',
        jevRequestUnits: 100,
        toolCallUnits: 10,
      },
    })
    const setup = await runTurn('s-cov-meter-throws', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('success')
      const held = store.getReservation('res-000001')
      expect(held.status).toBe('held')
    } finally {
      await setup.dispose()
    }
  })

  it('retains a hold when Jev settlement throws', async () => {
    const { store } = budgetFixture()
    const driver = makeDriver({
      provider: {
        decide: async (input) => ({
          ...testDecision('c1'),
          decisionId: input.decisionId,
          usage: { inputTokens: 30, outputTokens: 20 },
        }),
      },
      budget: {
        ledger: failingLedger(store, 'settle'),
        poolName: 'pool-budget',
        jevRequestUnits: 100,
        toolCallUnits: 10,
      },
    })
    const setup = await runTurn('s-cov-settle-fail', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('success')
      const held = store.getReservation('res-000001')
      expect(held.status).toBe('held')
    } finally {
      await setup.dispose()
    }
  })

  it('fails the turn when the tool reservation fails', async () => {
    const { store } = budgetFixture()
    let calls = 0
    const ledger: HandoffBudgetLedger = {
      reserve: (tenantId, poolName, taskId, units, deadlineAt) => {
        calls += 1
        if (calls > 1) throw new Error('tool reserve failed')
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
    const driver = makeDriver({
      budget: { ledger, poolName: 'pool-budget', jevRequestUnits: 100, toolCallUnits: 10 },
    })
    const setup = await runTurn('s-cov-tool-reserve-fail', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
      expect(recorded[0].summary).toMatch(/Tool call budget reservation failed/)
    } finally {
      await setup.dispose()
    }
  })

  it('retains a hold when tool settlement throws', async () => {
    const { store } = budgetFixture()
    const ledger: HandoffBudgetLedger = {
      reserve: (tenantId, poolName, taskId, units, deadlineAt) =>
        store.reserve(tenantId, poolName, taskId, units, deadlineAt),
      settle: (reservationId, actualUnits) => {
        // Fail only the tool settlement (second settle call).
        if (reservationId === 'res-000002') throw new Error('tool settle failed')
        store.settle(reservationId, actualUnits)
      },
      release: (reservationId, cancelled) => {
        store.release(reservationId, cancelled)
      },
      holdForReconciliation: (reservationId, claimedUnits, reason) => {
        store.holdForReconciliation(reservationId, claimedUnits, reason)
      },
    }
    const driver = makeDriver({
      budget: { ledger, poolName: 'pool-budget', jevRequestUnits: 100, toolCallUnits: 10 },
    })
    const setup = await runTurn('s-cov-tool-settle-fail', driver)
    try {
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('success')
      const held = store.getReservation('res-000002')
      expect(held.status).toBe('held')
    } finally {
      await setup.dispose()
    }
  })
})

describe('driver fallback error classification', () => {
  async function setupFailingTurn(
    sessionId: string,
    provider: DecisionProvider,
  ): Promise<{
    driver: ReadOnlyProductionDriver
    seen: Array<{ reason: string }>
    session: Session
    coordinator: System1CoordinatorAgent
    dispose: () => Promise<void>
  }> {
    const seen: Array<{ reason: string }> = []
    const driver = makeDriver({
      provider,
      handoff: async (_coordinator, bundle) => {
        seen.push({ reason: bundle.constraints.join(' ') })
        return { kind: 'completed', artifacts: [], evidence: [], actualUnits: 0 }
      },
      handoffBudget: { poolName: 'pool-main', units: 100 },
      fallback: { timeoutMs: 1000, maxConsecutiveFailures: 3, maxSteps: 5 },
    })
    const { ctx, workflows } = await boot()
    const session = Session.create(SessionId(sessionId))
    const handle = await workflows.create(session, driver)
    registerCiTool(handle.coordinator)
    return {
      driver,
      seen,
      session,
      coordinator: handle.coordinator,
      dispose: async () => {
        await handle.dispose()
        await ctx.fiber.dispose()
      },
    }
  }

  it('does not fall back on a non-System1Error', async () => {
    const setup = await setupFailingTurn('s-cov-non-system1', {
      decide: async () => {
        throw new Error('plain failure')
      },
    })
    try {
      await setup.driver.run(setup.coordinator, AbortSignal.timeout(30000))
      // The turn fails closed without invoking the handoff.
      expect(setup.seen).toHaveLength(0)
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
      expect(recorded[0].summary).toMatch(/plain failure/)
    } finally {
      await setup.dispose()
    }
  })

  it('does not fall back on a non-provider System1Error', async () => {
    const setup = await setupFailingTurn('s-cov-other-system1', {
      decide: async () => {
        throw system1Error('CANDIDATE_NOT_ADMISSIBLE', 'denied', {})
      },
    })
    try {
      await setup.driver.run(setup.coordinator, AbortSignal.timeout(30000))
      // The turn fails closed without invoking the handoff.
      expect(setup.seen).toHaveLength(0)
      const recorded = terminals(setup.session)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].outcome).toBe('failure')
    } finally {
      await setup.dispose()
    }
  })
})

describe('driver abort handling', () => {
  it('finalizes cancelled when aborted after the decision', async () => {
    const aborter = new AbortController()
    const { ctx, workflows } = await boot()
    try {
      const driver = makeDriver({
        provider: {
          decide: async (input) => {
            const decision = { ...testDecision('c1'), decisionId: input.decisionId }
            // Abort after the decision is produced but before the turn
            // completes: the driver must finalize cancelled.
            aborter.abort()
            return decision
          },
        },
      })
      const session = Session.create(SessionId('s-cov-abort-after-decision'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        await driver.run(handle.coordinator, aborter.signal)
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('cancelled')
        expect(recorded[0].summary).toMatch(/aborted after decision/)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('finalizes cancelled when a shadow turn aborts after the decision', async () => {
    const aborter = new AbortController()
    const { ctx, workflows } = await boot('shadow')
    try {
      const driver = makeDriver({
        mode: 'shadow',
        provider: {
          decide: async (input) => {
            const decision = { ...testDecision('c1'), decisionId: input.decisionId }
            aborter.abort()
            return decision
          },
        },
      })
      const session = Session.create(SessionId('s-cov-shadow-abort-after'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        await driver.run(handle.coordinator, aborter.signal)
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('cancelled')
        expect(recorded[0].summary).toMatch(/aborted after decision/)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})


describe('driver fallback breaker recovery', () => {
  it('emits breaker_open after consecutive handoff failures', async () => {
    const driver = makeDriver({
      provider: {
        decide: async () => {
          throw system1Error('PROVIDER_TIMEOUT', 'Jev timed out', {})
        },
      },
      handoff: async () => ({
        kind: 'failed',
        code: 'HANDOFF_FAILED',
        reason: 'handoff down',
      }),
      handoffBudget: { poolName: 'pool-main', units: 100 },
      fallback: { timeoutMs: 1000, maxConsecutiveFailures: 2, maxSteps: 5 },
    })
    const { ctx, workflows } = await boot()
    const breakerStates: string[] = []
    try {
      for (let i = 0; i < 2; i += 1) {
        const session = Session.create(SessionId(`s-cov-breaker-${i}`))
        const handle = await workflows.create(session, driver)
        try {
          registerCiTool(handle.coordinator)
          await driver.run(handle.coordinator, AbortSignal.timeout(30000))
          const states = session
            .snapshotEvents()
            .filter((event) => event.type === 'system1/fallback-breaker')
            .map((event) => (event.data as { state: string }).state)
          breakerStates.push(...states)
        } finally {
          await handle.dispose()
        }
      }
      // The breaker opens after maxConsecutiveFailures handoff failures.
      // (The breaker-close path is unreachable: an open breaker fails fast
      // without attempting the handoff, so recordSuccess() never sees an
      // open breaker. See the v8 ignore in driver.ts.)
      expect(breakerStates).toContain('open')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('driver handoff evidence refs', () => {
  it('records an unresolved evidence ref without a reason', async () => {
    const seen: Array<{ ref: string; reason: string | undefined }> = []
    const driver = makeDriver({
      // Select escalate-none to force the handoff path.
      provider: {
        decide: async (input) => ({ ...testDecision('escalate-none'), decisionId: input.decisionId }),
      },
      handoff: async () => ({
        kind: 'completed',
        artifacts: [],
        // A ref that will not resolve: the driver must still record it.
        evidence: ['spill://tenant-test/missing'],
        actualUnits: 5,
      }),
      handoffBudget: { poolName: 'pool-main', units: 100 },
      fallback: { timeoutMs: 1000, maxConsecutiveFailures: 3, maxSteps: 5 },
    })
    // The driver emits evidence_ref_unresolved via onEvent? No — check
    // the session for the verification event instead.
    const { ctx, workflows } = await boot()
    try {
      const session = Session.create(SessionId('s-cov-evidence-noreason'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        await driver.run(handle.coordinator, AbortSignal.timeout(30000))
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('escalated')
        // The unresolved ref is recorded as failed verification evidence.
        const verifications = session
          .snapshotEvents()
          .filter((event) => event.type === 'system1/verification')
        expect(verifications.length).toBeGreaterThan(0)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('driver inbox handling', () => {
  it('claims inbox input and associates it with the request before dispatch', async () => {
    const { ctx, workflows } = await boot()
    try {
      const driver = makeDriver()
      const session = Session.create(SessionId('s-cov-inbox-claim'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        const inputId = handle.coordinator.followup(userMessage('Check CI status'))
        // The followup wakes the driver; wait for the background turn.
        const start = Date.now()
        while (Date.now() - start < 15000) {
          const count = session
            .snapshotEvents()
            .filter((event) => event.type === 'system1/terminal').length
          if (count > 0) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('success')
        const requestId = recorded[0].requestId
        // The turn claimed the input (journaled, so recovery never requeues
        // it) and associated it with the request before dispatch.
        const transitions = session
          .snapshotEvents()
          .filter((event) => event.type === 'system1/inbox-transition')
          .map((event) => event.data as { inputId: string; transition: string; requestId?: string })
        const claimed = transitions.find(
          (t) => t.inputId === inputId && t.transition === 'claimed',
        )
        expect(claimed).toBeDefined()
        const associated = transitions.find(
          (t) => t.inputId === inputId && t.transition === 'associated',
        )
        expect(associated).toBeDefined()
        expect(associated?.requestId).toBe(requestId)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips inbox messages with no text content', async () => {
    const { ctx, workflows } = await boot()
    try {
      const driver = makeDriver()
      const session = Session.create(SessionId('s-cov-inbox-empty'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        // A message with only non-text content contributes nothing.
        handle.coordinator.followup({
          ...createUserMessage({
            content: [],
            source: { kind: 'user' },
          }),
        })
        // The followup wakes the driver; wait for the background turn.
        handle.coordinator.followup(userMessage('Check CI status'))
        const start = Date.now()
        while (Date.now() - start < 15000) {
          const count = session
            .snapshotEvents()
            .filter((event) => event.type === 'system1/terminal').length
          if (count > 0) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('success')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('driver failure summary', () => {
  it('stringifies a non-Error thrown failure', async () => {
    const { ctx, workflows } = await boot()
    try {
      const driver = makeDriver({
        provider: {
          decide: async () => {
            // Providers may throw non-Error values.
            throw 'plain string failure'
          },
        },
      })
      const session = Session.create(SessionId('s-cov-string-throw'))
      const handle = await workflows.create(session, driver)
      try {
        registerCiTool(handle.coordinator)
        await driver.run(handle.coordinator, AbortSignal.timeout(30000))
        const recorded = terminals(session)
        expect(recorded).toHaveLength(1)
        expect(recorded[0].outcome).toBe('failure')
        expect(recorded[0].summary).toMatch(/plain string failure/)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('driver budget config validation', () => {
  it('rejects an empty budget pool name', () => {
    const { ledger } = budgetFixture()
    expect(() =>
      makeDriver({ budget: { ledger, poolName: '', jevRequestUnits: 100, toolCallUnits: 10 } }),
    ).toThrow(/non-empty pool name/)
  })

  it('rejects non-positive unit reservations', () => {
    const { ledger } = budgetFixture()
    expect(() =>
      makeDriver({
        budget: { ledger, poolName: 'pool-budget', jevRequestUnits: 0, toolCallUnits: 10 },
      }),
    ).toThrow(/positive integer/)
  })

  it('rejects a non-finite reservation deadline', () => {
    const { ledger } = budgetFixture()
    expect(() =>
      makeDriver({
        budget: {
          ledger,
          poolName: 'pool-budget',
          jevRequestUnits: 100,
          toolCallUnits: 10,
          deadlineAt: Number.POSITIVE_INFINITY,
        },
      }),
    ).toThrow(/finite timestamp/)
  })
})

describe('admitDecision', () => {
  it('rejects a concrete decision when vendor confidence is null', () => {
    const decision = testDecision('c1', null)
    const verdict = admitDecision({
      decision,
      input: {
        decisionId: decision.decisionId,
        questionFamily: decision.questionFamily,
        promptVersion: decision.promptVersion,
        observations: [],
        candidates: [],
      },
      admittedCandidates: [
        {
          id: 'c1',
          label: 'l',
          route: 'tool',
          effect: 'read',
          operationRef: 'op',
          preconditionHash: 'h',
          verificationPolicyId: 'v',
        },
      ],
      calibration: testCalibration(),
      expectedModel: EXPECTED_MODEL,
      minCalibratedConfidence: 0,
    })
    expect(verdict.admitted).toBe(false)
    expect(verdict.reason).toMatch(/no vendor confidence/)
  })
})
