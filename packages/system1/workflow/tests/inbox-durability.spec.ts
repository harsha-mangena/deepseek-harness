/** Durable inbox (N02): recovery replays only pending input.
 *
 * Every inbox input carries a stable id assigned at enqueue; enqueue,
 * claim, discard, replacement, and request-association transitions are
 * journaled to the session log as `system1/inbox` and
 * `system1/inbox-transition` events. `recover()` rebuilds ONLY pending
 * input — claimed, discarded, or cancelled work is never requeued —
 * injected context travels through the same durable mechanism, and
 * cancellation is preserved across a file-backed process restart.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  System1InputId,
  System1RequestId,
  System1Workflows,
  type CoordinatorDriver,
  type System1CoordinatorAgent,
  type System1InboxData,
  type System1TerminalData,
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

/** Driver that drains the inbox exactly like the production driver: read, then clear. */
const drainingDriver: CoordinatorDriver = {
  run: (coordinator) => {
    const messages = [...coordinator.inbox.nextStep, ...coordinator.inbox.nextTurn]
    coordinator.inbox.clear()
    void messages
    return Promise.resolve()
  },
}

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Persist the durable session log to a file: the on-disk log is what
 * survives a process restart.
 */
function persistLog(session: Session): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-system1-inbox-'))
  tempRoots.push(dir)
  const file = join(dir, 'session-log.json')
  writeFileSync(
    file,
    JSON.stringify(
      session.snapshotEvents().map((event) => ({ type: event.type, data: event.data })),
    ),
  )
  return file
}

/**
 * Simulate a process restart: only the file-backed log survives, so a
 * fresh session is rebuilt by replaying it verbatim.
 */
function restartSession(sessionId: SessionId, file: string): Session {
  const persisted = JSON.parse(readFileSync(file, 'utf8')) as Array<{
    type: string
    data: unknown
  }>
  const session = Session.create(sessionId)
  for (const event of persisted) {
    // The log is the durability boundary; replay every persisted event verbatim.
    session.append(event.type as 'system1/inbox', event.data as never)
  }
  return session
}

function inboxEvents(session: Session): System1InboxData[] {
  return session
    .snapshotEvents()
    .filter((event) => event.type === 'system1/inbox')
    .map((event) => event.data as System1InboxData)
}

function transitionEvents(session: Session): Array<{ transition: string; inputId: string }> {
  return session
    .snapshotEvents()
    .filter((event) => event.type === 'system1/inbox-transition')
    .map((event) => {
      const data = event.data as { transition: string; inputId: string }
      return { transition: data.transition, inputId: data.inputId }
    })
}

async function createCoordinator(
  ctx: Context,
  session: Session,
  driver: CoordinatorDriver = idleDriver,
): Promise<{ coordinator: System1CoordinatorAgent; dispose: () => Promise<void> }> {
  const handle = await ctx.system1Workflows.create(session, driver)
  return { coordinator: handle.coordinator, dispose: () => handle.dispose() }
}

