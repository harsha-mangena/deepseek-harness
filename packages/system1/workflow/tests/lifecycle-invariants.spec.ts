/** Lifecycle invariants for the System 1 coordinator agent (remediation B).
 *
 * Each test pins a behavior the phase 1 review required: the coordinator
 * owns a private Cordis scope, wakes record the coordinator as initiator
 * when no agent chain is active, wakes during a run latch instead of
 * dropping, maintenance is owned and abortable and refuses active turns,
 * and disposal awaits asynchronous effect disposers exactly once.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime, {
  defineContentToolFixture,
  type ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  System1Workflows,
  type CoordinatorDriver,
  type System1CoordinatorAgent,
} from '@deepseek-ai/dsh-system1-workflow'

function userMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(System1Workflows, { mode: 'shadow' })
  return ctx
}

const idleDriver: CoordinatorDriver = { run: () => Promise.resolve() }

describe('system1 coordinator lifecycle invariants', () => {
  it('records the coordinator itself as initiator when woken outside an agent chain (R15)', async () => {
    const ctx = await boot()
    try {
      let seen: string | undefined
      const driver: CoordinatorDriver = {
        run(coordinator, signal) {
          void signal
          seen = coordinator.ctx.agents.currentInitiator()?.id
          return Promise.resolve()
        },
      }
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-init')), driver)
      try {
        handle.coordinator.followup(userMessage('go'))
        await handle.coordinator.whenIdle()
        expect(seen).toBe('s-init')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps per-coordinator registrations private across coordinators (R16)', async () => {
    const ctx = await boot()
    try {
      let ran = false
      const a = await ctx.system1Workflows.create(Session.create(SessionId('s-a')), idleDriver)
      const b = await ctx.system1Workflows.create(Session.create(SessionId('s-b')), idleDriver)
      try {
        a.coordinator.ctx.tools.register(defineContentToolFixture({
          name: 's1-a-tool',
          description: 'probe tool registered through coordinator A',
          parameters: {},
          async execute() {
            ran = true
            return [{ type: 'text', text: 'a-only' }]
          },
        }))
        const result: ToolExecutionResult = await ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId('r16'),
          name: 's1-a-tool',
          arguments: {},
          agent: b.coordinator,
        })
        expect(ran).toBe(false)
        expect(result.isError).toBe(true)
      } finally {
        await a.dispose()
        await b.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses maintenance while a driver turn is active (R18)', async () => {
    const ctx = await boot()
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const driver: CoordinatorDriver = { run: () => gate }
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-maint')), driver)
      try {
        handle.coordinator.followup(userMessage('go'))
        await Promise.resolve()
        expect(handle.coordinator.status).toBe('running')
        expect(() => handle.coordinator.runMaintenance(async () => undefined)).toThrow(/active turn/)
        release()
        await handle.coordinator.whenIdle()
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('aborts owned maintenance on cancel (R33)', async () => {
    const ctx = await boot()
    try {
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-cancel')), idleDriver)
      try {
        let aborted = false
        const maintenance = handle.coordinator.runMaintenance(async (signal) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true
              resolve()
            })
          })
        })
        await Promise.resolve()
        handle.coordinator.cancel({ kind: 'parent' })
        await maintenance
        expect(aborted).toBe(true)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('awaits asynchronous effect disposers on dispose and memoizes teardown (R34)', async () => {
    const ctx = await boot()
    try {
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-async')), idleDriver)
      const coordinator: System1CoordinatorAgent = handle.coordinator
      let released = false
      const gate = new Promise<void>((resolve) => {
        coordinator.effect(() => async () => {
          await new Promise((tick) => setTimeout(tick, 10))
          released = true
        })
        resolve()
      })
      await gate
      const first = coordinator.dispose()
      const second = coordinator.dispose()
      expect(released).toBe(false)
      await Promise.all([first, second])
      expect(released).toBe(true)
      await handle.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('chains a latched wake as an additional turn (R17)', async () => {
    const ctx = await boot()
    try {
      let turns = 0
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const driver: CoordinatorDriver = {
        run: (c) => {
          turns += 1
          if (turns === 1) {
            return gate.then(() => {
              c.inbox.splice('next-turn', 0, 1, [])
            })
          }
          c.inbox.splice('next-turn', 0, 1, [])
          return Promise.resolve()
        },
      }
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-latch')), driver)
      try {
        handle.coordinator.followup(userMessage('one'))
        handle.coordinator.followup(userMessage('two'))
        handle.coordinator.followup(userMessage('three'))
        await Promise.resolve()
        expect(turns).toBe(1)
        release()
        await handle.coordinator.whenIdle()
        // Three wakeups coalesce to exactly two turns: the active turn and
        // one latched follow-up turn.
        expect(turns).toBe(2)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
