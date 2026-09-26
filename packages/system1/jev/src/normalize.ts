/**
 * Normalize Jev API responses to NormalizedDecision.
 *
 * The provider only issues `choice` questions. An answer whose `type` is
 * present but is not `choice` is rejected as a type mismatch: per the Jev
 * wire spec, Noul is a yes/no probability, not an abstention, so a Noul
 * answer to a Choice request is malformed. The explicit escalation option
 * is the Choice fallback.
 *
 * A choice answer carries a complete probability map: every candidate ID
 * must appear exactly once, keys outside the candidate set are rejected,
 * values are finite numbers in [0,1], and the values sum to 1 within a
 * small tolerance. Score and Noul wire shapes without an explicit answer
 * type are still parsed, so typed handling stays available if those
 * question types are requested later. Raw probabilities, vendor
 * confidence, and calibrated correctness remain distinct fields.
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
  readonly type?: unknown
  readonly choice?: unknown
  readonly score?: unknown
  readonly noul?: unknown
  readonly probabilities?: unknown
  readonly confidence?: unknown
  readonly legend?: unknown
}

/** The only answer type this provider requests. */
const CHOICE_ANSWER_TYPE = 'choice'

/** Tolerance for probability sums (floating-point rounding). */
const PROBABILITY_SUM_TOLERANCE = 1e-6

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

  // Answers are keyed by question ID under `answers`; the key lookup is the
  // question-ID match.
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

  // The provider only sends choice questions; an explicit different answer
  // type is a wire mismatch, never an abstention.
  if (result.type !== undefined && result.type !== CHOICE_ANSWER_TYPE) {
    throw system1Error(
      'PROVIDER_MALFORMED_RESPONSE',
      'Jev answer type does not match the requested choice question',
      { questionId: input.questionFamily, answerType: result.type },
    )
  }

  // Noul: legacy abstention wire shape, kept for typed handling if Noul
  // questions are requested later.
  if (result.noul !== undefined) {
    return {
      decisionId: input.decisionId,
      questionFamily: input.questionFamily,
      promptVersion: input.promptVersion,
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
    // parseProbabilities guarantees an entry for every candidate ID,
    // including the selected choice.
    const selectedProbability = probabilities[choice] as number
    return {
      decisionId: input.decisionId,
      questionFamily: input.questionFamily,
      promptVersion: input.promptVersion,
      selectedId: choice,
      probabilities,
      selectedProbability,
      vendorConfidence: parseConfidence(result.confidence),
      calibratedCorrectness: null,
      calibrationVersion: null,
      modelRequested,
      modelResolved: asStringOrNull(response.model),
      requestId: asStringOrNull(response.requestId ?? response.request_id),
      usage: parseUsage(response.usage),
      reasonCode: 'accepted',
    }
  }

  // Score: legacy wire shape; select the highest-probability candidate.
  if (result.score !== undefined) {
    const probabilities = parseProbabilities(result.probabilities ?? result.score, candidateIds)
    const top = topCandidate(probabilities, candidateIds)
    return {
      decisionId: input.decisionId,
      questionFamily: input.questionFamily,
      promptVersion: input.promptVersion,
      selectedId: top.id,
      probabilities,
      selectedProbability: top.probability,
      vendorConfidence: parseConfidence(result.confidence),
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

/**
 * Parse a probability map, requiring exactly the candidate set: no unknown
 * keys, no missing candidates, finite values in [0,1], and a sum of 1
 * within tolerance.
 * @param value - raw probability map.
 * @param candidateIds - the complete candidate ID set.
 * @returns the validated probability map.
 * @throws System1Error PROVIDER_MALFORMED_RESPONSE on any deviation.
 */
function parseProbabilities(
  value: unknown,
  candidateIds: ReadonlySet<string>,
): Record<string, number> {
  if (typeof value !== 'object' || value === null) {
    throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Jev probabilities are not an object', {})
  }
  const entries = Object.entries(value)
  if (entries.length === 0) {
    throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Jev probability map is empty', {})
  }
  const result: Record<string, number> = {}
  let sum = 0
  for (const [key, val] of entries) {
    if (!candidateIds.has(key)) {
      throw system1Error(
        'PROVIDER_MALFORMED_RESPONSE',
        `Jev probability for unknown candidate ${key}`,
        { key },
      )
    }
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) {
      throw system1Error('PROVIDER_MALFORMED_RESPONSE', `Invalid probability for ${key}`, { key, val })
    }
    result[key] = val
    sum += val
  }
  for (const id of candidateIds) {
    if (!(id in result)) {
      throw system1Error(
        'PROVIDER_MALFORMED_RESPONSE',
        `Jev probability map is missing candidate ${id}`,
        { id },
      )
    }
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Jev probabilities do not sum to 1', { sum })
  }
  return result
}

/**
 * Parse vendor confidence: absent becomes null; a present value must be a
 * finite number in [0,1].
 * @param value - raw confidence value.
 * @returns the confidence, or null when absent.
 * @throws System1Error PROVIDER_MALFORMED_RESPONSE when present but invalid.
 */
function parseConfidence(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw system1Error('PROVIDER_MALFORMED_RESPONSE', 'Jev confidence is out of range', {
      confidence: value,
    })
  }
  return value
}

/**
 * Select the candidate with the highest probability; the first maximum in
 * candidate order wins ties.
 * @param probabilities - validated complete probability map.
 * @param candidateIds - candidate IDs in selection order.
 * @returns the top candidate and its probability.
 */
function topCandidate(
  probabilities: Readonly<Record<string, number>>,
  candidateIds: ReadonlySet<string>,
): { id: string; probability: number } {
  // The map was validated to hold every candidate ID.
  let bestId = ''
  let bestProbability = -1
  for (const id of candidateIds) {
    const probability = probabilities[id] as number
    if (probability > bestProbability) {
      bestProbability = probability
      bestId = id
    }
  }
  return { id: bestId, probability: bestProbability }
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

function asIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}
