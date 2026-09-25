/**
 * Stored-evidence helpers for the System 1 production driver.
 *
 * The driver records everything the finalizer needs as session events
 * before it acts on it: admission and the provider decision plus the
 * approved operation/argument digest, attempt, and execution intent are
 * recorded before dispatch; the real sanitized tool result is persisted
 * as `tool/result` before verification; and success is finalized from a
 * projection re-read from the session log, never from caller-supplied
 * booleans. Every helper here is pure over the session log so a restarted
 * coordinator resolves the same evidence from persisted events.
 *
 * @module @deepseek-ai/dsh-system1-integration/evidence
 */

import { createHash } from 'node:crypto'
import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type {
  Candidate,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm/message'
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm/types'
import type {
  Session,
  SessionEvent,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type { ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import {
  boundChars,
  filterSecrets,
} from '@deepseek-ai/dsh-system1-observations'
import {
  checkReturnContract,
  finalizeTerminal,
  System1RequestId,
} from '@deepseek-ai/dsh-system1-workflow'
import type {
  FinalizeTerminalRequest,
  FinalizerVerification,
  HandoffBundle,
  HandoffOutcome,
} from '@deepseek-ai/dsh-system1-workflow'

/** A concrete tool call resolved from an admitted candidate. */
export interface ResolvedToolCall {
  /** Registered tool name in the coordinator's scoped tool runtime. */
  readonly name: string
  /** Losslessly JSON-serializable parsed arguments. */
  readonly arguments: unknown
}

/** Maximum characters kept in a recorded argument summary. */
export const MAX_ARGS_SUMMARY_CHARS = 256

/**
 * Inline evidence bound: sanitized tool results longer than this are
 * stored by reference (spilled) with the full-text hash and owner
 * recorded in the evidence binding. Keeps the session log bounded while
 * the hash still commits to the complete result.
 */
export const MAX_EVIDENCE_CHARS = 32_000

/**
 * Pre-dispatch plan: the evidence N06 requires before anything executes.
 * Admission, decision identity, the approved operation/argument digest,
 * the attempt, and the argument summary are recorded as one durable
 * record; the workflow's own `system1/decision` and
 * `system1/execution-intent` events carry the same turn in the shared
 * vocabulary.
 */
export interface System1DispatchPlanData {
  /** Payload schema version; currently always 1. */
  readonly schemaVersion: 1
  /** Workflow request this plan belongs to. */
  readonly requestId: ReturnType<typeof System1RequestId>
  /** Provider decision identity the plan was admitted under. */
  readonly decisionId: string
  /** Admission verdict; only `admit` plans dispatch. */
  readonly admission: 'admit'
  /** Calibrated correctness that gated the dispatch, when computed. */
  readonly calibratedCorrectness: number | null
  /** Admitted candidate being dispatched. */
  readonly candidateId: string
  /** Catalog operation approved for dispatch. */
  readonly operationRef: string
  /** SHA-256 over the canonical JSON of the approved tool-call arguments. */
  readonly argumentDigest: string
  /** 1-based dispatch attempt this plan covers. */
  readonly attempt: number
  /** One-line secret-filtered summary of the approved arguments. */
  readonly argsSummary: string
}

/**
 * Evidence binding: which verifier version ran and which stored resource
 * versions it checked. Recorded beside the `system1/verification` event
 * so the finalizer resolves the check against fresh stored evidence.
 */
export interface System1EvidenceBindingData {
  /** Payload schema version; currently always 1. */
  readonly schemaVersion: 1
  /** Workflow request this binding belongs to. */
  readonly requestId: ReturnType<typeof System1RequestId>
  /** Verifier check this binding supports. */
  readonly checkId: string
  /** Required verification policy version the check ran under. */
  readonly verifierVersion: string
  /** Receipt reference to evidence content hash for each checked resource. */
  readonly resourceVersions: Readonly<Record<string, string>>
  /** Oversized-evidence spill reference, when the result spilled by reference. */
  readonly spill?: SpilledEvidenceRef
}

/**
 * Where an oversized tool result went. The full sanitized text lives
 * behind the opaque locator; the hash commits to it and the recorded
 * tenant lets resolvers reject cross-tenant references. The session id
 * is provenance: forks inherit the seeded log's spills.
 */
export interface SpilledEvidenceRef {
  /** Opaque spill-store locator for the full result text. */
  readonly locator: string
  /** SHA-256 over the full sanitized text (pre-truncation). */
  readonly contentHash: string
  /** Byte length reported by the spill store. */
  readonly bytes: number
  /** Session that owns the spill. */
  readonly sessionId: string
  /** Tenant that owns the spill. */
  readonly tenantId: string
}

/**
 * Structural spill-store surface the evidence path needs. Matches the
 * `ctx.spillStore` seam; the driver reads it opportunistically so the
 * integration package takes no dependency on a spill backend.
 */
export interface EvidenceSpillStore {
  saveText(input: {
    owner: { sessionId: ReturnType<typeof SessionId> }
    source: { kind: 'tool'; toolName: string; callId: ToolCallId; label: string }
    suggestedName: string
    content: string
  }): Promise<{ locator: string; bytes: number }>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** The driver committed to a dispatch plan before executing it. */
    'system1/dispatch-plan': System1DispatchPlanData
    /** A verifier check bound to the stored evidence it checked. */
    'system1/evidence-binding': System1EvidenceBindingData
  }
}

/**
 * Serialize resolved tool-call arguments for the durable log.
 * @param args - losslessly JSON-serializable parsed arguments.
 * @returns the canonical JSON string; `'null'` when not serializable.
 */
export function serializeArguments(args: unknown): string {
  return JSON.stringify(args) ?? 'null'
}

/**
 * Sanitize a successful tool result for durable evidence: visible text is
 * kept with secrets redacted; non-text blocks are recorded as placeholders
 * so the evidence log never carries images, files, or reasoning content.
 * @param content - the tool's raw result blocks.
 * @returns sanitized text blocks; empty when the result carried no text.
 */
export function sanitizeToolResultContent(
  content: readonly ContentBlock[],
): readonly TextBlock[] {
  return content.flatMap((block): readonly TextBlock[] => {
    if (block.type !== 'text') {
      return [{ type: 'text', text: `[omitted ${block.type} block from verification evidence]` }]
    }
    const text = filterSecrets(block.text).trim()
    return text.length > 0 ? [{ type: 'text', text }] : []
  })
}

/**
 * Hash evidence content for integrity matching between dispatch and
 * finalization. The hash covers the visible text of each block in order;
 * it is a match check, not a security boundary.
 * @param content - evidence blocks to hash.
 * @returns lowercase hex SHA-256 over the canonical JSON of the texts.
 */
export function hashEvidenceContent(content: readonly ContentBlock[]): string {
  const texts = content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  return createHash('sha256').update(JSON.stringify(texts)).digest('hex')
}

/**
 * Parse a `tool-call:<id>` receipt reference back to its call id.
 * @param receiptRef - receipt reference recorded at dispatch.
 * @returns the call id, or `undefined` when the reference is malformed.
 */
export function parseReceiptRef(receiptRef: string): ToolCallId | undefined {
  const prefix = 'tool-call:'
  if (!receiptRef.startsWith(prefix)) return undefined
  const callId = receiptRef.slice(prefix.length)
  if (callId.length === 0) return undefined
  return ToolCallId(callId)
}

/**
 * Turn/step coordinates for the next tool call in a session. Turns count
 * completed requests; steps count tool calls so far, so evidence from
 * successive turns never shares coordinates.
 * @param session - session log to scan.
 * @returns the turn and step for the next tool call.
 */
export function nextToolStep(session: Session): { turn: number; step: number } {
  let turn = 0
  let step = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'system1/terminal') {
      turn += 1
    } else if (event.type === 'tool/call') {
      step += 1
    }
  }
  return { turn, step }
}

