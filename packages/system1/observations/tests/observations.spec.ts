/** Observation synthesis and candidate menu tests. */

import { describe, expect, it } from 'vitest'
import {
  ESCALATE_CANDIDATE_ID,
  boundChars,
  describeProvenance,
  escalateCandidate,
  filterSecrets,
  generateCandidateMenu,
  hashObservations,
  hashPreconditions,
  synthesizeObservations,
  MAX_OBSERVATION_CHARS,
} from '@deepseek-ai/dsh-system1-observations'
import type { CatalogTool, Observation } from '@deepseek-ai/dsh-system1-observations'

describe('observation synthesis', () => {
  it('labels provenance and filters secrets', () => {
    const observations: Observation[] = [
      {
        provenance: { kind: 'tool-result', toolId: 'ci-runs' },
        content: 'Build passed. api_key = sk-1234567890abcdef',
        timestampMs: 1000,
      },
      {
        provenance: { kind: 'user-input' },
        content: 'Check the CI status',
        timestampMs: 2000,
      },
    ]
    const state = synthesizeObservations(observations)
    expect(state).toContain('[tool:ci-runs]')
    expect(state).toContain('[user]')
    expect(state).not.toContain('sk-1234567890abcdef')
    expect(state).toContain('[REDACTED]')
  })

  it('bounds the final rendered payload, marker included', () => {
    const longContent = 'x'.repeat(MAX_OBSERVATION_CHARS + 100)
    const observations: Observation[] = [
      { provenance: { kind: 'system' }, content: longContent, timestampMs: 1000 },
    ]
    const state = synthesizeObservations(observations)
    expect(state.length).toBeLessThanOrEqual(MAX_OBSERVATION_CHARS)
    expect(state).toContain('[TRUNCATED]')
  })

  it('bounds separators and later observations within the final payload', () => {
    // Two half-budget parts plus the separator exceed the budget; the tail is cut.
    const half = 'y'.repeat(Math.floor(MAX_OBSERVATION_CHARS / 2))
    const observations: Observation[] = [
      { provenance: { kind: 'system' }, content: half, timestampMs: 1000 },
      { provenance: { kind: 'system' }, content: `${half}should not appear`, timestampMs: 2000 },
    ]
    const state = synthesizeObservations(observations)
    expect(state).not.toContain('should not appear')
    expect(state.length).toBeLessThanOrEqual(MAX_OBSERVATION_CHARS)
    expect(state).toContain('[TRUNCATED]')
  })

  it('filters bearer tokens, passwords, and private keys', () => {
    expect(filterSecrets('Authorization: Bearer abc123.def456')).toContain('[REDACTED]')
    expect(filterSecrets('password: hunter2')).toContain('[REDACTED]')
    expect(filterSecrets('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).toContain(
      '[REDACTED]',
    )
    // Clean text passes through.
    expect(filterSecrets('Build passed')).toBe('Build passed')
  })

  it('describes all provenance kinds', () => {
    expect(describeProvenance({ kind: 'tool-result', toolId: 't' })).toBe('tool:t')
    expect(describeProvenance({ kind: 'session-event', eventType: 'e' })).toBe('event:e')
    expect(describeProvenance({ kind: 'user-input' })).toBe('user')
    expect(describeProvenance({ kind: 'system' })).toBe('system')
  })

  it('hashes observations deterministically', () => {
    const obs: Observation[] = [
      { provenance: { kind: 'system' }, content: 'hello', timestampMs: 1000 },
    ]
    const h1 = hashObservations(obs)
    const h2 = hashObservations(obs)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    // Different content => different hash.
    const h3 = hashObservations([{ ...obs[0], content: 'world' }])
    expect(h3).not.toBe(h1)
  })
})

describe('candidate menus', () => {
  const tools: CatalogTool[] = [
    {
      toolId: 'ci-runs',
      label: 'Read CI runs',
      route: 'tool',
      effect: 'read',
      operationRef: 'op:ci-runs:read:v1',
      preconditions: { branch: 'main', fresh: true },
      verificationPolicyId: 'verify:ci-runs:v1',
    },
    {
      toolId: 'deploy',
      label: 'Deploy to staging',
      route: 'tool',
      effect: 'write',
      operationRef: 'op:deploy:write:v1',
      preconditions: { environment: 'staging' },
      verificationPolicyId: 'verify:deploy:v1',
    },
  ]

  it('generates a flat menu with precondition hashes and ESCALATE last', () => {
    const menu = generateCandidateMenu(tools)
    expect(menu).toHaveLength(3)
    expect(menu[0].id).toBe('c1')
    expect(menu[0].preconditionHash).toMatch(/^[0-9a-f]{64}$/)
    expect(menu[1].id).toBe('c2')
    // ESCALATE is always last.
    const last = menu[menu.length - 1]
    expect(last.id).toBe(ESCALATE_CANDIDATE_ID)
    expect(last.route).toBe('stop')
  })

  it('computes stable precondition hashes regardless of key order', () => {
    const h1 = hashPreconditions({ b: 2, a: 1 })
    const h2 = hashPreconditions({ a: 1, b: 2 })
    expect(h1).toBe(h2)
    const h3 = hashPreconditions({ a: 1, b: 3 })
    expect(h3).not.toBe(h1)
    // Arrays and nested objects are canonicalized.
    const h4 = hashPreconditions({ items: [{ z: 1, a: 2 }, 3] })
    const h5 = hashPreconditions({ items: [{ a: 2, z: 1 }, 3] })
    expect(h4).toBe(h5)
  })

  it('respects maxCandidates, always reserving ESCALATE', () => {
    const menu = generateCandidateMenu(tools, { maxCandidates: 2 })
    expect(menu).toHaveLength(2)
    expect(menu[1].id).toBe(ESCALATE_CANDIDATE_ID)
    // Even with maxCandidates=1, ESCALATE is present.
    const minimal = generateCandidateMenu(tools, { maxCandidates: 1 })
    expect(minimal).toHaveLength(1)
    expect(minimal[0].id).toBe(ESCALATE_CANDIDATE_ID)
  })

  it('builds the ESCALATE candidate directly', () => {
    const esc = escalateCandidate('verify:custom:v1')
    expect(esc.id).toBe(ESCALATE_CANDIDATE_ID)
    expect(esc.verificationPolicyId).toBe('verify:custom:v1')
    expect(esc.route).toBe('stop')
  })
})

describe('secret filtering (structured JSON)', () => {
  const secret = 'abcd1234abcd1234abcd1234'

  it('R32: redacts JSON-formatted secrets', () => {
    const filtered = filterSecrets(JSON.stringify({ api_key: secret, password: 'private-pass' }))
    expect(filtered).not.toContain(secret)
    expect(filtered).not.toContain('private-pass')
    expect(filtered).toContain('[REDACTED]')
  })

  it('redacts nested objects', () => {
    const filtered = filterSecrets(JSON.stringify({ outer: { api_key: 'sk-nested-secret-12345' } }))
    expect(filtered).not.toContain('sk-nested-secret-12345')
  })

  it('redacts JSON embedded in strings (escaped quotes)', () => {
    const inner = JSON.stringify({ api_key: 'sk-escaped-secret-67890' })
    const filtered = filterSecrets(JSON.stringify({ payload: inner }))
    expect(filtered).not.toContain('sk-escaped-secret-67890')
  })

  it('redacts arrays of objects', () => {
    const filtered = filterSecrets(
      JSON.stringify([{ token: 'tok-value-abcdef' }, { user: 'bob' }]),
    )
    expect(filtered).not.toContain('tok-value-abcdef')
    expect(filtered).toContain('bob')
  })

  it('normalizes key spellings', () => {
    expect(filterSecrets(JSON.stringify({ 'API-KEY': 'sk-upper-secret-1' }))).not.toContain(
      'sk-upper-secret-1',
    )
    expect(filterSecrets(JSON.stringify({ my_api_key: 'sk-prefixed-secret-2' }))).not.toContain(
      'sk-prefixed-secret-2',
    )
  })

  it('redacts sensitive keys holding objects by recursing', () => {
    const filtered = filterSecrets(
      JSON.stringify({ credentials: { user: 'u', password: 'pw-secret-123' } }),
    )
    expect(filtered).not.toContain('pw-secret-123')
    expect(filtered).toContain('u')
  })

  it('redacts authorization headers in JSON', () => {
    const filtered = filterSecrets(JSON.stringify({ authorization: 'Bearer header-secret-1' }))
    expect(filtered).not.toContain('header-secret-1')
  })

  it('leaves benign JSON byte-identical', () => {
    const benign = '{"user": "bob", "count": 3, "n": null, "tags": ["a", "b"]}'
    expect(filterSecrets(benign)).toBe(benign)
  })

  it('leaves nested JSON strings without secrets unchanged', () => {
    const text = '{"payload": "{\\"a\\": 1}"}'
    expect(filterSecrets(text)).toBe(text)
  })

  it('leaves malformed nested JSON strings for the text pass', () => {
    const filtered = filterSecrets('{"payload": "{oops", "api_key": "sk-1234567890abcdef"}')
    expect(filtered).not.toContain('sk-1234567890abcdef')
    expect(filtered).toContain('{oops')
  })

  it('falls back to text patterns for invalid JSON', () => {
    expect(filterSecrets('{not valid json, api_key = sk-1234567890abcdef}')).toContain(
      '[REDACTED]',
    )
  })
})

describe('secret filtering (text fallback)', () => {
  it('redacts quoted key/value pairs', () => {
    expect(filterSecrets('"api_key": "sk-1234567890abcdef"')).toContain('[REDACTED]')
    expect(filterSecrets('"password":"hunter2"')).toContain('[REDACTED]')
  })

  it('redacts header-style credentials', () => {
    expect(filterSecrets('Authorization: Bearer abcdefghijklmnop')).toContain('[REDACTED]')
    expect(filterSecrets('authorization: bearer abcdefghijklmnop')).toContain('[REDACTED]')
  })

  it('redacts secret and token keys', () => {
    expect(filterSecrets('client_secret=abcdefgh12345678')).toContain('[REDACTED]')
    expect(filterSecrets('mytoken: abcdefgh12345678')).toContain('[REDACTED]')
    expect(filterSecrets('secret = hunter2')).not.toContain('hunter2')
  })

  it('redacts values on following lines', () => {
    const filtered = filterSecrets('api_key:\n  abcdefghijklmnop1234')
    expect(filtered).not.toContain('abcdefghijklmnop1234')
    expect(filtered).toContain('[REDACTED]')
  })
})

describe('character bounding', () => {
  it('boundChars leaves text within budget untouched', () => {
    expect(boundChars('abcdef', 6)).toBe('abcdef')
    expect(boundChars('abcdef', 100)).toBe('abcdef')
  })

  it('boundChars truncates with a marker inside the budget', () => {
    const result = boundChars('x'.repeat(100), 50)
    expect(result).toHaveLength(50)
    expect(result).toBe(`${'x'.repeat(36)}...[TRUNCATED]`)
  })

  it('boundChars cuts the marker itself for tiny budgets', () => {
    expect(boundChars('hello world', 8)).toBe('...[TRUN')
    expect(boundChars('hello world', 0)).toBe('')
  })

  it('boundChars counts multibyte characters without splitting surrogates', () => {
    const result = boundChars('😀'.repeat(100), 50)
    expect(Array.from(result)).toHaveLength(50)
    expect(result.endsWith('...[TRUNCATED]')).toBe(true)
    // No lone surrogates.
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('R31: bounds observations including markers and separators', () => {
    const state = synthesizeObservations([
      { provenance: { kind: 'user-input' }, content: 'x'.repeat(40000), timestampMs: 1 },
    ])
    expect(state.length).toBeLessThanOrEqual(MAX_OBSERVATION_CHARS)
  })

  it('does not mark output that exactly fills the budget', () => {
    const state = synthesizeObservations([
      {
        provenance: { kind: 'system' },
        content: 'x'.repeat(MAX_OBSERVATION_CHARS - '[system] '.length),
        timestampMs: 1,
      },
    ])
    expect(Array.from(state)).toHaveLength(MAX_OBSERVATION_CHARS)
    expect(state).not.toContain('[TRUNCATED]')
  })

  it('bounds multibyte observations without splitting surrogates', () => {
    const state = synthesizeObservations([
      { provenance: { kind: 'user-input' }, content: '😀'.repeat(40000), timestampMs: 1 },
    ])
    expect(Array.from(state)).toHaveLength(MAX_OBSERVATION_CHARS)
    expect(state).toContain('[TRUNCATED]')
    expect(state).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('synthesizes empty observations to an empty string', () => {
    expect(synthesizeObservations([])).toBe('')
  })
})
