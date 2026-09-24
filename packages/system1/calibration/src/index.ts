/**
 * System 1 calibration: isotonic correctness calibration and shadow evaluation.
 *
 * @module @deepseek-ai/dsh-system1-calibration
 */

/** Package version marker (ensures the barrel has executable statements). */
export const CALIBRATION_PACKAGE_VERSION = '0.1.7-alpha.2'

export { fitIsotonic, calibrate } from './isotonic.ts'
export type { CalibrationObservation, IsotonicCalibration } from './isotonic.ts'
export { ShadowEvaluator } from './shadow.ts'
export type { ShadowRecord, ShadowEvaluatorConfig } from './shadow.ts'
