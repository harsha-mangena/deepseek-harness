/**
 * Candidate menu generation from the tool catalog.
 *
 * Builds a flat menu of executable candidate bundles. Each candidate
 * references a host-owned immutable operation bundle (operationRef) and
 * carries a precondition hash. An ESCALATE/NONE candidate is always included;
 * if pruning removed a plausible action, the provider should abstain rather
 * than force an inaccurate choice.
 *
 * @module @deepseek-ai/dsh-system1-observations/candidates
 */

import { createHash } from 'node:crypto'
import type { Candidate, Effect, RouteKind } from '@deepseek-ai/dsh-system1-contracts'

/** A tool in the host catalog. */
export interface CatalogTool {
  readonly toolId: string
  readonly label: string
  readonly route: RouteKind
  readonly effect: Effect
  /** Host-owned immutable bundle reference. */
  readonly operationRef: string
  /** Route-specific preconditions (canonical JSON). */
  readonly preconditions: Readonly<Record<string, unknown>>
  readonly verificationPolicyId: string
}

/** The ESCALATE/NONE candidate ID. */
export const ESCALATE_CANDIDATE_ID = 'escalate-none'

/**
 * Compute the precondition hash for a candidate.
 * @param preconditions - canonical precondition object.
 * @returns hex SHA-256 hash.
 */
export function hashPreconditions(preconditions: Readonly<Record<string, unknown>>): string {
  const canonical = JSON.stringify(sortKeys(preconditions))
  return createHash('sha256').update(canonical).digest('hex')
}

/** Sort object keys recursively for canonical JSON. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Build the ESCALATE/NONE candidate.
 * @param verificationPolicyId - verification policy for escalation.
 */
export function escalateCandidate(verificationPolicyId: string): Candidate {
  return {
    id: ESCALATE_CANDIDATE_ID,
    label: 'Escalate: no candidate is suitable',
    route: 'stop',
    effect: 'read',
    operationRef: 'op:escalate:v1',
    preconditionHash: hashPreconditions({}),
    verificationPolicyId,
  }
}

/** Options for menu generation. */
export interface MenuOptions {
  /** Maximum candidates (including ESCALATE). Defaults to 32. */
  readonly maxCandidates?: number
  /** Verification policy ID for the ESCALATE candidate. */
  readonly escalateVerificationPolicyId?: string
}

/**
 * Generate a flat candidate menu from the tool catalog.
 * @param tools - catalog tools to include.
 * @param options - menu options.
 * @returns candidates with the ESCALATE candidate last.
 */
export function generateCandidateMenu(
  tools: readonly CatalogTool[],
  options: MenuOptions = {},
): Candidate[] {
  const maxCandidates = options.maxCandidates ?? 32
  const escalatePolicyId = options.escalateVerificationPolicyId ?? 'verify:escalate:v1'

  // Reserve one slot for ESCALATE.
  const toolSlots = Math.max(0, maxCandidates - 1)
  const selected = tools.slice(0, toolSlots)

  const candidates: Candidate[] = selected.map((tool, index) => ({
    id: `c${index + 1}`,
    label: tool.label,
    route: tool.route,
    effect: tool.effect,
    operationRef: tool.operationRef,
    preconditionHash: hashPreconditions(tool.preconditions),
    verificationPolicyId: tool.verificationPolicyId,
  }))

  candidates.push(escalateCandidate(escalatePolicyId))
  return candidates
}
