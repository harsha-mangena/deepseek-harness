/**
 * System 1 Jev provider: TypeSafe API adapter.
 *
 * @module @deepseek-ai/dsh-system1-jev
 */

/** Package version marker (ensures the barrel has executable statements). */
export const JEV_PACKAGE_VERSION = '0.1.7-alpha.2'

export { JevDecisionProvider, nonRetryableCode } from './jev-provider.ts'
export type { JevProviderConfig } from './jev-provider.ts'
export { normalizeJevResponse } from './normalize.ts'
