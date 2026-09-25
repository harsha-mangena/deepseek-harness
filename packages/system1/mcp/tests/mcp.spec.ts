/** MCP adapter tests: controlled execution, namespaced identity, resilience. */

import { describe, expect, it } from 'vitest'
import { McpAdapter } from '@deepseek-ai/dsh-system1-mcp'
import type { McpDispatchTarget, McpExecutor, McpToolDefinition } from '@deepseek-ai/dsh-system1-mcp'
import { System1Error, system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type { Candidate } from '@deepseek-ai/dsh-system1-contracts'
import { checkSchemaSupport, validateJsonSchemaArgs } from '../src/json-schema.ts'

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

const ciDef: McpToolDefinition = {
  name: 'ci',
  description: 'CI',
  mutates: false,
  inputSchema: {
    type: 'object',
    required: ['repo'],
    properties: { repo: { type: 'string' } },
    additionalProperties: false,
  },
}

function testCandidate(
  operationRef: string,
  effect: 'read' | 'write' | 'external' = 'read',
  verificationPolicyId = 'v1',
): Candidate {
  return {
    id: 'c1',
    label: 'Test',
    route: 'tool',
    effect,
    operationRef,
    preconditionHash: 'h1',
    verificationPolicyId,
  }
}

function rejectedWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`expected rejection with ${code}`)
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(System1Error)
      expect((error as System1Error).code).toBe(code)
    },
  )
}

