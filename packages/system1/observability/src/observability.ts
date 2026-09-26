/**
 * Observability: metrics, evaluation, and regression gates.
 *
 * Metrics: counters, histograms, and gauges for System 1 operations.
 * Evaluation: scenario-based testing with expected outcomes.
 * Regression gates: thresholds that must pass for promotion.
 *
 * @module @deepseek-ai/dsh-system1-observability/observability
 */

/** A metric sample. */
export interface MetricSample {
  readonly name: string
  readonly value: number
  readonly timestampMs: number
  readonly labels: Readonly<Record<string, string>>
}

/** Metrics collector. */
export class MetricsCollector {
  private readonly samples: MetricSample[] = []
  private readonly now: () => number

  /**
   * @param now - clock (injectable for tests).
   */
  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /**
   * Record a metric.
   * @param name - metric name.
   * @param value - metric value.
   * @param labels - metric labels.
   */
  record(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    this.samples.push({
      name,
      value,
      timestampMs: this.now(),
      labels,
    })
  }

  /**
   * Get samples for a metric.
   * @param name - metric name.
   * @returns matching samples.
   */
  getSamples(name: string): readonly MetricSample[] {
    return this.samples.filter((s) => s.name === name)
  }

  /**
   * Compute the mean of a metric.
   * @param name - metric name.
   * @returns mean, or null if no samples.
   */
  mean(name: string): number | null {
    const samples = this.getSamples(name)
    if (samples.length === 0) return null
    const sum = samples.reduce((acc, s) => acc + s.value, 0)
    return sum / samples.length
  }

  /**
   * Count samples for a metric.
   * @param name - metric name.
   * @returns count.
   */
  count(name: string): number {
    return this.getSamples(name).length
  }
}

/** An evaluation scenario. */
export interface EvaluationScenario {
  readonly id: string
  readonly description: string
  /** Expected selected candidate ID (or 'escalate-none'). */
  readonly expectedSelection: string
  /** Minimum acceptable calibrated correctness (if applicable). */
  readonly minCalibratedCorrectness?: number
}

/** Result of running a scenario. */
export interface ScenarioResult {
  readonly scenarioId: string
  readonly passed: boolean
  readonly actualSelection: string
  readonly calibratedCorrectness: number | null
  readonly failureReason: string | null
}

/** Evaluation runner. */
export class EvaluationRunner {
  /**
   * Run a scenario against an actual result.
   * @param scenario - the scenario.
   * @param actualSelection - actual selected candidate ID.
   * @param calibratedCorrectness - calibrated correctness (if available).
   * @returns the scenario result.
   */
  runScenario(
    scenario: EvaluationScenario,
    actualSelection: string,
    calibratedCorrectness: number | null,
  ): ScenarioResult {
    if (actualSelection !== scenario.expectedSelection) {
      return {
        scenarioId: scenario.id,
        passed: false,
        actualSelection,
        calibratedCorrectness,
        failureReason: `Expected ${scenario.expectedSelection}, got ${actualSelection}`,
      }
    }

    if (
      scenario.minCalibratedCorrectness !== undefined &&
      (calibratedCorrectness === null || calibratedCorrectness < scenario.minCalibratedCorrectness)
    ) {
      return {
        scenarioId: scenario.id,
        passed: false,
        actualSelection,
        calibratedCorrectness,
        failureReason: `Calibrated correctness ${calibratedCorrectness} below minimum ${scenario.minCalibratedCorrectness}`,
      }
    }

    return {
      scenarioId: scenario.id,
      passed: true,
      actualSelection,
      calibratedCorrectness,
      failureReason: null,
    }
  }
}

/** A regression gate (threshold). */
export interface RegressionGate {
  readonly name: string
  readonly metricName: string
  /** Minimum acceptable mean (or null for no lower bound). */
  readonly minMean: number | null
  /** Maximum acceptable mean (or null for no upper bound). */
  readonly maxMean: number | null
}

/** Result of checking gates. */
export interface GateCheckResult {
  readonly passed: boolean
  readonly failures: readonly string[]
}

/** Checks regression gates against metrics. */
export class RegressionGateChecker {
  private readonly gates: readonly RegressionGate[]

  /**
   * @param gates - gates to check.
   */
  constructor(gates: readonly RegressionGate[]) {
    this.gates = gates
  }

  /**
   * Check all gates.
   * @param metrics - metrics collector.
   * @returns check result.
   */
  check(metrics: MetricsCollector): GateCheckResult {
    const failures: string[] = []

    for (const gate of this.gates) {
      const mean = metrics.mean(gate.metricName)
      if (mean === null) {
        failures.push(`Gate ${gate.name}: no samples for ${gate.metricName}`)
        continue
      }
      if (gate.minMean !== null && mean < gate.minMean) {
        failures.push(`Gate ${gate.name}: mean ${mean} below minimum ${gate.minMean}`)
      }
      if (gate.maxMean !== null && mean > gate.maxMean) {
        failures.push(`Gate ${gate.name}: mean ${mean} above maximum ${gate.maxMean}`)
      }
    }

    return {
      passed: failures.length === 0,
      failures,
    }
  }
}
