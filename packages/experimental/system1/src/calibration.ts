/**
 * Calibration utilities for System 1 judgments.
 *
 * A judgment is *calibrated* when its confidence means what it says: among
 * judgments reported at 0.8, about 80% should be right. The plugin gates on
 * confidence, so miscalibration is a correctness bug, not a curiosity —
 * overconfident wrong judgments actuate bad steering; underconfident right
 * ones waste the backend's cost.
 *
 * Labels come from outside this module: a trace is *correct* when a later
 * human or LLM-judge review (or a scripted scenario with a known right
 * answer) says the judgment was the right call. `summarizeCalibration`
 * joins traces with their labels and reports per-kind expected calibration
 * error (ECE), accuracy, and latency, which the eval harness turns into a
 * go/no-go per question kind.
 */

import type { System1QuestionKind, System1Trace } from './types.ts'

/** One labeled judgment: its reported confidence and whether it was right. */
export interface CalibrationPair {
  readonly confidence: number
  readonly correct: boolean
}

/** One reliability-diagram bin. */
export interface ReliabilityBin {
  readonly binStart: number
  readonly binEnd: number
  readonly count: number
  readonly meanConfidence: number
  readonly accuracy: number
}

/** Per-kind calibration summary over labeled traces. */
export interface KindCalibration {
  readonly kind: System1QuestionKind
  /** Labeled traces for this kind. */
  readonly n: number
  /** Fraction of labeled judgments that were correct. */
  readonly accuracy: number
  /** Expected calibration error (0 = perfectly calibrated). */
  readonly ece: number
  readonly meanConfidence: number
  /** 95th-percentile backend latency in milliseconds. */
  readonly p95LatencyMs: number
  readonly bins: readonly ReliabilityBin[]
}

/** Default reliability bins (deciles). */
export const CALIBRATION_BINS = 10

/**
 * Expected calibration error: the confidence-weighted mean of
 * |accuracy − confidence| over bins. Returns NaN for an empty input.
 *
 * @param pairs - labeled (confidence, correctness) pairs.
 * @param bins - number of equal-width confidence bins.
 */
export function computeECE(pairs: readonly CalibrationPair[], bins: number = CALIBRATION_BINS): number {
  if (pairs.length === 0 || bins <= 0) return NaN
  const buckets: Array<{ count: number; confidenceSum: number; correctSum: number }> =
    Array.from({ length: bins }, () => ({ count: 0, confidenceSum: 0, correctSum: 0 }))
  for (const pair of pairs) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(pair.confidence * bins)))
    const bucket = buckets[index] as { count: number; confidenceSum: number; correctSum: number }
    bucket.count += 1
    bucket.confidenceSum += pair.confidence
    bucket.correctSum += pair.correct ? 1 : 0
  }
  let ece = 0
  for (const bucket of buckets) {
    if (bucket.count === 0) continue
    ece += (bucket.count / pairs.length)
      * Math.abs(bucket.correctSum / bucket.count - bucket.confidenceSum / bucket.count)
  }
  return ece
}

/**
 * Reliability-diagram bins for labeled pairs: per bin the mean reported
 * confidence against the observed accuracy. Empty bins are omitted.
 */
export function reliabilityCurve(
  pairs: readonly CalibrationPair[],
  bins: number = CALIBRATION_BINS,
): ReliabilityBin[] {
  const out: ReliabilityBin[] = []
  if (pairs.length === 0 || bins <= 0) return out
  const buckets: CalibrationPair[][] = Array.from({ length: bins }, () => [])
  for (const pair of pairs) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(pair.confidence * bins)))
    ;(buckets[index] as CalibrationPair[]).push(pair)
  }
  buckets.forEach((bucket, index) => {
    if (bucket.length === 0) return
    const confidenceSum = bucket.reduce((sum, pair) => sum + pair.confidence, 0)
    const correctSum = bucket.reduce((sum, pair) => sum + (pair.correct ? 1 : 0), 0)
    out.push({
      binStart: index / bins,
      binEnd: (index + 1) / bins,
      count: bucket.length,
      meanConfidence: confidenceSum / bucket.length,
      accuracy: correctSum / bucket.length,
    })
  })
  return out
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] as number
}