describe('stable input identities', () => {
  it('assigns a stable id to every enqueued input and journals it', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-input-ids'))
      const { coordinator, dispose } = await createCoordinator(ctx, session)
      try {
        const first = coordinator.send(userMessage('one'), 'next-turn', false)
        const second = coordinator.steer(userMessage('two'))
        expect(second).not.toBe(first)

        const logged = inboxEvents(session)
        expect(logged).toHaveLength(2)
        expect(logged[0]!.inputId).toBe(first)
        expect(logged[1]!.inputId).toBe(second)
        expect(logged[0]!.target).toBe('next-turn')
        expect(logged[1]!.target).toBe('next-step')
      } finally {
        await dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('routes inject through the same durable mechanism as send (V04)', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-inject-durable'))
      const { coordinator, dispose } = await createCoordinator(ctx, session)
      try {
        const inputId = coordinator.inject(userMessage('critical context'))
        expect(inboxEvents(session)).toHaveLength(1)
        expect(inboxEvents(session)[0]!.inputId).toBe(inputId)

        coordinator.recover()
        expect(coordinator.inbox.nextStep).toHaveLength(1)
      } finally {
        await dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('inbox transitions', () => {
  it('journals claimed transitions for an explicit claim; recovery skips them', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-claim'))
      const { coordinator, dispose } = await createCoordinator(ctx, session)
      try {
        const first = coordinator.send(userMessage('a'), 'next-turn', false)
        const second = coordinator.send(userMessage('b'), 'next-step', false)

        const claimed = coordinator.claimInboxInput()
        // Drain order: next-step before next-turn.
        expect(claimed.map((entry) => entry.inputId)).toEqual([second, first])
        expect(coordinator.inbox.nextTurn).toHaveLength(0)
        expect(coordinator.inbox.nextStep).toHaveLength(0)

        const transitions = transitionEvents(session)
        expect(transitions).toHaveLength(2)
        expect(transitions.every((event) => event.transition === 'claimed')).toBe(true)

        coordinator.recover()
        expect(coordinator.inbox.nextTurn).toHaveLength(0)
        expect(coordinator.inbox.nextStep).toHaveLength(0)
      } finally {
        await dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('journals discarded transitions on cancel; recovery preserves the cancellation (V03)', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-discard'))
      const { coordinator, dispose } = await createCoordinator(ctx, session)
      try {
        coordinator.send(userMessage('cancel me'), 'next-turn', false)
        coordinator.cancel()

        const transitions = transitionEvents(session)
        expect(transitions).toHaveLength(1)
        expect(transitions[0]!.transition).toBe('discarded')

        coordinator.recover()
        expect(coordinator.inbox.nextTurn).toHaveLength(0)
      } finally {
        await dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('labels a driver-turn drain as claimed so completed work is never requeued (V02)', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-turn-claim'))
      const { coordinator, dispose } = await createCoordinator(ctx, session, drainingDriver)
      try {
        coordinator.followup(userMessage('do the thing'))
        await coordinator.whenIdle()

        const transitions = transitionEvents(session)
        expect(transitions).toHaveLength(1)
        expect(transitions[0]!.transition).toBe('claimed')

        coordinator.recover()
        expect(coordinator.inbox.nextTurn).toHaveLength(0)
      } finally {
        await dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('journals request association before dispatch and refuses unknown inputs', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-associate'))
      const { coordinator, dispose } = await createCoordinator(ctx, session)
      try {
        const inputId = coordinator.send(userMessage('work'), 'next-turn', false)
        coordinator.claimInboxInput()
        const requestId = System1RequestId('req-assoc-1')
        coordinator.associateInboxInput(inputId, requestId)

        expect(coordinator.associatedRequest(inputId)).toEqual(requestId)
        expect(coordinator.associatedRequest(System1InputId('inbox-input-unknown'))).toBeUndefined()
        expect(() =>
          coordinator.associateInboxInput(System1InputId('inbox-input-unknown'), requestId),
        ).toThrow(/unknown inbox input/)

        const associated = session
          .snapshotEvents()
          .filter(
            (event) =>
              event.type === 'system1/inbox-transition' &&
              (event.data as { transition: string }).transition === 'associated',
          )
        expect(associated).toHaveLength(1)
        expect((associated[0]!.data as { requestId: string }).requestId).toBe(requestId)
      } finally {
        await dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('replays replacements instead of the original message', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-replace'))
      const { coordinator, dispose } = await createCoordinator(ctx, session)
      try {
        const original = userMessage('original')
        coordinator.send(original, 'next-turn', false)
        expect(coordinator.inbox.replace(original.id, userMessage('replacement'))).toBe(true)

        coordinator.recover()
        expect(coordinator.inbox.nextTurn).toHaveLength(1)
        expect(coordinator.inbox.nextTurn[0]!.content).toEqual([
          { type: 'text', text: 'replacement' },
        ])
      } finally {
        await dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('replays legacy inbox events that predate stable input ids', async () => {
    const ctx = await boot()
    try {
      const session = Session.create(SessionId('s-legacy'))
      // A log written before stable input ids existed carries no inputId.
      session.append('system1/inbox', {
        schemaVersion: 1,
        target: 'next-turn',
        message: userMessage('legacy work'),
        appendedAt: Date.now(),
      } as unknown as System1InboxData)
      const { coordinator, dispose } = await createCoordinator(ctx, session)
      try {
        coordinator.recover()
        expect(coordinator.inbox.nextTurn).toHaveLength(1)
      } finally {
        await dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('file-backed process restart', () => {
  it('pending input survives a restart at the enqueue boundary', async () => {
    const sessionId = SessionId('s-restart-enqueue')
    const ctx1 = await boot()
    let firstIds!: string[]
    let file!: string
    try {
      const session = Session.create(sessionId)
      const { coordinator, dispose } = await createCoordinator(ctx1, session)
      try {
        coordinator.send(userMessage('turn work'), 'next-turn', false)
        coordinator.send(userMessage('step work'), 'next-step', false)
        firstIds = [
          ...coordinator.inbox.entries('next-step').map((entry) => entry.inputId),
          ...coordinator.inbox.entries('next-turn').map((entry) => entry.inputId),
        ]
        file = persistLog(session)
      } finally {
        await dispose()
      }
    } finally {
      await ctx1.fiber.dispose()
    }

    const ctx2 = await boot()
    try {
      const restored = restartSession(sessionId, file)
      const { coordinator, dispose } = await createCoordinator(ctx2, restored)
      try {
        coordinator.recover()
        expect(coordinator.inbox.nextTurn).toHaveLength(1)
        expect(coordinator.inbox.nextStep).toHaveLength(1)
        const secondIds = [
          ...coordinator.inbox.entries('next-step').map((entry) => entry.inputId),
          ...coordinator.inbox.entries('next-turn').map((entry) => entry.inputId),
        ]
        // Stable identities survive the restart.
        expect(secondIds).toEqual(firstIds)
      } finally {
        await dispose()
      }
    } finally {
      await ctx2.fiber.dispose()
    }
  })

  it('claimed input is not requeued after a restart at the claim boundary', async () => {
    const sessionId = SessionId('s-restart-claim')
    const ctx1 = await boot()
    let file!: string
    try {
      const session = Session.create(sessionId)
      const { coordinator, dispose } = await createCoordinator(ctx1, session)
      try {
        coordinator.send(userMessage('claimed work'), 'next-turn', false)
        expect(coordinator.claimInboxInput()).toHaveLength(1)
        file = persistLog(session)
      } finally {
        await dispose()
      }
    } finally {
      await ctx1.fiber.dispose()
    }

    const ctx2 = await boot()
    try {
      const restored = restartSession(sessionId, file)
      const { coordinator, dispose } = await createCoordinator(ctx2, restored)
      try {
        coordinator.recover()
        expect(coordinator.inbox.nextTurn).toHaveLength(0)
        expect(coordinator.inbox.nextStep).toHaveLength(0)
      } finally {
        await dispose()
      }
    } finally {
      await ctx2.fiber.dispose()
    }
  })

  it('completed work is not repeated after a restart at the terminal boundary', async () => {
    const sessionId = SessionId('s-restart-terminal')
    const ctx1 = await boot()
    let file!: string
    try {
      const session = Session.create(sessionId)
      const { coordinator, dispose } = await createCoordinator(ctx1, session, drainingDriver)
      try {
        const inputId = coordinator.followup(userMessage('do the thing'))
        await coordinator.whenIdle()
        const requestId = System1RequestId('req-restart-1')
        coordinator.associateInboxInput(inputId, requestId)
        session.append('system1/terminal', {
          schemaVersion: 1,
          requestId,
          outcome: 'success',
          summary: 'done',
          verifiedBy: ['check-1'],
        } satisfies System1TerminalData)
        file = persistLog(session)
      } finally {
        await dispose()
      }
    } finally {
      await ctx1.fiber.dispose()
    }

    const ctx2 = await boot()
    try {
      const restored = restartSession(sessionId, file)
      const { coordinator, dispose } = await createCoordinator(ctx2, restored)
      try {
        coordinator.recover()
        expect(coordinator.inbox.nextTurn).toHaveLength(0)
        expect(coordinator.inbox.nextStep).toHaveLength(0)
        // The terminal record and the input/request association survive.
        expect(
          restored.snapshotEvents().some((event) => event.type === 'system1/terminal'),
        ).toBe(true)
      } finally {
        await dispose()
      }
    } finally {
      await ctx2.fiber.dispose()
    }
  })

  it('cancellation is preserved across a restart', async () => {
    const sessionId = SessionId('s-restart-cancel')
    const ctx1 = await boot()
    let file!: string
    try {
      const session = Session.create(sessionId)
      const { coordinator, dispose } = await createCoordinator(ctx1, session)
      try {
        coordinator.send(userMessage('cancel me'), 'next-turn', false)
        coordinator.cancel()
        file = persistLog(session)
      } finally {
        await dispose()
      }
    } finally {
      await ctx1.fiber.dispose()
    }

    const ctx2 = await boot()
    try {
      const restored = restartSession(sessionId, file)
      const { coordinator, dispose } = await createCoordinator(ctx2, restored)
      try {
        coordinator.recover()
        expect(coordinator.inbox.nextTurn).toHaveLength(0)
        expect(coordinator.inbox.nextStep).toHaveLength(0)
      } finally {
        await dispose()
      }
    } finally {
      await ctx2.fiber.dispose()
    }
  })

  it('injected context survives a restart', async () => {
    const sessionId = SessionId('s-restart-inject')
    const ctx1 = await boot()
    let file!: string
    try {
      const session = Session.create(sessionId)
      const { coordinator, dispose } = await createCoordinator(ctx1, session)
      try {
        coordinator.inject(userMessage('critical context'))
        file = persistLog(session)
      } finally {
        await dispose()
      }
    } finally {
      await ctx1.fiber.dispose()
    }

    const ctx2 = await boot()
    try {
      const restored = restartSession(sessionId, file)
      const { coordinator, dispose } = await createCoordinator(ctx2, restored)
      try {
        coordinator.recover()
        expect(coordinator.inbox.nextStep).toHaveLength(1)
        expect(coordinator.inbox.nextStep[0]!.content).toEqual([
          { type: 'text', text: 'critical context' },
        ])
      } finally {
        await dispose()
      }
    } finally {
      await ctx2.fiber.dispose()
    }
  })

  it('rebuilds only pending input when settled and pending inputs interleave', async () => {
    const sessionId = SessionId('s-restart-interleaved')
    // A turn that consumes only the first next-turn message, like a
    // partial drain: the rest stays pending.
    const partialDriver: CoordinatorDriver = {
      run: (coordinator) => {
        coordinator.inbox.splice('next-turn', 0, 1, [])
        return Promise.resolve()
      },
    }
    const ctx1 = await boot()
    let file!: string
    try {
      const session = Session.create(sessionId)
      const { coordinator, dispose } = await createCoordinator(ctx1, session, partialDriver)
      try {
        coordinator.send(userMessage('first'), 'next-turn', false)
        coordinator.send(userMessage('second'), 'next-turn', false)
        coordinator.followup(userMessage('third'))
        await coordinator.whenIdle()
        file = persistLog(session)
      } finally {
        await dispose()
      }
    } finally {
      await ctx1.fiber.dispose()
    }

    const ctx2 = await boot()
    try {
      const restored = restartSession(sessionId, file)
      const { coordinator, dispose } = await createCoordinator(ctx2, restored)
      try {
        coordinator.recover()
        const texts = coordinator.inbox.nextTurn.map(
          (message) => (message.content[0] as { text: string }).text,
        )
        // 'first' was claimed by the turn; 'second' and 'third' rebuild.
        expect(texts).toEqual(['second', 'third'])
      } finally {
        await dispose()
      }
    } finally {
      await ctx2.fiber.dispose()
    }
  })
})
