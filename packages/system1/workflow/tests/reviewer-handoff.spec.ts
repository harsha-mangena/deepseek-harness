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


describe('independent handoff review probes',()=>{
  it('V19 negative model-reported usage cannot refund previously consumed budget',async()=>{
    const f=await setup({result:{artifacts:[],evidence:[],actualUnits:-50}})
    try {
      const earlier=f.store.reserve('tenant-1','pool-main','earlier',100);f.store.settle(earlier.reservationId,100)
      const outcome=await handoffToDeepSeek(f.coordinator,validBundle(),new AbortController().signal,handoffOptions(f.ledger))
      expect({kind:outcome.kind,consumed:f.store.getPoolUtilization('tenant-1','pool-main').consumed}).toEqual({kind:'failed',consumed:100})
    } finally{await f.dispose();f.store.close()}
  })
  it('V20 a malformed child result must not make already-started work free',async()=>{
    const f=await setup({rawFinalMessage:'not JSON'})
    try {
      await handoffToDeepSeek(f.coordinator,validBundle(),new AbortController().signal,handoffOptions(f.ledger))
      const utilization=f.store.getPoolUtilization('tenant-1','pool-main'); expect(utilization.consumed+utilization.reserved).toBeGreaterThan(0)
    }finally{await f.dispose();f.store.close()}
  })
  it('V21 handoff prompt includes resource versions budget and return requirements',()=>{
    const text=renderHandoffText(validBundle({resourceVersions:{'report.pdf':'version-47'},remainingBudget:{poolName:'pool',units:37},verifierRequirements:['verify-freshness'],returnContract:{requiredArtifacts:['artifact:required'],requiredEvidence:['evidence:required']}}))
    expect(text).toContain('version-47');expect(text).toContain('37');expect(text).toContain('verify-freshness');expect(text).toContain('artifact:required')
  })
})
