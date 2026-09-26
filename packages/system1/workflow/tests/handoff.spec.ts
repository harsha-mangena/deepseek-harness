/** Real DeepSeek handoff (Phase E, §13.5).
 *
 * Exercises the shipped `handoffToDeepSeek` code — budget reservation /
 * settlement / release, child lineage, cancellation propagation, and
 * return-contract validation — with a scripted child factory standing in
 * for the standard DeepSeek factory (which is never modified or replaced).
 * The budget ledger is the real coordination store.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  AgentRegistry,
  type Agent,
  type AgentCancelCause,
  type AgentFactory,
  type AgentHandle,
  type AgentStatus,
  type CreateAgentOptions,
  type Inbox,
  type InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  CoordinationStore,
  SequentialIdGenerator,
  SystemClock,
} from '@deepseek-ai/dsh-system1-coordination'
import {
  System1Workflows,
  System1Inbox,
  System1RequestId,
  checkReturnContract,
  extractHandoffResult,
  findUnresolvableEvidence,
  handoffToDeepSeek,
  parseHandoffBundle,
  renderHandoffText,
  MAX_HANDOFF_DEPTH,
  type CoordinatorDriver,
  type HandoffBudgetLedger,
  type HandoffBundle,
  type HandoffOptions,
  type HandoffPromptEnvelope,
  type System1CoordinatorAgent,
} from '@deepseek-ai/dsh-system1-workflow'

const idleDriver: CoordinatorDriver = { run: () => Promise.resolve() }

/** Scripted behavior of the fake DeepSeek child. */
interface ChildScript {
  /** Structured result the child commits as its final assistant message. */
  result?: { artifacts: string[]; evidence: string[]; actualUnits: number }
  /** Raw final message text instead of the structured result. */
  rawFinalMessage?: string
  /** Throw when the child is driven. */
  throwOnDrive?: boolean
  /** Reject when the driven child is awaited for idleness. */
  throwOnIdle?: boolean
  /** Abort this controller when the child is driven. */
  abortOnDrive?: AbortController
  /** Throw when the child handle is disposed. */
  failOnDispose?: boolean
  /** Milliseconds the driven child stays busy before going idle. */
  driveDelayMs?: number
  /**
   * Host-observed provider usage the fake records on its final assistant
   * message — the telemetry the real provider adapter would log. When
   * absent, the child's run is unmetered (settlement falls back to the
   * conservative full-reservation charge).
   */
  usage?: { inputTokens: number; outputTokens: number }
}

class FakeChildAgent implements Agent {
  readonly id: SessionId
  readonly options = {}
  readonly session: Session
  readonly inbox: Inbox = new System1Inbox()
  readonly status: AgentStatus = 'idle'
  readonly ctx: Context
  cancelCount = 0
  private readonly script: ChildScript

  constructor(sessionId: SessionId, agentCtx: Context, script: ChildScript) {
    this.id = sessionId
    this.session = Session.create(sessionId)
    this.ctx = agentCtx
    this.script = script
  }

  cancel(_cause: AgentCancelCause): void {
    this.cancelCount += 1
  }

  whenIdle(): Promise<void> {
    const delayMs = this.script.driveDelayMs ?? 0
    if (delayMs > 0) {
      return new Promise((resolve, reject) =>
        setTimeout(
          () =>
            this.script.throwOnIdle === true
              ? reject(new Error('scripted child idle failure'))
              : resolve(),
          delayMs,
        ),
      )
    }
    if (this.script.throwOnIdle === true) {
      return Promise.reject(new Error('scripted child idle failure'))
    }
    return Promise.resolve()
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(new AbortController().signal)
  }

  send(message: UserMessage, target: InboxTarget, _wakeup: boolean): void {
    this.inbox.append(target, message)
  }

  followup(message: UserMessage): void {
    // The real loop logs claimed input in the child's session; the fake
    // does the same so the handoff input is durable on the child side.
    this.session.append('user/message', message, { surfaceOp: 'append' })
    this.inbox.append('next-turn', message)
    this.script.abortOnDrive?.abort()
    if (this.script.throwOnDrive === true) {
      throw new Error('scripted child drive failure')
    }
    const text =
      this.script.rawFinalMessage ??
      (this.script.result === undefined
        ? undefined
        : JSON.stringify({ schemaVersion: 1, ...this.script.result }))
    if (text !== undefined) {
      const assistant = createAssistantMessage({
        content: text,
        source: { provider: 'mock', model: 'mock' },
      })
      this.session.append(
        'assistant/message',
        {
          turn: 0,
          step: 0,
          message: assistant,
          stream: [],
          // Host-observed telemetry, like the real provider adapter logs.
          ...(this.script.usage !== undefined ? { usage: this.script.usage } : {}),
        },
        { surfaceOp: 'append' },
      )
    }
  }

  steer(message: UserMessage): void {
    this.inbox.append('next-step', message)
  }

  inject(message: UserMessage): void {
    this.inbox.append('next-turn', message)
  }
}

interface FactoryCall {
  options: CreateAgentOptions
  agent: FakeChildAgent
}

interface FactoryState {
  calls: FactoryCall[]
  script: ChildScript
  disposed: number
}

/** Test-only factory: shapes the child's scope and runs setup, like the real one. */
function fakeFactory(state: FactoryState): AgentFactory {
  return {
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      const scope = createScope(ownerCtx, {})
      const agent = new FakeChildAgent(options.sessionId, scope.ctx, state.script)
      await options.setup?.(scope.ctx, agent)
      state.calls.push({ options, agent })
      return {
        agent,
        dispose: async () => {
          state.disposed += 1
          if (state.script.failOnDispose === true) {
            throw new Error('scripted dispose failure')
          }
          await scope.dispose()
        },
      }
    },
    resume(): Promise<AgentHandle> {
      throw new Error('resume is not implemented in the handoff test factory')
    },
  }
}