/** Input for {@link recordDispatchPlan}. */
export interface DispatchPlanInput {
  /** Workflow request owning the turn. */
  readonly requestId: ReturnType<typeof System1RequestId>
  /** The admitted candidate being dispatched. */
  readonly candidate: Candidate
  /** The captured provider decision the candidate was admitted under. */
  readonly decision: NormalizedDecision
  /** Resolved tool name being dispatched. */
  readonly callName: string
  /** Canonical JSON of the approved tool-call arguments. */
  readonly argsJson: string
  /** Pinned model id; used when the decision resolved no model. */
  readonly expectedModel: string
}

/**
 * Record the pre-dispatch evidence: the provider decision in the shared
 * vocabulary, the committed execution intent, and the N06 dispatch plan
 * (admission, decision identity, approved operation/argument digest,
 * attempt). All three land in the session log before the tool runs.
 * @param session - session log receiving the evidence.
 * @param input - the admitted decision, candidate, and resolved call.
 */
export function recordDispatchPlan(session: Session, input: DispatchPlanInput): void {
  const { requestId, candidate, decision } = input
  const confidence = decision.vendorConfidence
  /* v8 ignore next -- defensive: admission rejects concrete selections without vendor confidence */
  if (confidence === null) {
    throw system1Error('DECISION_NOT_ADMITTED', 'cannot plan a dispatch without vendor confidence', {
      decisionId: decision.decisionId,
    })
  }
  const argsSummary = boundChars(filterSecrets(input.argsJson), MAX_ARGS_SUMMARY_CHARS)
  session.append('system1/decision', {
    schemaVersion: 1,
    requestId,
    primitive: 'choice',
    candidateId: candidate.id,
    confidence,
    model: decision.modelResolved ?? input.expectedModel,
  })
  session.append('system1/execution-intent', {
    schemaVersion: 1,
    requestId,
    steps: [
      {
        id: 'step-1',
        tool: input.callName,
        argsSummary,
        reversible: candidate.effect === 'read',
      },
    ],
  })
  session.append('system1/dispatch-plan', {
    schemaVersion: 1,
    requestId,
    decisionId: decision.decisionId,
    admission: 'admit',
    calibratedCorrectness: decision.calibratedCorrectness,
    candidateId: candidate.id,
    operationRef: candidate.operationRef,
    argumentDigest: hashEvidenceContent([{ type: 'text', text: input.argsJson }]),
    attempt: 1,
    argsSummary,
  })
}

