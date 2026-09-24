/** Behavioral coverage for coordinator, inbox, and service disposal seams.
 *
 * Each test asserts observable behavior; together they exercise the branches
 * the contract probes leave cold: inbox mutation paths, coordinator input
 * methods on disposed agents, effect self-disposal, cancellation options,
 * idle waiting, idempotent disposal, and abort vs failure error capture.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  System1Inbox,
  System1Workflows,
  type CoordinatorDriver,
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

describe('system1 inbox', () => {
  it('reads back appended and prepended messages per target', () => {
    const inbox = new System1Inbox()
    const first = userMessage('first')
    const second = userMessage('second')
    inbox.append('next-turn', first)
    inbox.prepend('next-turn', second)
    expect(inbox.nextTurn.map(message => message.id)).toEqual([second.id, first.id])
    const step = userMessage('step')
    inbox.append('next-step', step)
    expect(inbox.nextStep.map(message => message.id)).toEqual([step.id])
  })

  it('replaces and removes pending messages, reporting misses', () => {
    const inbox = new System1Inbox()
    const original = userMessage('original')
    const replacement = userMessage('replacement')
    inbox.append('next-step', original)
    expect(inbox.replace(original.id, replacement)).toBe(true)
    expect(inbox.nextStep[0]?.id).toBe(replacement.id)
    expect(inbox.replace(original.id, original)).toBe(false)
    expect(inbox.remove(replacement.id)).toBe(true)
    expect(inbox.nextStep).toHaveLength(0)
    expect(inbox.remove(replacement.id)).toBe(false)
  })

  it('finds messages in the next-turn list after the next-step list misses', () => {
    const inbox = new System1Inbox()
    const message = userMessage('turn-scoped')
    inbox.append('next-turn', message)
    expect(inbox.remove(message.id)).toBe(true)
    inbox.append('next-turn', message)
    const replacement = userMessage('replaced')
    expect(inbox.replace(message.id, replacement)).toBe(true)
    expect(inbox.nextTurn[0]?.id).toBe(replacement.id)
  })

  it('splices a pending list with standard semantics and clears both lists', () => {
    const inbox = new System1Inbox()
    const a = userMessage('a')
    const b = userMessage('b')
    const c = userMessage('c')
    inbox.append('next-turn', a)
    inbox.append('next-turn', b)
    const removed = inbox.splice('next-turn', 0, 1, [c])
    expect(removed.map(message => message.id)).toEqual([a.id])
    expect(inbox.nextTurn.map(message => message.id)).toEqual([c.id, b.id])
    inbox.clear()
    expect(inbox.nextTurn).toHaveLength(0)
    expect(inbox.nextStep).toHaveLength(0)
  })
})

describe('system1 coordinator input seams', () => {
  it('rejects input methods once disposed', async () => {
    const ctx = await boot()
    try {
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-input-disposed')), idleDriver)
      await handle.dispose()
      const message = userMessage('late')
      expect(() => handle.coordinator.send(message, 'next-turn', true)).toThrow(/is disposed/)
      expect(() => handle.coordinator.followup(message)).toThrow(/is disposed/)
      expect(() => handle.coordinator.steer(message)).toThrow(/is disposed/)
      expect(() => handle.coordinator.inject(message)).toThrow(/is disposed/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('queues without waking when send targets next-step with wakeup false', async () => {
    const ctx = await boot()
    try {
      let runs = 0
      const driver: CoordinatorDriver = { run: () => { runs += 1; return Promise.resolve() } }
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-quiet-send')), driver)
      try {
        handle.coordinator.send(userMessage('quiet'), 'next-step', false)
        await handle.coordinator.whenIdle()
        expect(runs).toBe(0)
        expect(handle.coordinator.inbox.nextStep).toHaveLength(1)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('injects context without waking the driver', async () => {
    const ctx = await boot()
    try {
      let runs = 0
      const driver: CoordinatorDriver = { run: () => { runs += 1; return Promise.resolve() } }
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-inject')), driver)
      try {
        handle.coordinator.inject(userMessage('context'))
        await handle.coordinator.whenIdle()
        expect(runs).toBe(0)
        expect(handle.coordinator.inbox.nextStep).toHaveLength(1)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('steers through the next-step inbox and wakes the driver', async () => {
    const ctx = await boot()
    try {
      let runs = 0
      const driver: CoordinatorDriver = { run: () => { runs += 1; return Promise.resolve() } }
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-steer')), driver)
      try {
        handle.coordinator.steer(userMessage('steered'))
        await handle.coordinator.whenIdle()
        expect(runs).toBe(1)
        expect(handle.coordinator.inbox.nextStep).toHaveLength(1)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('survives a throwing status observer without breaking the turn lifecycle', async () => {
    const ctx = await boot()
    try {
      ctx.on('agent/status', () => { throw new Error('observer boom') })
      let runs = 0
      const driver: CoordinatorDriver = { run: () => { runs += 1; return Promise.resolve() } }
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-throwing-observer')), driver)
      try {
        handle.coordinator.followup(userMessage('go'))
        await handle.coordinator.whenIdle()
        expect(runs).toBe(1)
        expect(handle.coordinator.lastError).toBeUndefined()
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
  it('preserves the inbox when cancel keeps it, and clears it otherwise', async () => {
    const ctx = await boot()
    try {
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-cancel-keep')), idleDriver)
      try {
        handle.coordinator.inject(userMessage('keep me'))
        handle.coordinator.cancel({ kind: 'user' }, { keepInbox: true })
        expect(handle.coordinator.inbox.nextStep).toHaveLength(1)
        expect(handle.coordinator.lastCancelCause).toEqual({ kind: 'user' })
        handle.coordinator.cancel()
        expect(handle.coordinator.inbox.nextStep).toHaveLength(0)
        expect(handle.coordinator.lastCancelCause).toEqual({ kind: 'parent' })
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('waits for an in-flight turn in whenIdle and reports no error on success', async () => {
    const ctx = await boot()
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const driver: CoordinatorDriver = { run: () => gate }
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-when-idle')), driver)
      try {
        handle.coordinator.followup(userMessage('go'))
        const idle = handle.coordinator.whenIdle()
        let settled = false
        void idle.then(() => { settled = true })
        await Promise.resolve()
        expect(settled).toBe(false)
        release()
        await idle
        expect(handle.coordinator.lastError).toBeUndefined()
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not record an abort as a driver failure', async () => {
    const ctx = await boot()
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve, reject) => { release = () => reject(new Error('aborted by test')) })
      const driver: CoordinatorDriver = {
        run: (_coordinator, signal) => {
          signal.addEventListener('abort', () => release(), { once: true })
          return gate
        },
      }
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-abort')), driver)
      try {
        handle.coordinator.followup(userMessage('go'))
        await Promise.resolve()
        await handle.coordinator.dispose()
        expect(handle.coordinator.lastError).toBeUndefined()
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('disposes idempotently, untracks self-disposed effects, and unwinds in reverse order', async () => {
    const ctx = await boot()
    try {
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-effects')), idleDriver)
      const order: string[] = []
      const first = handle.coordinator.effect(() => () => { order.push('first') })
      handle.coordinator.effect(() => () => { order.push('second') })
      // Self-disposal runs the effect now and untracks it, so dispose skips it.
      first()
      expect(order).toEqual(['first'])
      await handle.coordinator.dispose()
      await handle.coordinator.dispose()
      expect(order).toEqual(['first', 'second'])
    } finally {
      await ctx.fiber.dispose()
    }
    const ctx2 = await boot()
    try {
      const handle = await ctx2.system1Workflows.create(Session.create(SessionId('s-effect-order')), idleDriver)
      const order: string[] = []
      handle.coordinator.effect(() => () => { order.push('a') })
      handle.coordinator.effect(() => () => { order.push('b') })
      handle.coordinator.effect(() => () => { order.push('c') })
      await handle.coordinator.dispose()
      expect(order).toEqual(['c', 'b', 'a'])
    } finally {
      await ctx2.fiber.dispose()
    }
  })

  it('latches wakeups during a run and ignores wakeups while disposed', async () => {
    const ctx = await boot()
    try {
      let runs = 0
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const driver: CoordinatorDriver = {
        run: () => { runs += 1; return gate },
      }
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-wake-guard')), driver)
      try {
        handle.coordinator.followup(userMessage('one'))
        handle.coordinator.followup(userMessage('two'))
        await Promise.resolve()
        expect(runs).toBe(1)
        release()
        await handle.coordinator.whenIdle()
        // The wake during the active turn is latched and runs once it
        // settles instead of being dropped (R17).
        expect(runs).toBe(2)
        await handle.coordinator.dispose()
        // Waking a disposed coordinator must not start the driver.
        expect(() => handle.coordinator.followup(userMessage('late'))).toThrow(/is disposed/)
        expect(runs).toBe(2)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs maintenance tasks against a fresh signal', async () => {
    const ctx = await boot()
    try {
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-maintenance')), idleDriver)
      try {
        const seen = await handle.coordinator.runMaintenance(async (signal) => {
          expect(signal.aborted).toBe(false)
          return 'done'
        })
        expect(seen).toBe('done')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('system1 service disposal seams', () => {
  it('applies defaults on direct construction without Cordis config resolution', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    try {
      const service = new System1Workflows(ctx, {})
      expect(service.config.mode).toBe('off')
      expect(service.config.provider).toBe('jev')
      expect(service.config.model).toBeUndefined()
      await ctx.fiber.dispose()
    } finally {
      // Direct construction does not register the plugin; nothing to dispose.
    }
  })

  it('honors an explicit provider and disposes handles idempotently', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(System1Workflows, { mode: 'shadow', provider: 'jev' })
    try {
      expect(ctx.system1Workflows.config.provider).toBe('jev')
      const handle = await ctx.system1Workflows.create(Session.create(SessionId('s-idempotent')), idleDriver)
      await handle.dispose()
      await handle.dispose()
      expect(ctx.agents.get(SessionId('s-idempotent')) === undefined).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
