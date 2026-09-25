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
 *    exists. The reservation settles on success; on failure or cancellation
 *    the outcome depends on whether work may have started:
 *    - No work started (invalid bundle, depth/budget refusal, reservation or
 *      creation failure, abort before the drive): the hold is released.
 *    - Work started but spend unknown (child failure, malformed result,
 *      mid-run abort): the reservation is retained as a reconciliation hold
 *      or conservatively charged — never released free.
 *    The child's reported `actualUnits` is untrusted: it is validated
 *    (finite, non-negative integer, within the reservation) and never
 *    settles blindly, so a fraudulent report can neither refund real spend
 *    nor decrease the pool's consumed total.
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
  /**
   * Retain an active reservation as a reconciliation hold when spend is
   * uncertain (child failure, invalid result, mid-run abort). The hold
   * keeps the reserved units encumbered until authoritative telemetry
   * reconciles it; it is never released free.
   *
   * Optional: ledgers without explicit hold support leave the reservation
   * active, which is itself a hold until settled or released.
   */
  holdForReconciliation?(reservationId: string, claimedUnits: number, reason: string): void
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
   * Enforceable child limits (token cap, deadline, step bound). Validated before the
   * reservation: an invalid limit fails closed without touching the ledger
   * or the registry.
   */
  readonly childLimits?: HandoffChildLimits
  /**
   * Host-observed usage meter for the child run. Called with the child's
   * session after the drive; returns whole budget units, or null when the
   * child's provider usage was not metered. Settlement never uses the
   * child-reported `actualUnits`: a null meter result conservatively
   * charges the full reservation on success, and a failed run retains the
   * hold. Defaults to folding the child's `assistant/message` token usage
   * at one unit per token.
   */
  readonly measureChildUsage?: (childSession: Session) => number | null
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
  /**
   * Budget units the child reports as consumed. Untrusted: validated
   * (finite, non-negative integer, within the reservation) before any
   * settlement, and never the basis for decreasing pool totals.
   */
  readonly actualUnits: number
}

/** Enforceable limits for the handoff child. */
export interface HandoffChildLimits {
  /**
   * Per-request output token cap, enforced by the provider adapter through
   * the child's agent options. Must be a positive integer.
   */
  readonly maxTokens?: number
  /**
   * Wall-clock deadline (ms since epoch). The child is cancelled when the
   * deadline passes; the deadline is also recorded on the budget
   * reservation. Must be finite.
   */
  readonly deadlineAt?: number
  /**
   * Maximum model steps the child may run. The handoff watches the child's
   * session for `step/start` events and cancels the child through its own
   * cancel path when the bound is exceeded. Must be a positive integer.
   */
  readonly maxSteps?: number
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
 * parent pool before creation and settled from the child's validated usage
 * report on success. When no work started the hold releases; when work may
 * have started but spend is uncertain, the reservation is retained as a
 * reconciliation hold or conservatively charged — never released free.
 * Parent cancellation propagates to the child; the owned child handle is
 * always disposed.
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
  // The child signal combines parent cancellation with the deadline: a
  // passing deadline aborts the child exactly like a parent cancel, so
  // every abort check below covers both.
  const childController = new AbortController()
  let deadlineFired = false
  // Set when the step watcher cancels the child: the budget hold is then
  // retained for reconciliation, like every other cancelled run.
  let stepLimitFired = false
  let stopStepWatch: (() => boolean) | undefined
  const onParentAbort = (): void => {
    childController.abort()
  }
  if (signal.aborted) {
    childController.abort()
  } else {
    signal.addEventListener('abort', onParentAbort, { once: true })
  }
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  // Cancellation is wired before the first await: an abort racing any later
  // suspension still reaches the child once it exists.
  let childAgent: Agent | undefined
  const onAbort = (): void => {
    childAgent?.cancel({ kind: 'parent' })
  }
  const childSignal = childController.signal
  childSignal.addEventListener('abort', onAbort, { once: true })
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
    // The schema types units as a number but cannot reject NaN or
    // fractions; only a positive integer budget reaches the ledger, so
    // every later settlement validates.
    const units = parsed.remainingBudget.units
    if (!Number.isInteger(units) || units <= 0) {
      return failed(
        'BUDGET_EXHAUSTED',
        `Handoff refused: remaining budget must be a positive integer, got ${units}`,
      )
    }

