/**
 * Unit tests for the calibration atom (src/calibration.ts): ECE,
 * reliability curves, and the go/no-go verdict over labeled decisions.
 */
import { describe, expect, it } from 'vitest'
import {
  CALIBRATION_BINS,
  DEFAULT_CALIBRATION_CRITERIA,
  calibrationVerdict,
  computeECE,
  reliabilityCurve,
  summarizeCalibration,
} from '../src/calibration.ts'
import type { CalibrationPair } from '../src/calibration.ts'
import type { System1Trace } from '../src/types.ts'

function pair(confidence: number, correct: boolean): CalibrationPair {
  return { confidence, correct }
}

function trace(id: string, kind: System1Trace['questionKind'], confidence: number, latencyMs: number): System1Trace {
  return {
    id,
    at: 1700000000000,
    agentId: 'agent-1',
    questionKind: kind,
    mode: 'enforce',
    backend: 'jev',
    confidence,
    latencyMs,
    fallback: null,
    acted: false,
  }
}

describe('computeECE', () => {
  it('is zero for perfectly calibrated judgments', () => {
    // 8/10 correct at 0.8 confidence: accuracy equals mean confidence.
    const calibrated = [
      ...Array.from({ length: 8 }, () => pair(0.8, true)),
      ...Array.from({ length: 2 }, () => pair(0.8, false)),
    ]
    expect(computeECE(calibrated)).toBeCloseTo(0, 10)
  })

  it('is large for overconfident judgments', () => {
    const pairs = Array.from({ length: 20 }, () => pair(0.95, false))
    expect(computeECE(pairs)).toBeGreaterThan(0.5)
  })

  it('is NaN for empty input (undefined, not zero)', () => {
    expect(computeECE([])).toBeNaN()
  })

  it('respects custom bin counts and bin edges', () => {
    const pairs = [pair(0.0, false), pair(1.0, true)]
    const curve = reliabilityCurve(pairs, 2)
    expect(curve).toHaveLength(2)
    expect(curve[0]?.binStart).toBe(0)
    expect(curve[1]?.binEnd).toBe(1)
    expect(curve[0]?.accuracy).toBe(0)
    expect(curve[1]?.accuracy).toBe(1)
  })
})

describe('reliabilityCurve', () => {
  it('skips empty bins', () => {
    const curve = reliabilityCurve([pair(0.95, true)], CALIBRATION_BINS)
    const nonEmpty = curve.filter(bin => bin.count > 0)
    expect(nonEmpty).toHaveLength(1)
    expect(nonEmpty[0]?.meanConfidence).toBeCloseTo(0.95, 10)
  })
})

describe('summarizeCalibration', () => {
  it('aggregates per-kind accuracy, ECE, and p95 latency', () => {
    const traces = [
      ...Array.from({ length: 8 }, (_, i) => trace(`tc-${i}`, 'tool-choice', 0.8, 120)),
      ...Array.from({ length: 2 }, (_, i) => trace(`tc-bad-${i}`, 'tool-choice', 0.8, 130)),
      trace('lc-0', 'loop-check', 0.5, 900),
      trace('lc-1', 'loop-check', 0.5, 100),
    ]
    const labels = new Map<string, boolean>([
      ...Array.from({ length: 8 }, (_, i) => [`tc-${i}`, true] as const),
      ...Array.from({ length: 2 }, (_, i) => [`tc-bad-${i}`, false] as const),
      ['lc-0', true],
      ['lc-1', false],
    ])
    const summary = summarizeCalibration(traces, labels)
    const toolChoice = summary.find(entry => entry.kind === 'tool-choice')
    const loopCheck = summary.find(entry => entry.kind === 'loop-check')
    expect(toolChoice?.accuracy).toBeCloseTo(0.8, 10)
    expect(toolChoice?.ece).toBeCloseTo(0, 10)
    expect(toolChoice?.n).toBe(10)
    expect(loopCheck?.p95LatencyMs).toBeGreaterThanOrEqual(900)
    expect(loopCheck?.meanConfidence).toBeCloseTo(0.5, 10)
  })

  it('skips traces without labels or confidence', () => {
    const traces = [
      trace('unlabeled', 'tool-choice', 0.8, 120),
      { ...trace('no-confidence', 'tool-choice', 0.8, 120), confidence: null },
    ]
    const summary = summarizeCalibration(traces, new Map([['no-confidence', true]]))
    expect(summary).toHaveLength(0)
  })
})

describe('calibrationVerdict', () => {
  function labeledSummary(count: number, confidence: number, correctEvery: number): ReturnType<typeof summarizeCalibration> {
    const traces = Array.from({ length: count }, (_, i) => trace(`t-${i}`, 'tool-choice', confidence, 120))
    const labels = new Map(traces.map((t, i) => [t.id, i % correctEvery !== 0] as const))
    return summarizeCalibration(traces, labels)
  }

  it('goes insufficient-data below the sample bar', () => {
    const verdicts = calibrationVerdict(labeledSummary(1, 0.9, 1), DEFAULT_CALIBRATION_CRITERIA)
    expect(verdicts[0]?.verdict).toBe('insufficient-data')
    expect(verdicts[0]?.reasons.join(' ')).toMatch(/30/)
  })

  it('goes go when accuracy and ECE meet the criteria', () => {
    // 32/40 correct at 0.8 confidence: 80% accuracy, well calibrated.
    const verdicts = calibrationVerdict(labeledSummary(40, 0.8, 5), DEFAULT_CALIBRATION_CRITERIA)
    expect(verdicts[0]?.verdict).toBe('go')
  })

  it('goes no-go on high ECE', () => {
    const verdicts = calibrationVerdict(
      labeledSummary(40, 0.95, 1),
      { ...DEFAULT_CALIBRATION_CRITERIA, minAccuracy: 0 },
    )
    expect(verdicts[0]?.verdict).toBe('no-go')
    expect(verdicts[0]?.reasons.join(' ')).toMatch(/ECE/)
  })

  it('goes no-go on low accuracy', () => {
    const verdicts = calibrationVerdict(
      labeledSummary(40, 0.55, 2),
      { ...DEFAULT_CALIBRATION_CRITERIA, maxEce: 1 },
    )
    expect(verdicts[0]?.verdict).toBe('no-go')
    expect(verdicts[0]?.reasons.join(' ')).toMatch(/accuracy/)
  })
})
