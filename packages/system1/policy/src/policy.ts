/**
 * Policy engine: capability profiles, effect policies, and guard evaluation.
 *
 * Policy is independent of model output. For every operation the engine
 * compiles the explicit list of required guards and evaluates ALL of them.
 * A false, missing, or unknown required guard blocks dispatch. Guards are
 * registered dynamically; the engine never hardcodes a fixed gate list.
 *
 * @module @deepseek-ai/dsh-system1-policy/policy
 */

import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type { Candidate, Effect, RouteKind } from '@deepseek-ai/dsh-system1-contracts'

/** Verdict of a single guard evaluation. */
export type GuardVerdict = 'pass' | 'fail' | 'unknown'

/** Result of evaluating one guard. */
export interface GuardResult {
  readonly guardId: string
  readonly verdict: GuardVerdict
  readonly detail?: string
}

/** Context passed to every guard. */
export interface GuardContext {
  readonly tenantId: string
  readonly taskId: string
  readonly candidate: Candidate
  readonly policyVersion: string
}

/** A named, registered guard. */
export interface Guard {
  readonly id: string
  evaluate(ctx: GuardContext): GuardResult | Promise<GuardResult>
}

/** What a tenant or workload is permitted to do. */
export interface CapabilityProfile {
  readonly tenantId: string
  readonly profileVersion: string
  readonly allowedEffects: ReadonlySet<Effect>
  readonly allowedRoutes: ReadonlySet<RouteKind>
  /** Guard IDs that must pass for every dispatch, regardless of effect. */
  readonly globalRequiredGuards: readonly string[]
}

/** Policy for one effect class. */
export interface EffectPolicy {
  readonly effect: Effect
  readonly allowed: boolean
  /** Guard IDs required for this effect class. */
  readonly requiredGuards: readonly string[]
}

/** Outcome of policy evaluation. */
export type PolicyDecision =
  | { readonly allowed: true; readonly evaluatedGuards: readonly GuardResult[] }
  | {
      readonly allowed: false
      readonly reason: string
      readonly code:
        | 'EFFECT_NOT_ALLOWED'
        | 'CAPABILITY_NOT_GRANTED'
        | 'GUARD_BLOCKED'
        | 'GUARD_MISSING'
        | 'GUARD_UNKNOWN'
      readonly evaluatedGuards: readonly GuardResult[]
    }

/** The policy engine. Guards are registered; required lists are compiled per operation. */
export class PolicyEngine {
  private readonly guards = new Map<string, Guard>()
  private readonly effectPolicies = new Map<Effect, EffectPolicy>()

  /**
   * Register a guard. Re-registering the same ID replaces the implementation.
   * @param guard - guard to register.
   */
  registerGuard(guard: Guard): void {
    this.guards.set(guard.id, guard)
  }

  /**
   * Remove a registered guard.
   * @param guardId - ID of the guard to remove.
   * @returns true if a guard was removed.
   */
  unregisterGuard(guardId: string): boolean {
    return this.guards.delete(guardId)
  }

  /**
   * Set the policy for an effect class.
   * @param policy - effect policy.
   */
  setEffectPolicy(policy: EffectPolicy): void {
    this.effectPolicies.set(policy.effect, policy)
  }

  /**
   * Evaluate whether a candidate may be dispatched.
   * Compiles the required guard list from the capability profile and the
   * candidate's effect policy, then evaluates every required guard.
   * @param candidate - candidate operation to check.
   * @param profile - tenant capability profile.
   * @param ctx - guard evaluation context.
   * @returns the policy decision.
   */
  async evaluate(
    candidate: Candidate,
    profile: CapabilityProfile,
    ctx: Omit<GuardContext, 'candidate'>,
  ): Promise<PolicyDecision> {
    const fullCtx: GuardContext = { ...ctx, candidate }

    // Effect must be allowed by both the profile and the effect policy.
    if (!profile.allowedEffects.has(candidate.effect)) {
      return {
        allowed: false,
        reason: `Effect ${candidate.effect} not granted to tenant ${profile.tenantId}`,
        code: 'CAPABILITY_NOT_GRANTED',
        evaluatedGuards: [],
      }
    }
    const effectPolicy = this.effectPolicies.get(candidate.effect)
    if (!effectPolicy || !effectPolicy.allowed) {
      return {
        allowed: false,
        reason: `Effect ${candidate.effect} is not allowed by policy`,
        code: 'EFFECT_NOT_ALLOWED',
        evaluatedGuards: [],
      }
    }
    if (!profile.allowedRoutes.has(candidate.route)) {
      return {
        allowed: false,
        reason: `Route ${candidate.route} not granted to tenant ${profile.tenantId}`,
        code: 'CAPABILITY_NOT_GRANTED',
        evaluatedGuards: [],
      }
    }

    // Compile the explicit required guard list: global + effect-specific.
    // Deduplicated, in registration-independent order.
    const requiredIds = [...new Set([...profile.globalRequiredGuards, ...effectPolicy.requiredGuards])]

    const evaluated: GuardResult[] = []
    for (const guardId of requiredIds) {
      const guard = this.guards.get(guardId)
      if (!guard) {
        // Missing required guard blocks dispatch.
        return {
          allowed: false,
          reason: `Required guard ${guardId} is not registered`,
          code: 'GUARD_MISSING',
          evaluatedGuards: evaluated,
        }
      }
      let result: GuardResult
      try {
        result = await guard.evaluate(fullCtx)
      } catch (error) {
        // A throwing guard is treated as unknown, which blocks.
        evaluated.push({ guardId, verdict: 'unknown', detail: String(error) })
        return {
          allowed: false,
          reason: `Guard ${guardId} threw during evaluation`,
          code: 'GUARD_UNKNOWN',
          evaluatedGuards: evaluated,
        }
      }
      // Normalize the guard's reported ID to the required ID.
      const normalized: GuardResult =
        result.detail === undefined
          ? { guardId, verdict: result.verdict }
          : { guardId, verdict: result.verdict, detail: result.detail }
      evaluated.push(normalized)
      if (result.verdict === 'fail') {
        return {
          allowed: false,
          reason: `Guard ${guardId} blocked dispatch${result.detail ? `: ${result.detail}` : ''}`,
          code: 'GUARD_BLOCKED',
          evaluatedGuards: evaluated,
        }
      }
      if (result.verdict === 'unknown') {
        return {
          allowed: false,
          reason: `Guard ${guardId} returned unknown${result.detail ? `: ${result.detail}` : ''}`,
          code: 'GUARD_UNKNOWN',
          evaluatedGuards: evaluated,
        }
      }
    }

    return { allowed: true, evaluatedGuards: evaluated }
  }
}

/**
 * Assert a policy decision allows dispatch, throwing a structured error otherwise.
 * @param decision - policy decision to enforce.
 * @throws System1Error with the decision's code.
 */
export function enforcePolicyDecision(decision: PolicyDecision): asserts decision is { allowed: true } & PolicyDecision {
  if (!decision.allowed) {
    throw system1Error(decision.code, decision.reason, {
      evaluatedGuards: decision.evaluatedGuards,
    })
  }
}