function validBundle(overrides: Partial<HandoffBundle> = {}): HandoffBundle {
  return {
    schemaVersion: 1,
    taskId: 'task-1',
    objective: 'Summarize the quarterly report',
    constraints: ['read-only'],
    acceptedFacts: [{ fact: 'Q3 revenue was $10M', provenance: 'report.pdf' }],
    resourceVersions: { 'report.pdf': 'v3' },
    completedEffects: [],
    unknownEffects: [],
    failedChoices: [],
    remainingBudget: { poolName: 'pool-main', units: 100 },
    verifierRequirements: [],
    returnContract: { requiredArtifacts: [], requiredEvidence: [] },
    ...overrides,
  }
}

interface Fixture {
  ctx: Context
  coordinator: System1CoordinatorAgent
  store: CoordinationStore
  ledger: HandoffBudgetLedger
  ledgerCalls: { reserve: number; settle: number; release: number }
  /** Reconciliation holds requested through the ledger. */
  readonly holdCalls: number
  /** Reservation ids in reserve order. */
  readonly reservationIds: readonly string[]
  factoryState: FactoryState
  promptSections: PromptSection[]
  dispose: () => Promise<void>
}

async function setup(script: ChildScript = {}, withFactory = true): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(System1Workflows, { mode: 'shadow' })

  const store = new CoordinationStore({
    clock: new SystemClock(),
    ids: new SequentialIdGenerator(),
  })
  store.createBudgetPool('tenant-1', 'pool-main', 1000)
  const ledgerCalls = { reserve: 0, settle: 0, release: 0 }
  let holdCalls = 0
  const reservationIds: string[] = []
  const ledger: HandoffBudgetLedger = {
    reserve: (tenantId, poolName, taskId, units) => {
      ledgerCalls.reserve += 1
      const reservation = store.reserve(tenantId, poolName, taskId, units)
      reservationIds.push(reservation.reservationId)
      return reservation
    },
    settle: (reservationId, actualUnits) => {
      ledgerCalls.settle += 1
      store.settle(reservationId, actualUnits)
    },
    release: (reservationId, cancelled) => {
      ledgerCalls.release += 1
      store.release(reservationId, cancelled)
    },
    holdForReconciliation: (reservationId, claimedUnits, reason) => {
      holdCalls += 1
      store.holdForReconciliation(reservationId, claimedUnits, reason)
    },
  }

  const promptSections: PromptSection[] = []
  // Spy on section registration to observe the handoff seeding; the spy is
  // removed when the fixture is disposed so tests stay isolated.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) {
    throw new Error('systemPrompt service missing in handoff test boot')
  }
  const originalSection = systemPrompt.section.bind(systemPrompt)
  systemPrompt.section = (section: PromptSection) => {
    promptSections.push(section)
    return originalSection(section)
  }
  const restorePromptSpy = (): void => {
    systemPrompt.section = originalSection
  }

  const factoryState: FactoryState = { calls: [], script, disposed: 0 }
  if (withFactory) {
    ctx.agents.setFactory(fakeFactory(factoryState))
  }

  const session = Session.create(SessionId('s-handoff'))
  const handle = await ctx.system1Workflows.create(session, idleDriver)
  return {
    ctx,
    coordinator: handle.coordinator,
    store,
    ledger,
    ledgerCalls,
    get holdCalls() {
      return holdCalls
    },
    reservationIds,
    factoryState,
    promptSections,
    dispose: async () => {
      restorePromptSpy()
      await handle.dispose()
      await ctx.fiber.dispose()
    },
  }
}

function handoffOptions(
  ledger: HandoffBudgetLedger,
  overrides: Partial<HandoffOptions> = {},
): HandoffOptions {
  return {
    tenantId: 'tenant-1',
    ledger,
    newSessionId: () => SessionId('s-child-1'),
    requestId: System1RequestId('req-handoff-1'),
    ...overrides,
  }
}

describe('handoff bundle schema', () => {
  it('validates a well-formed bundle', () => {
    expect(parseHandoffBundle(validBundle())).toEqual(validBundle())
  })

  it('rejects a bundle with the wrong schema version', () => {
    expect(() => parseHandoffBundle({ ...validBundle(), schemaVersion: 2 })).toThrow()
  })

  it('rejects a bundle missing required fields', () => {
    const { taskId, ...rest } = validBundle()
    expect(taskId).toBe('task-1')
    expect(() => parseHandoffBundle(rest)).toThrow()
  })

  it('rejects a bundle whose budget is not an object', () => {
    expect(() =>
      parseHandoffBundle({ ...validBundle(), remainingBudget: 'lots' }),
    ).toThrow()
  })
})

describe('return contract checking', () => {
  it('lists missing artifacts and evidence', () => {
    const missing = checkReturnContract(
      { artifacts: ['a:1'], evidence: ['e:1'], actualUnits: 5 },
      { requiredArtifacts: ['a:1', 'a:2'], requiredEvidence: ['e:2'] },
    )
    expect(missing).toEqual(['artifact:a:2', 'evidence:e:2'])
  })

  it('is empty when the contract is satisfied', () => {
    expect(
      checkReturnContract(
        { artifacts: ['a:1'], evidence: [], actualUnits: 0 },
        { requiredArtifacts: ['a:1'], requiredEvidence: [] },
      ),
    ).toEqual([])
  })
})

