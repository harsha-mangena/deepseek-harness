/**
 * Observation synthesis: provenance-labelled, bounded, secret-filtered.
 *
 * Observations are the "state" shown to the decision provider. Each carries
 * its provenance (source), is bounded to a maximum size, and is filtered
 * for secrets before it ever reaches a provider.
 *
 * @module @deepseek-ai/dsh-system1-observations/observation
 */

import { createHash } from 'node:crypto'

/** Maximum observation content size in characters. */
export const MAX_OBSERVATION_CHARS = 32_000

/** Where an observation came from. */
export type ObservationProvenance =
  | { readonly kind: 'tool-result'; readonly toolId: string }
  | { readonly kind: 'session-event'; readonly eventType: string }
  | { readonly kind: 'user-input' }
  | { readonly kind: 'system' }

/** A single observation with provenance. */
export interface Observation {
  readonly provenance: ObservationProvenance
  readonly content: string
  readonly timestampMs: number
}

/** Patterns for secret filtering. */
const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'api-key', pattern: /\b(api[_-]?key|apikey)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/gi },
  { name: 'bearer-token', pattern: /\bbearer\s+[A-Za-z0-9_\-\.~+/]+=*/gi },
  { name: 'password', pattern: /\b(password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]+['"]?/gi },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
]

/**
 * Filter secrets from text, replacing them with a redaction marker.
 * @param text - text to filter.
 * @returns filtered text.
 */
export function filterSecrets(text: string): string {
  let filtered = text
  for (const { pattern } of SECRET_PATTERNS) {
    filtered = filtered.replace(pattern, '[REDACTED]')
  }
  return filtered
}

/**
 * Synthesize observations into a bounded, provenance-labelled, secret-filtered state string.
 * @param observations - observations to synthesize.
 * @returns the state string for DecisionInput.
 */
export function synthesizeObservations(observations: readonly Observation[]): string {
  const parts: string[] = []
  let totalChars = 0

  for (const obs of observations) {
    const provenanceLabel = describeProvenance(obs.provenance)
    const filtered = filterSecrets(obs.content)
    // Bound each observation; truncate with a marker.
    const bounded = filtered.length > MAX_OBSERVATION_CHARS
      ? filtered.slice(0, MAX_OBSERVATION_CHARS) + '...[TRUNCATED]'
      : filtered
    const part = `[${provenanceLabel}] ${bounded}`
    // Bound the total; stop adding when full.
    if (totalChars + part.length > MAX_OBSERVATION_CHARS) {
      const remaining = MAX_OBSERVATION_CHARS - totalChars
      if (remaining > 100) {
        parts.push(part.slice(0, remaining) + '...[TRUNCATED]')
      }
      break
    }
    parts.push(part)
    totalChars += part.length
  }

  return parts.join('\n---\n')
}

/**
 * Describe a provenance for labelling.
 * @param provenance - provenance to describe.
 */
export function describeProvenance(provenance: ObservationProvenance): string {
  switch (provenance.kind) {
    case 'tool-result':
      return `tool:${provenance.toolId}`
    case 'session-event':
      return `event:${provenance.eventType}`
    case 'user-input':
      return 'user'
    case 'system':
      return 'system'
  }
}

/**
 * Hash observations for the observationHash field.
 * @param observations - observations to hash.
 * @returns hex SHA-256 hash.
 */
export function hashObservations(observations: readonly Observation[]): string {
  const hash = createHash('sha256')
  for (const obs of observations) {
    hash.update(describeProvenance(obs.provenance))
    hash.update('\0')
    hash.update(filterSecrets(obs.content))
    hash.update('\0')
  }
  return hash.digest('hex')
}
