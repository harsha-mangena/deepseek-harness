/**
 * Observation synthesis: provenance-labelled, bounded, secret-filtered.
 *
 * Observations are the "state" shown to the decision provider. Each carries
 * its provenance (source), is bounded to a maximum size, and is filtered
 * for secrets before it ever reaches a provider.
 *
 * Secret filtering is defense in depth only: it runs a structured redaction
 * pass over JSON payloads (objects, arrays, nested values, and JSON embedded
 * in strings) plus a text-pattern fallback for free-form logs. Callers must
 * still minimize the fields they serialize before handing text to this
 * package; no filter can make arbitrary tool output safe to exfiltrate.
 *
 * All character budgets in this module count Unicode code points, not UTF-16
 * code units or bytes, so multibyte content is measured consistently with
 * the named limits.
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

/** Marker substituted for redacted secrets. */
const REDACTED_MARKER = '[REDACTED]'

/** Marker appended when text is shortened to fit a character budget. */
const TRUNCATION_MARKER = '...[TRUNCATED]'

/**
 * Sensitive object keys for structured (JSON) redaction. A key matches when
 * its normalized form (lowercased, `_`/`-`/spaces removed) equals or ends
 * with a listed name, so `api_key`, `API-KEY`, and `my_api_key` all match.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'accesskey',
  'accesstoken',
  'apikey',
  'apisecret',
  'authtoken',
  'authorization',
  'bearer',
  'clientsecret',
  'credentials',
  'passwd',
  'password',
  'passwords',
  'privatekey',
  'pwd',
  'refreshtoken',
  'secret',
  'secrets',
  'sessiontoken',
  'token',
  'tokens',
])

/** Text patterns for secret filtering of free-form (non-JSON) content. */
const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'api-key', pattern: /\b[\w-]*api[_-]?key['"]?\s*[:=]\s*['"]?[A-Z0-9_-]{16,}['"]?/gi },
  { name: 'bearer-token', pattern: /\bbearer\s+[A-Z0-9_.\~+/-]+=*/gi },
  { name: 'password', pattern: /\b[\w-]*(password|passwd|pwd)['"]?\s*[:=]\s*['"]?[^\s'"]+['"]?/gi },
  { name: 'secret', pattern: /\b[\w-]*secret['"]?\s*[:=]\s*['"]?[^\s'"]+['"]?/gi },
  { name: 'token', pattern: /\b[\w-]*token['"]?\s*[:=]\s*['"]?[A-Z0-9_.\~+/-]{8,}['"]?/gi },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
]

/**
 * Normalize an object key for sensitive-key comparison.
 * @param key - object key.
 * @returns lowercased key with `_`, `-`, and spaces removed.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '')
}

/**
 * Check whether an object key is sensitive.
 * @param key - object key.
 * @returns true when the normalized key equals or ends with a sensitive name.
 */
function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key)
  if (SENSITIVE_KEYS.has(normalized)) {
    return true
  }
  for (const sensitive of SENSITIVE_KEYS) {
    if (normalized.endsWith(sensitive)) {
      return true
    }
  }
  return false
}

/**
 * Recursively redact sensitive values in parsed JSON. String values under a
 * sensitive key become the redaction marker; objects and arrays are walked;
 * string values that themselves parse as JSON (escaped nested JSON) are
 * redacted recursively and re-serialized.
 * @param value - parsed JSON value.
 * @returns the redacted value and whether anything was redacted.
 */
function redactStructured(value: unknown): { readonly redacted: unknown; readonly changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false
    const redacted = value.map((item) => {
      const result = redactStructured(item)
      changed = changed || result.changed
      return result.redacted
    })
    return { redacted, changed }
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false
    const redacted: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveKey(key) && typeof entry === 'string') {
        redacted[key] = REDACTED_MARKER
        changed = true
      } else {
        const result = redactStructured(entry)
        redacted[key] = result.redacted
        changed = changed || result.changed
      }
    }
    return { redacted, changed }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const nested: unknown = JSON.parse(trimmed)
        const result = redactStructured(nested)
        if (result.changed) {
          return { redacted: JSON.stringify(result.redacted), changed: true }
        }
      } catch (parseError) {
        // Not valid JSON; leave the string for the text-pattern pass.
        void parseError
      }
    }
  }
  return { redacted: value, changed: false }
}

/**
 * Attempt structured secret redaction when the whole text is a JSON value.
 * Returns the original text unchanged when it is not JSON or when no
 * sensitive value was found, so benign payloads keep their exact formatting.
 * @param text - text to inspect.
 * @returns redacted JSON text, or the original text.
 */
function redactJsonText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return text
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (parseError) {
    // Not valid JSON; the text-pattern pass handles free-form content.
    void parseError
    return text
  }
  const { redacted, changed } = redactStructured(parsed)
  return changed ? JSON.stringify(redacted) : text
}

/**
 * Filter secrets from text, replacing them with a redaction marker.
 *
 * Runs structured JSON redaction first (sensitive keys, nested objects,
 * arrays, and JSON embedded in strings), then text patterns for free-form
 * logs, including `Authorization: Bearer` headers and values on following
 * lines. This is defense in depth: callers must still minimize the fields
 * they serialize before calling.
 * @param text - text to filter.
 * @returns filtered text.
 */
export function filterSecrets(text: string): string {
  let filtered = redactJsonText(text)
  for (const { pattern } of SECRET_PATTERNS) {
    filtered = filtered.replace(pattern, REDACTED_MARKER)
  }
  return filtered
}

/**
 * Bound text to a maximum number of characters, appending a truncation
 * marker when shortened. The bound applies to the returned text, marker
 * included. Counts Unicode code points and never splits a surrogate pair.
 * When the budget is smaller than the marker, the marker itself is cut to
 * the budget so truncation stays visible.
 * @param text - text to bound.
 * @param maxChars - maximum characters in the returned text; must be >= 0.
 * @returns text bounded to maxChars characters.
 */
export function boundChars(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) {
    return text
  }
  if (maxChars <= TRUNCATION_MARKER.length) {
    return Array.from(TRUNCATION_MARKER).slice(0, maxChars).join('')
  }
  return chars.slice(0, maxChars - TRUNCATION_MARKER.length).join('') + TRUNCATION_MARKER
}

/**
 * Synthesize observations into a bounded, provenance-labelled, secret-filtered state string.
 *
 * The MAX_OBSERVATION_CHARS bound applies to the final rendered payload,
 * including provenance labels, separators, and the truncation marker.
 * @param observations - observations to synthesize.
 * @returns the state string for DecisionInput.
 */
export function synthesizeObservations(observations: readonly Observation[]): string {
  const parts: string[] = []
  for (const obs of observations) {
    const provenanceLabel = describeProvenance(obs.provenance)
    parts.push(`[${provenanceLabel}] ${filterSecrets(obs.content)}`)
  }
  return boundChars(parts.join('\n---\n'), MAX_OBSERVATION_CHARS)
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