describe('child result extraction', () => {
  it('reads the last committed assistant message', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:late'], evidence: [], actualUnits: 9 },
    })
    try {
      const child = new FakeChildAgent(SessionId('s-extract'), fixture.ctx, {
        result: { artifacts: ['a:early'], evidence: [], actualUnits: 1 },
      })
      const first = createAssistantMessage({
        content: JSON.stringify({ schemaVersion: 1, artifacts: ['a:early'], evidence: [], actualUnits: 1 }),
        source: { provider: 'mock', model: 'mock' },
      })
      child.session.append(
        'assistant/message',
        { turn: 0, step: 0, message: first, stream: [] },
        { surfaceOp: 'append' },
      )
      const late = createAssistantMessage({
        content: JSON.stringify({ schemaVersion: 1, artifacts: ['a:late'], evidence: [], actualUnits: 9 }),
        source: { provider: 'mock', model: 'mock' },
      })
      child.session.append(
        'assistant/message',
        { turn: 0, step: 1, message: late, stream: [] },
        { surfaceOp: 'append' },
      )
      expect(extractHandoffResult(child.session)).toEqual({
        artifacts: ['a:late'],
        evidence: [],
        actualUnits: 9,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('throws when the child produced no assistant message', async () => {
    const fixture = await setup()
    try {
      const child = new FakeChildAgent(SessionId('s-extract-empty'), fixture.ctx, {})
      expect(() => extractHandoffResult(child.session)).toThrow(/no assistant message/)
    } finally {
      await fixture.dispose()
    }
  })

  it('joins text blocks when the final message uses array content', async () => {
    const fixture = await setup()
    try {
      const child = new FakeChildAgent(SessionId('s-extract-blocks'), fixture.ctx, {})
      const message = createAssistantMessage({
        content: [
          { type: 'text', text: '{"schemaVersion":1,"artifacts":["a:block"],' },
          { type: 'text', text: '"evidence":[],"actualUnits":5}' },
          // Non-text blocks are ignored when joining.
          { type: 'image', image: 'not-text' },
        ],
        source: { provider: 'mock', model: 'mock' },
      })
      child.session.append(
        'assistant/message',
        { turn: 0, step: 0, message, stream: [] },
        { surfaceOp: 'append' },
      )
      expect(extractHandoffResult(child.session)).toEqual({
        artifacts: ['a:block'],
        evidence: [],
        actualUnits: 5,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('rejects a final message whose content is not text', async () => {
    const fixture = await setup()
    try {
      const child = new FakeChildAgent(SessionId('s-extract-corrupt'), fixture.ctx, {})
      const message = createAssistantMessage({
        content: 'placeholder',
        source: { provider: 'mock', model: 'mock' },
      })
      // A corrupt session record: content that is neither a string nor an
      // array of blocks yields no text, so the result cannot parse.
      const corrupt = { ...message, content: 42 }
      child.session.append(
        'assistant/message',
        { turn: 0, step: 0, message: corrupt, stream: [] },
        { surfaceOp: 'append' },
      )
      expect(() => extractHandoffResult(child.session)).toThrow()
    } finally {
      await fixture.dispose()
    }
  })
})

describe('handoffToDeepSeek', () => {
  it('creates a real child with lineage metadata and settles measured usage', async () => {
    // The child reports 37 units but host-observed telemetry measures
    // 30 + 20 = 50: settlement must follow the telemetry, never the report.
    const fixture = await setup({
      result: { artifacts: ['artifact:report'], evidence: ['evidence:q3'], actualUnits: 37 },
      usage: { inputTokens: 30, outputTokens: 20 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle({
          returnContract: {
            requiredArtifacts: ['artifact:report'],
            requiredEvidence: ['evidence:q3'],
          },
        }),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: ['artifact:report'],
        evidence: ['evidence:q3'],
        actualUnits: 50,
      })

      // Child creation used the coordinator's registry with explicit lineage.
      expect(fixture.factoryState.calls).toHaveLength(1)
      const call = fixture.factoryState.calls[0] as FactoryCall
      expect(call.options.parentAgent).toBe(fixture.coordinator)
      expect(call.options.meta?.delegationDepth).toBe(1)
      expect(call.options.meta?.parentSession).toBe(fixture.coordinator.session.id)
      expect(call.options.meta?.origin).toBe('subagent')
      expect(call.options.sessionId).toBe(SessionId('s-child-1'))

      // The bundle reached the child's initial context: prompt section plus
      // the durable inbox message.
      expect(fixture.promptSections.map((s) => s.name)).toContain('system1/handoff')
      const handoffSection = fixture.promptSections.find((s) => s.name === 'system1/handoff') as PromptSection
      expect(typeof handoffSection.text === 'string' ? handoffSection.text : '').toContain(
        'Summarize the quarterly report',
      )
      expect(call.agent.inbox.nextTurn).toHaveLength(1)
      const childMessages = call.agent.session
        .snapshotEvents()
        .filter((event) => event.type === 'user/message')
      expect(childMessages).toHaveLength(1)

      // Budget: reserved once, settled against host-observed usage (50, not
      // the child's reported 37), never released.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 50,
      })

      // The transfer is durable on the parent side.
      const handoffEvents = fixture.coordinator.session
        .snapshotEvents()
        .filter((event) => event.type === 'system1/handoff')
      expect(handoffEvents).toHaveLength(1)
      expect(handoffEvents[0].data.requestId).toBe('req-handoff-1')

      // The owned child handle is always disposed.
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('settles zero measured usage as a completed run', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 0 },
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      // Zero is valid measured usage: the run completes and settles 0.
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: ['a:1'],
        evidence: [],
        actualUnits: 0,
      })
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 0,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('refuses a non-positive budget before touching the registry', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 0 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle({ remainingBudget: { poolName: 'pool-main', units: 0 } }),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('BUDGET_EXHAUSTED')
      }
      expect(fixture.factoryState.calls).toHaveLength(0)
      expect(fixture.ledgerCalls.reserve).toBe(0)
    } finally {
      await fixture.dispose()
    }
  })

  it('refuses a handoff at the maximum depth without reserving budget', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 0 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { parentDepth: MAX_HANDOFF_DEPTH }),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('DELEGATION_DEPTH_EXCEEDED')
      }
      expect(fixture.factoryState.calls).toHaveLength(0)
      expect(fixture.ledgerCalls.reserve).toBe(0)
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 0,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('fails closed on an invalid bundle without touching the registry or ledger', async () => {
    const fixture = await setup()
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        { ...validBundle(), schemaVersion: 2 } as HandoffBundle,
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('VERIFICATION_FAILED')
      }
      expect(fixture.factoryState.calls).toHaveLength(0)
      expect(fixture.ledgerCalls.reserve).toBe(0)
    } finally {
      await fixture.dispose()
    }
  })

  it('fails closed when no agent factory is registered, releasing the hold', async () => {
    const fixture = await setup({}, false)
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('EXECUTION_FAILED')
        expect(outcome.reason).toMatch(/no agent factory/)
      }
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 1 })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 0,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('fails closed when the budget pool cannot cover the reservation', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 0 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle({ remainingBudget: { poolName: 'pool-main', units: 10_000 } }),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('BUDGET_EXHAUSTED')
      }
      expect(fixture.factoryState.calls).toHaveLength(0)
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 0 })
    } finally {
      await fixture.dispose()
    }
  })

  it('propagates parent cancellation to the child and releases the hold', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 10 },
    })
    try {
      const controller = new AbortController()
      controller.abort()
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        controller.signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome).toEqual({
        kind: 'failed',
        code: 'TASK_CANCELLED',
        reason: expect.any(String),
      })
      // The child was created, then cancelled via agent.cancel().
      expect(fixture.factoryState.calls).toHaveLength(1)
      const call = fixture.factoryState.calls[0] as FactoryCall
      expect(call.agent.cancelCount).toBe(1)
      // The hold is released as cancelled; nothing is settled or consumed.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 1 })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 0,
      })
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('propagates cancellation raised while the child is running and retains the hold', async () => {
    const controller = new AbortController()
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 10 },
      abortOnDrive: controller,
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        controller.signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('TASK_CANCELLED')
      }
      const call = fixture.factoryState.calls[0] as FactoryCall
      expect(call.agent.cancelCount).toBe(1)
      // The child ran, so spend is uncertain: the hold is retained for
      // reconciliation, never released free.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 0 })
      expect(fixture.holdCalls).toBe(1)
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 100,
        consumed: 0,
      })
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('retains a reconciliation hold when the child drive fails', async () => {
    const fixture = await setup({ throwOnDrive: true })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('EXECUTION_FAILED')
        expect(outcome.reason).toMatch(/scripted child drive failure/)
        expect(outcome.reason).toMatch(/held for reconciliation/)
      }
      // The drive started, so spend is uncertain: hold, never release free.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 0 })
      expect(fixture.holdCalls).toBe(1)
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 100,
        consumed: 0,
      })
      const reservation = fixture.store.getReservation(fixture.reservationIds[0] as string)
      expect(reservation.status).toBe('held')
      expect(reservation.holdReason).toMatch(/scripted child drive failure/)
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('releases the hold when the handoff log append fails', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 1 },
    })
    try {
      const session = fixture.coordinator.session
      const originalAppend = session.append.bind(session)
      session.append = ((type: string, ...args: [unknown]) => {
        if (type === 'system1/handoff') throw new Error('scripted log failure')
        return (originalAppend as (type: string, ...args: [unknown]) => unknown)(type, ...args)
      }) as typeof session.append
      try {
        const outcome = await handoffToDeepSeek(
          fixture.coordinator,
          validBundle(),
          new AbortController().signal,
          handoffOptions(fixture.ledger),
        )
        expect(outcome.kind).toBe('failed')
        if (outcome.kind === 'failed') {
          expect(outcome.code).toBe('EXECUTION_FAILED')
          expect(outcome.reason).toMatch(/scripted log failure/)
        }
        // The reservation was made, then released: no child was created.
        expect(fixture.factoryState.calls).toHaveLength(0)
        expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 1 })
      } finally {
        session.append = originalAppend
      }
    } finally {
      await fixture.dispose()
    }
  })

  it('retains a reconciliation hold when budget settlement fails', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 7 },
    })
    try {
      const ledger = fixture.ledger
      const originalSettle = ledger.settle
      ledger.settle = (...args: Parameters<HandoffBudgetLedger['settle']>) => {
        // Count the attempt, then fail: the child ran, so the hold must be
        // retained for reconciliation instead of settling or releasing.
        fixture.ledgerCalls.settle += 1
        throw new Error('scripted settle failure')
      }
      try {
        const outcome = await handoffToDeepSeek(
          fixture.coordinator,
          validBundle(),
          new AbortController().signal,
          handoffOptions(fixture.ledger),
        )
        expect(outcome.kind).toBe('failed')
        if (outcome.kind === 'failed') {
          expect(outcome.code).toBe('EXECUTION_FAILED')
          expect(outcome.reason).toMatch(/scripted settle failure/)
          expect(outcome.reason).toMatch(/held for reconciliation/)
        }
        // Settle threw after the child ran: hold, never release free.
        expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
        expect(fixture.holdCalls).toBe(1)
        expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
          capacity: 1000,
          reserved: 100,
          consumed: 0,
        })
        expect(fixture.factoryState.disposed).toBe(1)
      } finally {
        ledger.settle = originalSettle
      }
    } finally {
      await fixture.dispose()
    }
  })

  it('maps a drive failure under abort to TASK_CANCELLED and retains the hold', async () => {
    const controller = new AbortController()
    const fixture = await setup({ throwOnDrive: true, abortOnDrive: controller })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        controller.signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('TASK_CANCELLED')
      }
      // The abort arrived mid-drive: the hold is retained, not released.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 0 })
      expect(fixture.holdCalls).toBe(1)
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('reports when the budget hold release itself fails', async () => {
    // No factory: child creation fails before the drive, so the hold
    // releases — and the release itself is scripted to fail.
    const fixture = await setup({}, false)
    try {
      const ledger = fixture.ledger
      const originalRelease = ledger.release
      ledger.release = () => {
        fixture.ledgerCalls.release += 1
        throw new Error('scripted release failure')
      }
      try {
        const outcome = await handoffToDeepSeek(
          fixture.coordinator,
          validBundle(),
          new AbortController().signal,
          handoffOptions(fixture.ledger),
        )
        expect(outcome.kind).toBe('failed')
        if (outcome.kind === 'failed') {
          expect(outcome.code).toBe('EXECUTION_FAILED')
          expect(outcome.reason).toMatch(/scripted release failure/)
        }
        expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 1 })
      } finally {
        ledger.release = originalRelease
      }
    } finally {
      await fixture.dispose()
    }
  })

  it('describes a non-Error release failure', async () => {
    const fixture = await setup({}, false)
    try {
      const ledger = fixture.ledger
      const originalRelease = ledger.release
      // A ledger that throws a non-Error still gets its value into the reason.
      ledger.release = () => {
        fixture.ledgerCalls.release += 1
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'a string, not an Error'
      }
      try {
        const outcome = await handoffToDeepSeek(
          fixture.coordinator,
          validBundle(),
          new AbortController().signal,
          handoffOptions(fixture.ledger),
        )
        expect(outcome.kind).toBe('failed')
        if (outcome.kind === 'failed') {
          expect(outcome.reason).toMatch(/a string, not an Error/)
        }
      } finally {
        ledger.release = originalRelease
      }
    } finally {
      await fixture.dispose()
    }
  })

  it('keeps the outcome when child disposal fails', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 3 },
      usage: { inputTokens: 2, outputTokens: 1 },
      failOnDispose: true,
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      // Disposal is best-effort: the completed outcome stands.
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: [],
        evidence: [],
        actualUnits: 3,
      })
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('mints the request id and session id when the caller omits them', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 2 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        { tenantId: 'tenant-1', ledger: fixture.ledger },
      )
      expect(outcome.kind).toBe('completed')
      // The child got a minted session id, not the fixture default.
      expect(fixture.factoryState.calls).toHaveLength(1)
      const call = fixture.factoryState.calls[0] as FactoryCall
      expect(String(call.options.sessionId)).toContain('sys1-handoff-')
      // The handoff event was still logged with a derived request id.
      const handoffEvents = fixture.coordinator.session
        .snapshotEvents()
        .filter((event) => event.type === 'system1/handoff')
      expect(handoffEvents).toHaveLength(1)
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
    } finally {
      await fixture.dispose()
    }
  })

  it('conservatively charges the full reservation on a non-JSON final message', async () => {
    const fixture = await setup({ rawFinalMessage: 'not json at all' })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('VERIFICATION_FAILED')
        expect(outcome.reason).toMatch(/conservatively/)
      }
      // The child ran but produced no usable result: the full reservation
      // settles instead of releasing free.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 100,
      })
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('conservatively charges the full reservation when the child produced no result', async () => {
    const fixture = await setup({})
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('VERIFICATION_FAILED')
        expect(outcome.reason).toMatch(/no valid result/)
      }
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 100,
      })
    } finally {
      await fixture.dispose()
    }
  })

