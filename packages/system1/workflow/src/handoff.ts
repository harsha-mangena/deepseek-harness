/**
 * Real DeepSeek handoff for System 1.
 *
 * A handoff transfers a bounded task from the System 1 coordinator to a real
 * DeepSeek child agent created through the coordinator's own agent registry —
 * the standard DeepSeek factory is used untouched; this module only shapes
 * the child's lineage, budget, initial context, and result contract.
 *
 * Lifecycle (fail-closed at every step):
 * 1. The bundle is runtime-validated (trust boundary: it crosses into a
 *    durable session and the child's model-visible context).
 * 2. Delegation depth is enforced: the child is created at
 *    `parentDepth + 1` and refused at or above {@link MAX_HANDOFF_DEPTH}.
 * 3. The remaining budget is reserved from the parent pool before the child
 *    exists; the hold is settled against measured usage on success and
 *    released (never consumed) on failure or cancellation.
 * 4. A durable `system1/handoff` event is appended to the parent session, so
 *    the transfer is reconstructable from the session log.
 * 5. The child is created with explicit `parentAgent` lineage,
 *    `meta.delegationDepth`, `meta.parentSession`, and `origin: 'subagent'`;
 *    its initial context is seeded with the bundle through the child's
 *    scoped system prompt, and it is driven through its real inbox.
 * 6. Parent cancellation propagates to the child via `agent.cancel()`.
 * 7. The child's final committed assistant message is parsed and validated
 *    against the bundle's return contract; invalid returns fail closed.
 * 8. The owned child handle is always disposed.
 *
 * @module @deepseek-ai/dsh-system1-workflow/handoff
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, UserMessage } from '@deepseek-ai/dsh-llm/types'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'

import type { System1ErrorCode } from '@deepseek-ai/dsh-system1-contracts'
import type { System1CoordinatorAgent } from './coordinator-agent.ts'
import { System1RequestId } from './request-id.ts'
import type { System1RequestId as System1RequestIdBrand } from './types.ts'

/** Maximum delegation depth for handoffs (mirrors the delegation package). */
export const MAX_HANDOFF_DEPTH = 5

/** Current handoff bundle schema version. */
export const HANDOFF_SCHEMA_VERSION = 1 as const

/**
 * Minimal budget-ledger surface the handoff needs. The production wiring
 * passes the coordination store's pool directly; tests may substitute a
 * scripted ledger.
 */
export interface HandoffBudgetLedger {
  reserve(
    tenantId: string,
    poolName: string,
    taskId: string,
    units: number,
    deadlineAt?: number,
  ): { reservationId: string; units: number }
  settle(reservationId: string, actualUnits: number): void
  release(reservationId: string, cancelled?: boolean): void
}

/** Budget remaining for the child, debited from the named parent pool. */
export interface HandoffBudget {
  readonly poolName: string
  /** Units reserved for the child before it is created. */
  readonly units: number
}

/** What the child must return for the handoff to validate. */
export interface HandoffReturnContract {
  /** Artifact references the child's result must include. */
  readonly requiredArtifacts: readonly string[]
  /** Evidence references the child's result must include. */
  readonly requiredEvidence: readonly string[]
}

/** The structured handoff bundle carried across the trust boundary. */
export interface HandoffBundle {
  readonly schemaVersion: typeof HANDOFF_SCHEMA_VERSION
  /** Stable id for this handoff; becomes the child's task identity. */
  readonly taskId: string
  /** The objective, in the child's own terms. */
  readonly objective: string
  /** Hard constraints the child must respect. */
  readonly constraints: readonly string[]
  /** Facts the parent accepts as established, with provenance. */
  readonly acceptedFacts: readonly { readonly fact: string; readonly provenance: string }[]
  /** Versions of external resources the facts were read from. */
  readonly resourceVersions: Record<string, string>
  /** Effects the parent already completed (must not be redone). */
  readonly completedEffects: readonly string[]
  /** Effects whose outcome is unknown (must be treated as pending). */
  readonly unknownEffects: readonly string[]
  /** Choices the parent tried and rejected, with reasons. */
  readonly failedChoices: readonly { readonly choice: string; readonly reason: string }[]
  /** Budget the child may consume. */
  readonly remainingBudget: HandoffBudget
  /** Verifier requirements the child must satisfy. */
  readonly verifierRequirements: readonly string[]
  /** What the child's result must contain. */
  readonly returnContract: HandoffReturnContract
}

