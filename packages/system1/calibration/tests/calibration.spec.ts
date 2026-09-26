/** Calibration and shadow evaluation tests. */

import { describe, expect, it } from 'vitest'
import {
  ShadowEvaluator,
  calibrate,
  fitIsotonic,
} from '@deepseek-ai/dsh-system1-calibration'
import type {
  CalibrationObservation,
  ShadowRecord,
} from '@deepseek-ai/dsh-system1-calibration'
import { system1Error } from '@deepseek-ai/dsh-system1-contracts'
import type {
  DecisionInput,
  DecisionProvider,
  NormalizedDecision,
} from '@deepseek-ai/dsh-system1-contracts'

describe('isotonic calibration', () => {
  it('fits a monotone non-decreasing function', () => {
    const observations: CalibrationObservation[] = [
      { vendorConfidence: 0.9, correct: 0 }, // violator: high confidence, wrong
      { vendorConfidence: 0.1, correct: 0 },
      { vendorConfidence: 0.5, correct: 1 },
      { vendorConfidence: 0.6, correct: 1 },
      { vendorConfidence: 0.2, correct: 0 },
      { vendorConfidence: 0.8, correct: 1 },
    ]
    const cal = fitIsotonic(observations, 'v1')
    expect(cal.version).toBe('v1')
    expect(cal.observationCount).toBe(6)
    // Verify monotonicity across a grid.
    let prev = -1
    for (let x = 0; x <= 1.001; x += 0.05) {
      const y = calibrate(cal, x)
      expect(y).toBeGreaterThanOrEqual(prev)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
      prev = y
    }
  })

  it('pools adjacent violators', () => {
    // Decreasing correctness with increasing confidence: all pooled.
    const observations: CalibrationObservation[] = [
      { vendorConfidence: 0.1, correct: 1 },
      { vendorConfidence: 0.9, correct: 0 },
    ]
    const cal = fitIsotonic(observations, 'v1')
    // Pooled mean is 0.5 for both.
    expect(calibrate(cal, 0.1)).toBe(0.5)
    expect(calibrate(cal, 0.9)).toBe(0.5)
  })

  it('pools tied vendor-confidence values before PAVA (order-invariant)', () => {
    // Same multiset of observations in two different input orders must
    // produce identical fits: tied scores are pooled first, so PAVA never
    // sees order-dependent adjacent violators among ties.
    const forward: CalibrationObservation[] = [
      { vendorConfidence: 0.5, correct: 1 },
      { vendorConfidence: 0.5, correct: 0 },
      { vendorConfidence: 0.5, correct: 1 },
      { vendorConfidence: 0.9, correct: 1 },
      { vendorConfidence: 0.1, correct: 0 },
    ]
    const reverse = [...forward].reverse()
    const calA = fitIsotonic(forward, 'v-tie')
    const calB = fitIsotonic(reverse, 'v-tie')
    expect(calA.breakpoints).toEqual(calB.breakpoints)
    // The tied 0.5 group pools to mean 2/3 before PAVA.
    expect(calibrate(calA, 0.5)).toBeCloseTo(2 / 3, 10)
    for (let x = 0; x <= 1.001; x += 0.1) {
      expect(calibrate(calA, x)).toBe(calibrate(calB, x))
    }
  })

  it('binds an identity to the fit when provided', () => {
    const observations: CalibrationObservation[] = [
      { vendorConfidence: 0.2, correct: 0 },
      { vendorConfidence: 0.8, correct: 1 },
    ]
    const identity = {
      model: 'jev-v1',
      promptVersion: 'p1',
      questionFamily: 'select-candidate',
    }
    const bound = fitIsotonic(observations, 'v2', identity)
    expect(bound.identity).toEqual(identity)
    const unbound = fitIsotonic(observations, 'v2')
    expect(unbound.identity).toBeNull()
  })

  it('rejects invalid inputs', () => {
    expect(() => fitIsotonic([], 'v1')).toThrow(/at least 2/)
    expect(() => fitIsotonic([{ vendorConfidence: 0.5, correct: 1 }], 'v1')).toThrow(/at least 2/)
    expect(() =>
      fitIsotonic(
        [
          { vendorConfidence: NaN, correct: 1 },
          { vendorConfidence: 0.5, correct: 0 },
        ],
        'v1',
      ),
    ).toThrow(/Invalid/)
    expect(() =>
      fitIsotonic(
        [
          { vendorConfidence: 0.1, correct: 1 },
          { vendorConfidence: 0.5, correct: 2 as 0 | 1 },
        ],
        'v1',
      ),
    ).toThrow(/Invalid/)
  })

  it('rejects non-finite calibration inputs', () => {
    const cal = fitIsotonic(
      [
        { vendorConfidence: 0.1, correct: 0 },
        { vendorConfidence: 0.9, correct: 1 },
      ],
      'v1',
    )
    expect(() => calibrate(cal, NaN)).toThrow(/finite/)
    expect(() =>
      calibrate({ version: 'v', identity: null, breakpoints: [], observationCount: 0 }, 0.5),
    ).toThrow(/no breakpoints/)
  })

  it('extrapolates with nearest breakpoint', () => {
    const cal = fitIsotonic(
      [
        { vendorConfidence: 0.2, correct: 0 },
        { vendorConfidence: 0.8, correct: 1 },
      ],
      'v1',
    )
    // Below min: uses first breakpoint.
    expect(calibrate(cal, 0.0)).toBe(calibrate(cal, 0.2))
    // Above max: uses last breakpoint.
    expect(calibrate(cal, 1.0)).toBe(calibrate(cal, 0.8))
  })
})

