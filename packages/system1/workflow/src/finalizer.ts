/**
 * Task finalizer: the only supported way to record a `system1/terminal` event.
 *
 * `Session.append` is a generic typed log API; it cannot enforce the System 1
 * finalization invariant (success requires independent verification evidence).
 * This finalizer is the enforcement point: it validates the invariant, then
 * appends the terminal event. Direct `session.append('system1/terminal', ...)`
 * bypasses the check and is unsupported.
 *
 * @module @deepseek-ai/dsh-system1-workflow/finalizer
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { System1RequestId } from './types.ts'
import type { System1TerminalData } from './events.ts'

/** A verifier check result backing a success terminal. */
export interface FinalizerVerification {
  /** Verifier check identity; matches an entry in `verifiedBy`. */
  checkId: string
  /** Whether the check passed against fresh evidence. */
  passed: boolean
}

/** Request to record the terminal outcome of a System 1 workflow request. */
export interface FinalizeTerminalRequest {
  /** Session log receiving the terminal event. */
  session: Session
  /** Workflow request being finalized. */
  requestId: System1RequestId
  /** Final outcome of the request. */
  outcome: 'success' | 'failure' | 'cancelled' | 'escalated'
  /** One-line outcome summary; never carries stack traces. */
  summary: string
  /**
   * Verifier check ids that passed before success was declared. Must be
   * non-empty for `success` and is ignored for other outcomes.
   */
  verifiedBy: readonly string[]
  /** Verification records backing `verifiedBy`. */
  verifications: ReadonlyArray<FinalizerVerification>
}

/** A terminal request violated the finalization invariant. */
export class TerminalInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminalInvariantError'
  }
}

/**
 * Validate the finalization invariant and record the terminal event.
 *
 * Success requires at least one verifier check id, and every cited check
 * must have a passing verification record. Any other outcome records
 * without verification evidence.
 *
 * @param request - the terminal request to validate and record.
 * @throws {TerminalInvariantError} when a success terminal lacks passing
 * verification evidence.
 */
export function finalizeTerminal(request: FinalizeTerminalRequest): void {
  const { session, requestId, outcome, summary, verifiedBy, verifications } = request
  if (outcome === 'success') {
    if (verifiedBy.length === 0) {
      throw new TerminalInvariantError(
        'success terminal requires at least one passing verifier check',
      )
    }
    for (const checkId of verifiedBy) {
      const record = verifications.find(verification => verification.checkId === checkId)
      if (record === undefined) {
        throw new TerminalInvariantError(
          `success terminal cites check "${checkId}" with no verification record`,
        )
      }
      if (!record.passed) {
        throw new TerminalInvariantError(
          `success terminal cites failed check "${checkId}"`,
        )
      }
    }
    const data: System1TerminalData = {
      schemaVersion: 1,
      requestId,
      outcome: 'success',
      summary,
      verifiedBy: [...verifiedBy],
    }
    session.append('system1/terminal', data)
    return
  }
  session.append('system1/terminal', {
    schemaVersion: 1,
    requestId,
    outcome,
    summary,
  })
}
