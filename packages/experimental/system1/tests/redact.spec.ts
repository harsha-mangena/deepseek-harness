/**
 * Unit tests for the secret-redaction atom (src/redact.ts): outbound Jev
 * state is scrubbed of secret-like values before it leaves the box.
 */
import { describe, expect, it } from 'vitest'
import { REDACTED, redactSecrets } from '../src/redact.ts'

describe('redactSecrets', () => {
  it('redacts secret-like property names', () => {
    const out = redactSecrets({ apiKey: 'sk-123', username: 'harsha' }) as Record<string, unknown>
    expect(out.apiKey).toBe(REDACTED)
    expect(out.username).toBe('harsha')
  })

  it('redacts high-precision credential prefixes inside strings', () => {
    // The secret is scrubbed but the surrounding prose survives so Jev
    // keeps its context.
    const out = redactSecrets({ note: 'call the key sk-abc123def456ghi789jkl now' }) as Record<string, unknown>
    expect(out.note).toBe(`call the key ${REDACTED} now`)
  })

  it('redacts nested objects and arrays', () => {
    const out = redactSecrets({
      args: { token: 'abc', nested: [{ password: 'x' }] },
    }) as { args: { token: unknown; nested: Array<{ password: unknown }> } }
    expect(out.args.token).toBe(REDACTED)
    expect(out.args.nested[0]?.password).toBe(REDACTED)
  })

  it('does not mutate the input', () => {
    const input = { apiKey: 'sk-123', deep: { secret: 's' } }
    redactSecrets(input)
    expect(input.apiKey).toBe('sk-123')
    expect(input.deep.secret).toBe('s')
  })

  it('handles cycles without hanging', () => {
    const input: Record<string, unknown> = { apiKey: 'sk-1' }
    input.self = input
    const out = redactSecrets(input) as Record<string, unknown>
    expect(out.apiKey).toBe(REDACTED)
    // The cyclic reference is cut (replaced with the marker), not followed.
    expect(out.self).toBe(REDACTED)
  })

  it('leaves non-secret values and primitives alone', () => {
    expect(redactSecrets('plain text')).toBe('plain text')
    expect(redactSecrets(42)).toBe(42)
    expect(redactSecrets(null)).toBe(null)
    const out = redactSecrets({ toolName: 'read_file', confidence: 0.9 }) as Record<string, unknown>
    expect(out.toolName).toBe('read_file')
    expect(out.confidence).toBe(0.9)
  })
})