describe('untrusted child usage reports', () => {
  it('retains a hold when the child reports negative usage', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: -50 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('VERIFICATION_FAILED')
        expect(outcome.reason).toMatch(/invalid usage/)
      }
      // The fraudulent report settles nothing and releases nothing.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 0 })
      expect(fixture.holdCalls).toBe(1)
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 100,
        consumed: 0,
      })
      const reservation = fixture.store.getReservation(fixture.reservationIds[0] as string)
      expect(reservation.status).toBe('held')
    } finally {
      await fixture.dispose()
    }
  })

  it('retains a hold when the child reports fractional usage', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 2.5 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('VERIFICATION_FAILED')
      }
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 0 })
      expect(fixture.holdCalls).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('retains a hold when the child reports usage above the reservation', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 10_000 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('VERIFICATION_FAILED')
        expect(outcome.reason).toMatch(/exceeds/)
      }
      // An over-reservation report is never absorbed silently.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 0 })
      expect(fixture.holdCalls).toBe(1)
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main').consumed).toBe(0)
    } finally {
      await fixture.dispose()
    }
  })

  it('keeps the reservation active when the ledger hold itself throws', async () => {
    const fixture = await setup({ throwOnDrive: true })
    try {
      const ledger = fixture.ledger
      const originalHold = ledger.holdForReconciliation
      ledger.holdForReconciliation = () => {
        throw new Error('scripted hold failure')
      }
      try {
        const outcome = await handoffToDeepSeek(
          fixture.coordinator,
          validBundle(),
          new AbortController().signal,
          handoffOptions(fixture.ledger),
        )
        expect(outcome.kind).toBe('failed')
        if (outcome.kind === 'failed') {
          expect(outcome.code).toBe('EXECUTION_FAILED')
        }
        // The explicit hold failed, but the reservation stays active as an
        // implicit hold: still encumbered, never released free.
        expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
          capacity: 1000,
          reserved: 100,
          consumed: 0,
        })
        const reservation = fixture.store.getReservation(fixture.reservationIds[0] as string)
        expect(reservation.status).toBe('active')
      } finally {
        ledger.holdForReconciliation = originalHold
      }
    } finally {
      await fixture.dispose()
    }
  })

  it('retains a hold when conservative settlement also fails', async () => {
    const fixture = await setup({ rawFinalMessage: 'not json at all' })
    try {
      const ledger = fixture.ledger
      const originalSettle = ledger.settle
      ledger.settle = (...args: Parameters<HandoffBudgetLedger['settle']>) => {
        fixture.ledgerCalls.settle += 1
        throw new Error('scripted conservative settle failure')
      }
      try {
        const outcome = await handoffToDeepSeek(
          fixture.coordinator,
          validBundle(),
          new AbortController().signal,
          handoffOptions(fixture.ledger),
        )
        expect(outcome.kind).toBe('failed')
        if (outcome.kind === 'failed') {
          expect(outcome.code).toBe('VERIFICATION_FAILED')
          expect(outcome.reason).toMatch(/conservative settlement also failed/)
          expect(outcome.reason).toMatch(/held for reconciliation/)
        }
        // The child ran: the failed conservative charge retains the hold,
        // never releases started work free.
        expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
        expect(fixture.holdCalls).toBe(1)
        expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
          capacity: 1000,
          reserved: 100,
          consumed: 0,
        })
        const reservation = fixture.store.getReservation(fixture.reservationIds[0] as string)
        expect(reservation.status).toBe('held')
      } finally {
        ledger.settle = originalSettle
      }
    } finally {
      await fixture.dispose()
    }
  })
})

