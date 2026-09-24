/**
 * Phase 0 guarded-tool probe: System 1 executes tools through the public
 * {@link ToolRuntime.execute} seam with a caller-owned AbortSignal, and the
 * `tools/pre-execute` guard waterfall is the blocking authority.
 *
 * These probes run against the real ToolRuntime and SystemPrompt services.
 * They prove the execution entry point phase 0 must certify: a guard that
 * denies stops the tool body from running, an allowing guard lets it
 * through, and caller cancellation is honored. No routing logic is
 * exercised here; that arrives with the phase 1 policy engine.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineContentToolFixture,
  type PreToolDecision,
  type ToolExecutionInput,
  type ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function execInput(name: string, signal: AbortSignal): ToolExecutionInput {
  return { signal, callId: ToolCallId('probe-1'), name, arguments: {} }
}

describe('guarded tool execution seam', () => {
  it('a denying guard blocks the tool body from running', async () => {
    const ctx = await setup()
    let ran = false
    ctx.tools.register(defineContentToolFixture({
      name: 'probe-echo',
      description: 'probe tool',
      parameters: {},
      async execute() {
        ran = true
        return [{ type: 'text', text: 'should not run' }]
      },
    }))
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name === 'probe-echo') return { kind: 'deny', reason: 'probe guard denies' }
      return next()
    })

    const result: ToolExecutionResult = await ctx.tools.execute(
      execInput('probe-echo', new AbortController().signal),
    )

    expect(ran).toBe(false)
    expect(result.isError).toBe(true)
  })

  it('an allowing guard lets the tool body run (no false blocking)', async () => {
    const ctx = await setup()
    let ran = false
    ctx.tools.register(defineContentToolFixture({
      name: 'probe-echo',
      description: 'probe tool',
      parameters: {},
      async execute() {
        ran = true
        return [{ type: 'text', text: 'ran' }]
      },
    }))
    ctx.on('tools/pre-execute', async (_exec, next): Promise<PreToolDecision> => next())

    const result: ToolExecutionResult = await ctx.tools.execute(
      execInput('probe-echo', new AbortController().signal),
    )

    expect(ran).toBe(true)
    expect(result.isError).toBe(false)
  })

  it('a caller-owned abort signal cancels the execution', async () => {
    const ctx = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'probe-slow',
      description: 'probe tool',
      parameters: {},
      async execute(_args, exec) {
        await new Promise<void>((_resolve, reject) => {
          exec.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return []
      },
    }))

    const aborter = new AbortController()
    const pending = ctx.tools.execute(execInput('probe-slow', aborter.signal))
    aborter.abort()
    const result: ToolExecutionResult = await pending
    expect(result.isError).toBe(true)
  })
})
