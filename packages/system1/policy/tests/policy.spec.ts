/** Policy engine tests: guards, capability profiles, effect policies. */

import { describe, expect, it } from 'vitest'
import { enforcePolicyDecision, PolicyEngine } from '@deepseek-ai/dsh-system1-policy'
import type {
  Candidate,
  CapabilityProfile,
  Guard,
  GuardContext,
} from '@deepseek-ai/dsh-system1-policy'

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
  globalRequiredGuards: ['tenant-isolation'],
}

const ctx = { tenantId: 'tenant-a', taskId: 't1', policyVersion: 'v1' }

function passGuard(id: string): Guard {
  return { id, evaluate: () => ({ guardId: id, verdict: 'pass' }) }
}

function makeEngine(): PolicyEngine {
  const engine = new PolicyEngine()
  engine.setEffectPolicy({ effect: 'read', allowed: true, requiredGuards: ['fresh-catalog'] })
  engine.setEffectPolicy({ effect: 'write', allowed: false, requiredGuards: [] })
  engine.setEffectPolicy({ effect: 'external', allowed: false, requiredGuards: [] })
  engine.registerGuard(passGuard('tenant-isolation'))
  engine.registerGuard(passGuard('fresh-catalog'))
  return engine
}

describe('policy engine', () => {
  it('allows dispatch when all required guards pass', async () => {
    const engine = makeEngine()
    const decision = await engine.evaluate(candidate, profile, ctx)
    expect(decision.allowed).toBe(true)
    if (decision.allowed) {
      expect(decision.evaluatedGuards.map((g) => g.guardId).sort()).toEqual([
        'fresh-catalog',
        'tenant-isolation',
      ])
    }
    expect(() => enforcePolicyDecision(decision)).not.toThrow()
  })

  it('blocks when a required guard returns false', async () => {
    const engine = makeEngine()
    engine.registerGuard({
      id: 'fresh-catalog',
      evaluate: () => ({ guardId: 'fresh-catalog', verdict: 'fail', detail: 'catalog is stale' }),
    })
    const decision = await engine.evaluate(candidate, profile, ctx)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.code).toBe('GUARD_BLOCKED')
      expect(decision.reason).toContain('catalog is stale')
    }
    expect(() => enforcePolicyDecision(decision)).toThrow(/catalog is stale/)
  })

  it('blocks when a required guard is missing (not registered)', async () => {
    const engine = makeEngine()
    engine.unregisterGuard('fresh-catalog')
    const decision = await engine.evaluate(candidate, profile, ctx)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.code).toBe('GUARD_MISSING')
    }
  })

  it('blocks when a required guard returns unknown', async () => {
    const engine = makeEngine()
    engine.registerGuard({
      id: 'fresh-catalog',
      evaluate: () => ({ guardId: 'fresh-catalog', verdict: 'unknown', detail: 'catalog unreachable' }),
    })
    const decision = await engine.evaluate(candidate, profile, ctx)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.code).toBe('GUARD_UNKNOWN')
      expect(decision.reason).toContain('catalog unreachable')
    }
  })

  it('blocks when a guard throws (treated as unknown)', async () => {
    const engine = makeEngine()
    engine.registerGuard({
      id: 'fresh-catalog',
      evaluate: () => {
        throw new Error('boom')
      },
    })
    const decision = await engine.evaluate(candidate, profile, ctx)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.code).toBe('GUARD_UNKNOWN')
    }
  })

  it('evaluates newly registered guards without code changes', async () => {
    // A guard registered after engine creation is compiled into the required list.
    const engine = makeEngine()
    const lateProfile: CapabilityProfile = {
      ...profile,
      globalRequiredGuards: ['tenant-isolation', 'late-guard'],
    }
    // Not yet registered: missing blocks.
    const missing = await engine.evaluate(candidate, lateProfile, ctx)
    expect(missing.allowed).toBe(false)
    // Register it: now it participates.
    let blocked = true
    engine.registerGuard({
      id: 'late-guard',
      evaluate: () => ({ guardId: 'late-guard', verdict: blocked ? 'fail' : 'pass' }),
    })
    const denied = await engine.evaluate(candidate, lateProfile, ctx)
    expect(denied.allowed).toBe(false)
    blocked = false
    const allowed = await engine.evaluate(candidate, lateProfile, ctx)
    expect(allowed.allowed).toBe(true)
    if (allowed.allowed) {
      expect(allowed.evaluatedGuards.some((g) => g.guardId === 'late-guard')).toBe(true)
    }
  })

  it('denies effects and routes outside the capability profile', async () => {
    const engine = makeEngine()
    const writeCandidate: Candidate = { ...candidate, effect: 'write' }
    const writeDecision = await engine.evaluate(writeCandidate, profile, ctx)
    expect(writeDecision.allowed).toBe(false)
    if (!writeDecision.allowed) {
      expect(writeDecision.code).toBe('CAPABILITY_NOT_GRANTED')
    }
    const badRoute: Candidate = { ...candidate, route: 'reasoning' }
    const routeDecision = await engine.evaluate(badRoute, profile, ctx)
    expect(routeDecision.allowed).toBe(false)
  })

  it('denies effects disabled by the effect policy', async () => {
    const engine = makeEngine()
    const profileAllowingWrite: CapabilityProfile = {
      ...profile,
      allowedEffects: new Set(['read', 'write']),
    }
    const writeCandidate: Candidate = { ...candidate, effect: 'write' }
    const decision = await engine.evaluate(writeCandidate, profileAllowingWrite, ctx)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.code).toBe('EFFECT_NOT_ALLOWED')
    }
  })

  it('denies cross-tenant access at the authoritative evaluation', async () => {
    const engine = makeEngine()
    // Even with a permissive tenant-isolation guard registered, a request
    // for a different tenant must be denied by the engine itself: the
    // guard check alone can be bypassed by evaluating with another profile.
    engine.registerGuard({
      id: 'tenant-isolation',
      evaluate: (c: GuardContext) => ({
        guardId: 'tenant-isolation',
        verdict: 'pass' as const,
        detail: c.tenantId === 'tenant-a' ? undefined : 'tenant mismatch',
      }),
    })
    const otherTenant = await engine.evaluate(candidate, profile, {
      ...ctx,
      tenantId: 'tenant-b',
    })
    expect(otherTenant.allowed).toBe(false)
    if (!otherTenant.allowed) {
      expect(otherTenant.code).toBe('TENANT_MISMATCH')
      expect(otherTenant.reason).toContain('tenant-a')
      expect(otherTenant.reason).toContain('tenant-b')
      expect(otherTenant.evaluatedGuards).toEqual([])
    }
  })
})
