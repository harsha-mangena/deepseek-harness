/**
 * Phase 0 contract probes: the System 1 coordinator coexists with the
 * default DeepSeek factory as a custom AgentRegistry runtime root.
 *
 * These probes run against the real Cordis runtime, the real
 * {@link AgentRegistry}, and real {@link Session} instances. The driver is a
 * controllable fake; the bounded workflow driver replaces it in phase 5.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  System1CoordinatorAgent,
  System1Inbox,
  System1RequestId,
  System1Workflows,
} from '@deepseek-ai/dsh-system1-workflow'
import type { CoordinatorDriver } from '@deepseek-ai/dsh-system1-workflow'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Probe-only ping for app-context liveness checks. */
    'probe/ping'(this: unknown): void
  }
}

function userMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** A driver the test fully controls: runs until the gate opens or abort fires. */
function gatedDriver() {
  let release: (() => void) | undefined
  const seen: { aborted: boolean }[] = []
  const driver: CoordinatorDriver = {
    run: (_coordinator, signal) =>
      new Promise<void>((resolve, reject) => {
        release = resolve
        signal.addEventListener('abort', () => {
          seen.push({ aborted: true })
          reject(new Error('driver aborted'))
        }, { once: true })
      }),
  }
  return {
    driver,
    seen,
    release: () => release?.(),
  }
}