/**
 * Join traces with correctness labels and summarize per question kind.
 * Traces without a label, without confidence (fallbacks never reported
 * one), or with an unknown kind are skipped.
 *
 * @param traces - the service's recorded traces.
 * @param labels - trace id → whether the judgment was the right call.
 */
export function summarizeCalibration(
  traces: readonly System1Trace[],
  labels: ReadonlyMap<string, boolean>,
): KindCalibration[] {
  const byKind = new Map<System1QuestionKind, { pairs: CalibrationPair[]; latencies: number[] }>()
  for (const trace of traces) {
    const correct = labels.get(trace.id)
    if (correct === undefined || trace.confidence === null) continue
    let entry = byKind.get(trace.questionKind)
    if (entry === undefined) {
      entry = { pairs: [], latencies: [] }
      byKind.set(trace.questionKind, entry)
    }
    entry.pairs.push({ confidence: trace.confidence, correct })
    entry.latencies.push(trace.latencyMs)
  }
  const out: KindCalibration[] = []
  for (const [kind, entry] of byKind) {
    const correctCount = entry.pairs.filter(pair => pair.correct).length
    const confidenceSum = entry.pairs.reduce((sum, pair) => sum + pair.confidence, 0)
    out.push({
      kind,
      n: entry.pairs.length,
      accuracy: correctCount / entry.pairs.length,
      ece: computeECE(entry.pairs),
      meanConfidence: confidenceSum / entry.pairs.length,
      p95LatencyMs: percentile([...entry.latencies].sort((a, b) => a - b), 95),
      bins: reliabilityCurve(entry.pairs),
    })
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind))
}

/** Thresholds for the per-kind go/no-go verdict. */
export interface CalibrationCriteria {
  /** Minimum labeled samples per kind before the verdict means anything. */
  readonly minSamples: number
  /** Maximum acceptable ECE. */
  readonly maxEce: number
  /** Minimum acceptable accuracy. */
  readonly minAccuracy: number
}

/** Sensible defaults: 30 samples, ECE ≤ 0.15, accuracy ≥ 0.7. */
export const DEFAULT_CALIBRATION_CRITERIA: CalibrationCriteria = {
  minSamples: 30,
  maxEce: 0.15,
  minAccuracy: 0.7,
}

/**
 * Turn per-kind summaries into a go/no-go: a kind is a GO when it has
 * enough samples, its ECE is within budget, and its accuracy clears the
 * bar. Kinds with too few samples report `insufficient-data`, never a pass.
 */
export function calibrationVerdict(
  summary: readonly KindCalibration[],
  criteria: CalibrationCriteria = DEFAULT_CALIBRATION_CRITERIA,
): Array<{ kind: System1QuestionKind; verdict: 'go' | 'no-go' | 'insufficient-data'; reasons: string[] }> {
  return summary.map((entry) => {
    const reasons: string[] = []
    if (entry.n < criteria.minSamples) {
      reasons.push(`only ${entry.n} labeled samples (need ${criteria.minSamples})`)
      return { kind: entry.kind, verdict: 'insufficient-data' as const, reasons }
    }
    if (entry.ece > criteria.maxEce) {
      reasons.push(`ECE ${entry.ece.toFixed(3)} exceeds ${criteria.maxEce}`)
    }
    if (entry.accuracy < criteria.minAccuracy) {
      reasons.push(`accuracy ${(entry.accuracy * 100).toFixed(1)}% below ${(criteria.minAccuracy * 100).toFixed(0)}%`)
    }
    return {
      kind: entry.kind,
      verdict: reasons.length === 0 ? 'go' : 'no-go',
      reasons,
    }
  })
}