    // Enforceable child limits are validated before the reservation: a bad
    // limit never reaches the ledger or the registry.
    const limitsCheck = validateChildLimits(options.childLimits)
    if (!limitsCheck.ok) return limitsCheck.outcome
    const { maxTokens, deadlineAt, maxSteps } = limitsCheck
    if (deadlineAt !== undefined) {
      const delayMs = deadlineAt - Date.now()
      if (delayMs <= 0) {
        deadlineFired = true
        childController.abort()
      } else {
        deadlineTimer = setTimeout(() => {
          deadlineFired = true
          childController.abort()
        }, delayMs)
        // The deadline must not hold the process open by itself.
        deadlineTimer.unref()
      }
    }

    // Reserve before the child exists: a creation failure must not strand
    // unreserved spend, and a success must not exceed the parent pool. The
    // reservation carries the deadline so reconciliation can see it.
    let reservationId: string
    try {
      reservationId = options.ledger.reserve(
        options.tenantId,
        parsed.remainingBudget.poolName,
        parsed.taskId,
        units,
        deadlineAt,
      ).reservationId
    } catch (error) {
      return failed('BUDGET_EXHAUSTED', `Handoff budget reservation failed: ${describeError(error)}`)
    }

    // From here the hold is live: every path below settles it, retains it
    // as a reconciliation hold, or releases it.
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
    // Spend is uncertain (the child may have run): retain the reservation
    // as a reconciliation hold instead of releasing it free. Consumed
    // totals never decrease; the hold settles from authoritative telemetry.
    const holdAndFail = (code: System1ErrorCode, reason: string): HandoffOutcome => {
      retainHold(options.ledger, reservationId, units, reason)
      return failed(code, `${reason}; spend held for reconciliation`)
    }
    // The child ran but produced no usable result: spend is unknown but
    // bounded by the reservation, so conservatively charge the full
    // reservation instead of releasing it free. If even the conservative
    // settlement fails, retain the hold for reconciliation — started
    // work is never released free.
    const settleConservativeAndFail = (code: System1ErrorCode, reason: string): HandoffOutcome => {
      try {
        options.ledger.settle(reservationId, units)
      } catch (settleError) {
        return holdAndFail(
          code,
          `${reason} (conservative settlement also failed: ${describeError(settleError)})`,
        )
      }
      return failed(code, `${reason}; charged the full ${units}-unit reservation conservatively`)
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
        signal: childSignal,
        meta: {
          parentSession: coordinator.session.id,
          origin: 'subagent',
          delegationDepth: childDepth,
        },
        // The token cap is enforced by the provider adapter, not by the
        // prompt: it travels in the child's agent options.
        // exactOptionalPropertyTypes: an absent cap must stay absent.
        ...(maxTokens !== undefined ? { agentOptions: { maxTokens } } : {}),
        setup: (agentCtx, agent) => {
          seedHandoffSection(agentCtx.get('systemPrompt'), handoffText)
          if (maxSteps !== undefined) {
            // The step bound is enforced against the child's own session
            // log: each step/start past the bound cancels the child through
            // its own cancel path. Scope-filtered dispatch delivers the
            // child's session events to this agent-scoped listener.
            const childSession = agent.session
            let steps = 0
            stopStepWatch = agentCtx.on('session/event', (subject, event) => {
              if (subject !== childSession || event.type !== 'step/start') return
              steps += 1
              if (steps > maxSteps && !stepLimitFired) {
                stepLimitFired = true
                // Abort exactly like a deadline: the abort listener cancels
                // the child agent, and the run below attributes the
                // reconciliation hold to the step limit.
                childController.abort()
              }
            })
          }
          return options.setupExtras?.(agentCtx, agent)
        },
      })
    } catch (error) {
      return releaseAndFail(
        'EXECUTION_FAILED',
        `DeepSeek child creation failed: ${describeError(error)}`,
        childSignal.aborted,
      )
    }
    childAgent = handle.agent

    try {
      if (childSignal.aborted) {
        // Aborted before the drive (or the deadline already passed): the
        // child never started, so no spend exists and the hold releases.
        childAgent.cancel({ kind: 'parent' })
        return releaseAndFail(
          'TASK_CANCELLED',
          deadlineFired ? 'Handoff deadline passed before DeepSeek execution' : 'Handoff aborted before DeepSeek execution',
          true,
        )
      }
      try {
        // Drive the child through its real inbox: the message is logged in
        // the child's session, wakes its loop, and carries the bundle.
        handle.agent.followup(renderHandoffMessage(parsed))
        await handle.agent.whenIdle()
      } catch (error) {
        // The drive failed after start: spend is uncertain — retain the
        // hold instead of releasing it free.
        if (stepLimitFired) {
          return holdAndFail(
            'TASK_CANCELLED',
            `DeepSeek child exceeded the ${maxSteps}-step limit during execution`,
          )
        }
        return holdAndFail(
          childSignal.aborted ? 'TASK_CANCELLED' : 'EXECUTION_FAILED',
          `DeepSeek child failed: ${describeError(error)}`,
        )
      }
      if (childSignal.aborted) {
        // Aborted mid-run (parent cancel, deadline, or step limit): the
        // child may have spent budget — hold, don't release.
        if (stepLimitFired) {
          return holdAndFail(
            'TASK_CANCELLED',
            `DeepSeek child exceeded the ${maxSteps}-step limit during execution`,
          )
        }
        return holdAndFail(
          'TASK_CANCELLED',
          deadlineFired
            ? 'Handoff deadline exceeded during DeepSeek execution'
            : 'Handoff aborted during DeepSeek execution',
        )
      }

      let result: HandoffChildResult
      try {
        result = extractHandoffResult(handle.agent.session)
      } catch (error) {
        return settleConservativeAndFail(
          'VERIFICATION_FAILED',
          `DeepSeek child returned no valid result: ${describeError(error)}`,
        )
      }

      // The child's reported usage is untrusted: validate it before any
      // settlement. A fraudulent or out-of-range report fails closed and
      // retains the hold — it never refunds real spend and never decreases
      // the pool's consumed total.
      const usageError = validateReportedUsage(result.actualUnits, units)
      if (usageError !== null) {
        return holdAndFail(
          'VERIFICATION_FAILED',
          `DeepSeek child reported invalid usage: ${usageError}`,
        )
      }

      const missing = checkReturnContract(result, parsed.returnContract)
      // The usage meter is host-observed but still untrusted at the
      // boundary: a throwing meter, or a negative/non-integer meter result,
      // means usage is unknown — settlement falls back to the full
      // reservation rather than trusting the figure.
      const measuredChildUsage = (childSession: Session): number | null => {
        let measured: number | null
        try {
          measured = (options.measureChildUsage ?? foldChildSessionUsage)(childSession)
        } catch {
          return null
        }
        if (measured === null) return null
        if (!Number.isInteger(measured) || measured < 0) return null
        return measured
      }
      // Settlement is authoritative: the meter folds host-observed provider
      // usage from the child's session — the child's reported actualUnits
      // is untrusted and never determines the settled amount. When the
      // meter observed nothing, conservatively charge the full reservation;
      // when it measured an overrun, the ledger's explicit overrun policy
      // decides. A settlement failure after the child ran retains the hold
      // for reconciliation — real spend must never release free.
      const settledUnits = measuredChildUsage(handle.agent.session) ?? units
      try {
        options.ledger.settle(reservationId, settledUnits)
      } catch (error) {
        return holdAndFail(
          'EXECUTION_FAILED',
          `DeepSeek child result accepted but budget settlement failed: ${describeError(error)}`,
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
        actualUnits: settledUnits,
      }
    } finally {
      // Best-effort: the outcome above already records the run, and a
      // disposal failure must not mask it or strand the reservation.
      await handle.dispose().catch(() => undefined)
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    // Close the step watcher before disposal so late step events stay silent.
    stopStepWatch?.()
    signal.removeEventListener('abort', onParentAbort)
    childSignal.removeEventListener('abort', onAbort)
  }
}