describe('handoff child limits', () => {
  it('rejects an invalid maxTokens before reserving', async () => {
    for (const maxTokens of [0, -3, 1.5]) {
      const fixture = await setup({
        result: { artifacts: [], evidence: [], actualUnits: 1 },
      })
      try {
        const outcome = await handoffToDeepSeek(
          fixture.coordinator,
          validBundle(),
          new AbortController().signal,
          handoffOptions(fixture.ledger, { childLimits: { maxTokens } }),
        )
        expect(outcome.kind).toBe('failed')
        if (outcome.kind === 'failed') {
          expect(outcome.code).toBe('INVALID_CONFIG')
          expect(outcome.reason).toMatch(/maxTokens/)
        }
        expect(fixture.factoryState.calls).toHaveLength(0)
        expect(fixture.ledgerCalls.reserve).toBe(0)
      } finally {
        await fixture.dispose()
      }
    }
  })

  it('rejects a non-finite deadline before reserving', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 1 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { childLimits: { deadlineAt: Number.NaN } }),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('INVALID_CONFIG')
        expect(outcome.reason).toMatch(/deadlineAt/)
      }
      expect(fixture.factoryState.calls).toHaveLength(0)
      expect(fixture.ledgerCalls.reserve).toBe(0)
    } finally {
      await fixture.dispose()
    }
  })

  it('passes the token cap and deadline to the child', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 5 },
      usage: { inputTokens: 3, outputTokens: 2 },
    })
    try {
      const deadlineAt = Date.now() + 60_000
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { childLimits: { maxTokens: 500, deadlineAt } }),
      )
      expect(outcome.kind).toBe('completed')
      expect(fixture.factoryState.calls).toHaveLength(1)
      const call = fixture.factoryState.calls[0] as FactoryCall
      // The token cap is enforced by the provider adapter through the
      // child's agent options, not by the prompt.
      expect(call.options.agentOptions).toMatchObject({ maxTokens: 500 })
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
    } finally {
      await fixture.dispose()
    }
  })

  it('treats empty limits as no limits', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 5 },
      usage: { inputTokens: 3, outputTokens: 2 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { childLimits: {} }),
      )
      expect(outcome.kind).toBe('completed')
      const call = fixture.factoryState.calls[0] as FactoryCall
      expect(call.options.agentOptions).toBeUndefined()
    } finally {
      await fixture.dispose()
    }
  })

  it('cancels the child when the deadline already passed, releasing the hold', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 10 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { childLimits: { deadlineAt: Date.now() - 1000 } }),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('TASK_CANCELLED')
        expect(outcome.reason).toMatch(/deadline passed/)
      }
      // The child never started: no spend exists, so the hold releases.
      const call = fixture.factoryState.calls[0] as FactoryCall
      expect(call.agent.cancelCount).toBe(1)
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 1 })
      expect(fixture.holdCalls).toBe(0)
    } finally {
      await fixture.dispose()
    }
  })

  it('cancels the child when the deadline fires mid-drive and retains the hold', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 10 },
      driveDelayMs: 150,
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { childLimits: { deadlineAt: Date.now() + 30 } }),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('TASK_CANCELLED')
        expect(outcome.reason).toMatch(/deadline exceeded/)
      }
      const call = fixture.factoryState.calls[0] as FactoryCall
      expect(call.agent.cancelCount).toBe(1)
      // The child ran past its deadline: spend is uncertain, so hold.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 0 })
      expect(fixture.holdCalls).toBe(1)
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 100,
        consumed: 0,
      })
    } finally {
      await fixture.dispose()
    }
  })
})

