/**
 * Secret redaction for Jev-bound state.
 *
 * Tool arguments and agent history can carry API keys, tokens, and session
 * material that the judge never needs. The Jev backend is an off-box wire
 * call, so the state is scrubbed at that boundary: every call site is
 * covered by redacting inside `JevBackend.decideMany` rather than at each
 * question builder.
 *
 * The rules are deliberately conservative: key names are matched against a
 * secret-name pattern, and bare string values are only scrubbed when they
 * match high-precision credential prefixes (a false positive here would
 * blind the judge; a false negative leaks a secret). Cyclic structures and
 * deep nesting are handled without throwing.
 */

/** Replacement marker for redacted values. */
export const REDACTED = '[REDACTED]'

/** Key names that indicate a secret value. */
const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|api[_-]?key|auth|credential|private[_-]?key|session[_-]?key|bearer|client[_-]?secret/i

/**
 * High-precision credential prefixes in bare string values. Each pattern
 * anchors on a provider-issued prefix so ordinary prose never matches.
 */
const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9\-_]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bgho_[A-Za-z0-9]{20,}/,
  /\bxox[abp]-[A-Za-z0-9\-]{10,}/,
  /\bAKIA[0-9A-Z]{16}/,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}/,
  /\bBasic\s+[A-Za-z0-9+/]{20,}={0,2}/,
]

/** Max recursion depth when walking state. */
const MAX_DEPTH = 12

/**
 * Returns a deep copy of `value` with secret-shaped entries replaced by
 * {@link REDACTED}. Objects, arrays, and strings are walked; all other
 * values pass through unchanged.
 *
 * @param value - The value to scrub.
 * @param depth - Current recursion depth (callers omit this).
 * @param seen - Cycle guard (callers omit this).
 * @returns The scrubbed copy.
 */
export function redactSecrets(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH || seen.has(value)) return REDACTED
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map(item => redactSecrets(item, depth + 1, seen))
  }
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key)
      ? REDACTED
      : redactSecrets(entry, depth + 1, seen)
  }
  return out
}

/**
 * Scrubs high-precision credential patterns from a string, preserving the
 * surrounding prose so the judge keeps its context.
 */
function redactString(text: string): string {
  let out = text
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const scheme = match.match(/^(Bearer|Basic)\s+/i)?.[0] ?? ''
      return `${scheme}${REDACTED}`
    })
  }
  return out
}
