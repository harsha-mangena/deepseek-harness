import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionSeq, type UserMessage } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { AgentRegistry, type Agent, type AgentFactory, type AgentHandle, type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import {
  CoordinationStore,
  SequentialIdGenerator,
  SystemClock,
} from '@deepseek-ai/dsh-system1-coordination'
import { DelegationManager } from '@deepseek-ai/dsh-system1-delegation'
import {
  System1Workflows,
  spawnWorker,
  type CoordinatorDriver,
  type HandoffBudgetLedger,
  type System1CoordinatorAgent,
  type WorkerOptions,
  type WorkerOutcome,
  type WorkerSpec,
} from '@deepseek-ai/dsh-system1-workflow'

/**
 * Workers use the real AgentRegistry pipeline: the factory mints a scoped
 * child the way the standard factory does (through an inject-declaring
 * plugin), so `tools.restrict()` applies a genuine scoped restriction and
 * the test observes it through the tools registry view.
 */

const idleDriver: CoordinatorDriver = { run: () => Promise.resolve() }

/** Scripted behavior of the fake DeepSeek worker child. */
interface ChildScript {
  /** Structured result the child commits as its final assistant message. */
  result?: { artifacts: string[]; evidence: string[]; actualUnits: number }
  /** Throw when the child is driven. */
  throwOnDrive?: boolean
  /** Step/start events to report through the child scope while driven. */
  stepsOnDrive?: number
  /**
   * Host-observed provider usage the fake records on its final assistant
   * message. When absent the worker run is unmetered (settlement falls
   * back to the conservative full-reservation charge).
   */
  usage?: { inputTokens: number; outputTokens: number }
}

class FakeWorkerAgent implements Agent {
  readonly sessionId: SessionId
  readonly session: Session
  private readonly inbox = new Session(SessionId('worker-inbox'))
  private readonly agentCtx: Context
  cancelCount = 0

  constructor(sessionId: SessionId, agentCtx: Context, private readonly script: ChildScript) {
    this.sessionId = sessionId
    this.session = new Session(sessionId)
    this.agentCtx = agentCtx
  }

  get ctx(): Context {
    throw new Error('worker test agent has no context')
  }

  followup(message: UserMessage): void {
    // The real loop logs claimed input in the child's session and drives a
    // turn from it; the fake does the same minus the model call.
    this.session.append('user/message', message, { surfaceOp: 'append' })
    this.inbox.append('next-turn', message)
    if (this.script.throwOnDrive === true) {
      throw new Error('scripted worker drive failure')
    }
    if (this.script.result !== undefined) {
      const assistant = createAssistantMessage({
        content: JSON.stringify({ schemaVersion: 1, ...this.script.result }),
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
    // Report model steps through the child scope, like the loop would: the
    // handoff's step watcher observes these and enforces the step bound.
    const steps = this.script.stepsOnDrive ?? 0
    for (let step = 1; step <= steps; step++) {
      this.agentCtx.emit('session/event', this.session, {
        type: 'step/start',
        seq: SessionSeq(step),
        time: Date.now(),
        data: { turn: 1, step },
      })
    }
  }

  async whenIdle(): Promise<void> {
    // The fake drives synchronously; there is no background turn.
  }

  cancel(): void {
    this.cancelCount += 1
  }
}

interface FactoryCall {
  options: CreateAgentOptions
  agent: FakeWorkerAgent
  /** Tool visibility from the child's scope after setup ran. */
  visibleTools: { read: boolean; write: boolean }
}

interface FactoryState {
  calls: FactoryCall[]
  script: ChildScript
  disposed: number
}

function fakeFactory(mintCtx: Context, state: FactoryState): AgentFactory {
  return {
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      void ownerCtx
      // Mint the child scope under the factory's own context, like the real
      // factory mints under the loop ctx: the ownerCtx handed to a factory
      // is the caller's traced context and does not carry service injects.
      let scope!: Scope
      const scopeKey = {}
      const fiber = await mintCtx.plugin(
        Object.assign(
          (inner: Context) => {
            scope = createScope(inner, scopeKey)
          },
          { inject: ['tools', 'systemPrompt'] },
        ),
      )
      const agent = new FakeWorkerAgent(options.sessionId, scope.ctx, state.script)
      try {
        await options.setup?.(scope.ctx, agent)
      } catch (error) {
        await fiber.dispose()
        throw error
      }
      // Observe the real scoped restriction through the tools registry view:
      // the child sees only the spec's capabilities.
      const tools = scope.ctx.get('tools')
      const visibleTools = {
        read: tools?.get('read', scopeKey) !== undefined,
        write: tools?.get('write', scopeKey) !== undefined,
      }
      state.calls.push({ options, agent, visibleTools })
      return {
        agent,
        dispose: async () => {
          state.disposed += 1
          await scope.dispose()
          await fiber.dispose()
        },
      }
    },
    resume(): Promise<AgentHandle> {
      throw new Error('resume is not implemented in the worker test factory')
    },
  }
}

interface Fixture {
  coordinator: System1CoordinatorAgent
  store: CoordinationStore
  ledger: HandoffBudgetLedger
  ledgerCalls: { reserve: number; settle: number; release: number }
  factoryState: FactoryState
  workerOptions: (
    delegation: DelegationManager,
    childSessionId: string,
    extra?: Partial<WorkerOptions>,
  ) => WorkerOptions
  dispose: () => Promise<void>
}

async function setup(
  script: ChildScript = {},
  ledgerCalls = { reserve: 0, settle: 0, release: 0 },
): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(System1Workflows, { mode: 'shadow' })

  // Two global tools: the worker spec allowlists `read`, so the child must
  // see `read` and must not see `write`.
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('tools service missing in worker test boot')
  for (const name of ['read', 'write'] as const) {
    tools.register(
      defineTool({
        name,
        description: `Worker test tool ${name}.`,
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        execute: () => Promise.resolve(`${name}-ok`),
      }),
    )
  }

  const factoryState: FactoryState = { calls: [], script, disposed: 0 }
  ctx.get('agents')?.setFactory(fakeFactory(ctx, factoryState))

  const store = new CoordinationStore({
    clock: new SystemClock(),
    ids: new SequentialIdGenerator(),
  })
  store.createBudgetPool('tenant-1', 'pool-shared', 100)
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

  const session = Session.create(SessionId('s-worker'))
  const handle = await ctx.system1Workflows.create(session, idleDriver)
  return {
    coordinator: handle.coordinator,
    store,
    ledger,
    ledgerCalls,
    factoryState,
    workerOptions: (delegation, childSessionId, extra) => ({
      tenantId: 'tenant-1',
      poolName: 'pool-shared',
      ledger,
      delegation,
      parentTaskId: 'parent-task-1',
      parentDepth: 0,
      newSessionId: () => SessionId(childSessionId),
      ...extra,
    }),
    dispose: async () => {
      await handle.dispose()
      await ctx.fiber.dispose()
    },
  }
}

function workerSpec(extra: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    taskId: 's-worker-1',
    objective: 'Do the scoped thing.',
    capabilities: ['read'],
    budgetUnits: 10,
    returnContract: { requiredArtifacts: ['a:1'], requiredEvidence: [] },
    ...extra,
  }
}

describe('spawnWorker', () => {
  it('spawns a scoped child with restricted capabilities and settles usage', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: ['e:1'], actualUnits: 6 },
      usage: { inputTokens: 4, outputTokens: 2 },
    })
    try {
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-1' })
      const outcome: WorkerOutcome = await spawnWorker(
        fixture.coordinator,
        workerSpec(),
        new AbortController().signal,
        fixture.workerOptions(delegation, 's-worker-child-1'),
      )
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: ['a:1'],
        evidence: ['e:1'],
        actualUnits: 6,
      })

      // The child carries lineage: a fresh session, a parent pointer, the
      // subagent origin, and the incremented depth.
      expect(fixture.factoryState.calls).toHaveLength(1)
      const call = fixture.factoryState.calls[0]!
      expect(call.options.sessionId).toBe('s-worker-child-1')
      expect(call.options.parentAgent).toBe(fixture.coordinator)
      expect(call.options.meta).toMatchObject({
        origin: 'subagent',
        delegationDepth: 1,
      })

      // The real tools.restrict() ran in the child's setup scope: only the
      // spec's capabilities are visible to the child.
      expect(call.visibleTools).toEqual({ read: true, write: false })

      // The shared hold moved through reserve -> settle, never release.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('propagates cancellation to the worker and releases the shared hold', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 4 },
    })
    try {
      const controller = new AbortController()
      controller.abort()
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-2' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec(),
        controller.signal,
        fixture.workerOptions(delegation, 's-worker-child-2'),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('TASK_CANCELLED')
      }
      // Reserve then release-as-cancelled: settle must not run.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 1 })
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('fails the return contract when the worker omits required artifacts', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:other'], evidence: [], actualUnits: 3 },
      usage: { inputTokens: 2, outputTokens: 1 },
    })
    try {
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-3' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec(),
        new AbortController().signal,
        fixture.workerOptions(delegation, 's-worker-child-3'),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('VERIFICATION_FAILED')
        expect(outcome.reason).toContain('a:1')
      }
      // Settlement still ran against measured usage before the contract
      // check failed; the restriction still applied in the child scope.
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
      expect(fixture.factoryState.calls[0]!.visibleTools).toEqual({ read: true, write: false })
      expect(fixture.factoryState.disposed).toBe(1)
    } finally {
      await fixture.dispose()
    }
  })

  it('fails closed when the spec names an unknown capability', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 2 },
    })
    try {
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-4' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec({ capabilities: ['nope'] }),
        new AbortController().signal,
        fixture.workerOptions(delegation, 's-worker-child-4'),
      )
      // The real restrict() rejects the unknown name during child setup, so
      // the child is never published and the hold is released.
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('EXECUTION_FAILED')
        expect(outcome.reason).toContain('unknown global tool')
      }
      expect(fixture.factoryState.calls).toHaveLength(0)
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 1 })
      expect(fixture.factoryState.disposed).toBe(0)
    } finally {
      await fixture.dispose()
    }
  })

  it('refuses a worker at the delegation depth limit', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 1 },
    })
    try {
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-5' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec(),
        new AbortController().signal,
        fixture.workerOptions(delegation, 's-worker-child-5', { parentDepth: 5 }),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('DELEGATION_DEPTH_EXCEEDED')
      }
      // Refused before any reservation: no ledger movement, no child.
      expect(fixture.ledgerCalls).toEqual({ reserve: 0, settle: 0, release: 0 })
      expect(fixture.factoryState.calls).toHaveLength(0)
    } finally {
      await fixture.dispose()
    }
  })

  it('completes with default session minting, constraints, and decision linkage', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 2 },
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    try {
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-6' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec({ constraints: ['read-only'] }),
        new AbortController().signal,
        {
          tenantId: 'tenant-1',
          poolName: 'pool-shared',
          ledger: fixture.ledger,
          delegation,
          parentTaskId: 'parent-task-1',
          parentDecisionId: 'decision-6',
        },
      )
      expect(outcome).toEqual({
        kind: 'completed',
        artifacts: ['a:1'],
        evidence: [],
        actualUnits: 2,
      })
      // Without newSessionId the worker mints its own session id.
      expect(fixture.factoryState.calls).toHaveLength(1)
      expect(String(fixture.factoryState.calls[0]!.options.sessionId)).toContain('sys1-handoff-')
      expect(fixture.factoryState.calls[0]!.visibleTools).toEqual({ read: true, write: false })
    } finally {
      await fixture.dispose()
    }
  })

  it('maps an unexpected delegation failure to EXECUTION_FAILED', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 1 },
    })
    try {
      class ExplodingDelegation extends DelegationManager {
        override delegate(): never {
          throw 'delegation bug'
        }
      }
      const delegation = new ExplodingDelegation({ newTaskId: () => 'delegated-task-7' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec(),
        new AbortController().signal,
        fixture.workerOptions(delegation, 's-worker-child-7'),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('EXECUTION_FAILED')
        expect(outcome.reason).toContain('Worker delegation refused')
      }
      // The failure happened before reservation: nothing was held.
      expect(fixture.ledgerCalls).toEqual({ reserve: 0, settle: 0, release: 0 })
      expect(fixture.factoryState.calls).toHaveLength(0)
    } finally {
      await fixture.dispose()
    }
  })

  it('passes worker token and deadline limits to the child', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 4 },
      usage: { inputTokens: 3, outputTokens: 1 },
    })
    try {
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-8' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec({ limits: { maxTokens: 50, deadlineMs: 60_000 } }),
        new AbortController().signal,
        fixture.workerOptions(delegation, 's-worker-child-8'),
      )
      expect(outcome.kind).toBe('completed')
      expect(fixture.factoryState.calls).toHaveLength(1)
      expect(fixture.factoryState.calls[0]!.options.agentOptions).toMatchObject({
        maxTokens: 50,
      })
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
    } finally {
      await fixture.dispose()
    }
  })

  it('rejects an invalid worker token limit before reserving', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 4 },
    })
    try {
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-9' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec({ limits: { maxTokens: 0 } }),
        new AbortController().signal,
        fixture.workerOptions(delegation, 's-worker-child-9'),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('INVALID_CONFIG')
        expect(outcome.reason).toContain('maxTokens')
      }
      expect(fixture.factoryState.calls).toHaveLength(0)
      expect(fixture.ledgerCalls).toEqual({ reserve: 0, settle: 0, release: 0 })
    } finally {
      await fixture.dispose()
    }
  })

  it('rejects an invalid worker step limit before reserving', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 4 },
    })
    try {
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-10' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec({ limits: { maxSteps: 0 } }),
        new AbortController().signal,
        fixture.workerOptions(delegation, 's-worker-child-10'),
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

  it('enforces the worker step limit through the handoff', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 4 },
      stepsOnDrive: 3,
    })
    try {
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-11' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec({ limits: { maxSteps: 2 } }),
        new AbortController().signal,
        fixture.workerOptions(delegation, 's-worker-child-11'),
      )
      // The third step trips the handoff's watcher: the child is cancelled
      // and its spend is held for reconciliation.
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('TASK_CANCELLED')
        expect(outcome.reason).toMatch(/step limit/)
      }
      const call = fixture.factoryState.calls[0]
      expect(call).toBeDefined()
      expect(call!.agent.cancelCount).toBe(1)
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 0, release: 0 })
      // The stopped worker's spend is uncertain: the reservation stays
      // encumbered instead of releasing free.
      expect(fixture.store.getPoolUtilization('tenant-1', 'pool-shared')).toEqual({
        capacity: 100,
        reserved: 10,
        consumed: 0,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('rejects an invalid worker deadline before reserving', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 4 },
    })
    try {
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-10' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec({ limits: { deadlineMs: Number.NaN } }),
        new AbortController().signal,
        fixture.workerOptions(delegation, 's-worker-child-10'),
      )
      expect(outcome.kind).toBe('failed')
      if (outcome.kind === 'failed') {
        expect(outcome.code).toBe('INVALID_CONFIG')
        expect(outcome.reason).toContain('deadlineMs')
      }
      expect(fixture.factoryState.calls).toHaveLength(0)
      expect(fixture.ledgerCalls).toEqual({ reserve: 0, settle: 0, release: 0 })
    } finally {
      await fixture.dispose()
    }
  })

  it('treats empty worker limits as no limits', async () => {
    const fixture = await setup({
      result: { artifacts: ['a:1'], evidence: [], actualUnits: 4 },
      usage: { inputTokens: 3, outputTokens: 1 },
    })
    try {
      const delegation = new DelegationManager({ newTaskId: () => 'delegated-task-12' })
      const outcome = await spawnWorker(
        fixture.coordinator,
        workerSpec({ limits: {} }),
        new AbortController().signal,
        fixture.workerOptions(delegation, 's-worker-child-12'),
      )
      expect(outcome.kind).toBe('completed')
      expect(fixture.ledgerCalls).toEqual({ reserve: 1, settle: 1, release: 0 })
    } finally {
      await fixture.dispose()
    }
  })
})