// The schema's static input is `any`: the bundle crosses a trust boundary,
// so validation happens at runtime and the typed output is the contract.
// Every field is `.required()`: schemastery fields accept absent values by
// default, which would silently drop required bundle entries.
const HandoffBundleSchema: z<any, HandoffBundle> = z.object({
  schemaVersion: z.const(HANDOFF_SCHEMA_VERSION).required(),
  taskId: z.string().required(),
  objective: z.string().required(),
  constraints: z.array(z.string().required()).required(),
  acceptedFacts: z
    .array(z.object({ fact: z.string().required(), provenance: z.string().required() }).required())
    .required(),
  resourceVersions: z.dict(z.string().required()).required(),
  completedEffects: z.array(z.string().required()).required(),
  unknownEffects: z.array(z.string().required()).required(),
  failedChoices: z
    .array(z.object({ choice: z.string().required(), reason: z.string().required() }).required())
    .required(),
  remainingBudget: z
    .object({
      poolName: z.string().required(),
      units: z.number().required(),
    })
    .required(),
  verifierRequirements: z.array(z.string().required()).required(),
  returnContract: z
    .object({
      requiredArtifacts: z.array(z.string().required()).required(),
      requiredEvidence: z.array(z.string().required()).required(),
    })
    .required(),
})

/**
 * Runtime-validate an untrusted value as a {@link HandoffBundle}.
 *
 * @param data - value crossing the trust boundary.
 * @returns the validated bundle.
 * @throws when the value is not a well-formed bundle.
 */
export function parseHandoffBundle(data: unknown): HandoffBundle {
  return HandoffBundleSchema(data)
}

/** Options for {@link handoffToDeepSeek}. All capabilities are explicit. */
export interface HandoffOptions {
  /**
   * Tenant owning the budget pool. Never inferred or defaulted: budgeting
   * against the wrong tenant is a fail-closed misconfiguration.
   */
  readonly tenantId: string
  /** Budget ledger; the production wiring passes the coordination store. */
  readonly ledger: HandoffBudgetLedger
  /**
   * Delegation depth of the caller; the child is created at `parentDepth + 1`.
   * Defaults to 0 (a top-level handoff).
   */
  readonly parentDepth?: number
  /** Child session id generator (injectable for deterministic tests). */
  readonly newSessionId?: () => SessionId
  /**
   * Request id for the durable parent `system1/handoff` event. When absent,
   * the handoff correlates under its own task id.
   */
  readonly requestId?: System1RequestIdBrand
  /**
   * Extra setup run inside the child's unpublished scope after the handoff
   * bundle is seeded — e.g. worker tool restriction. Runs before the child
   * is published, so it can only shape the child's scoped world.
   */
  readonly setupExtras?: (agentCtx: Context, agent: Agent) => void | Promise<void>
}

/** Result parsed from the child's final committed assistant message. */
export interface HandoffChildResult {
  /** Artifact references the child produced. */
  readonly artifacts: readonly string[]
  /** Evidence references backing the result. */
  readonly evidence: readonly string[]
  /** Budget units the child reports as consumed. */
  readonly actualUnits: number
}

/** Outcome of {@link handoffToDeepSeek}. Never throws for expected failures. */
export type HandoffOutcome =
  | {
      readonly kind: 'completed'
      /** Validated artifact references returned by the child. */
      readonly artifacts: readonly string[]
      /** Validated evidence references returned by the child. */
      readonly evidence: readonly string[]
      /** Budget units settled against the parent pool. */
      readonly actualUnits: number
    }
  | {
      readonly kind: 'failed'
      /** Typed failure; one of the System 1 error codes. */
      readonly code: System1ErrorCode
      /** Human-readable reason; safe to surface. */
      readonly reason: string
    }