function stubAgent(id: string, ctx: Context): Agent {
  const sessionId = SessionId(id)
  return {
    id: sessionId,
    options: {},
    session: Session.create(sessionId),
    inbox: new System1Inbox(),
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Minimal stub of the default DeepSeek factory path. */
function stubFactory(ctx: Context): AgentFactory {
  return {
    createAgent: async (ownerCtx, options): Promise<AgentHandle> => {
      const agent = stubAgent(options.sessionId, ownerCtx)
      const unregister = await ctx.agents.register(agent)
      return { agent, dispose: async () => unregister() }
    },
    resume: async () => {
      throw new Error('not implemented in probe')
    },
  }
}

async function boot(mode: 'off' | 'shadow'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(System1Workflows, { mode })
  return ctx
}

async function shutdown(ctx: Context): Promise<void> {
  await ctx.fiber.dispose()
}

describe('phase 0: coordinator runtime seams', () => {
  it('refuses coordinator creation while the kill switch is off', async () => {
    const ctx = await boot('off')
    const session = Session.create(SessionId('s-off'))
    await expect(ctx.system1Workflows.create(session, gatedDriver().driver)).rejects.toThrow(/mode is "off"/)
    expect(ctx.agents.get(session.id)).toBeUndefined()
    await shutdown(ctx)
  })

  it('registers a coordinator alongside a factory-built agent without replacing the factory', async () => {
    const ctx = await boot('shadow')
    const factory = stubFactory(ctx)
    const unsetFactory = ctx.agents.setFactory(factory)
    // A second factory is rejected: the standard path keeps its single slot.
    expect(() => ctx.agents.setFactory(factory)).toThrow()

    const deepseekId = SessionId('s-deepseek')
    const handle = await factory.createAgent(ctx, { sessionId: deepseekId })
    const session = Session.create(SessionId('s-coord'))
    const { coordinator, dispose } = await ctx.system1Workflows.create(session, gatedDriver().driver)

    expect(ctx.agents.get(deepseekId)).toBe(handle.agent)
    expect(ctx.agents.get(session.id)).toBe(coordinator)
    expect(ctx.system1Workflows.get(session.id)).toBe(coordinator)
    expect(ctx.system1Workflows.get(deepseekId)).toBeUndefined()
    expect(coordinator).toBeInstanceOf(System1CoordinatorAgent)
    expect(handle.agent).not.toBeInstanceOf(System1CoordinatorAgent)

    await dispose()
    await handle.dispose()
    unsetFactory()
    await shutdown(ctx)
  })

  it('rejects a second coordinator for the same session at the collision boundary', async () => {
    const ctx = await boot('shadow')
    const session = Session.create(SessionId('s-collide'))
    const first = await ctx.system1Workflows.create(session, gatedDriver().driver)
    await expect(
      ctx.system1Workflows.create(session, gatedDriver().driver),
    ).rejects.toThrow(/already registered/)
    expect(ctx.agents.get(session.id)).toBe(first.coordinator)
    await first.dispose()
    await shutdown(ctx)
  })

  it('rolls back registration when agent/created vetoes, leaving no residue', async () => {
    const ctx = await boot('shadow')
    const lifecycle: string[] = []
    ctx.on('agent/created', ({ agent }) => void lifecycle.push(`created:${agent.id}`))
    ctx.on('agent/disposed', ({ agent }) => void lifecycle.push(`disposed:${agent.id}`))
    const veto = ctx.on('agent/created', () => {
      throw new Error('creation veto')
    })
    const session = Session.create(SessionId('s-veto'))
    await expect(
      ctx.system1Workflows.create(session, gatedDriver().driver),
    ).rejects.toThrow('creation veto')
    expect(ctx.agents.get(session.id)).toBeUndefined()
    expect(lifecycle).toEqual(['created:s-veto', 'disposed:s-veto'])
    veto()
    await shutdown(ctx)
  })

  it('drives idle/running transitions and emits agent/status on every change', async () => {
    const ctx = await boot('shadow')
    const session = Session.create(SessionId('s-lifecycle'))
    const gate = gatedDriver()
    const { coordinator, dispose } = await ctx.system1Workflows.create(session, gate.driver)
    const statuses: string[] = []
    ctx.on('agent/status', ({ status }) => void statuses.push(status))

    expect(coordinator.status).toBe('idle')
    coordinator.send(userMessage('hello'), 'next-turn', true)
    expect(coordinator.status).toBe('running')
    gate.release()
    await coordinator.whenIdle()
    expect(coordinator.status).toBe('idle')
    expect(statuses).toEqual(['running', 'idle'])

    await dispose()
    await shutdown(ctx)
  })

  it('cancels the active driver and clears the inbox', async () => {
    const ctx = await boot('shadow')
    const session = Session.create(SessionId('s-cancel'))
    const gate = gatedDriver()
    const { coordinator, dispose } = await ctx.system1Workflows.create(session, gate.driver)

    coordinator.send(userMessage('work'), 'next-turn', true)
    expect(coordinator.status).toBe('running')
    const idle = coordinator.whenIdle()
    coordinator.cancel({ kind: 'user' })
    coordinator.cancel({ kind: 'parent' })
    await expect(idle).resolves.toBeUndefined()
    expect(coordinator.status).toBe('idle')
    expect(gate.seen).toEqual([{ aborted: true }])
    expect(coordinator.lastError).toBeUndefined()
    // The inbox is cleared unless keepInbox is set.
    expect(coordinator.inbox.nextTurn).toEqual([])

    await dispose()
    await shutdown(ctx)
  })

  it('preserves the initiating agent across the driver lifetime', async () => {
    const ctx = await boot('shadow')
    const parentAgent = stubAgent('s-parent', ctx)
    const unregisterParent = await ctx.agents.register(parentAgent)

    let observed: unknown
    const driver: CoordinatorDriver = {
      run: () => {
        observed = ctx.agents.currentInitiator()
        return Promise.resolve()
      },
    }
    const session = Session.create(SessionId('s-child'))
    const { coordinator, dispose } = await ctx.system1Workflows.create(session, driver)
    ctx.agents.withInitiator(parentAgent, () => {
      coordinator.send(userMessage('go'), 'next-turn', true)
    })
    await coordinator.whenIdle()
    expect(observed).toBe(parentAgent)

    await dispose()
    unregisterParent()
    await shutdown(ctx)
  })

  it('keeps coordinator lifecycle events observable from the application root', async () => {
    const ctx = await boot('shadow')
    const session = Session.create(SessionId('s-visible'))
    const gate = gatedDriver()
    const { coordinator, dispose } = await ctx.system1Workflows.create(session, gate.driver)
    // The coordinator is rooted in the plugin's context, never a private
    // event bus: status changes propagate up to the application root.
    // (Never identity-compare Cordis contexts: the proxy trips test
    // serializers. Assert the behavioral contract instead.)
    const seen: string[] = []
    ctx.on('agent/status', ({ status }) => void seen.push(status))
    coordinator.send(userMessage('hello'), 'next-turn', true)
    gate.release()
    await coordinator.whenIdle()
    expect(seen).toEqual(['running', 'idle'])

    await dispose()
    await shutdown(ctx)
  })

  it('appends system1 events to the session write-ahead log with snapshot integrity', async () => {
    const ctx = await boot('shadow')
    const session = Session.create(SessionId('s-events'))
    const requestId = System1RequestId('req-1')
    const admission = {
      schemaVersion: 1 as const,
      requestId,
      objective: 'probe the log',
      limits: { steps: 5, tokens: 1000, wallClockMs: 30_000 },
    }
    const event = session.append('system1/admission', admission)
    expect(event.type).toBe('system1/admission')
    expect(event.seq).toBe(0)
    admission.objective = 'mutated after append'
    expect(event.data.objective).toBe('probe the log')

    const terminal = session.append('system1/terminal', {
      schemaVersion: 1,
      requestId,
      outcome: 'success',
      summary: 'probe done',
      verifiedBy: ['probe-check'],
    })
    expect(terminal.seq).toBe(1)
    await shutdown(ctx)
  })

  it('tears down in dependency order: drain, owned effects, unregister', async () => {
    const ctx = await boot('shadow')
    const session = Session.create(SessionId('s-teardown'))
    const gate = gatedDriver()
    const { coordinator, dispose } = await ctx.system1Workflows.create(session, gate.driver)
    const unwound: string[] = []
    coordinator.effect(() => () => void unwound.push('first'), 'probe.first()')
    coordinator.effect(() => () => void unwound.push('second'), 'probe.second()')

    coordinator.send(userMessage('work'), 'next-turn', true)
    expect(coordinator.status).toBe('running')
    const disposing = dispose()
    // Teardown drains the driver first: the coordinator stays registered
    // until the turn settles.
    expect(ctx.agents.get(session.id)).toBe(coordinator)
    gate.release()
    await disposing
    expect(coordinator.status).toBe('idle')
    expect(unwound).toEqual(['second', 'first'])
    expect(ctx.agents.get(session.id)).toBeUndefined()

    // The application context survives coordinator teardown.
    let appAlive = false
    ctx.on('probe/ping', () => void (appAlive = true))
    ctx.emit('probe/ping')
    expect(appAlive).toBe(true)
    await shutdown(ctx)
  })

  it('records non-abort driver failures instead of dropping them', async () => {
    const ctx = await boot('shadow')
    const session = Session.create(SessionId('s-failure'))
    const failure = new Error('driver exploded')
    const driver: CoordinatorDriver = {
      run: () => Promise.reject(failure),
    }
    const { coordinator, dispose } = await ctx.system1Workflows.create(session, driver)
    coordinator.send(userMessage('work'), 'next-turn', true)
    await coordinator.whenIdle()
    expect(coordinator.status).toBe('idle')
    expect(coordinator.lastError).toBe(failure)

    await dispose()
    await shutdown(ctx)
  })
})
