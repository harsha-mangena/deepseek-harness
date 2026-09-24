/**
 * System 1 policy engine.
 *
 * @module @deepseek-ai/dsh-system1-policy
 */

/** Package version marker (ensures the barrel has executable statements). */
export const POLICY_PACKAGE_VERSION = '0.1.7-alpha.2'

export { PolicyEngine, enforcePolicyDecision } from './policy.ts'
export type {
  GuardVerdict,
  GuardResult,
  GuardContext,
  Guard,
  CapabilityProfile,
  EffectPolicy,
  PolicyDecision,
} from './policy.ts'
