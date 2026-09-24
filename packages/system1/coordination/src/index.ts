/**
 * System 1 coordination: budgets, leases, and deterministic fixtures.
 *
 * @module @deepseek-ai/dsh-system1-coordination
 */

/** Package version marker (ensures the barrel has executable statements). */
export const COORDINATION_PACKAGE_VERSION = '0.1.7-alpha.2'

export { CoordinationStore } from './store.ts'
export type { Reservation, Lease, CoordinationStoreOptions } from './store.ts'
export { SystemClock, ManualClock, RandomIdGenerator, SequentialIdGenerator } from './deterministic.ts'
export type { Clock, IdGenerator } from './deterministic.ts'
export { RecordedDecisionProvider } from './recorded-provider.ts'
export type { ProviderFault } from './recorded-provider.ts'
