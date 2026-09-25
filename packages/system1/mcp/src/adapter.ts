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
 * 4. Registration: the operationRef must resolve to a tool adapted by this
 *    adapter; unknown or stale operationRefs are rejected with zero executor
 *    calls, and the candidate's effect and verification policy must match the
 *    adapted record (schema, effect, verifier, server, and catalog generation
 *    stay bound together).
 * 5. Argument validation: arguments are validated against the tool's
 *    inputSchema (supported JSON Schema subset, see ./json-schema.ts). The
 *    validated argument object is dispatched unchanged.
 * 6. Circuit: a half-open circuit admits exactly one trial at a time.
 *
 * Controlled mutations:
 * - Write/external effects are allowed only with an explicit verification policy.
 * - A failed mutating call reports EXECUTION_UNKNOWN: the adapter never
 *   claims exactly-once. The caller must reconcile before retrying. Effect
 *   certainty is derived from the dispatch phase and the candidate's effect,
 *   not from the error class: any failure after a mutating dispatch is
 *   unknown, including typed transport errors.
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

/** Dispatch target: an MCP tool plus its server and catalog binding. */
export interface McpDispatchTarget {
  /** MCP tool name on the server. */
  readonly toolName: string
  /** Namespaced tool identity (`mcp:<name>` or `mcp:<serverId>:<name>`). */
  readonly toolIdentity: string
  /** MCP server identity, when the tool was adapted with one. */
  readonly serverId?: string
  /** Catalog generation embedded in the operationRef. */
  readonly catalogVersion: string
}

/** MCP tool executor (injected; wraps the MCP client). */
export interface McpExecutor {
  /**
   * Execute an MCP tool.
   * @param target - tool, server, and catalog binding from the adapter registry.
   * @param args - tool arguments (the exact object that passed validation).
   * @param signal - abort signal.
   * @returns the tool result.
   */
  execute(target: McpDispatchTarget, args: unknown, signal: AbortSignal): Promise<unknown>
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
  readonly serverId: string | undefined
  readonly catalogVersion: string
  readonly effect: Effect
  readonly verificationPolicyId: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** Circuit breaker record. `halfOpenTrial` reserves the single half-open trial. */
interface Circuit {
  failures: number
  state: CircuitState
  openedAt: number
  halfOpenTrial: boolean
}

/** Adapts MCP tools with circuit breaking. */
export class McpAdapter {
  private readonly executor: McpExecutor
  private readonly failureThreshold: number
  private readonly resetTimeoutMs: number
  private readonly callTimeoutMs: number
  private readonly now: () => number
  private readonly circuits = new Map<string, Circuit>()
  /** Authoritative operation registry keyed by operationRef. */
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
    this.adaptedTools.set(operationRef, {
      toolName: def.name,
      toolIdentity,
      serverId: options.serverId,
      catalogVersion,
      effect,
      verificationPolicyId,
      inputSchema: def.inputSchema,
    })
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
   * policy for mutating effects, authoritative operation registration,
   * candidate-metadata binding, then argument validation. The caller signal
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

    // 3. Verification policy: only read effects may dispatch without one.
    if (candidate.effect !== 'read' && candidate.verificationPolicyId.trim() === '') {
      throw system1Error(
        'EFFECT_NOT_ALLOWED',
        `MCP ${candidate.effect} effect requires a verification policy`,
        { candidateId: candidate.id, effect: candidate.effect },
      )
    }

    // 4. Authoritative registration: the operationRef must resolve to a tool
    // adapted by this adapter. Unknown or stale refs never reach the executor.
    const adapted = this.adaptedTools.get(candidate.operationRef)
    if (!adapted) {
      throw system1Error(
        'CANDIDATE_NOT_ADMISSIBLE',
        `Unknown MCP operationRef ${candidate.operationRef}: the tool was never adapted by this adapter`,
        { candidateId: candidate.id, operationRef: candidate.operationRef },
      )
    }