/**
 * Handler invoked by the production driver at escalation. The handler owns
 * the child lifecycle and budget and returns a typed outcome; a throwing
 * handler fails the turn closed as `escalated`.
 */
export type HandoffHandler = (
  coordinator: System1CoordinatorAgent,
  bundle: HandoffBundle,
  signal: AbortSignal,
) => Promise<HandoffOutcome>

/**
 * Render the handoff bundle as a system-prompt section. The section is
 * registered in the child's unpublished scope during setup, so the bundle is
 * part of the child's initial context and reconstructable from configuration.
 */
export function renderHandoffText(bundle: HandoffBundle): string {
  const lines = [
    `# System 1 handoff (task ${bundle.taskId})`,
    '',
    'You are a DeepSeek worker receiving a structured handoff from System 1.',
    `Objective: ${bundle.objective}`,
  ]
  if (bundle.constraints.length > 0) {
    lines.push('', 'Constraints:', ...bundle.constraints.map((c) => `- ${c}`))
  }
  if (bundle.acceptedFacts.length > 0) {
    lines.push(
      '',
      'Accepted facts (established; do not re-derive):',
      ...bundle.acceptedFacts.map((f) => `- ${f.fact} [${f.provenance}]`),
    )
  }
  if (bundle.completedEffects.length > 0) {
    lines.push('', 'Already completed (do not redo):', ...bundle.completedEffects.map((e) => `- ${e}`))
  }
  if (bundle.unknownEffects.length > 0) {
    lines.push('', 'Unknown outcome (treat as pending):', ...bundle.unknownEffects.map((e) => `- ${e}`))
  }
  if (bundle.failedChoices.length > 0) {
    lines.push(
      '',
      'Rejected choices (do not retry without new evidence):',
      ...bundle.failedChoices.map((f) => `- ${f.choice}: ${f.reason}`),
    )
  }
  lines.push(
    '',
    'When you finish, your final message MUST be a single JSON object with this shape:',
    '{"schemaVersion":1,"artifacts":[...],"evidence":[...],"actualUnits":<number>}',
    'where `artifacts` and `evidence` are string references and `actualUnits`',
    'is the budget you consumed.',
  )
  return lines.join('\n')
}

/**
 * Render the bundle as the driver input sent to the child through its real
 * inbox. The message is logged in the child's session, so the handoff is
 * durable on both sides of the transfer.
 */
export function renderHandoffMessage(bundle: HandoffBundle): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: renderHandoffText(bundle) }],
    source: { kind: 'user' },
  })
}

/**
 * Extract the structured child result from the child's session. The result
 * is the last committed `assistant/message` event; earlier messages (e.g.
 * progress notes) are ignored.
 *
 * @param session - the child's session after its run.
 * @returns the validated child result.
 * @throws when no final message exists or its content is not the result JSON.
 */
export function extractHandoffResult(session: Session): HandoffChildResult {
  for (const event of session.snapshotEvents().toReversed()) {
    if (event.type !== 'assistant/message') continue
    return parseChildResult(finalMessageText(event.data.message))
  }
  throw new Error('handoff child produced no assistant message')
}

/** Text of a final message: string content verbatim, otherwise joined text blocks. */
function finalMessageText(message: AssistantMessage): string {
  const content: unknown = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
    ) {
      text += block.text
    }
  }
  return text
}

const ChildResultSchema: z<any, HandoffChildResult> = z.object({
  schemaVersion: z.const(1).required(),
  artifacts: z.array(z.string().required()).required(),
  evidence: z.array(z.string().required()).required(),
  actualUnits: z.number().required(),
})