/**
 * Validate the child's reported usage without trusting it. The report is
 * model output: it must be a non-negative integer within the reservation.
 * @param actualUnits - the child's reported units.
 * @param reservedUnits - the reservation bounding the child's spend.
 * @returns the violation, or null when the report is usable.
 */
function validateReportedUsage(actualUnits: number, reservedUnits: number): string | null {
  if (!Number.isInteger(actualUnits) || actualUnits < 0) {
    return `usage ${actualUnits} is not a non-negative integer`
  }
  if (actualUnits > reservedUnits) {
    return `usage ${actualUnits} exceeds the ${reservedUnits}-unit reservation`
  }
  return null
}

/**
 * Default host-observed usage meter for a handoff child: fold the child's
 * session log for `assistant/message` token usage, at one unit per token.
 * These counts are recorded by the provider adapter's transport telemetry —
 * the host's own observation of the child's provider calls — never by the
 * model.
 * @param session - the child's session after its run.
 * @returns whole units, or null when no message carried usage telemetry.
 */
export function foldChildSessionUsage(session: Session): number | null {
  let total = 0
  let observed = false
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined) continue
    // Corrupt telemetry is unmetered: a negative or fractional token count
    // fails closed to the conservative full-reservation charge.
    if (!Number.isInteger(usage.inputTokens) || usage.inputTokens < 0) return null
    if (!Number.isInteger(usage.outputTokens) || usage.outputTokens < 0) return null
    observed = true
    total += usage.inputTokens + usage.outputTokens
  }
  return observed ? total : null
}