    // 5. Metadata binding: the candidate must carry the adapted tool's effect
    // and verification policy, so a stale or forged candidate cannot dispatch
    // under different authority. Server, catalog generation, and tool name are
    // bound by the exact operationRef lookup above.
    if (candidate.effect !== adapted.effect || candidate.verificationPolicyId !== adapted.verificationPolicyId) {
      throw system1Error(
        'CANDIDATE_NOT_ADMISSIBLE',
        `MCP candidate metadata does not match the adapted tool ${adapted.toolIdentity}`,
        {
          candidateId: candidate.id,
          operationRef: candidate.operationRef,
          expectedEffect: adapted.effect,
          expectedVerificationPolicyId: adapted.verificationPolicyId,
        },
      )
    }

    // 6. Argument validation against the schema retained by adaptTool. The
    // validated `args` object is dispatched unchanged below.
    const violations = validateJsonSchemaArgs(adapted.inputSchema, args)
    if (violations.length > 0) {
      throw system1Error(
        'SCHEMA_VALIDATION_FAILED',
        `MCP arguments failed input schema validation for ${adapted.toolIdentity}`,
        { candidateId: candidate.id, toolIdentity: adapted.toolIdentity, violations },
      )
    }

    // 7. Circuit breaker, keyed by namespaced tool identity. A half-open
    // circuit admits exactly one concurrent trial; further trials reject
    // without dispatching.
    const toolIdentity = adapted.toolIdentity
    const circuit = this.circuits.get(toolIdentity)
    if (circuit?.state === 'open') {
      if (this.now() - circuit.openedAt < this.resetTimeoutMs) {
        throw system1Error('PROVIDER_TRANSPORT_FAILED', `Circuit open for ${toolIdentity}`, {
          toolIdentity,
        })
      }
      circuit.state = 'half-open'
      circuit.halfOpenTrial = false
    }
    if (circuit?.state === 'half-open') {
      if (circuit.halfOpenTrial) {
        throw system1Error(
          'PROVIDER_TRANSPORT_FAILED',
          `Circuit half-open trial already in progress for ${toolIdentity}`,
          { toolIdentity },
        )
      }
      circuit.halfOpenTrial = true
    }

    // 8. Dispatch with timeout; the caller signal still aborts mid-flight.
    // `dispatched` records the dispatch phase so effect certainty is derived
    // from whether the executor was reached, not from the error class.
    const target: McpDispatchTarget = {
      toolName: adapted.toolName,
      toolIdentity,
      catalogVersion: adapted.catalogVersion,
      ...(adapted.serverId === undefined ? {} : { serverId: adapted.serverId }),
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.callTimeoutMs)
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    let dispatched = false

    try {
      dispatched = true
      const result = await this.executor.execute(target, args, controller.signal)
      // Success: reset circuit.
      this.circuits.delete(toolIdentity)
      return result
    } catch (error) {
      // Failure: record and possibly open circuit. A failed half-open trial
      // reopens immediately regardless of the failure threshold.
      const prior = this.circuits.get(toolIdentity)
      const failures = (prior?.failures ?? 0) + 1
      if (prior?.state === 'half-open' || failures >= this.failureThreshold) {
        this.circuits.set(toolIdentity, { failures, state: 'open', openedAt: this.now(), halfOpenTrial: false })
      } else {
        this.circuits.set(toolIdentity, { failures, state: 'closed', openedAt: prior?.openedAt ?? 0, halfOpenTrial: false })
      }
      if (dispatched && candidate.effect !== 'read') {
        // No exactly-once: the mutation may have applied before the failure.
        // Effect certainty comes from the dispatch phase and effect class, so
        // even typed transport errors report unknown here.
        throw system1Error(
          'EXECUTION_UNKNOWN',
          `MCP ${candidate.effect} call failed with unknown outcome; reconcile before retrying`,
          {
            candidateId: candidate.id,
            toolIdentity,
            cause: String(error),
            errorCode: error instanceof System1Error ? error.code : undefined,
          },
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      const current = this.circuits.get(toolIdentity)
      /* istanbul ignore next -- defensive: success deletes the circuit and failure always resets it to open/closed, so it is never half-open here */
      if (current?.state === 'half-open') {
        current.halfOpenTrial = false
      }
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
