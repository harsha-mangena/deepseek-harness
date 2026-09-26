/**
 * System 1 observations: synthesis and candidate menus.
 *
 * @module @deepseek-ai/dsh-system1-observations
 */

/** Package version marker (ensures the barrel has executable statements). */
export const OBSERVATIONS_PACKAGE_VERSION = '0.1.7-alpha.2'

export {
  MAX_OBSERVATION_CHARS,
  boundChars,
  filterSecrets,
  synthesizeObservations,
  describeProvenance,
  hashObservations,
} from './observation.ts'
export type { ObservationProvenance, Observation } from './observation.ts'
export {
  ESCALATE_CANDIDATE_ID,
  hashPreconditions,
  escalateCandidate,
  generateCandidateMenu,
} from './candidates.ts'
export type { CatalogTool, MenuOptions } from './candidates.ts'