describe('handoff step limits', () => {
  it('rejects a non-positive step limit before touching the registry', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 0 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { childLimits: { maxSteps: 0 } }),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('INVALID_CONFIG')
        expect(outcome.reason).toContain('maxSteps')
      }
      expect(fixture.factoryState.calls).toHaveLength(0)
      expect(fixture.ledgerCalls).toEqual({ reserve: 0, settle: 0, release: 0 })
    } finally {
      await fixture.dispose()
    }
  })

  it('rejects a fractional step limit before touching the registry', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 0 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { childLimits: { maxSteps: 2.5 } }),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('INVALID_CONFIG')
        expect(outcome.reason).toContain('maxSteps')
      }
      expect(fixture.factoryState.calls).toHaveLength(0)
      expect(fixture.ledgerCalls).toEqual({ reserve: 0, settle: 0, release: 0 })
    } finally {
      await fixture.dispose()
    }
  })

  /** Wait for the handoff to create its child. */
  async function awaitChild(fixture: Fixture): Promise<FactoryCall> {
    for (let i = 0; i < 200; i++) {
      const call = fixture.factoryState.calls[0] as FactoryCall | undefined
      if (call !== undefined) return call
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('timed out waiting for the handoff child')
  }

  /** Report one model step through the child's scope, like the loop would. */
  function emitStep(call: FactoryCall, step: number): void {
    call.agent.ctx.emit('session/event', call.agent.session, {
      type: 'step/start',
      seq: SessionSeq(step),
      time: Date.now(),
      data: { turn: 1, step },
    })
  }

  it('cancels the child and retains the hold when steps exceed the bound', async () => {
    const fixture = await setup({ driveDelayMs: 120 })
    try {
      const outcomePromise = handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { childLimits: { maxSteps: 2 } }),
      )
      const call = await awaitChild(fixture)
      // Two steps are allowed; the third trips the watcher.
      emitStep(call, 1)
      emitStep(call, 2)
      expect(call.agent.cancelCount).toBe(0)
      emitStep(call, 3)
      expect(call.agent.cancelCount).toBe(1)
      // A further step does not re-trip the watcher, and non-step events
      // are ignored.
      emitStep(call, 4)
      call.agent.ctx.emit('session/event', call.agent.session, {
        type: 'turn/end',
        seq: SessionSeq(5),
        time: Date.now(),
        data: { turn: 1, reason: { kind: 'completed' } },
      })
      expect(call.agent.cancelCount).toBe(1)

      const outcome = await outcomePromise
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('TASK_CANCELLED')
        expect(outcome.reason).toMatch(/step limit/)
      }
      // The child was stopped mid-run: spend is uncertain, so hold.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 0 })
      expect(fixture.holdCalls).toBe(1)
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 100,
        consumed: 0,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('attributes a drive failure to the step limit when the bound tripped first', async () => {
    const fixture = await setup({ driveDelayMs: 120, throwOnIdle: true })
    try {
      const outcomePromise = handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { childLimits: { maxSteps: 2 } }),
      )
      const call = await awaitChild(fixture)
      emitStep(call, 1)
      emitStep(call, 2)
      emitStep(call, 3)
      // The watcher already cancelled the child; the idle failure below
      // must still report the step limit and retain the hold.
      expect(call.agent.cancelCount).toBe(1)

      const outcome = await outcomePromise
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('TASK_CANCELLED')
        expect(outcome.reason).toMatch(/step limit/)
      }
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 0 })
      expect(fixture.holdCalls).toBe(1)
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 100,
        consumed: 0,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('lets the child finish when steps stay within the bound', async () => {    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 6 },
      usage: { inputTokens: 4, outputTokens: 2 },
      driveDelayMs: 60,
    })
    try {
      const outcomePromise = handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { childLimits: { maxSteps: 3 } }),
      )
      const call = await awaitChild(fixture)
      emitStep(call, 1)
      emitStep(call, 2)
      const outcome = await outcomePromise
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: ['a:1'],
        evidence: [],
        actualUnits: 6,
      })
      expect(call.agent.cancelCount).toBe(0)
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 6,
      })
    } finally {
      await fixture.dispose()
    }
  })
})

