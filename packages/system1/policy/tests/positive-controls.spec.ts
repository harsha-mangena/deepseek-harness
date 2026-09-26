/**
 * Positive control C02: an absent required policy guard blocks dispatch
 * eligibility. Reviewer-verified behavior that must keep working.
 */

import { describe, expect, it } from 'vitest'
import { PolicyEngine } from '@deepseek-ai/dsh-system1-policy'
import type { Candidate, CapabilityProfile } from '@deepseek-ai/dsh-system1-policy'

const candidate: Candidate = {
  id: 'c1',
  label: 'Read CI runs',
  route: 'tool',
  effect: 'read',
  operationRef: 'op:ci-runs:read:v1',
  preconditionHash: 'abc123',
  verificationPolicyId: 'verify:ci-runs:v1',
}

const profile: CapabilityProfile = {
  tenantId: 'tenant-a',
  profileVersion: 'v1',
  allowedEffects: new Set(['read']),
  allowedRoutes: new Set(['tool', 'stop']),
  globalRequiredGuards: ['missing'],
}

describe('positive controls', () => {
  it('C02 an absent required policy guard blocks dispatch eligibility', async () => {
    const engine = new PolicyEngine()
    engine.setEffectPolicy({ effect: 'read', allowed: true, requiredGuards: [] })
    const decision = await engine.evaluate(candidate, profile, {
      tenantId: profile.tenantId,
      taskId: 't',
      policyVersion: 'p1',
    })
    expect(decision.allowed).toBe(false)
  })
})
