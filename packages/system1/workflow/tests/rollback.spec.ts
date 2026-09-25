/** Rollback to the baseline DeepSeek path.
 *
 * `System1Workflows.rollbackToBaseline()` drains every live coordinator
 * (cancelling in-flight turns), unregisters them, and latches the plugin
 * mode to `'off'` — one-way. Session events, receipts, verification
 * evidence, budgets, and unknown outcomes are preserved: rollback deletes
 * nothing.
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
import type { System1VerificationData } from '@deepseek-ai/dsh-system1-workflow'

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

describe('rollbackToBaseline', () => {
  it('preserves session events, receipts, and verification evidence', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-rollback-events'))
      const handle = await ctx.system1Workflows.create(session, idleDriver)
      handle.coordinator.followup(userMessage('do the thing'))
      const requestId = System1RequestId('r-rollback-1')
      session.append('system1/verification', {
        schemaVersion: 1,
        requestId,
        checkId: 'tool-result-read',
        passed: true,
        evidence: 'tool-call:1 succeeded',
      } satisfies System1VerificationData)
      const before = session.snapshotEvents().map((event) => event.type)

      await ctx.system1Workflows.rollbackToBaseline()

      const after = session.snapshotEvents().map((event) => event.type)
      expect(after).toEqual(before)
      expect(after).toContain('system1/inbox')
      expect(after).toContain('system1/verification')
      expect(handle.coordinator.getEvidence(requestId)).toHaveLength(1)
      expect(handle.coordinator.getEvidence(requestId)[0].checkId).toBe('tool-result-read')
      await handle.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cancels in-flight turns and unregisters live coordinators', async () => {
    const ctx = await boot()
    try {
      const sessionId = SessionId('s-rollback-inflight')
      let release!: () => void
      let aborted = false
      const gate = new Promise<void>((_resolve, reject) => {
        release = () => reject(new Error('aborted by test'))
      })
      const driver: CoordinatorDriver = {
        run: (_coordinator, signal) => {
          signal.addEventListener('abort', () => {
            aborted = true
            release()
          }, { once: true })
          return gate
        },
      }
      const handle = await ctx.system1Workflows.create(Session.create(sessionId), driver)
      handle.coordinator.followup(userMessage('go'))
      await Promise.resolve()

      await ctx.system1Workflows.rollbackToBaseline()

      expect(aborted).toBe(true)
      expect(handle.coordinator.lastError).toBeUndefined()
      expect(ctx.system1Workflows.get(sessionId)).toBeUndefined()
      await handle.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('latches mode to off so new coordinator creation is refused', async () => {
    const ctx = await boot()
    try {
      expect(ctx.system1Workflows.config.mode).toBe('shadow')
      const session = Session.create(SessionId('s-rollback-mode'))
      const handle = await ctx.system1Workflows.create(session, idleDriver)

      await ctx.system1Workflows.rollbackToBaseline()

      expect(ctx.system1Workflows.config.mode).toBe('off')
      await expect(
        ctx.system1Workflows.create(Session.create(SessionId('s-rollback-after')), idleDriver),
      ).rejects.toThrow('mode is "off"')
      await handle.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drains a creation still suspended on registration', async () => {
    const ctx = await boot()
    try {
      const sessionId = SessionId('s-rollback-pending')
      // Start creation but do not await it: registration is in flight when
      // the rollback barrier latches, so the drain must pick up the pending
      // handle instead of leaving a half-created coordinator running.
      const pendingCreate = ctx.system1Workflows.create(Session.create(sessionId), idleDriver)
      const rollback = ctx.system1Workflows.rollbackToBaseline()
      const handle = await pendingCreate
      await rollback

      expect(ctx.system1Workflows.config.mode).toBe('off')
      expect(ctx.system1Workflows.get(sessionId)).toBeUndefined()
      await handle.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('shares one drain across simultaneous rollbacks', async () => {
    const ctx = await boot()
    try {
      let unwinds = 0
      const track = async (id: string) => {
        const handle = await ctx.system1Workflows.create(Session.create(SessionId(id)), idleDriver)
        handle.coordinator.effect(() => () => {
          unwinds += 1
        })
        return handle
      }
      const a = await track('s-rollback-sim-a')
      const b = await track('s-rollback-sim-b')

      await Promise.all([
        ctx.system1Workflows.rollbackToBaseline(),
        ctx.system1Workflows.rollbackToBaseline(),
      ])

      // One shared drain: each coordinator unwound exactly once.
      expect(unwinds).toBe(2)
      expect(ctx.system1Workflows.get(SessionId('s-rollback-sim-a'))).toBeUndefined()
      expect(ctx.system1Workflows.get(SessionId('s-rollback-sim-b'))).toBeUndefined()
      await a.dispose()
      await b.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('surfaces teardown failures while still draining the rest and latching off', async () => {
    const ctx = await boot()
    try {
      const bad = await ctx.system1Workflows.create(
        Session.create(SessionId('s-rollback-bad')),
        idleDriver,
      )
      bad.coordinator.effect(() => () => {
        throw new Error('teardown boom')
      })
      const goodId = SessionId('s-rollback-good')
      const good = await ctx.system1Workflows.create(Session.create(goodId), idleDriver)

      await expect(ctx.system1Workflows.rollbackToBaseline()).rejects.toThrow(
        /rollback drained with 1 teardown failure.*teardown boom/,
      )
      expect(ctx.system1Workflows.config.mode).toBe('off')
      // The healthy coordinator is still drained and unregistered.
      expect(ctx.system1Workflows.get(goodId)).toBeUndefined()
      await good.dispose()
      await expect(bad.dispose()).rejects.toThrow('teardown boom')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stringifies non-Error teardown failures in the rollback aggregate', async () => {
    const ctx = await boot()
    try {
      const bad = await ctx.system1Workflows.create(
        Session.create(SessionId('s-rollback-string')),
        idleDriver,
      )
      bad.coordinator.effect(() => () => {
        throw 'teardown string boom'
      })

      await expect(ctx.system1Workflows.rollbackToBaseline()).rejects.toThrow(
        /rollback drained with 1 teardown failure.*teardown string boom/,
      )
      expect(ctx.system1Workflows.config.mode).toBe('off')
      await expect(bad.dispose()).rejects.toBe('teardown string boom')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('is idempotent and safe with no live coordinators', async () => {
    const ctx = await boot()
    try {
      await ctx.system1Workflows.rollbackToBaseline()
      await ctx.system1Workflows.rollbackToBaseline()
      expect(ctx.system1Workflows.config.mode).toBe('off')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