const testInput: DecisionInput = {
  schemaVersion: 1,
  taskId: 't1',
  decisionId: 'd1',
  stateVersion: 0,
  policyVersion: 'p1',
  catalogVersion: 'c1',
  observationHash: 'o1',
  questionFamily: 'q1',
  promptVersion: 'p1',
  state: 'state',
  candidates: [],
}

function testDecision(selectedId: string): NormalizedDecision {
  return {
    decisionId: 'd1',
    questionFamily: 'q1',
    promptVersion: 'p1',
    selectedId,
    probabilities: {},
    selectedProbability: 0.8,
    vendorConfidence: 0.9,
    calibratedCorrectness: null,
    calibrationVersion: null,
    modelRequested: 'm',
    modelResolved: null,
    requestId: null,
    usage: { inputTokens: null, outputTokens: null },
    reasonCode: 'accepted',
  }
}

describe('shadow evaluator', () => {
  it('records agreements and disagreements', async () => {
    const records: ShadowRecord[] = []
    const provider: DecisionProvider = {
      decide: async () => testDecision('c1'),
    }
    const evaluator = new ShadowEvaluator({
      provider,
      baseline: () => 'c1',
      sink: (r) => records.push(r),
      now: () => 12345,
    })
    await evaluator.evaluateShadow(testInput, new AbortController().signal)
    expect(records).toHaveLength(1)
    expect(records[0].agrees).toBe(true)
    expect(records[0].comparison).toBe('agree')
    expect(records[0].providerFailed).toBe(false)
    expect(records[0].timestampMs).toBe(12345)

    // Disagreement.
    const evaluator2 = new ShadowEvaluator({
      provider,
      baseline: () => 'c2',
      sink: (r) => records.push(r),
      now: () => 12346,
    })
    await evaluator2.evaluateShadow(testInput, new AbortController().signal)
    expect(records[1].agrees).toBe(false)
    expect(records[1].comparison).toBe('disagree')
    expect(records[1].baselineSelectedId).toBe('c2')
  })

  it('records a missing baseline as unknown, never as agreement', async () => {
    const records: ShadowRecord[] = []
    const provider: DecisionProvider = {
      decide: async () => testDecision('c1'),
    }
    const evaluator = new ShadowEvaluator({
      provider,
      sink: (r) => records.push(r),
    })
    await evaluator.evaluateShadow(testInput, new AbortController().signal)
    expect(records).toHaveLength(1)
    expect(records[0].agrees).toBe(false)
    expect(records[0].comparison).toBe('unknown')
    expect(records[0].baselineSelectedId).toBeNull()
    expect(records[0].providerFailed).toBe(false)
  })

  it('records provider failures instead of dropping them', async () => {
    const records: ShadowRecord[] = []
    const errors: unknown[] = []
    const provider: DecisionProvider = {
      decide: async () => {
        throw system1Error('PROVIDER_TIMEOUT', 'timeout', {})
      },
    }
    const evaluator = new ShadowEvaluator({
      provider,
      sink: (r) => records.push(r),
      onError: (e) => errors.push(e),
    })
    // Never rejects: the failure is isolated from the production path.
    await evaluator.evaluateShadow(testInput, new AbortController().signal)
    expect(records).toHaveLength(1)
    expect(records[0].providerFailed).toBe(true)
    expect(records[0].shadowDecision).toBeNull()
    expect(records[0].comparison).toBe('unknown')
    expect(records[0].agrees).toBe(false)
    expect(errors).toHaveLength(1)
  })

  it('isolates baseline and sink failures through onError', async () => {
    const errors: unknown[] = []
    const provider: DecisionProvider = {
      decide: async () => testDecision('c1'),
    }
    // Baseline throws: still records, reports via onError.
    const records: ShadowRecord[] = []
    const evaluator = new ShadowEvaluator({
      provider,
      baseline: () => {
        throw new Error('baseline boom')
      },
      sink: (r) => records.push(r),
      onError: (e) => errors.push(e),
    })
    await evaluator.evaluateShadow(testInput, new AbortController().signal)
    expect(records).toHaveLength(1)
    expect(records[0].comparison).toBe('unknown')
    expect(errors).toHaveLength(1)

    // Sink throws: never propagates to the caller.
    const evaluator2 = new ShadowEvaluator({
      provider,
      sink: () => {
        throw new Error('sink boom')
      },
      onError: (e) => errors.push(e),
    })
    await evaluator2.evaluateShadow(testInput, new AbortController().signal)
    expect(errors).toHaveLength(2)
  })
})