/**
 * Parse and validate the child's result JSON.
 *
 * @throws when the content is not a well-formed child result.
 */
export function parseChildResult(text: string): HandoffChildResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('handoff child final message is not JSON')
  }
  const parsed = ChildResultSchema(data)
  return { artifacts: parsed.artifacts, evidence: parsed.evidence, actualUnits: parsed.actualUnits }
}

/**
 * Check the child's result against the bundle's return contract.
 *
 * @returns the missing references; empty when the contract is satisfied.
 */
export function checkReturnContract(
  result: HandoffChildResult,
  contract: HandoffReturnContract,
): string[] {
  const missing: string[] = []
  for (const required of contract.requiredArtifacts) {
    if (!result.artifacts.includes(required)) missing.push(`artifact:${required}`)
  }
  for (const required of contract.requiredEvidence) {
    if (!result.evidence.includes(required)) missing.push(`evidence:${required}`)
  }
  return missing
}

/**
 * Hand a bounded task to a real DeepSeek child agent.
 *
 * The child is created through the coordinator's own agent registry, so the
 * standard DeepSeek factory is used untouched. Budget is reserved from the
 * parent pool before creation, settled against measured usage on success,
 * and released on failure or cancellation. Parent cancellation propagates
 * to the child; the owned child handle is always disposed.
 *
 * This function never throws for expected failures: invalid bundles, depth
 * violations, budget exhaustion, child failures, cancellations, and invalid
 * child returns are all reported as typed {@link HandoffOutcome} failures.
 *
 * @param coordinator - the System 1 coordinator owning the child.
 * @param bundle - the validated handoff bundle (re-validated at runtime).
 * @param signal - parent cancellation signal, propagated to the child.
 * @param options - explicit budget/depth/session capabilities.
 */