/** Input for {@link recordToolEvidence}. */
export interface ToolEvidenceInput {
  /** Turn coordinate for the evidence pair. */
  readonly turn: number
  /** Step coordinate for the evidence pair. */
  readonly step: number
  /** Tool call id the evidence answers. */
  readonly callId: ToolCallId
  /** Tool name that ran. */
  readonly name: string
  /** Canonical JSON of the arguments the tool ran with. */
  readonly argsJson: string
  /** The materialized successful tool execution. */
  readonly result: ToolExecutionSuccess
  /**
   * Best-effort spill for oversized results. When set and the sanitized
   * result exceeds {@link MAX_EVIDENCE_CHARS}, the full text is stored by
   * reference; without it (or when the store rejects) the inline evidence
   * is truncated to the bound.
   */
  readonly spill?: {
    /** Spill store; read opportunistically from the coordinator context. */
    readonly store: EvidenceSpillStore
    /** Tenant recorded as the spill owner. */
    readonly tenantId: string
  }
}

/**
 * Join the visible text of evidence blocks, in order, for spill storage.
 * @param content - evidence blocks.
 * @returns the concatenated text blocks.
 */
export function evidenceText(content: readonly ContentBlock[]): string {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/**
 * Best-effort spill save. A store failure returns `undefined` so the
 * caller keeps bounded inline evidence; the returned hash still commits
 * to exactly what was stored.
 * @param store - spill store to save through.
 * @param input - the store's save input.
 * @returns the save reference, or `undefined` when the store rejects.
 */
async function trySaveSpill(
  store: EvidenceSpillStore,
  input: Parameters<EvidenceSpillStore['saveText']>[0],
): Promise<{ locator: string; bytes: number } | undefined> {
  try {
    return await store.saveText(input)
  } catch (error: unknown) {
    // Best-effort: the caller falls back to bounded inline evidence.
    void error
    return undefined
  }
}

/**
 * Truncate evidence to the inline bound, keeping a hash of the full text
 * in the marker so the truncation is auditable.
 * @param sanitized - sanitized evidence blocks.
 * @returns blocks bounded to {@link MAX_EVIDENCE_CHARS}.
 */
function truncateEvidence(sanitized: readonly ContentBlock[]): ContentBlock[] {
  const fullText = evidenceText(sanitized)
  if (fullText.length <= MAX_EVIDENCE_CHARS) return [...sanitized]
  const marker =
    `\n…[evidence truncated to ${MAX_EVIDENCE_CHARS} chars; ` +
    `full SHA-256 ${hashEvidenceContent(sanitized)}]`
  return [{ type: 'text', text: fullText.slice(0, MAX_EVIDENCE_CHARS - marker.length) + marker }]
}

/**
 * Persist the tool call and the real sanitized tool result as durable
 * evidence. The `tool/result` cites its `tool/call` via `sourceEventSeqs`
 * and carries the `append` surface op, exactly like the agent loop's own
 * tool evidence. Results longer than {@link MAX_EVIDENCE_CHARS} are stored
 * by reference when a spill store is available; the inline evidence is
 * always bounded. Call this before verification runs.
 * @param session - session log receiving the evidence.
 * @param input - coordinates, call identity, the tool result, and the spill option.
 * @returns the evidence hash the finalizer resolves, plus the spill
 * reference when the result spilled by reference. The hash covers the
 * stored inline evidence, or the full text when spilled.
 */
export async function recordToolEvidence(
  session: Session,
  input: ToolEvidenceInput,
): Promise<{ readonly evidenceHash: string; readonly spilled?: SpilledEvidenceRef }> {
  const callEvent: SessionEvent<'tool/call'> = session.append('tool/call', {
    turn: input.turn,
    step: input.step,
    callId: input.callId,
    name: input.name,
    arguments: input.argsJson,
  })
  const sanitized = sanitizeToolResultContent(input.result.content)
  const oversized = evidenceText(sanitized).length > MAX_EVIDENCE_CHARS
  let spilled: SpilledEvidenceRef | undefined
  if (oversized && input.spill !== undefined) {
    const ref = await trySaveSpill(input.spill.store, {
      owner: { sessionId: session.id },
      source: { kind: 'tool', toolName: input.name, callId: input.callId, label: 'result' },
      suggestedName: `${input.name}-result.txt`,
      content: evidenceText(sanitized),
    })
    if (ref !== undefined) {
      spilled = {
        locator: ref.locator,
        contentHash: hashEvidenceContent(sanitized),
        bytes: ref.bytes,
        sessionId: session.id,
        tenantId: input.spill.tenantId,
      }
    }
  }
  const inline: ContentBlock[] =
    spilled !== undefined
      ? [
          {
            type: 'text',
            text:
              `[evidence spilled to ${spilled.locator}; ` +
              `full SHA-256 ${spilled.contentHash}; ${spilled.bytes} bytes]`,
          },
        ]
      : truncateEvidence(sanitized)
  const message = createToolResultMessage({
    callId: input.callId,
    content: inline,
    isError: false,
  })
  session.append(
    'tool/result',
    { turn: input.turn, step: input.step, message },
    { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] },
  )
  return {
    evidenceHash: spilled !== undefined ? spilled.contentHash : hashEvidenceContent(inline),
    ...(spilled !== undefined ? { spilled } : {}),
  }
}

