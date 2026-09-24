/**
 * System 1 observability: metrics, evaluation, regression gates.
 *
 * @module @deepseek-ai/dsh-system1-observability
 */

/** Package version marker (ensures the barrel has executable statements). */
export const OBSERVABILITY_PACKAGE_VERSION = '0.1.7-alpha.2'

export { MetricsCollector, EvaluationRunner, RegressionGateChecker } from './observability.ts'
export type {
  MetricSample,
  EvaluationScenario,
  ScenarioResult,
  RegressionGate,
  GateCheckResult,
} from './observability.ts'