describe('McpAdapter', () => {
  it('adapts read and write tools', () => {
    const adapter = new McpAdapter({
      executor: { execute: async () => null },
    })
    const readTool = adapter.adaptTool(readDef, 'verify:read:v1')
    expect(readTool.toolId).toBe('mcp:read-file')
    expect(readTool.operationRef).toBe('op:mcp:read-file:v1')
    expect(readTool.effect).toBe('read')

    const writeTool = adapter.adaptTool(writeDef, 'verify:write:v1')
    expect(writeTool.toolId).toBe('mcp:write-file')
    expect(writeTool.operationRef).toBe('op:mcp:write-file:v1')
    expect(writeTool.effect).toBe('write')
  })

  it('namespaces tool identity by server and catalog generation', () => {
    const adapter = new McpAdapter({
      executor: { execute: async () => null },
    })
    const tool = adapter.adaptTool(readDef, 'verify:read:v1', {
      serverId: 'github',
      catalogVersion: 'c7',
    })
    expect(tool.toolId).toBe('mcp:github:read-file')
    expect(tool.operationRef).toBe('op:mcp:github:read-file:c7')

    const serverOnly = adapter.adaptTool(readDef, 'verify:read:v1', { serverId: 'github' })
    expect(serverOnly.toolId).toBe('mcp:github:read-file')
    expect(serverOnly.operationRef).toBe('op:mcp:github:read-file:v1')
  })

  it('rejects tools whose inputSchema the adapter cannot validate', () => {
    const adapter = new McpAdapter({
      executor: { execute: async () => null },
    })
    expect(() =>
      adapter.adaptTool({ ...readDef, inputSchema: { $ref: '#/$defs/tool' } }, 'verify:read:v1'),
    ).toThrow(/cannot validate/)
  })

  it('executes candidates via MCP', async () => {
    const executor: McpExecutor = {
      execute: async (target, args) => ({ toolName: target.toolName, args, ok: true }),
    }
    const adapter = new McpAdapter({ executor })
    const tool = adapter.adaptTool(readDef, 'v1')
    const candidate = testCandidate(tool.operationRef)
    const result = await adapter.executeCandidate(candidate, { path: '/tmp' }, new AbortController().signal)
    expect(result).toEqual({ toolName: 'read-file', args: { path: '/tmp' }, ok: true })
  })

  it('dispatches namespaced tools under their tool name', async () => {
    let seenName: string | null = null
    const adapter = new McpAdapter({
      executor: {
        execute: async (target) => {
          seenName = target.toolName
          return 'ok'
        },
      },
    })
    const tool = adapter.adaptTool(readDef, 'verify:read:v1', { serverId: 'github', catalogVersion: 'c7' })
    const result = await adapter.executeCandidate(
      testCandidate(tool.operationRef, 'read', 'verify:read:v1'),
      {},
      new AbortController().signal,
    )
    expect(result).toBe('ok')
    expect(seenName).toBe('read-file')
  })

  it('delivers the bound server identity to the executor', async () => {
    let seen: McpDispatchTarget | null = null
    const adapter = new McpAdapter({
      executor: {
        execute: async (target) => {
          seen = target
          return 'ok'
        },
      },
    })
    const tool = adapter.adaptTool(readDef, 'verify:read:v1', { serverId: 'github', catalogVersion: 'c7' })
    await adapter.executeCandidate(
      testCandidate(tool.operationRef, 'read', 'verify:read:v1'),
      {},
      new AbortController().signal,
    )
    expect(seen).toMatchObject({
      toolName: 'read-file',
      toolIdentity: 'mcp:github:read-file',
      serverId: 'github',
      catalogVersion: 'c7',
    })
  })

  it('rejects unregistered operationRefs with zero executor calls', async () => {
    let executed = false
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          executed = true
          return 'ran'
        },
      },
    })
    const candidate = testCandidate('op:mcp:never-adapted:v1')
    await rejectedWithCode(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
      'CANDIDATE_NOT_ADMISSIBLE',
    )
    expect(executed).toBe(false)
  })

  it('rejects candidates whose effect or verifier no longer matches the adapted tool', async () => {
    let executed = false
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          executed = true
          return 'ran'
        },
      },
    })
    const tool = adapter.adaptTool(readDef, 'verify:read:v1')
    const signal = (): AbortSignal => new AbortController().signal
    await rejectedWithCode(
      adapter.executeCandidate(
        testCandidate(tool.operationRef, 'write', 'verify:read:v1'),
        {},
        signal(),
      ),
      'CANDIDATE_NOT_ADMISSIBLE',
    )
    await rejectedWithCode(
      adapter.executeCandidate(
        testCandidate(tool.operationRef, 'read', 'verify:other:v9'),
        {},
        signal(),
      ),
      'CANDIDATE_NOT_ADMISSIBLE',
    )
    expect(executed).toBe(false)
  })

  it('validates nested properties without a redundant type keyword', async () => {
    let executed = false
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          executed = true
          return 'ran'
        },
      },
    })
    const tool = adapter.adaptTool(
      {
        name: 'read',
        description: 'read',
        mutates: false,
        inputSchema: { type: 'object', properties: { filters: { properties: { repo: { type: 'string' } } } } },
      },
      'v',
    )
    const candidate = testCandidate(tool.operationRef, 'read', 'v')
    await rejectedWithCode(
      adapter.executeCandidate(candidate, { filters: { repo: 42 } }, new AbortController().signal),
      'SCHEMA_VALIDATION_FAILED',
    )
    expect(executed).toBe(false)
    // A matching nested value still dispatches.
    const result = await adapter.executeCandidate(
      candidate,
      { filters: { repo: 'deepseek-harness' } },
      new AbortController().signal,
    )
    expect(result).toBe('ran')
  })

  it('enforces schema-valued additionalProperties', async () => {
    let executed = false
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          executed = true
          return 'ran'
        },
      },
    })
    const tool = adapter.adaptTool(
      {
        name: 'read',
        description: 'read',
        mutates: false,
        inputSchema: { type: 'object', additionalProperties: { type: 'string' } },
      },
      'v',
    )
    const candidate = testCandidate(tool.operationRef, 'read', 'v')
    await rejectedWithCode(
      adapter.executeCandidate(candidate, { repo: 42 }, new AbortController().signal),
      'SCHEMA_VALIDATION_FAILED',
    )
    expect(executed).toBe(false)
    const result = await adapter.executeCandidate(
      candidate,
      { repo: 'deepseek-harness' },
      new AbortController().signal,
    )
    expect(result).toBe('ran')
  })

  it('rejects input schemas with unsupported nested additionalProperties at adapt time', () => {
    const adapter = new McpAdapter({ executor: { execute: async () => null } })
    expect(() =>
      adapter.adaptTool(
        { ...readDef, inputSchema: { type: 'object', additionalProperties: { allOf: [] } } },
        'verify:read:v1',
      ),
    ).toThrow(/cannot validate/)
  })

  it('rejects non-MCP candidates', async () => {
    const adapter = new McpAdapter({ executor: { execute: async () => null } })
    const candidate = testCandidate('op:other:v1')
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/Not an MCP candidate/)
  })

  it('R26: never dispatches an already-cancelled MCP call', async () => {
    let executed = false
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          executed = true
          return null
        },
      },
    })
    const controller = new AbortController()
    controller.abort()
    const candidate = testCandidate('op:mcp:read-file:v1')
    await rejectedWithCode(adapter.executeCandidate(candidate, {}, controller.signal), 'TASK_CANCELLED')
    expect(executed).toBe(false)
  })

  it('R27: rejects write dispatch without a verification policy', async () => {
    let executed = false
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          executed = true
          return 'changed'
        },
      },
    })
    const candidate = testCandidate('op:mcp:write-file:v1', 'write', '')
    await rejectedWithCode(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
      'EFFECT_NOT_ALLOWED',
    )
    expect(executed).toBe(false)
  })

  it('R27: rejects external-effect dispatch without a verification policy', async () => {
    let executed = false
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          executed = true
          return 'changed'
        },
      },
    })
    const candidate = testCandidate('op:mcp:notify:v1', 'external', '   ')
    await rejectedWithCode(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
      'EFFECT_NOT_ALLOWED',
    )
    expect(executed).toBe(false)
  })

  it('R27: dispatches writes carrying a verification policy', async () => {
    const adapter = new McpAdapter({ executor: { execute: async () => 'written' } })
    const tool = adapter.adaptTool(writeDef, 'verify:write:v1')
    const result = await adapter.executeCandidate(
      testCandidate(tool.operationRef, 'write', 'verify:write:v1'),
      {},
      new AbortController().signal,
    )
    expect(result).toBe('written')
  })

  it('R28: rejects invalid MCP arguments before dispatch', async () => {
    let executed = false
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          executed = true
          return 'ran'
        },
      },
    })
    const tool = adapter.adaptTool(ciDef, 'verify-ci')
    const candidate = testCandidate(tool.operationRef, 'read', 'verify-ci')
    await rejectedWithCode(
      adapter.executeCandidate(candidate, { repo: 42 }, new AbortController().signal),
      'SCHEMA_VALIDATION_FAILED',
    )
    expect(executed).toBe(false)
  })

  it('R28: rejects missing required and unexpected arguments', async () => {
    const adapter = new McpAdapter({ executor: { execute: async () => 'ran' } })
    const tool = adapter.adaptTool(ciDef, 'verify-ci')
    const candidate = testCandidate(tool.operationRef, 'read', 'verify-ci')
    const signal = (): AbortSignal => new AbortController().signal
    await rejectedWithCode(adapter.executeCandidate(candidate, {}, signal()), 'SCHEMA_VALIDATION_FAILED')
    await rejectedWithCode(
      adapter.executeCandidate(candidate, { repo: 'x', extra: 1 }, signal()),
      'SCHEMA_VALIDATION_FAILED',
    )
  })

  it('R28: dispatches arguments that satisfy the input schema', async () => {
    const adapter = new McpAdapter({ executor: { execute: async (_target, args) => args } })
    const tool = adapter.adaptTool(ciDef, 'verify-ci')
    const result = await adapter.executeCandidate(
      testCandidate(tool.operationRef, 'read', 'verify-ci'),
      { repo: 'deepseek-harness' },
      new AbortController().signal,
    )
    expect(result).toEqual({ repo: 'deepseek-harness' })
  })

  it('reports failed writes as unknown outcomes, never exactly-once', async () => {
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          throw new Error('disk on fire')
        },
      },
    })
    const tool = adapter.adaptTool(writeDef, 'verify:write:v1')
    const error: unknown = await adapter
      .executeCandidate(
        testCandidate(tool.operationRef, 'write', 'verify:write:v1'),
        {},
        new AbortController().signal,
      )
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(System1Error)
    expect((error as System1Error).code).toBe('EXECUTION_UNKNOWN')
    expect((error as System1Error).message).toMatch(/reconcile/)
  })

  it('reports typed transport failures after a mutating dispatch as unknown outcomes', async () => {
    const inner = system1Error('PROVIDER_TIMEOUT', 'receipt lost')
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          throw inner
        },
      },
    })
    const tool = adapter.adaptTool(writeDef, 'verify:write:v1')
    await expect(
      adapter.executeCandidate(
        testCandidate(tool.operationRef, 'write', 'verify:write:v1'),
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' })
  })

  it('rethrows read failures unchanged', async () => {
    const failure = new Error('MCP down')
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          throw failure
        },
      },
    })
    const tool = adapter.adaptTool(readDef, 'verify:read:v1')
    await expect(
      adapter.executeCandidate(
        testCandidate(tool.operationRef, 'read', 'verify:read:v1'),
        {},
        new AbortController().signal,
      ),
    ).rejects.toBe(failure)
  })

  it('preserves structured errors thrown by the executor on read calls', async () => {
    const inner = system1Error('PROVIDER_TRANSPORT_FAILED', 'client exploded')
    const adapter = new McpAdapter({
      executor: {
        execute: async () => {
          throw inner
        },
      },
    })
    const tool = adapter.adaptTool(readDef, 'verify:read:v1')
    await expect(
      adapter.executeCandidate(
        testCandidate(tool.operationRef, 'read', 'verify:read:v1'),
        {},
        new AbortController().signal,
      ),
    ).rejects.toBe(inner)
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
    const tool = adapter.adaptTool({ ...readDef, name: 'failing-tool' }, 'v1')
    const candidate = testCandidate(tool.operationRef)

    // First failure: circuit closed.
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/MCP down/)
    expect(adapter.getCircuitState('mcp:failing-tool')).toBe('closed')

    // Second failure: circuit opens.
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/MCP down/)
    expect(adapter.getCircuitState('mcp:failing-tool')).toBe('open')
    expect(calls).toBe(2)

    // Third call: rejected without executing.
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/Circuit open/)
    expect(calls).toBe(2)
  })

  it('isolates circuits by namespaced tool identity', async () => {
    let calls = 0
    const executor: McpExecutor = {
      execute: async () => {
        calls++
        throw new Error('MCP down')
      },
    }
    const adapter = new McpAdapter({ executor, failureThreshold: 1 })
    const defA: McpToolDefinition = { ...readDef, name: 'deploy' }
    const toolA = adapter.adaptTool(defA, 'v', { serverId: 'a' })
    const toolB = adapter.adaptTool(defA, 'v', { serverId: 'b' })
    const signal = (): AbortSignal => new AbortController().signal

    await expect(
      adapter.executeCandidate(testCandidate(toolA.operationRef, 'read', 'v'), {}, signal()),
    ).rejects.toThrow(/MCP down/)
    expect(adapter.getCircuitState('mcp:a:deploy')).toBe('open')
    // Same tool name on another server keeps its own closed circuit.
    expect(adapter.getCircuitState('mcp:b:deploy')).toBe('closed')

    await expect(
      adapter.executeCandidate(testCandidate(toolB.operationRef, 'read', 'v'), {}, signal()),
    ).rejects.toThrow(/MCP down/)
    expect(calls).toBe(2)
    expect(adapter.getCircuitState('mcp:b:deploy')).toBe('open')
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
    const tool = adapter.adaptTool({ ...readDef, name: 'flaky' }, 'v1')
    const candidate = testCandidate(tool.operationRef)

    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/down/)
    expect(adapter.getCircuitState('mcp:flaky')).toBe('open')

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
    expect(adapter.getCircuitState('mcp:flaky')).toBe('closed')
  })

  it('admits exactly one concurrent half-open trial', async () => {
    let calls = 0
    let releaseTrial!: () => void
    const trialGate = new Promise<void>((resolve) => {
      releaseTrial = resolve
    })
    const executor: McpExecutor = {
      execute: async () => {
        calls++
        if (calls === 1) throw new Error('offline')
        await trialGate
        return 'ok'
      },
    }
    let now = 0
    const adapter = new McpAdapter({
      executor,
      failureThreshold: 1,
      resetTimeoutMs: 1,
      now: () => now,
    })
    const tool = adapter.adaptTool({ ...readDef, name: 'read' }, 'v')
    const candidate = testCandidate(tool.operationRef, 'read', 'v')
    const signal = (): AbortSignal => new AbortController().signal

    await expect(adapter.executeCandidate(candidate, {}, signal())).rejects.toThrow(/offline/)
    expect(adapter.getCircuitState('mcp:read')).toBe('open')

    now = 2
    const first = adapter.executeCandidate(candidate, {}, signal())
    // The second concurrent call must reject without dispatching.
    await rejectedWithCode(adapter.executeCandidate(candidate, {}, signal()), 'PROVIDER_TRANSPORT_FAILED')
    expect(calls).toBe(2)
    releaseTrial()
    await expect(first).resolves.toBe('ok')
    expect(adapter.getCircuitState('mcp:read')).toBe('closed')
  })

  it('keeps the circuit open when a half-open trial fails', async () => {
    const executor: McpExecutor = {
      execute: async () => {
        throw new Error('still down')
      },
    }
    let now = 0
    const adapter = new McpAdapter({
      executor,
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: () => now,
    })
    const tool = adapter.adaptTool({ ...readDef, name: 'flaky' }, 'v1')
    const candidate = testCandidate(tool.operationRef)
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/still down/)
    expect(adapter.getCircuitState('mcp:flaky')).toBe('open')
    now = 1500
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/still down/)
    // A failed trial reopens the circuit instead of admitting more traffic.
    expect(adapter.getCircuitState('mcp:flaky')).toBe('open')
    now = 1600
    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/Circuit open/)
  })

  it('propagates abort to MCP execution', async () => {
    let receivedSignal: AbortSignal | null = null
    const executor: McpExecutor = {
      execute: async (_target, _args, signal) => {
        receivedSignal = signal
        // Wait until aborted.
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return null
      },
    }
    const adapter = new McpAdapter({ executor })
    const tool = adapter.adaptTool({ ...readDef, name: 'slow' }, 'v1')
    const candidate = testCandidate(tool.operationRef)
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
      execute: async (_target, _args, signal) => {
        // Never resolves unless aborted.
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('timeout-aborted')), { once: true })
        })
        return null
      },
    }
    const adapter = new McpAdapter({ executor, callTimeoutMs: 10 })
    const tool = adapter.adaptTool({ ...readDef, name: 'slow' }, 'v1')
    const candidate = testCandidate(tool.operationRef)

    await expect(
      adapter.executeCandidate(candidate, {}, new AbortController().signal),
    ).rejects.toThrow(/timeout-aborted/)
  })

  it('returns closed for unknown tools', () => {
    const adapter = new McpAdapter({ executor: { execute: async () => null } })
    expect(adapter.getCircuitState('mcp:unknown')).toBe('closed')
  })
})