/**
 * Find the stored `tool/result` answering one tool call.
 * @param session - session log to search.
 * @param callId - tool call id to resolve.
 * @returns the stored result event, or `undefined` when absent.
 */
export function findStoredToolResult(
  session: Session,
  callId: ToolCallId,
): SessionEvent<'tool/result'> | undefined {
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'tool/result') continue
    if (event.data.message.toolCallId !== callId) continue
    return event
  }
  return undefined
}

/**
 * One verification record rebuilt from the session log. Unlike
 * {@link FinalizerVerification}, this keeps the cited evidence so checks
 * can resolve what the verifier actually read.
 */
export interface StoredVerification {
  /** Verifier check identity. */
  readonly checkId: string
  /** Whether the check passed. */
  readonly passed: boolean
  /** Evidence the verifier cited, as compact text. */
  readonly evidence: string
}

/**
 * Rebuild the verification records for a request from the session log.
 * The finalizer reads these — never caller-supplied booleans — so a
 * restarted coordinator finalizes from the same stored projection.
 * @param session - session log to project.
 * @param requestId - workflow request to load.
 * @returns the stored verification records in log order.
 */
export function loadStoredVerifications(
  session: Session,
  requestId: ReturnType<typeof System1RequestId>,
): StoredVerification[] {
  const verifications: StoredVerification[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'system1/verification') continue
    if (event.data.requestId !== requestId) continue
    verifications.push({
      checkId: event.data.checkId,
      passed: event.data.passed,
      evidence: event.data.evidence,
    })
  }
  return verifications
}

