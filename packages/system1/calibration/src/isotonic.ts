/**
 * Isotonic calibration: correctness-only, monotone non-decreasing.
 *
 * Maps vendor confidence scores to calibrated correctness probabilities using
 * isotonic regression (Pool Adjacent Violators Algorithm). The calibration is:
 * - Correctness-only: trained on (vendor_confidence, was_correct) pairs.
 * - Monotone non-decreasing: higher vendor confidence never maps to lower
 *   calibrated correctness.
 * - Opaque: the fitted function is a stepwise constant; no intercepts, slopes,
 *   or vendor internals are exposed or reconstructible.
 * - Versioned: each fit produces a versioned record; no online updates.
 *
 * @module @deepseek-ai/dsh-system1-calibration/isotonic
 */

/** A single calibration observation. */
export interface CalibrationObservation {
  /** Vendor confidence score (input). */
  readonly vendorConfidence: number
  /** Whether the decision was correct (1) or not (0). */
  readonly correct: 0 | 1
}

/** A fitted isotonic calibration. */
export interface IsotonicCalibration {
  /** Version identifier for this fit. */
  readonly version: string
  /** Sorted breakpoints: [threshold, calibratedValue] pairs. */
  readonly breakpoints: ReadonlyArray<readonly [number, number]>
  /** Number of observations used. */
  readonly observationCount: number
}

/**
 * Fit an isotonic regression using the Pool Adjacent Violators Algorithm.
 * @param observations - calibration observations.
 * @param version - version identifier for this fit.
 * @returns the fitted calibration.
 * @throws if fewer than 2 observations or invalid values.
 */
export function fitIsotonic(
  observations: readonly CalibrationObservation[],
  version: string,
): IsotonicCalibration {
  if (observations.length < 2) {
    throw new Error('Isotonic calibration requires at least 2 observations')
  }
  for (const obs of observations) {
    if (!Number.isFinite(obs.vendorConfidence) || (obs.correct !== 0 && obs.correct !== 1)) {
      throw new Error('Invalid calibration observation')
    }
  }

  // Sort by vendor confidence.
  const sorted = [...observations].sort((a, b) => a.vendorConfidence - b.vendorConfidence)

  // PAVA: pool adjacent violators to enforce monotonicity.
  // Each block is { sum, count, values }.
  interface Block {
    sum: number
    count: number
    minX: number
    maxX: number
  }
  const blocks: Block[] = []
  for (const obs of sorted) {
    blocks.push({ sum: obs.correct, count: 1, minX: obs.vendorConfidence, maxX: obs.vendorConfidence })
    // Merge while the last two blocks violate monotonicity.
    // Invariant: blocks.length >= 2, so both indices are valid.
    while (blocks.length >= 2) {
      const last = blocks[blocks.length - 1]!
      const prev = blocks[blocks.length - 2]!
      const lastMean = last.sum / last.count
      const prevMean = prev.sum / prev.count
      if (prevMean <= lastMean) break
      // Merge: pool the violators.
      blocks.pop()
      blocks.pop()
      blocks.push({
        sum: prev.sum + last.sum,
        count: prev.count + last.count,
        minX: Math.min(prev.minX, last.minX),
        maxX: Math.max(prev.maxX, last.maxX),
      })
    }
  }

  // Build breakpoints: each block maps [minX, maxX] to mean.
  // For prediction, use the block whose range contains x, or nearest.
  const breakpoints = blocks.map(
    (b) => [b.minX, b.sum / b.count] as const,
  )

  return {
    version,
    breakpoints,
    observationCount: observations.length,
  }
}

/**
 * Apply a fitted calibration to a vendor confidence score.
 * @param calibration - the fitted calibration.
 * @param vendorConfidence - vendor confidence to calibrate.
 * @returns calibrated correctness probability in [0, 1].
 */
export function calibrate(
  calibration: IsotonicCalibration,
  vendorConfidence: number,
): number {
  if (!Number.isFinite(vendorConfidence)) {
    throw new Error('Vendor confidence must be finite')
  }
  const breakpoints = calibration.breakpoints
  const first = breakpoints[0]
  if (first === undefined) {
    throw new Error('Calibration has no breakpoints')
  }
  // Find the last breakpoint with threshold <= x.
  let result = first[1]
  for (const [threshold, value] of breakpoints) {
    if (threshold <= vendorConfidence) {
      result = value
    } else {
      break
    }
  }
  return result
}