describe('handoff budget edge cases', () => {
  it('settles measured usage but fails the return contract on missing entries', async () => {
    const fixture = await setup({
      result: { artifacts: ['artifact:other'], evidence: [], actualUnits: 22 },
      usage: { inputTokens: 15, outputTokens: 7 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle({
          returnContract: {
            requiredArtifacts: ['artifact:required'],
            requiredEvidence: [],
          },
        }),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('VERIFICATION_FAILED')
        expect(outcome.reason).toContain('artifact:required')
      }
      // The child did the work, so its spend still settles.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 22,
      })
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('conservatively charges the full reservation when the child is unmetered', async () => {
    // The child reports 37 units but recorded no provider telemetry: the
    // report is untrusted and usage is unknown, so success settles the
    // full reservation instead of the reported figure.
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 37 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: ['a:1'],
        evidence: [],
        actualUnits: 100,
      })
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 100,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('retains a hold when measured usage exceeds the reservation', async () => {
    // Host-observed usage (130) overruns the 100-unit reservation: the
    // store's explicit overrun policy rejects the settlement, and the
    // hold is retained for reconciliation instead of releasing free.
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 90 },
      usage: { inputTokens: 90, outputTokens: 40 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('EXECUTION_FAILED')
        expect(outcome.reason).toMatch(/held for reconciliation/)
      }
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.holdCalls).toBe(1)
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 100,
        consumed: 0,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('ignores a throwing usage meter and charges conservatively', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 37 },
      usage: { inputTokens: 30, outputTokens: 20 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, {
          measureChildUsage: () => {
            throw new Error('scripted meter failure')
          },
        }),
      )
      // A throwing meter means usage is unknown: conservative full charge.
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: ['a:1'],
        evidence: [],
        actualUnits: 100,
      })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main').consumed).toBe(100)
    } finally {
      await fixture.dispose()
    }
  })

  it('ignores a negative usage meter result and charges conservatively', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 37 },
      usage: { inputTokens: 30, outputTokens: 20 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { measureChildUsage: () => -12 }),
      )
      // A negative meter result is corrupt telemetry: conservative charge.
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: ['a:1'],
        evidence: [],
        actualUnits: 100,
      })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main').consumed).toBe(100)
    } finally {
      await fixture.dispose()
    }
  })

  it('treats corrupt recorded token counts as unmetered', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 37 },
      usage: { inputTokens: -5, outputTokens: 20 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      // Negative recorded tokens fail closed to the conservative charge.
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: ['a:1'],
        evidence: [],
        actualUnits: 100,
      })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main').consumed).toBe(100)
    } finally {
      await fixture.dispose()
    }
  })

  it('renders the bundle text with the objective and result shape', () => {
    const text = renderHandoffText(validBundle())
    expect(text).toContain('task-1')
    expect(text).toContain('Summarize the quarterly report')
    expect(text).toContain('Q3 revenue was $10M')
    expect(text).toContain('"artifacts"')
    expect(text).toContain('"actualUnits"')
  })

  it('renders every populated bundle section and skips empty ones', () => {
    const text = renderHandoffText(
      validBundle({
        constraints: [],
        acceptedFacts: [],
        completedEffects: ['report drafted'],
        unknownEffects: ['email sent?'],
        failedChoices: [{ choice: 'local model', reason: 'too slow' }],
      }),
    )
    expect(text).not.toContain('Constraints:')
    expect(text).not.toContain('Accepted facts')
    expect(text).toContain('Already completed (do not redo):')
    expect(text).toContain('report drafted')
    expect(text).toContain('Unknown outcome (treat as pending):')
    expect(text).toContain('email sent?')
    expect(text).toContain('Rejected choices (do not retry without new evidence):')
    expect(text).toContain('local model: too slow')
  })
})
})