export async function handoffToDeepSeek(
  coordinator: System1CoordinatorAgent,
  bundle: HandoffBundle,
  signal: AbortSignal,
  options: HandoffOptions,
): Promise<HandoffOutcome> {
  // Cancellation is wired before the first await: an abort racing any later
  // suspension still reaches the child once it exists.
  let childAgent: Agent | undefined
  const onAbort = (): void => {
    childAgent?.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    let parsed: HandoffBundle
    try {
      parsed = parseHandoffBundle(bundle)
    } catch (error) {
      return failed('VERIFICATION_FAILED', `Invalid handoff bundle: ${describeError(error)}`)
    }

    const parentDepth = options.parentDepth ?? 0
    const childDepth = parentDepth + 1
    if (childDepth > MAX_HANDOFF_DEPTH) {
      return failed(
        'DELEGATION_DEPTH_EXCEEDED',
        `Handoff refused: child depth ${childDepth} exceeds maximum ${MAX_HANDOFF_DEPTH}`,
      )
    }
    // The schema types units as a number but cannot reject NaN; a
    // non-positive or non-finite budget never reaches the ledger.
    const units = parsed.remainingBudget.units
    if (!Number.isFinite(units) || units <= 0) {
      return failed(
        'BUDGET_EXHAUSTED',
        `Handoff refused: remaining budget must be finite and positive, got ${units}`,
      )
    }

    // Reserve before the child exists: a creation failure must not strand
    // unreserved spend, and a success must not exceed the parent pool.
    let reservationId: string
    try {
      reservationId = options.ledger.reserve(
        options.tenantId,
        parsed.remainingBudget.poolName,
        parsed.taskId,
        units,
      ).reservationId
    } catch (error) {
      return failed('BUDGET_EXHAUSTED', `Handoff budget reservation failed: ${describeError(error)}`)
    }

    // From here the hold is live: every path below settles or releases it.
    const releaseAndFail = (
      code: System1ErrorCode,
      reason: string,
      cancelled: boolean,
    ): HandoffOutcome => {
      try {
        options.ledger.release(reservationId, cancelled)
      } catch (releaseError) {
        return failed(
          code,
          `${reason} (budget hold release also failed: ${describeError(releaseError)})`,
        )
      }
      return failed(code, reason)
    }

    // The transfer itself is durable: reconstructable from the parent log.
    // A log failure releases the hold instead of stranding it.
    try {
      coordinator.session.append('system1/handoff', {
        schemaVersion: 1,
        requestId: options.requestId ?? System1RequestId(parsed.taskId),
        to: 'deepseek',
        summary: `Handoff ${parsed.taskId} to DeepSeek (depth ${childDepth}, ${units} units)`,
      })
    } catch (error) {
      return releaseAndFail(
        'EXECUTION_FAILED',
        `Handoff log append failed: ${describeError(error)}`,
        false,
      )
    }

    const sessionId = options.newSessionId?.()
      ?? SessionId(`sys1-handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const handoffText = renderHandoffText(parsed)
    let handle: AgentHandle
    try {
      handle = await coordinator.ctx.agents.create({
        sessionId,
        parentAgent: coordinator,
        signal,
        meta: {
          parentSession: coordinator.session.id,
          origin: 'subagent',
          delegationDepth: childDepth,
        },
        setup: (agentCtx, agent) => {
          seedHandoffSection(agentCtx.get('systemPrompt'), handoffText)
          return options.setupExtras?.(agentCtx, agent)
        },
      })
    } catch (error) {
      return releaseAndFail(
        'EXECUTION_FAILED',
        `DeepSeek child creation failed: ${describeError(error)}`,
        signal.aborted,
      )
    }
    childAgent = handle.agent

    try {
      if (signal.aborted) {
        // Already aborted before the drive: cancel the fresh child directly.
        childAgent.cancel({ kind: 'parent' })
      } else {
        // Drive the child through its real inbox: the message is logged in
        // the child's session, wakes its loop, and carries the bundle.
        try {
          handle.agent.followup(renderHandoffMessage(parsed))
          await handle.agent.whenIdle()
        } catch (error) {
          return releaseAndFail(
            signal.aborted ? 'TASK_CANCELLED' : 'EXECUTION_FAILED',
            `DeepSeek child failed: ${describeError(error)}`,
            signal.aborted,
          )
        }
      }
      if (signal.aborted) {
        return releaseAndFail('TASK_CANCELLED', 'Handoff aborted during DeepSeek execution', true)
      }

      let result: HandoffChildResult
      try {
        result = extractHandoffResult(handle.agent.session)
      } catch (error) {
        return releaseAndFail(
          'VERIFICATION_FAILED',
          `DeepSeek child returned no valid result: ${describeError(error)}`,
          false,
        )
      }

      const missing = checkReturnContract(result, parsed.returnContract)
      // Settle against measured usage even when the contract fails: the
      // child did the work, so its spend is real.
      try {
        options.ledger.settle(reservationId, result.actualUnits)
      } catch (error) {
        return releaseAndFail(
          'EXECUTION_FAILED',
          `DeepSeek child result accepted but budget settlement failed: ${describeError(error)}`,
          false,
        )
      }
      if (missing.length > 0) {
        return failed(
          'VERIFICATION_FAILED',
          `DeepSeek child result missing return-contract entries: ${missing.join(', ')}`,
        )
      }
      return {
        kind: 'completed',
        artifacts: result.artifacts,
        evidence: result.evidence,
        actualUnits: result.actualUnits,
      }
    } finally {
      // Best-effort: the outcome above already records the run, and a
      // disposal failure must not mask it or strand the reservation.
      await handle.dispose().catch(() => undefined)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Register the handoff bundle as an ordered prompt section in the child's
 * unpublished scope. A missing prompt service is tolerated (the inbox
 * message still carries the bundle); a present one must accept the section.
 */
function seedHandoffSection(prompt: SystemPrompt | undefined, text: string): void {
  prompt?.section({ name: 'system1/handoff', order: 450, text })
}

function failed(code: System1ErrorCode, reason: string): HandoffOutcome {
  return { kind: 'failed', code, reason }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
