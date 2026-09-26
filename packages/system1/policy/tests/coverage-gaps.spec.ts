/** Coverage-gap tests: exercise uncovered branches in policy.ts. */

import { describe, expect, it } from 'vitest'
import { PolicyEngine } from '../src/policy.ts'
import type { Candidate, CapabilityProfile, GuardContext } from '../src/policy.ts'

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
  allowedRoutes: new Set(['tool', 'direct']),
  globalRequiredGuards: [],
}

const ctx: GuardContext = { tenantId: 'tenant-a', taskId: 't1', policyVersion: 'v1' }

describe('policy coverage gaps', () => {
  it('includes guard detail in GUARD_UNKNOWN reason', async () => {
    const engine = new PolicyEngine()
    engine.setEffectPolicy({ effect: 'read', allowed: true, requiredGuards: ['detail-guard'] })
    engine.registerGuard({
      id: 'detail-guard',
      evaluate: () => ({ guardId: 'detail-guard', verdict: 'unknown', detail: 'specific failure detail' }),
    })
    const decision = await engine.evaluate(candidate, profile, ctx)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.code).toBe('GUARD_UNKNOWN')
      expect(decision.reason).toContain('specific failure detail')
    }
  })

  it('omits detail suffix when guard unknown has no detail', async () => {
    const engine = new PolicyEngine()
    engine.setEffectPolicy({ effect: 'read', allowed: true, requiredGuards: ['nodetail-guard'] })
    engine.registerGuard({
      id: 'nodetail-guard',
      evaluate: () => ({ guardId: 'nodetail-guard', verdict: 'unknown' }),
    })
    const decision = await engine.evaluate(candidate, profile, ctx)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.code).toBe('GUARD_UNKNOWN')
      expect(decision.reason).toBe('Guard nodetail-guard returned unknown')
    }
  })
})
