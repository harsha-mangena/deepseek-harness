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
import { Session, SessionId } from '@deepseek-ai/dsh-session'
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
  handoffToDeepSeek,
  parseHandoffBundle,
  renderHandoffText,
  MAX_HANDOFF_DEPTH,
  type CoordinatorDriver,
  type HandoffBudgetLedger,
  type HandoffBundle,
  type HandoffOptions,
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
  /** Abort this controller when the child is driven. */
  abortOnDrive?: AbortController
  /** Throw when the child handle is disposed. */
  failOnDispose?: boolean
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
        { turn: 0, step: 0, message: assistant, stream: [] },
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
  const ledger: HandoffBudgetLedger = {
    reserve: (tenantId, poolName, taskId, units) => {
      ledgerCalls.reserve += 1
      return store.reserve(tenantId, poolName, taskId, units)
    },
    settle: (reservationId, actualUnits) => {
      ledgerCalls.settle += 1
      store.settle(reservationId, actualUnits)
    },
    release: (reservationId, cancelled) => {
      ledgerCalls.release += 1
      store.release(reservationId, cancelled)
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
    const fixture = await setup({
      result: { artifacts: ['artifact:report'], evidence: ['evidence:q3'], actualUnits: 37 },
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
        actualUnits: 37,
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

      // Budget: reserved once, settled against measured usage, never released.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-main')).toEqual({
        capacity: 1000,
        reserved: 0,
        consumed: 37,
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

  it('propagates cancellation raised while the child is running', async () => {
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
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 1 })
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('releases the hold when the child drive fails', async () => {
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
      }
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

  it('releases the hold when budget settlement fails', async () => {
    const fixture = await setup({
      result: { artifacts: [], evidence: [], actualUnits: 7 },
    })
    try {
      const ledger = fixture.ledger
      const originalSettle = ledger.settle
      ledger.settle = (...args: Parameters<HandoffBudgetLedger['settle']>) => {
        // Count the attempt, then fail: the hold must release instead of
        // settling.
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
        }
        // Settle threw, so the hold was released instead of settling.
        expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 1 })
        expect(fixture.factoryState.disposed).toBe(1)
      } finally {
        ledger.settle = originalSettle
      }
    } finally {
      await fixture.dispose()
    }
  })

  it('maps a drive failure under abort to TASK_CANCELLED', async () => {
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
      // The abort arrived mid-drive: the hold releases as cancelled.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 1 })
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('reports when the budget hold release itself fails', async () => {
    const fixture = await setup({ throwOnDrive: true })
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
        expect(fixture.factoryState.disposed).toBe(1)
      } finally {
        ledger.release = originalRelease
      }
    } finally {
      await fixture.dispose()
    }
  })

  it('describes a non-Error release failure', async () => {
    const fixture = await setup({ throwOnDrive: true })
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

  it('rejects a non-JSON final message and releases the hold', async () => {
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
      }
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 1 })
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('rejects a child result with no assistant message', async () => {
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
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 1 })
    } finally {
      await fixture.dispose()
    }
  })

  it('settles measured usage but fails the return contract on missing entries', async () => {
    const fixture = await setup({
      result: { artifacts: ['artifact:other'], evidence: [], actualUnits: 22 },
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
