/** Recovery, delegation, and evidence handling for the System 1 coordinator (Phase D).
 *
 * R19: inbox appends are written to the durable session log as
 * `system1/inbox` events, and a restarted coordinator rebuilds its
 * pending work by replaying them. Delegation binds a fencing token and
 * enforces a depth limit fail-closed. Verification evidence is stored
 * durably as `system1/verification` events and retrievable by request id.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  System1Workflows,
  System1RequestId,
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

describe('durable inbox (R19)', () => {
  it('writes inbox appends to the session log', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-inbox-log'))
      const handle = await ctx.system1Workflows.create(session, idleDriver)
      try {
        handle.coordinator.send(userMessage('hello'), 'next-turn', false)
        handle.coordinator.steer(userMessage('nudge'))

        const inboxEvents = session
          .snapshotEvents()
          .filter((event) => event.type === 'system1/inbox')
        expect(inboxEvents).toHaveLength(2)
        expect(inboxEvents[0].data.target).toBe('next-turn')
        expect(inboxEvents[1].data.target).toBe('next-step')
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recovers pending work by replaying the session log', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-inbox-recover'))
      const first = await ctx.system1Workflows.create(session, idleDriver)
      try {
        first.coordinator.send(userMessage('turn work'), 'next-turn', false)
        first.coordinator.send(userMessage('step work'), 'next-step', false)
      } finally {
        await first.dispose()
      }

      // A fresh coordinator on the same session rebuilds the inbox.
      const second = await ctx.system1Workflows.create(session, idleDriver)
      try {
        expect(second.coordinator.inbox.nextTurn).toHaveLength(0)
        expect(second.coordinator.inbox.nextStep).toHaveLength(0)
        second.coordinator.recover()
        expect(second.coordinator.inbox.nextTurn).toHaveLength(1)
        expect(second.coordinator.inbox.nextStep).toHaveLength(1)
      } finally {
        await second.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recovery on an empty session yields an empty inbox', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-inbox-empty'))
      const handle = await ctx.system1Workflows.create(session, idleDriver)
      try {
        expect(() => handle.coordinator.recover()).not.toThrow()
        expect(handle.coordinator.inbox.nextTurn).toHaveLength(0)
        expect(handle.coordinator.inbox.nextStep).toHaveLength(0)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('delegation safety', () => {
  it('refuses delegation with an invalid fencing token', async () => {
    const ctx = await boot()
    try {
      const handle = await ctx.system1Workflows.create(
        Session.create(SessionId('s-delegate-token')),
        idleDriver,
      )
      try {
        await expect(
          handle.coordinator.delegate(0, 0, () => Promise.resolve()),
        ).rejects.toThrow(/invalid fencing token/)
        await expect(
          handle.coordinator.delegate(-3, 0, () => Promise.resolve()),
        ).rejects.toThrow(/invalid fencing token/)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses delegation beyond the maximum depth', async () => {
    const ctx = await boot()
    try {
      const handle = await ctx.system1Workflows.create(
        Session.create(SessionId('s-delegate-depth')),
        idleDriver,
      )
      try {
        await expect(
          handle.coordinator.delegate(7, 5, () => Promise.resolve()),
        ).rejects.toThrow(/depth 5/)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs delegated work with the fencing token', async () => {
    const ctx = await boot()
    try {
      const handle = await ctx.system1Workflows.create(
        Session.create(SessionId('s-delegate-ok')),
        idleDriver,
      )
      try {
        let seenToken = 0
        await handle.coordinator.delegate(42, 0, async (_signal, token) => {
          seenToken = token
        })
        expect(seenToken).toBe(42)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('evidence handling', () => {
  it('returns empty evidence when nothing was verified', async () => {
    const ctx = await boot()
    try {
      const handle = await ctx.system1Workflows.create(
        Session.create(SessionId('s-evidence-empty')),
        idleDriver,
      )
      try {
        const evidence = handle.coordinator.getEvidence(System1RequestId('req-none'))
        expect(evidence).toEqual([])
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retrieves verification evidence by request id', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-evidence'))
      const handle = await ctx.system1Workflows.create(session, idleDriver)
      try {
        const requestId = System1RequestId('req-1')
        session.append('system1/verification', {
          schemaVersion: 1,
          requestId,
          checkId: 'check-1',
          passed: true,
          evidence: 'tool-call:abc',
        })
        session.append('system1/verification', {
          schemaVersion: 1,
          requestId: System1RequestId('req-other'),
          checkId: 'check-2',
          passed: true,
          evidence: 'tool-call:def',
        })

        const evidence = handle.coordinator.getEvidence(requestId)
        expect(evidence).toHaveLength(1)
        expect(evidence[0].checkId).toBe('check-1')
        expect(evidence[0].passed).toBe(true)
      } finally {
        await handle.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