describe('checkSchemaSupport', () => {
  it('accepts boolean schemas', () => {
    expect(checkSchemaSupport(true)).toEqual([])
    expect(checkSchemaSupport(false)).toEqual([])
  })

  it('rejects non-object schemas', () => {
    expect(checkSchemaSupport('nope')).toHaveLength(1)
  })

  it('accepts the supported subset and ignores annotations', () => {
    expect(
      checkSchemaSupport({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 't',
        description: 'd',
        default: 1,
        examples: [1],
        type: 'object',
        properties: { n: { type: 'integer' } },
        required: ['n'],
        additionalProperties: false,
      }),
    ).toEqual([])
  })

  it('rejects unsupported keywords at the top level and nested', () => {
    expect(checkSchemaSupport({ type: 'object', $ref: '#/$defs/x' })).toHaveLength(1)
    expect(
      checkSchemaSupport({ type: 'object', properties: { n: { allOf: [] } } }),
    ).toHaveLength(1)
    expect(checkSchemaSupport({ type: 'array', items: { $ref: '#/$defs/x' } })).toHaveLength(1)
  })

  it('inspects nested boolean and absent item schemas without failing', () => {
    expect(
      checkSchemaSupport({ type: 'object', properties: { flag: true } }),
    ).toEqual([])
    expect(checkSchemaSupport({ type: 'array' })).toEqual([])
  })
})

