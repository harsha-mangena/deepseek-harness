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
