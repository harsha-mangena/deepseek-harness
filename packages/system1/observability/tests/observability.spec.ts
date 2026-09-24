/** Observability tests. */

import { describe, expect, it } from 'vitest'
import {
  MetricsCollector,
  EvaluationRunner,
  RegressionGateChecker,
} from '@deepseek-ai/dsh-system1-observability'

describe('MetricsCollector', () => {
  it('records and retrieves samples', () => {
    const metrics = new MetricsCollector(() => 1000)
    metrics.record('latency_ms', 150, { operation: 'decide' })
    metrics.record('latency_ms', 200)

    const samples = metrics.getSamples('latency_ms')
    expect(samples).toHaveLength(2)
    expect(samples[0].timestampMs).toBe(1000)
    expect(samples[0].labels).toEqual({ operation: 'decide' })
  })

  it('computes mean', () => {
    const metrics = new MetricsCollector()
    metrics.record('x', 10)
    metrics.record('x', 20)
    expect(metrics.mean('x')).toBe(15)
  })

  it('returns null mean for no samples', () => {
    const metrics = new MetricsCollector()
    expect(metrics.mean('missing')).toBeNull()
  })

  it('counts samples', () => {
    const metrics = new MetricsCollector()
    metrics.record('x', 1)
    metrics.record('x', 2)
    metrics.record('y', 3)
    expect(metrics.count('x')).toBe(2)
    expect(metrics.count('y')).toBe(1)
    expect(metrics.count('z')).toBe(0)
  })
})

describe('EvaluationRunner', () => {
  it('passes when selection matches', () => {
    const runner = new EvaluationRunner()
    const result = runner.runScenario(
      { id: 's1', description: 'test', expectedSelection: 'c1' },
      'c1',
      0.9,
    )
    expect(result.passed).toBe(true)
    expect(result.failureReason).toBeNull()
  })

  it('fails when selection mismatches', () => {
    const runner = new EvaluationRunner()
    const result = runner.runScenario(
      { id: 's1', description: 'test', expectedSelection: 'c1' },
      'c2',
      0.9,
    )
    expect(result.passed).toBe(false)
    expect(result.failureReason).toContain('Expected c1, got c2')
  })

  it('fails when calibrated correctness below minimum', () => {
    const runner = new EvaluationRunner()
    const result = runner.runScenario(
      { id: 's1', description: 'test', expectedSelection: 'c1', minCalibratedCorrectness: 0.8 },
      'c1',
      0.5,
    )
    expect(result.passed).toBe(false)
    expect(result.failureReason).toContain('below minimum')
  })

  it('fails when calibrated correctness is null but required', () => {
    const runner = new EvaluationRunner()
    const result = runner.runScenario(
      { id: 's1', description: 'test', expectedSelection: 'c1', minCalibratedCorrectness: 0.8 },
      'c1',
      null,
    )
    expect(result.passed).toBe(false)
  })

  it('passes when correctness meets minimum', () => {
    const runner = new EvaluationRunner()
    const result = runner.runScenario(
      { id: 's1', description: 'test', expectedSelection: 'c1', minCalibratedCorrectness: 0.8 },
      'c1',
      0.9,
    )
    expect(result.passed).toBe(true)
  })
})

describe('RegressionGateChecker', () => {
  it('passes when all gates satisfied', () => {
    const metrics = new MetricsCollector()
    metrics.record('latency', 100)
    metrics.record('latency', 200)

    const checker = new RegressionGateChecker([
      { name: 'latency-gate', metricName: 'latency', minMean: null, maxMean: 500 },
    ])
    const result = checker.check(metrics)
    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('fails when mean below minimum', () => {
    const metrics = new MetricsCollector()
    metrics.record('accuracy', 0.5)

    const checker = new RegressionGateChecker([
      { name: 'acc-gate', metricName: 'accuracy', minMean: 0.8, maxMean: null },
    ])
    const result = checker.check(metrics)
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toContain('below minimum')
  })

  it('fails when mean above maximum', () => {
    const metrics = new MetricsCollector()
    metrics.record('latency', 1000)

    const checker = new RegressionGateChecker([
      { name: 'lat-gate', metricName: 'latency', minMean: null, maxMean: 500 },
    ])
    const result = checker.check(metrics)
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toContain('above maximum')
  })

  it('fails when no samples', () => {
    const metrics = new MetricsCollector()
    const checker = new RegressionGateChecker([
      { name: 'empty-gate', metricName: 'missing', minMean: 0, maxMean: 100 },
    ])
    const result = checker.check(metrics)
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toContain('no samples')
  })

  it('checks multiple gates', () => {
    const metrics = new MetricsCollector()
    metrics.record('a', 10)
    metrics.record('b', 100)

    const checker = new RegressionGateChecker([
      { name: 'gate-a', metricName: 'a', minMean: 5, maxMean: 15 },
      { name: 'gate-b', metricName: 'b', minMean: null, maxMean: 50 },
    ])
    const result = checker.check(metrics)
    expect(result.passed).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain('gate-b')
  })
})
