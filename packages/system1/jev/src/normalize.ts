/**
 * Normalize Jev API responses to NormalizedDecision.
 *
 * Handles choice, score, and noul response types. The selected candidate ID
 * must be one of the input candidates; otherwise the response is malformed.
 * Raw probabilities, vendor confidence, and calibrated correctness remain
 * distinct fields.
 *
 * @module @deepseek-ai/dsh-system1-jev/normalize
 */

import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type {
  DecisionInput,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'

/** Raw Jev API response shape (partial). */
interface JevRawResponse {
  readonly answers?: unknown
  readonly model?: unknown
  readonly requestId?: unknown
  readonly request_id?: unknown
  readonly usage?: unknown
}

/** Raw per-question answer shape (partial). */
interface JevRawAnswer {
  readonly choice?: unknown
  readonly score?: unknown
  readonly noul?: unknown
  readonly probabilities?: unknown
  readonly confidence?: unknown
  readonly legend?: unknown
}

/**
 * Normalize a raw Jev response to a NormalizedDecision.
 * @param raw - raw API response.
 * @param input - the decision input that produced it.
 * @param modelRequested - the pinned model that was requested.
 * @returns the normalized decision.
 * @throws System1Error PROVIDER_MALFORMED_RESPONSE on invalid shape.
 */
export function normalizeJevResponse(
  raw: unknown,
  input: DecisionInput,
  modelRequested: string,
): NormalizedDecision {
  if (typeof raw !== 'object' || raw === null) {
    throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Jev response is not an object', {})
  }
  const response = raw as JevRawResponse
  const candidateIds = new Set(input.candidates.map(c => c.id))

  // Answers are keyed by question ID under `answers`.
  if (typeof response.answers !== 'object' || response.answers === null) {
    throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Jev response has no answers', {})
  }
  const answer = (response.answers as Record<string, unknown>)[input.questionFamily]
  if (typeof answer !== 'object' || answer === null) {
    throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Jev response is missing the answer', {
      questionId: input.questionFamily,
    })
  }
  const result = answer as JevRawAnswer

  // Noul: the model abstained.
  if (result.noul !== undefined) {
    return {
      decisionId: input.decisionId,
      selectedId: 'escalate-none',
      probabilities: {},
      selectedProbability: 0,
      vendorConfidence: null,
      calibratedCorrectness: null,
      calibrationVersion: null,
      modelRequested,
      modelResolved: asStringOrNull(response.model),
      requestId: asStringOrNull(response.requestId ?? response.request_id),
      usage: parseUsage(response.usage),
      reasonCode: 'uncertain',
    }
  }

  // Choice: the model selected one candidate.
  if (result.choice !== undefined) {
    const choice = result.choice
    if (typeof choice !== 'string' || !candidateIds.has(choice)) {
      throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Jev choice is not a valid candidate ID', {
        choice,
      })
    }
    const probabilities = parseProbabilities(result.probabilities, candidateIds)
    return {
      decisionId: input.decisionId,
      selectedId: choice,
      probabilities,
      selectedProbability: probabilities[choice] ?? 0,
      vendorConfidence: asNumberOrNull(result.confidence),
      calibratedCorrectness: null,
      calibrationVersion: null,
      modelRequested,
      modelResolved: asStringOrNull(response.model),
      requestId: asStringOrNull(response.requestId ?? response.request_id),
      usage: parseUsage(response.usage),
      reasonCode: 'accepted',
    }
  }

  // Score: the model scored candidates; select the highest.
  if (result.score !== undefined) {
    const probabilities = parseProbabilities(result.probabilities ?? result.score, candidateIds)
    const top = topCandidate(probabilities, candidateIds)
    if (!top) {
      throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Jev score has no valid candidate', {})
    }
    return {
      decisionId: input.decisionId,
      selectedId: top.id,
      probabilities,
      selectedProbability: top.probability,
      vendorConfidence: asNumberOrNull(result.confidence),
      calibratedCorrectness: null,
      calibrationVersion: null,
      modelRequested,
      modelResolved: asStringOrNull(response.model),
      requestId: asStringOrNull(response.requestId ?? response.request_id),
      usage: parseUsage(response.usage),
      reasonCode: 'accepted',
    }
  }

  throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Jev answer has no choice, score, or noul', {})
}

/** Parse probabilities, validating against candidate IDs. */
function parseProbabilities(
  value: unknown,
  candidateIds: ReadonlySet<string>,
): Record<string, number> {
  if (typeof value !== 'object' || value === null) {
    throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Jev probabilities are not an object', {})
  }
  const result: Record<string, number> = {}
  for (const [key, val] of Object.entries(value)) {
    if (!candidateIds.has(key)) continue
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) {
      throw system1Error('PROVIDER_MALFORMED_RESPONSE', `Invalid probability for ${key}`, { key, val })
    }
    result[key] = val
  }
  return result
}

/** Select the candidate with the highest probability. */
function topCandidate(
  probabilities: Record<string, number>,
  candidateIds: ReadonlySet<string>,
): { id: string; probability: number } | null {
  let best: string | null = null
  let bestProb = 0
  for (const id of candidateIds) {
    const prob = probabilities[id] ?? 0
    if (prob > bestProb) {
      bestProb = prob
      best = id
    }
  }
  return best === null ? null : { id: best, probability: bestProb }
}

/** Parse usage tokens (null-safe). */
function parseUsage(value: unknown): { inputTokens: number | null; outputTokens: number | null } {
  if (typeof value !== 'object' || value === null) {
    return { inputTokens: null, outputTokens: null }
  }
  const usage = value as { inputTokens?: unknown; outputTokens?: unknown; input_tokens?: unknown; output_tokens?: unknown }
  return {
    inputTokens: asIntOrNull(usage.inputTokens ?? usage.input_tokens),
    outputTokens: asIntOrNull(usage.outputTokens ?? usage.output_tokens),
  }
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}
