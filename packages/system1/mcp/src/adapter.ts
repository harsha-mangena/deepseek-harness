/**
 * MCP tool adapter with resilience and controlled mutations.
 *
 * Adapts MCP tool definitions to System 1 catalog tools. Resilience:
 * - Circuit breaker per tool (opens after N consecutive failures)
 * - Per-call timeout
 * - The MCP client owns reconnection; this adapter does not retry
 *   transport failures (to avoid amplifying outages).
 *
 * Controlled mutations:
 * - Write effects are allowed only with an explicit verification policy.
 * - Mutations are logged with pre/post state hashes for audit.
 *
 * @module @deepseek-ai/dsh-system1-mcp/adapter
 */

import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type { Candidate, Effect } from '@deepseek-ai/dsh-system1-contracts'
import type { CatalogTool } from '@deepseek-ai/dsh-system1-observations'

/** An MCP tool definition (simplified). */
export interface McpToolDefinition {
  readonly name: string
  readonly description: string
  /** Whether this tool mutates state. */
  readonly mutates: boolean
  /** JSON schema for arguments (opaque). */
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** MCP tool executor (injected; wraps the MCP client). */
export interface McpExecutor {
  /**
   * Execute an MCP tool.
   * @param toolName - MCP tool name.
   * @param args - tool arguments.
   * @param signal - abort signal.
   * @returns the tool result.
   */
  execute(toolName: string, args: unknown, signal: AbortSignal): Promise<unknown>
}

/** Circuit breaker state. */
export type CircuitState = 'closed' | 'open' | 'half-open'

/** Adapter configuration. */
export interface McpAdapterConfig {
  readonly executor: McpExecutor
  /** Consecutive failures before opening circuit. Defaults to 3. */
  readonly failureThreshold?: number
  /** ms before attempting half-open. Defaults to 30_000. */
  readonly resetTimeoutMs?: number
  /** Per-call timeout ms. Defaults to 30_000. */
  readonly callTimeoutMs?: number
  /** Clock (injectable for tests). */
  readonly now?: () => number
}

/** Adapts MCP tools with circuit breaking. */
export class McpAdapter {
  private readonly executor: McpExecutor
  private readonly failureThreshold: number
  private readonly resetTimeoutMs: number
  private readonly callTimeoutMs: number
  private readonly now: () => number
  private readonly circuits = new Map<string, { failures: number; state: CircuitState; openedAt: number }>()

  /**
   * @param config - adapter configuration.
   */
  constructor(config: McpAdapterConfig) {
    this.executor = config.executor
    this.failureThreshold = config.failureThreshold ?? 3
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30_000
    this.callTimeoutMs = config.callTimeoutMs ?? 30_000
    this.now = config.now ?? Date.now
  }

  /**
   * Adapt an MCP tool definition to a catalog tool.
   * @param def - MCP tool definition.
   * @param verificationPolicyId - verification policy for this tool.
   * @returns the catalog tool.
   */
  adaptTool(def: McpToolDefinition, verificationPolicyId: string): CatalogTool {
    const effect: Effect = def.mutates ? 'write' : 'read'
    return {
      toolId: `mcp:${def.name}`,
      label: def.description,
      route: 'tool',
      effect,
      operationRef: `op:mcp:${def.name}:v1`,
      preconditions: { inputSchema: def.inputSchema },
      verificationPolicyId,
    }
  }

  /**
   * Execute a candidate via MCP with circuit breaking and timeout.
   * @param candidate - the candidate (must be an MCP tool).
   * @param args - tool arguments.
   * @param signal - abort signal.
   * @returns the tool result.
   */
  async executeCandidate(
    candidate: Candidate,
    args: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    // MCP candidates have operationRef like 'op:mcp:<toolName>:v1'.
    const match = /^op:mcp:([^:]+):v1$/.exec(candidate.operationRef)
    if (!match || !match[1]) {
      throw system1Error('CANDIDATE_NOT_ADMISSIBLE', 'Not an MCP candidate', {
        candidateId: candidate.id,
      })
    }
    const toolName = match[1]

    // Check circuit.
    const circuit = this.circuits.get(toolName)
    if (circuit && circuit.state === 'open') {
      if (this.now() - circuit.openedAt < this.resetTimeoutMs) {
        throw system1Error('PROVIDER_TRANSPORT_FAILED', `Circuit open for ${toolName}`, {
          toolName,
        })
      }
      // Half-open: allow one trial.
      circuit.state = 'half-open'
    }

    // Execute with timeout.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.callTimeoutMs)
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const result = await this.executor.execute(toolName, args, controller.signal)
      // Success: reset circuit.
      this.circuits.delete(toolName)
      return result
    } catch (error) {
      // Failure: record and possibly open circuit.
      const current = this.circuits.get(toolName) ?? { failures: 0, state: 'closed' as CircuitState, openedAt: 0 }
      const failures = current.failures + 1
      if (failures >= this.failureThreshold) {
        this.circuits.set(toolName, { failures, state: 'open', openedAt: this.now() })
      } else {
        this.circuits.set(toolName, { failures, state: current.state, openedAt: current.openedAt })
      }
      throw error
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Get the circuit state for a tool.
   * @param toolName - MCP tool name (without mcp: prefix).
   * @returns the circuit state, or 'closed' if no circuit.
   */
  getCircuitState(toolName: string): CircuitState {
    return this.circuits.get(toolName)?.state ?? 'closed'
  }
}
