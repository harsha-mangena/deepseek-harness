/** MCP adapter tests. */

import { describe, expect, it } from 'vitest'
import { McpAdapter } from '@deepseek-ai/dsh-system1-mcp'
import type { McpExecutor, McpToolDefinition } from '@deepseek-ai/dsh-system1-mcp'
import type { Candidate } from '@deepseek-ai/dsh-system1-contracts'

const readDef: McpToolDefinition = {
  name: 'read-file',
  description: 'Read a file',
  mutates: false,
  inputSchema: { type: 'object' },
}

const writeDef: McpToolDefinition = {
  name: 'write-file',
  description: 'Write a file',
  mutates: true,
  inputSchema: { type: 'object' },
}

function testCandidate(operationRef: string, effect: 'read' | 'write' = 'read'): Candidate {
  return {
    id: 'c1',
    label: 'Test',
    route: 'tool',
    effect,
    operationRef,
    preconditionHash: 'h1',
    verificationPolicyId: 'v1',
  }
}

describe('McpAdapter', () => {
  it('adapts read and write tools', () => {
    const adapter = new McpAdapter({
      executor: { execute: async () => null },
    })
    const readTool = adapter.adaptTool(readDef, 'verify:read:v1')
    expect(readTool.toolId).toBe('mcp:read-file')
    expect(readTool.effect).toBe('read')

    const writeTool = adapter.adaptTool(writeDef, 'verify:write:v1')
    expect(writeTool.toolId).toBe('mcp:write-file')
    expect(writeTool.effect).toBe('write')
  })

  it('executes candidates via MCP', async () => {
    const executor: McpExecutor = {
      execute: async (toolName, args) => ({ toolName, args, ok: true }),
    }
    const adapter = new McpAdapter({ executor })
    const candidate = testCandidate('op:mcp:read-file:v1')
    const result = await adapter.executeCandidate(candidate, { path: '/tmp' }, new AbortController().signal)
    expect(result).toEqual({ toolName: 'read-file', args: { path: '/tmp' }, ok: true })
  })

  it('rejects non-MCP candidates', async () => {
    const adapter = new McpAdapter({ executor: { execute: async () => null } })
    const candidate = testCandidate('op:other:v1')
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/Not an MCP candidate/)
  })

  it('opens circuit after threshold failures', async () => {
    let calls = 0
    const executor: McpExecutor = {
      execute: async () => {
        calls++
        throw new Error('MCP down')
      },
    }
    const adapter = new McpAdapter({ executor, failureThreshold: 2, resetTimeoutMs: 1000 })
    const candidate = testCandidate('op:mcp:failing-tool:v1')

    // First failure: circuit closed.
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/MCP down/)
    expect(adapter.getCircuitState('failing-tool')).toBe('closed')

    // Second failure: circuit opens.
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/MCP down/)
    expect(adapter.getCircuitState('failing-tool')).toBe('open')
    expect(calls).toBe(2)

    // Third call: rejected without executing.
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/Circuit open/)
    expect(calls).toBe(2)
  })

  it('half-opens after reset timeout', async () => {
    let shouldFail = true
    const executor: McpExecutor = {
      execute: async () => {
        if (shouldFail) throw new Error('down')
        return 'recovered'
      },
    }
    let now = 0
    const adapter = new McpAdapter({
      executor,
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: () => now,
    })
    const candidate = testCandidate('op:mcp:flaky:v1')

    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/down/)
    expect(adapter.getCircuitState('flaky')).toBe('open')

    // Before timeout: still open.
    now = 500
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/Circuit open/)

    // After timeout: half-open, trial succeeds, circuit closes.
    now = 1500
    shouldFail = false
    const result = await adapter.executeCandidate(candidate, {}, new AbortController().signal)
    expect(result).toBe('recovered')
    expect(adapter.getCircuitState('flaky')).toBe('closed')
  })

  it('propagates abort to MCP execution', async () => {
    let receivedSignal: AbortSignal | null = null
    const executor: McpExecutor = {
      execute: async (_tool, _args, signal) => {
        receivedSignal = signal
        // Wait until aborted.
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return null
      },
    }
    const adapter = new McpAdapter({ executor })
    const candidate = testCandidate('op:mcp:slow:v1')
    const controller = new AbortController()

    const promise = adapter.executeCandidate(candidate, {}, controller.signal)
    // Let the executor start.
    await new Promise((r) => setTimeout(r, 10))
    controller.abort()

    await expect(promise).rejects.toThrow(/aborted/)
    expect(receivedSignal).not.toBeNull()
  })

  it('times out slow MCP calls', async () => {
    const executor: McpExecutor = {
      execute: async (_tool, _args, signal) => {
        // Never resolves unless aborted.
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('timeout-aborted')), { once: true })
        })
        return null
      },
    }
    const adapter = new McpAdapter({ executor, callTimeoutMs: 10 })
    const candidate = testCandidate('op:mcp:slow:v1')

    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/timeout-aborted/)
  })

  it('returns closed for unknown tools', () => {
    const adapter = new McpAdapter({ executor: { execute: async () => null } })
    expect(adapter.getCircuitState('unknown')).toBe('closed')
  })
})
