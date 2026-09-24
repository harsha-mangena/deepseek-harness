/** Observation synthesis and candidate menu tests. */

import { describe, expect, it } from 'vitest'
import {
  ESCALATE_CANDIDATE_ID,
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

  it('bounds observations and total state', () => {
    const longContent = 'x'.repeat(MAX_OBSERVATION_CHARS + 100)
    const observations: Observation[] = [
      { provenance: { kind: 'system' }, content: longContent, timestampMs: 1000 },
    ]
    const state = synthesizeObservations(observations)
    expect(state.length).toBeLessThanOrEqual(MAX_OBSERVATION_CHARS + 50)
    expect(state).toContain('[TRUNCATED]')
  })

  it('stops adding observations when the budget is nearly exhausted', () => {
    // Fill the budget so the next observation has <= 100 chars remaining.
    const filler = 'y'.repeat(MAX_OBSERVATION_CHARS - 10)
    const observations: Observation[] = [
      { provenance: { kind: 'system' }, content: filler, timestampMs: 1000 },
      { provenance: { kind: 'system' }, content: 'should not appear', timestampMs: 2000 },
    ]
    const state = synthesizeObservations(observations)
    expect(state).not.toContain('should not appear')
    expect(state.length).toBeLessThanOrEqual(MAX_OBSERVATION_CHARS + 50)
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
