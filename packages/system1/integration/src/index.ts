/**
 * System 1 integration: end-to-end read-only coordinator.
 *
 * @module @deepseek-ai/dsh-system1-integration
 */

/** Package version marker (ensures the barrel has executable statements). */
export const INTEGRATION_PACKAGE_VERSION = '0.1.7-alpha.2'

export { ReadOnlyCoordinator, admitDecision } from './coordinator.ts'
export type { AdmissionContext, AdmissionVerdict } from './coordinator.ts'
export type {
  ReadOnlyExecutor,
  CoordinatorConfig,
  CoordinatorInput,
  CoordinatorResult,
} from './coordinator.ts'
