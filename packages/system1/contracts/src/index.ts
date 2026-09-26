/**
 * System 1 contracts: schemas, errors, migrations, reducer, provider interface.
 *
 * @module @deepseek-ai/dsh-system1-contracts
 */

/** Package version marker (ensures the barrel has executable statements). */
export const CONTRACTS_PACKAGE_VERSION = '0.1.7-alpha.2'

export {
  CONTRACT_SCHEMA_VERSION,
  RouteKindSchema,
  EffectSchema,
  CandidateSchema,
  DecisionInputSchema,
  DecisionReasonCodeSchema,
  NormalizedDecisionSchema,
  ExecutionOutcomeSchema,
  VerificationResultSchema,
  TaskStateSchema,
} from './schemas.ts'
export type {
  RouteKind,
  Effect,
  Candidate,
  DecisionInput,
  DecisionReasonCode,
  NormalizedDecision,
  ExecutionOutcome,
  VerificationResult,
  TaskState,
} from './schemas.ts'
export { System1Error, ERROR_RETRY_CLASSES, system1Error } from './errors.ts'
export type { System1ErrorCode, ErrorRetryClass } from './errors.ts'
export { reduceTransition, initialWorkflowState, isTerminalState } from './reducer.ts'
export type { WorkflowState, TransitionRequest } from './reducer.ts'
export { migrateToCurrent, __registerMigration } from './migrations.ts'
export type { VersionedRecord, Migration } from './migrations.ts'
export type { DecisionProvider } from './decision-provider.ts'
export { isDecisionProvider } from './decision-provider.ts'
