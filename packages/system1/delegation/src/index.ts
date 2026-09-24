/**
 * System 1 delegation: DeepSeek handoff with depth limits.
 *
 * @module @deepseek-ai/dsh-system1-delegation
 */

/** Package version marker (ensures the barrel has executable statements). */
export const DELEGATION_PACKAGE_VERSION = '0.1.7-alpha.2'

export { DelegationManager, MAX_DELEGATION_DEPTH } from './delegation.ts'
export type { DelegationRequest, DelegatedTask, DelegationConfig } from './delegation.ts'