/** One verifier check whose evidence must resolve to stored tool results. */
export interface ExpectedCheckEvidence {
  /** Verifier check id that must resolve. */
  readonly checkId: string
  /** Receipt reference the check must cite, exactly. */
  readonly expectedReceiptRef: string
  /** Evidence hash the stored tool result must carry. */
  readonly expectedHash: string
  /**
   * Tenant the evidence must be owned by. Spilled evidence records its
   * owner in the evidence binding; a binding owned by another tenant
   * rejects the check.
   */
  readonly expectedTenantId?: string
}

/** A verifier check whose evidence resolved to a stored tool result. */
export interface ResolvedCheckEvidence {
  /** Verifier check id that resolved. */
  readonly checkId: string
  /** Receipt reference the check cited. */
  readonly receiptRef: string
  /** Evidence hash matched on the stored tool result. */
  readonly evidenceHash: string
  /** The stored verification record backing the check. */
  readonly verification: FinalizerVerification
}

/** Whether every expected check resolved to fresh stored evidence. */
export type CheckEvidenceResolution =
  | { readonly ok: true; readonly checks: readonly ResolvedCheckEvidence[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Resolve verifier checks against fresh stored evidence. Each check must
 * cite a stored passing verification for its check id, the verification
 * must cite exactly the dispatched receipt, and the stored `tool/result`
 * behind that receipt must hash to the dispatched evidence. Missing,
 * stale, or mismatched evidence resolves to `ok: false` — it can never
 * produce a success terminal.
 * @param session - session log holding the stored evidence.
 * @param requestId - workflow request being finalized.
 * @param expected - the checks the success claim depends on.
 * @returns the resolved checks, or the first resolution failure.
 */
export function resolveCheckEvidence(
  session: Session,
  requestId: ReturnType<typeof System1RequestId>,
  expected: readonly ExpectedCheckEvidence[],
): CheckEvidenceResolution {
  const verifications = loadStoredVerifications(session, requestId)
  const checks: ResolvedCheckEvidence[] = []
  for (const { checkId, expectedReceiptRef, expectedHash, expectedTenantId } of expected) {
    const verification = verifications.find((record) => record.checkId === checkId)
    if (verification === undefined) {
      return { ok: false, reason: `no stored verification for check "${checkId}"` }
    }
    if (!verification.passed) {
      return { ok: false, reason: `stored verification for check "${checkId}" did not pass` }
    }
    if (verification.evidence !== expectedReceiptRef) {
      return {
        ok: false,
        reason: `check "${checkId}" cites "${verification.evidence}", expected "${expectedReceiptRef}"`,
      }
    }
    const callId = parseReceiptRef(verification.evidence)
    if (callId === undefined) {
      return {
        ok: false,
        reason: `check "${checkId}" cites malformed receipt "${verification.evidence}"`,
      }
    }
    const toolResult = findStoredToolResult(session, callId)
    if (toolResult === undefined) {
      return {
        ok: false,
        reason: `no stored tool/result for receipt "${verification.evidence}"`,
      }
    }
    // Oversized results spill by reference: the binding records the
    // full-text hash and the spill owner, and the check resolves against
    // those instead of the bounded inline content. The tenant owns the
    // spill: a reference owned by another tenant cannot back this check.
    // The recorded session id is provenance (forks inherit the seeded
    // log's spills); the tenant is the enforced boundary.
    const binding = loadEvidenceBinding(session, requestId, checkId)
    let evidenceHash: string
    if (binding?.spill !== undefined) {
      const spill = binding.spill
      if (expectedTenantId !== undefined && spill.tenantId !== expectedTenantId) {
        return {
          ok: false,
          reason: `spill for check "${checkId}" is owned by another tenant`,
        }
      }
      evidenceHash = spill.contentHash
    } else {
      evidenceHash = hashEvidenceContent(toolResult.data.message.content)
    }
    if (evidenceHash !== expectedHash) {
      return {
        ok: false,
        reason: `stored tool/result for "${verification.evidence}" does not match the dispatched evidence`,
      }
    }
    checks.push({
      checkId,
      receiptRef: verification.evidence,
      evidenceHash,
      verification: { checkId: verification.checkId, passed: verification.passed },
    })
  }
  return { ok: true, checks }
}

/**
 * Load the evidence binding for one check, or `undefined` when the log
 * holds none. The binding names the verifier version, the checked
 * resource versions, and the spill reference for oversized results.
 * @param session - session log to search.
 * @param requestId - workflow request to match.
 * @param checkId - verifier check to match.
 * @returns the stored binding, or `undefined`.
 */
export function loadEvidenceBinding(
  session: Session,
  requestId: ReturnType<typeof System1RequestId>,
  checkId: string,
): System1EvidenceBindingData | undefined {
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'system1/evidence-binding') continue
    if (event.data.requestId !== requestId) continue
    if (event.data.checkId !== checkId) continue
    return event.data
  }
  return undefined
}