/**
 * Validate enforceable child limits before they reach the ledger or the
 * registry.
 * @param limits - the requested limits, if any.
 * @returns the normalized limits, or a fail-closed outcome.
 */
function validateChildLimits(limits: HandoffChildLimits | undefined):
  | { readonly ok: true; readonly maxTokens?: number; readonly deadlineAt?: number; readonly maxSteps?: number }
  | { readonly ok: false; readonly outcome: HandoffOutcome } {
  if (limits === undefined) return { ok: true }
  let maxTokens: number | undefined
  let deadlineAt: number | undefined
  let maxSteps: number | undefined
  if (limits.maxTokens !== undefined) {
    if (!Number.isInteger(limits.maxTokens) || limits.maxTokens <= 0) {
      return {
        ok: false,
        outcome: failed(
          'INVALID_CONFIG',
          `Handoff child maxTokens must be a positive integer, got ${limits.maxTokens}`,
        ),
      }
    }
    maxTokens = limits.maxTokens
  }
  if (limits.deadlineAt !== undefined) {
    if (!Number.isFinite(limits.deadlineAt)) {
      return {
        ok: false,
        outcome: failed(
          'INVALID_CONFIG',
          `Handoff child deadlineAt must be a finite timestamp, got ${limits.deadlineAt}`,
        ),
      }
    }
    deadlineAt = limits.deadlineAt
  }
  if (limits.maxSteps !== undefined) {
    if (!Number.isInteger(limits.maxSteps) || limits.maxSteps <= 0) {
      return {
        ok: false,
        outcome: failed(
          'INVALID_CONFIG',
          `Handoff child maxSteps must be a positive integer, got ${limits.maxSteps}`,
        ),
      }
    }
    maxSteps = limits.maxSteps
  }
  return {
    ok: true,
    // exactOptionalPropertyTypes: absent limits stay absent.
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
  }
}

/**
 * Retain a reservation as a reconciliation hold. Best-effort: ledgers
 * without explicit hold support leave the reservation active, which is
 * itself a hold until settled or released by reconciliation.
 * @param ledger - the budget ledger.
 * @param reservationId - the live reservation.
 * @param claimedUnits - advisory claimed usage.
 * @param reason - why the spend is uncertain.
 */
function retainHold(
  ledger: HandoffBudgetLedger,
  reservationId: string,
  claimedUnits: number,
  reason: string,
): void {
  try {
    ledger.holdForReconciliation?.(reservationId, claimedUnits, reason)
  } catch {
    // The reservation stays active as an implicit hold.
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
