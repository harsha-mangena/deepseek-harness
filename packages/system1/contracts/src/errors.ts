/**
 * Structured error taxonomy for System 1 operations.
 *
 * Every error carries a machine-readable code, a retry classification, and
 * whether it indicates a contract violation (caller bug) versus an
 * operational failure (retryable or escalatable).
 *
 * @module @deepseek-ai/dsh-system1-contracts/errors
 */

/** How the caller should respond to an error. */
export type ErrorRetryClass =
  | 'none'
  | 'immediate'
  | 'backoff'
  | 'reobserve'
  | 'escalate'

/** Machine-readable System 1 error codes. */
export type System1ErrorCode =
  // Contract violations (caller bugs, not retryable)
  | 'SCHEMA_VALIDATION_FAILED'
  | 'UNKNOWN_FIELD_REJECTED'
  | 'ILLEGAL_STATE_TRANSITION'
  | 'STALE_WORKFLOW_VERSION'
  | 'STALE_FENCING_TOKEN'
  | 'DUPLICATE_DECISION_ID'
  | 'DUPLICATE_REQUEST_ID'
  | 'CORRUPT_RECORD'
  | 'MIGRATION_FAILED'
  // Policy denials (not retryable without change)
  | 'GUARD_BLOCKED'
  | 'GUARD_UNKNOWN'
  | 'GUARD_MISSING'
  | 'EFFECT_NOT_ALLOWED'
  | 'CAPABILITY_NOT_GRANTED'
  | 'CANDIDATE_NOT_ADMISSIBLE'
  | 'BUDGET_EXHAUSTED'
  | 'DELEGATION_DEPTH_EXCEEDED'
  | 'CONCURRENCY_LIMIT_EXCEEDED'
  | 'CROSS_TENANT_DENIED'
  // Provider failures (retry classification varies)
  | 'PROVIDER_TRANSPORT_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_MALFORMED_RESPONSE'
  | 'PROVIDER_UNSUPPORTED_MODEL'
  | 'PROVIDER_CONTEXT_OVERFLOW'
  // Execution failures
  | 'EXECUTION_FAILED'
  | 'EXECUTION_UNKNOWN'
  | 'RECEIPT_MISSING'
  | 'RECONCILIATION_FAILED'
  | 'VERIFICATION_FAILED'
  | 'VERIFICATION_INCONCLUSIVE'
  // Coordination
  | 'LEASE_CONFLICT'
  | 'LEASE_EXPIRED'
  | 'RESERVATION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  // Lifecycle
  | 'TASK_CANCELLED'
  | 'TASK_ALREADY_TERMINAL'

/** Structured System 1 error. */
export class System1Error extends Error {
  readonly code: System1ErrorCode
  readonly retryClass: ErrorRetryClass
  readonly isContractViolation: boolean
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: System1ErrorCode,
    message: string,
    options: {
      retryClass?: ErrorRetryClass
      isContractViolation?: boolean
      details?: Record<string, unknown>
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'System1Error'
    this.code = code
    this.retryClass = options.retryClass ?? 'none'
    this.isContractViolation = options.isContractViolation ?? false
    this.details = Object.freeze({ ...(options.details ?? {}) })
  }
}

/** Default retry classification for each error code. */
export const ERROR_RETRY_CLASSES: Readonly<Record<System1ErrorCode, ErrorRetryClass>> = {
  SCHEMA_VALIDATION_FAILED: 'none',
  UNKNOWN_FIELD_REJECTED: 'none',
  ILLEGAL_STATE_TRANSITION: 'none',
  STALE_WORKFLOW_VERSION: 'none',
  STALE_FENCING_TOKEN: 'none',
  DUPLICATE_DECISION_ID: 'none',
  DUPLICATE_REQUEST_ID: 'none',
  CORRUPT_RECORD: 'none',
  MIGRATION_FAILED: 'none',
  GUARD_BLOCKED: 'none',
  GUARD_UNKNOWN: 'escalate',
  GUARD_MISSING: 'escalate',
  EFFECT_NOT_ALLOWED: 'none',
  CAPABILITY_NOT_GRANTED: 'none',
  CANDIDATE_NOT_ADMISSIBLE: 'none',
  BUDGET_EXHAUSTED: 'escalate',
  DELEGATION_DEPTH_EXCEEDED: 'none',
  CONCURRENCY_LIMIT_EXCEEDED: 'backoff',
  CROSS_TENANT_DENIED: 'none',
  PROVIDER_TRANSPORT_FAILED: 'backoff',
  PROVIDER_TIMEOUT: 'backoff',
  PROVIDER_RATE_LIMITED: 'backoff',
  PROVIDER_MALFORMED_RESPONSE: 'none',
  PROVIDER_UNSUPPORTED_MODEL: 'none',
  PROVIDER_CONTEXT_OVERFLOW: 'reobserve',
  EXECUTION_FAILED: 'none',
  EXECUTION_UNKNOWN: 'reobserve',
  RECEIPT_MISSING: 'reobserve',
  RECONCILIATION_FAILED: 'escalate',
  VERIFICATION_FAILED: 'none',
  VERIFICATION_INCONCLUSIVE: 'escalate',
  LEASE_CONFLICT: 'backoff',
  LEASE_EXPIRED: 'reobserve',
  RESERVATION_CONFLICT: 'backoff',
  IDEMPOTENCY_KEY_REUSED: 'none',
  TASK_CANCELLED: 'none',
  TASK_ALREADY_TERMINAL: 'none',
}

/**
 * Create a System1Error with the default retry class for its code.
 * @param code - machine-readable error code.
 * @param message - human-readable description.
 * @param details - structured context for diagnostics.
 */
export function system1Error(
  code: System1ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): System1Error {
  const contractViolations: ReadonlySet<System1ErrorCode> = new Set([
    'SCHEMA_VALIDATION_FAILED',
    'UNKNOWN_FIELD_REJECTED',
    'ILLEGAL_STATE_TRANSITION',
    'STALE_WORKFLOW_VERSION',
    'STALE_FENCING_TOKEN',
    'DUPLICATE_DECISION_ID',
    'DUPLICATE_REQUEST_ID',
    'CORRUPT_RECORD',
    'MIGRATION_FAILED',
  ])
  return new System1Error(code, message, {
    retryClass: ERROR_RETRY_CLASSES[code],
    isContractViolation: contractViolations.has(code),
    details,
  })
}