/**
 * Whether the session log already holds a terminal for a request.
 * @param session - session log to scan.
 * @param requestId - workflow request to check.
 * @returns true when a terminal for the request is already recorded.
 */
export function hasTerminal(
  session: Session,
  requestId: ReturnType<typeof System1RequestId>,
): boolean {
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'system1/terminal') continue
    if (event.data.requestId === requestId) return true
  }
  return false
}

/**
 * Finalize a terminal exactly once per request: a repeated finalization
 * (for example a retried turn reusing its request id) keeps the first
 * recorded terminal instead of appending a conflicting outcome.
 * @param request - the terminal request to record.
 */
export function finalizeOnce(request: FinalizeTerminalRequest): void {
  if (hasTerminal(request.session, request.requestId)) return
  finalizeTerminal(request)
}

/** Resolution of one handoff evidence reference against the bundle. */
export interface HandoffRefResolution {
  /** The returned reference. */
  readonly ref: string
  /** Whether the reference resolved and may be accepted as evidence. */
  readonly resolved: boolean
  /** Why the reference did not resolve, when it didn't. */
  readonly reason?: string
}

/**
 * Resolve handoff evidence references before they are accepted. A
 * reference resolves only when it is well-formed and the bundle's return
 * contract is fully satisfied; unresolved references are recorded as
 * failed verification evidence, never as passing.
 * @param bundle - the escalation bundle the child answered.
 * @param outcome - the child's completed outcome.
 * @returns one resolution per returned evidence reference.
 */
export function resolveHandoffRefs(
  bundle: HandoffBundle,
  outcome: Extract<HandoffOutcome, { kind: 'completed' }>,
): readonly HandoffRefResolution[] {
  const missing = checkReturnContract(outcome, bundle.returnContract)
  return outcome.evidence.map((ref): HandoffRefResolution => {
    if (ref.trim().length === 0) {
      return { ref, resolved: false, reason: 'empty evidence reference' }
    }
    if (missing.length > 0) {
      return {
        ref,
        resolved: false,
        reason: `return contract not satisfied: ${missing.join(', ')}`,
      }
    }
    return { ref, resolved: true }
  })
}