describe('validateJsonSchemaArgs', () => {
  it('fails closed on unsupported schemas', () => {
    expect(validateJsonSchemaArgs({ $ref: '#/$defs/x' }, {})).toHaveLength(1)
  })

  it('handles boolean and malformed schemas', () => {
    expect(validateJsonSchemaArgs(true, { anything: 1 })).toEqual([])
    expect(validateJsonSchemaArgs(false, { anything: 1 })).toHaveLength(1)
    expect(validateJsonSchemaArgs('nope', {})).toHaveLength(1)
  })

  it('accepts schemas without a type', () => {
    expect(validateJsonSchemaArgs({}, 42)).toEqual([])
  })

  it('validates const and enum', () => {
    expect(validateJsonSchemaArgs({ const: 'a' }, 'a')).toEqual([])
    expect(validateJsonSchemaArgs({ const: 'a' }, 'b')).toHaveLength(1)
    expect(validateJsonSchemaArgs({ enum: ['a', 'b'] }, 'b')).toEqual([])
    expect(validateJsonSchemaArgs({ enum: ['a', 'b'] }, 'c')).toHaveLength(1)
    expect(validateJsonSchemaArgs({ enum: 'a' }, 'a')).toHaveLength(1)
  })

  it('validates primitive types', () => {
    const cases: Array<[unknown, unknown, boolean]> = [
      [{ type: 'string' }, 'x', true],
      [{ type: 'string' }, 42, false],
      [{ type: 'number' }, 1.5, true],
      [{ type: 'number' }, 'x', false],
      [{ type: 'boolean' }, true, true],
      [{ type: 'boolean' }, 1, false],
      [{ type: 'integer' }, 3, true],
      [{ type: 'integer' }, 1.5, false],
      [{ type: 'integer' }, 'x', false],
      [{ type: 'null' }, null, true],
      [{ type: 'null' }, 0, false],
      [{ type: 'weird' }, 1, false],
    ]
    for (const [schema, value, valid] of cases) {
      expect(validateJsonSchemaArgs(schema, value)).toHaveLength(valid ? 0 : 1)
    }
  })

  it('validates objects', () => {
    const schema = {
      type: 'object',
      required: ['repo'],
      properties: { repo: { type: 'string' }, count: { type: 'integer' } },
      additionalProperties: false,
    }
    expect(validateJsonSchemaArgs(schema, { repo: 'x', count: 2 })).toEqual([])
    expect(validateJsonSchemaArgs(schema, { repo: 'x' })).toEqual([])
    expect(validateJsonSchemaArgs(schema, { count: 2 })).toHaveLength(1)
    expect(validateJsonSchemaArgs(schema, { repo: 'x', extra: true })).toHaveLength(1)
    expect(validateJsonSchemaArgs(schema, { repo: 42 })).toHaveLength(1)
    expect(validateJsonSchemaArgs(schema, [1])).toHaveLength(1)
    expect(validateJsonSchemaArgs(schema, null)).toHaveLength(1)
  })

  it('validates objects with open additional properties', () => {
    expect(validateJsonSchemaArgs({ type: 'object' }, { anything: 1 })).toEqual([])
    expect(
      validateJsonSchemaArgs({ type: 'object', additionalProperties: false }, { a: 1 }),
    ).toHaveLength(1)
    expect(
      validateJsonSchemaArgs({ type: 'object', additionalProperties: false }, {}),
    ).toEqual([])
  })

  it('applies object keywords by instance type even without a type keyword', () => {
    const schema = { properties: { filters: { properties: { repo: { type: 'string' } } } } }
    expect(validateJsonSchemaArgs(schema, { filters: { repo: 'x' } })).toEqual([])
    const violations = validateJsonSchemaArgs(schema, { filters: { repo: 42 } })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/repo/)
    // Non-object instances ignore object keywords.
    expect(validateJsonSchemaArgs(schema, 'not-an-object')).toEqual([])
    expect(validateJsonSchemaArgs({ required: ['a'] }, ['a'])).toEqual([])
  })

  it('applies array items by instance type even without a type keyword', () => {
    const schema = { items: { type: 'string' } }
    expect(validateJsonSchemaArgs(schema, ['a', 'b'])).toEqual([])
    expect(validateJsonSchemaArgs(schema, ['a', 1])).toHaveLength(1)
    expect(validateJsonSchemaArgs(schema, {})).toEqual([])
  })

  it('validates schema-valued additionalProperties', () => {
    const schema = { type: 'object', additionalProperties: { type: 'string' } }
    expect(validateJsonSchemaArgs(schema, { repo: 'x' })).toEqual([])
    expect(validateJsonSchemaArgs(schema, { repo: 42 })).toHaveLength(1)
    expect(validateJsonSchemaArgs(schema, {})).toEqual([])
    // Named properties are not treated as additional.
    const named = {
      type: 'object',
      properties: { count: { type: 'integer' } },
      additionalProperties: { type: 'string' },
    }
    expect(validateJsonSchemaArgs(named, { count: 2, note: 'ok' })).toEqual([])
    expect(validateJsonSchemaArgs(named, { count: 2, note: 7 })).toHaveLength(1)
    expect(validateJsonSchemaArgs({ additionalProperties: { type: 'string' } }, { repo: 42 })).toHaveLength(1)
  })

  it('rejects unsupported keywords nested in additionalProperties', () => {
    expect(
      checkSchemaSupport({ type: 'object', additionalProperties: { allOf: [] } }),
    ).toHaveLength(1)
    expect(
      checkSchemaSupport({ type: 'object', additionalProperties: { type: 'string' } }),
    ).toEqual([])
  })

  it('tolerates malformed object keywords without crashing', () => {
    expect(validateJsonSchemaArgs({ type: 'object', required: 'repo' }, {})).toEqual([])
    expect(validateJsonSchemaArgs({ type: 'object', required: [42] }, {})).toEqual([])
    expect(validateJsonSchemaArgs({ type: 'object', properties: 42 }, { a: 1 })).toEqual([])
  })

  it('rejects malformed nested schemas', () => {
    expect(
      validateJsonSchemaArgs({ type: 'object', properties: { x: 'nope' } }, { x: 1 }),
    ).toHaveLength(1)
    expect(
      validateJsonSchemaArgs({ type: 'object', properties: { x: false } }, { x: 1 }),
    ).toHaveLength(1)
    expect(
      validateJsonSchemaArgs({ type: 'object', properties: { x: true } }, { x: 1 }),
    ).toEqual([])
  })

  it('validates arrays', () => {
    expect(validateJsonSchemaArgs({ type: 'array', items: { type: 'string' } }, ['a', 'b'])).toEqual([])
    expect(
      validateJsonSchemaArgs({ type: 'array', items: { type: 'string' } }, ['a', 1]),
    ).toHaveLength(1)
    expect(validateJsonSchemaArgs({ type: 'array' }, [1, 'a'])).toEqual([])
    expect(validateJsonSchemaArgs({ type: 'array' }, [])).toEqual([])
    expect(validateJsonSchemaArgs({ type: 'array' }, {})).toHaveLength(1)
  })

  it('validates nested structures with paths', () => {
    const schema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    }
    const violations = validateJsonSchemaArgs(schema, { tags: ['ok', 42] })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/tags\[1\]/)
  })
})
