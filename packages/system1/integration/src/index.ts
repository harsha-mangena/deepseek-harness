/**
 * System 1 integration: end-to-end read-only coordinator.
 *
 * @module @deepseek-ai/dsh-system1-integration
 */

/** Package version marker (ensures the barrel has executable statements). */
export const INTEGRATION_PACKAGE_VERSION = '0.1.7-alpha.2'

export { ReadOnlyCoordinator, admitDecision } from './coordinator.ts'
export type { AdmissionContext, AdmissionVerdict } from './coordinator.ts'
export type {
  ReadOnlyExecutor,
  CoordinatorConfig,
  CoordinatorInput,
  CoordinatorResult,
} from './coordinator.ts'
export { ReadOnlyProductionDriver, buildEscalationBundle } from './driver.ts'
export type {
  EscalationBundleInput,
  ToolVerificationContext,
  ProductionDriverConfig,
} from './driver.ts'
export {
  MAX_ARGS_SUMMARY_CHARS,
  MAX_EVIDENCE_CHARS,
  evidenceText,
  finalizeOnce,
  findStoredToolResult,
  hasTerminal,
  hashEvidenceContent,
  loadEvidenceBinding,
  loadStoredVerifications,
  nextToolStep,
  parseReceiptRef,
  recordDispatchPlan,
  recordToolEvidence,
  resolveCheckEvidence,
  resolveHandoffRefs,
  sanitizeToolResultContent,
  serializeArguments,
} from './evidence.ts'
export type {
  CheckEvidenceResolution,
  DispatchPlanInput,
  EvidenceSpillStore,
  ExpectedCheckEvidence,
  HandoffRefResolution,
  ResolvedCheckEvidence,
  ResolvedToolCall,
  SpilledEvidenceRef,
  StoredVerification,
  System1DispatchPlanData,
  System1EvidenceBindingData,
  ToolEvidenceInput,
} from './evidence.ts'