describe('handoff return obligations (N11)', () => {
  it('renders pinned resource versions, budget envelope, verifier requirements, and the return contract', () => {
    const envelope: HandoffPromptEnvelope = { reservationId: 'res-9', overrunPolicy: 'reject' }
    const text = renderHandoffText(
      validBundle({
        resourceVersions: { 'report.pdf': 'version-47', 'tool-catalog': 'catalog-12' },
        remainingBudget: { poolName: 'pool', units: 37 },
        verifierRequirements: ['verify-freshness'],
        returnContract: { requiredArtifacts: ['artifact:required'], requiredEvidence: ['evidence:required'] },
      }),
      envelope,
    )
    expect(text).toContain('Pinned resource versions')
    expect(text).toContain('report.pdf: version-47')
    expect(text).toContain('tool-catalog: catalog-12')
    expect(text).toContain('Budget envelope')
    expect(text).toContain('Pool: pool')
    expect(text).toContain('Units reserved: 37')
    expect(text).toContain('Reservation: res-9')
    expect(text).toContain('Overrun policy: reject')
    expect(text).toContain('Verifier requirements')
    expect(text).toContain('verify-freshness')
    expect(text).toContain('Return contract')
    expect(text).toContain('artifact:required')
    expect(text).toContain('evidence:required')
    expect(text).toContain('usage report')
  })

  it('omits the reservation and overrun lines when the envelope does not carry them', () => {
    const text = renderHandoffText(validBundle(), {})
    expect(text).toContain('Budget envelope')
    expect(text).not.toContain('Reservation:')
    expect(text).not.toContain('Overrun policy:')
  })

  it('renders the reservation without an overrun policy', () => {
    const text = renderHandoffText(validBundle(), { reservationId: 'res-9' })
    expect(text).toContain('Reservation: res-9')
    expect(text).not.toContain('Overrun policy:')
  })

  it('renders the overrun policy without a reservation id', () => {
    const text = renderHandoffText(validBundle(), { overrunPolicy: 'hold' })
    expect(text).toContain('Overrun policy: hold')
    expect(text).not.toContain('Reservation:')
  })

  it('skips the pinned versions section when no versions are pinned', () => {
    const text = renderHandoffText(validBundle({ resourceVersions: {} }))
    expect(text).not.toContain('Pinned resource versions')
  })

  it('renders artifact-only and evidence-only return contracts', () => {
    const artifactsOnly = renderHandoffText(
      validBundle({ returnContract: { requiredArtifacts: ['a:1'], requiredEvidence: [] } }),
    )
    expect(artifactsOnly).toContain('Required artifacts')
    expect(artifactsOnly).not.toContain('Required evidence')
    const evidenceOnly = renderHandoffText(
      validBundle({ returnContract: { requiredArtifacts: [], requiredEvidence: ['e:1'] } }),
    )
    expect(evidenceOnly).toContain('Required evidence')
    expect(evidenceOnly).not.toContain('Required artifacts')
  })

  it('finds unresolvable evidence references', () => {
    expect(findUnresolvableEvidence([])).toEqual([])
    expect(findUnresolvableEvidence(['e:1', 'e:2'])).toEqual([])
    expect(findUnresolvableEvidence(['e:1', '  '])).toEqual(['  '])
    expect(findUnresolvableEvidence(['e:1', 'e:2'], () => true)).toEqual([])
    expect(findUnresolvableEvidence(['e:1', 'e:fake'], (ref) => ref !== 'e:fake')).toEqual(['e:fake'])
  })

  it('fails closed when the child returns an unresolvable evidence reference', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: ['evidence:invented'], actualUnits: 10 },
      usage: { inputTokens: 5, outputTokens: 5 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle({ returnContract: { requiredArtifacts: [], requiredEvidence: [] } }),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { resolveEvidence: (ref) => ref === 'evidence:real' }),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('VERIFICATION_FAILED')
        expect(outcome.reason).toContain('evidence:invented')
      }
      // The child ran: spend settled from telemetry, never released free.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
    } finally {
      await fixture.dispose()
    }
  })

  it('fails closed on a blank evidence reference even without a resolver', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: ['   '], actualUnits: 10 },
      usage: { inputTokens: 5, outputTokens: 5 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') expect(outcome.code).toBe('VERIFICATION_FAILED')
    } finally {
      await fixture.dispose()
    }
  })

  it('completes when every evidence reference resolves', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: ['evidence:real'], actualUnits: 10 },
      usage: { inputTokens: 5, outputTokens: 5 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger, { resolveEvidence: (ref) => ref === 'evidence:real' }),
      )
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: ['a:1'],
        evidence: ['evidence:real'],
        actualUnits: 10,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('treats corrupt recorded output token counts as unmetered', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 37 },
      usage: { inputTokens: 20, outputTokens: -5 },
    })
    try {
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(fixture.ledger),
      )
      // Negative recorded output tokens fail closed to the conservative charge.
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: ['a:1'],
        evidence: [],
        actualUnits: 100,
      })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main').consumed).toBe(100)
    } finally {
      await fixture.dispose()
    }
  })

  it('seeds the child prompt with the reservation id and the ledger overrun policy', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 10 },
      usage: { inputTokens: 5, outputTokens: 5 },
    })
    try {
      const ledger: HandoffBudgetLedger = {
        ...fixture.ledger,
        overrunPolicyDescription: () => 'reject',
      }
      const outcome = await handoffToDeepSeek(
        fixture.coordinator,
        validBundle(),
        new AbortController().signal,
        handoffOptions(ledger),
      )
      expect(outcome.kind).toBe('completed')
      const section = fixture.promptSections.find((s) => s.name === 'system1/handoff') as PromptSection
      const text = typeof section.text === 'string' ? section.text : ''
      expect(text).toContain(`Reservation: ${fixture.reservationIds[0]}`)
      expect(text).toContain('Overrun policy: reject')
    } finally {
      await fixture.dispose()
    }
  })
})
