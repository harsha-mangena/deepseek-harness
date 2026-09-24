/**
 * MCP tool adapter with resilience and controlled mutations.
 *
 * Adapts MCP tool definitions to System 1 catalog tools. Resilience:
 * - Circuit breaker per tool identity (opens after N consecutive failures)
 * - Per-call timeout
 * - The MCP client owns reconnection; this adapter does not retry
 *   transport failures (to avoid amplifying outages).
 *
 * Controlled execution: every dispatch runs pre-dispatch checks in order:
 * 1. Cancellation: an already-aborted caller signal rejects before dispatch.
 * 2. Identity: the candidate must reference an MCP tool identity.
 * 3. Verification policy: non-read effects require a verification policy ID.
 * 4. Argument validation: arguments are validated against the tool's
 *    inputSchema (supported JSON Schema subset, see ./json-schema.ts).
 *
 * Controlled mutations:
 * - Write/external effects are allowed only with an explicit verification policy.
 * - A failed mutating call reports EXECUTION_UNKNOWN: the adapter never
 *   claims exactly-once. The caller must reconcile before retrying.
 *
 * @module @deepseek-ai/dsh-system1-mcp/adapter
 */

import { System1Error, system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type { Candidate, Effect } from '@deepseek-ai/dsh-system1-contracts'
import type { CatalogTool } from '@deepseek-ai/dsh-system1-observations'
import { checkSchemaSupport, validateJsonSchemaArgs } from './json-schema.ts'

/** An MCP tool definition (simplified). */
export interface McpToolDefinition {
  readonly name: string
  readonly description: string
  /** Whether this tool mutates state. */
  readonly mutates: boolean
  /** JSON schema for arguments (opaque). */
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** Options for {@link McpAdapter.adaptTool}. */
export interface McpAdaptOptions {
  /**
   * MCP server identity. Namespaced into the tool identity
   * (`mcp:<serverId>:<name>`) and the operationRef. Omit for the legacy
   * unnamespaced identity (`mcp:<name>`).
   */
  readonly serverId?: string
  /** Catalog generation embedded in the operationRef. Defaults to `'v1'`. */
  readonly catalogVersion?: string
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

/** Tool record retained by the adapter for pre-dispatch validation. */
interface AdaptedTool {
  readonly toolName: string
  readonly toolIdentity: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** Adapts MCP tools with circuit breaking. */
export class McpAdapter {
  private readonly executor: McpExecutor
  private readonly failureThreshold: number
  private readonly resetTimeoutMs: number
  private readonly callTimeoutMs: number
  private readonly now: () => number
  private readonly circuits = new Map<string, { failures: number; state: CircuitState; openedAt: number }>()
  /** inputSchema registry keyed by operationRef, for pre-dispatch argument validation. */
  private readonly adaptedTools = new Map<string, AdaptedTool>()

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
   *
   * The tool identity namespaces server and catalog generation:
   * `mcp:<name>` (or `mcp:<serverId>:<name>`) with operationRef
   * `op:mcp:<name>:<catalogVersion>` (or
   * `op:mcp:<serverId>:<name>:<catalogVersion>`). Omitting the options keeps
   * the legacy `mcp:<name>` / `op:mcp:<name>:v1` shape.
   *
   * The inputSchema is retained for pre-dispatch argument validation. Schemas
   * outside the supported subset are rejected here, failing loud at adapt
   * time rather than silently skipping validation at dispatch.
   * @param def - MCP tool definition.
   * @param verificationPolicyId - verification policy for this tool.
   * @param options - server identity and catalog generation.
   * @returns the catalog tool.
   */
  adaptTool(def: McpToolDefinition, verificationPolicyId: string, options: McpAdaptOptions = {}): CatalogTool {
    const unsupported = checkSchemaSupport(def.inputSchema)
    if (unsupported.length > 0) {
      throw system1Error(
        'SCHEMA_VALIDATION_FAILED',
        `MCP tool "${def.name}" has an inputSchema the adapter cannot validate`,
        { toolName: def.name, violations: unsupported },
      )
    }
    const effect: Effect = def.mutates ? 'write' : 'read'
    const catalogVersion = options.catalogVersion ? options.catalogVersion : 'v1'
    const toolIdentity = options.serverId ? `mcp:${options.serverId}:${def.name}` : `mcp:${def.name}`
    const operationRef = options.serverId
      ? `op:mcp:${options.serverId}:${def.name}:${catalogVersion}`
      : `op:mcp:${def.name}:${catalogVersion}`
    this.adaptedTools.set(operationRef, { toolName: def.name, toolIdentity, inputSchema: def.inputSchema })
    return {
      toolId: toolIdentity,
      label: def.description,
      route: 'tool',
      effect,
      operationRef,
      preconditions: { inputSchema: def.inputSchema },
      verificationPolicyId,
    }
  }

  /**
   * Execute a candidate via MCP with controlled pre-dispatch checks, circuit
   * breaking, and timeout.
   *
   * Checks run in order: caller cancellation, MCP identity, verification
   * policy for mutating effects, then argument validation. The caller signal
   * still aborts a dispatched call mid-flight. A failed mutating call reports
   * EXECUTION_UNKNOWN: the adapter never claims exactly-once.
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
    // 1. Cancellation: an already-aborted caller never reaches the executor.
    if (signal.aborted) {
      throw system1Error('TASK_CANCELLED', 'MCP dispatch cancelled before dispatch', {
        candidateId: candidate.id,
      })
    }

    // 2. Identity: op:mcp:<name>:<catalog> or op:mcp:<server>:<name>:<catalog>.
    const match = /^op:mcp:(?:([^:]+):)?([^:]+):([^:]+)$/.exec(candidate.operationRef)
    const toolName = match?.[2]
    if (!match || !toolName) {
      throw system1Error('CANDIDATE_NOT_ADMISSIBLE', 'Not an MCP candidate', {
        candidateId: candidate.id,
      })
    }
    const serverId = match[1]
    const toolIdentity = serverId ? `mcp:${serverId}:${toolName}` : `mcp:${toolName}`

    // 3. Verification policy: only read effects may dispatch without one.
    if (candidate.effect !== 'read' && candidate.verificationPolicyId.trim() === '') {
      throw system1Error(
        'EFFECT_NOT_ALLOWED',
        `MCP ${candidate.effect} effect requires a verification policy`,
        { candidateId: candidate.id, effect: candidate.effect },
      )
    }

    // 4. Argument validation against the schema retained by adaptTool.
    const adapted = this.adaptedTools.get(candidate.operationRef)
    if (adapted) {
      const violations = validateJsonSchemaArgs(adapted.inputSchema, args)
      if (violations.length > 0) {
        throw system1Error(
          'SCHEMA_VALIDATION_FAILED',
          `MCP arguments failed input schema validation for ${toolIdentity}`,
          { candidateId: candidate.id, toolIdentity, violations },
        )
      }
    }

    // 5. Circuit breaker, keyed by namespaced tool identity.
    const circuit = this.circuits.get(toolIdentity)
    if (circuit && circuit.state === 'open') {
      if (this.now() - circuit.openedAt < this.resetTimeoutMs) {
        throw system1Error('PROVIDER_TRANSPORT_FAILED', `Circuit open for ${toolIdentity}`, {
          toolIdentity,
        })
      }
      // Half-open: allow one trial.
      circuit.state = 'half-open'
    }

    // 6. Dispatch with timeout; the caller signal still aborts mid-flight.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.callTimeoutMs)
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const result = await this.executor.execute(toolName, args, controller.signal)
      // Success: reset circuit.
      this.circuits.delete(toolIdentity)
      return result
    } catch (error) {
      // Failure: record and possibly open circuit.
      const current = this.circuits.get(toolIdentity) ?? { failures: 0, state: 'closed' as CircuitState, openedAt: 0 }
      const failures = current.failures + 1
      if (failures >= this.failureThreshold) {
        this.circuits.set(toolIdentity, { failures, state: 'open', openedAt: this.now() })
      } else {
        this.circuits.set(toolIdentity, { failures, state: current.state, openedAt: current.openedAt })
      }
      if (error instanceof System1Error) {
        throw error
      }
      if (candidate.effect !== 'read') {
        // No exactly-once: the mutation may have applied before the failure.
        throw system1Error(
          'EXECUTION_UNKNOWN',
          `MCP ${candidate.effect} call failed with unknown outcome; reconcile before retrying`,
          { candidateId: candidate.id, toolIdentity, cause: String(error) },
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Get the circuit state for a tool.
   * @param toolIdentity - MCP tool identity as returned by adaptTool
   * (`mcp:<name>` or `mcp:<serverId>:<name>`).
   * @returns the circuit state, or 'closed' if no circuit.
   */
  getCircuitState(toolIdentity: string): CircuitState {
    return this.circuits.get(toolIdentity)?.state ?? 'closed'
  }
}
