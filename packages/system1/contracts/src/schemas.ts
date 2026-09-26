/**
 * Runtime-validating schemas for System 1 contracts.
 *
 * Unknown fields are rejected at trust boundaries. All schemas are versioned;
 * see `./migrations.ts` for upgrade paths.
 *
 * @module @deepseek-ai/dsh-system1-contracts/schemas
 */

import { z } from 'zod'

/** Current schema version for all System 1 contracts. */
export const CONTRACT_SCHEMA_VERSION = 1 as const

/** Where a decision routes execution. */
export const RouteKindSchema = z.enum([
  'direct',
  'workflow',
  'tool',
  'specialist',
  'reasoning',
  'clarify',
  'verify',
  'stop',
])
export type RouteKind = z.infer<typeof RouteKindSchema>

/** The effect class of a candidate operation. */
export const EffectSchema = z.enum(['read', 'write', 'external'])
export type Effect = z.infer<typeof EffectSchema>

/**
 * One executable action bundle offered to the decision provider.
 * The provider returns a candidate ID; it never invents operations.
 */
export const CandidateSchema = z
  .object({
    /** Opaque ID, local lookup only. */
    id: z.string().min(1),
    /** Concise, untrusted text (escaped at render). */
    label: z.string().min(1).max(500),
    route: RouteKindSchema,
    effect: EffectSchema,
    /** Host-owned immutable bundle reference. */
    operationRef: z.string().min(1),
    preconditionHash: z.string().min(1),
    verificationPolicyId: z.string().min(1),
  })
  .strict()
export type Candidate = z.infer<typeof CandidateSchema>

/**
 * Input to a decision provider call. Bounded, provenance-labelled,
 * secret-filtered by the caller before submission.
 */
export const DecisionInputSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    taskId: z.string().min(1),
    decisionId: z.string().min(1),
    stateVersion: z.number().int().nonnegative(),
    policyVersion: z.string().min(1),
    catalogVersion: z.string().min(1),
    observationHash: z.string().min(1),
    questionFamily: z.string().min(1),
    promptVersion: z.string().min(1),
    state: z.string().max(32_000),
    candidates: z.array(CandidateSchema).min(1).max(32),
  })
  .strict()
export type DecisionInput = z.infer<typeof DecisionInputSchema>

/** Why a normalized decision was accepted or rejected. */
export const DecisionReasonCodeSchema = z.enum(['accepted', 'uncertain', 'unsupported', 'invalid'])
export type DecisionReasonCode = z.infer<typeof DecisionReasonCodeSchema>

/**
 * A validated decision from a provider, normalized to host semantics.
 * Raw probabilities, vendor confidence, and empirical correctness are
 * distinct fields; never substitute one for another.
 */
export const NormalizedDecisionSchema = z
  .object({
    decisionId: z.string().min(1),
    /** Echo of the DecisionInput question family; admission checks exact equality. */
    questionFamily: z.string().min(1),
    /** Echo of the DecisionInput prompt version; admission checks exact equality. */
    promptVersion: z.string().min(1),
    selectedId: z.string().min(1),
    probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
    selectedProbability: z.number().finite().min(0).max(1),
    vendorConfidence: z.number().finite().min(0).max(1).nullable(),
    calibratedCorrectness: z.number().finite().min(0).max(1).nullable(),
    calibrationVersion: z.string().nullable(),
    modelRequested: z.string().min(1),
    modelResolved: z.string().nullable(),
    requestId: z.string().nullable(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    reasonCode: DecisionReasonCodeSchema,
  })
  .strict()
export type NormalizedDecision = z.infer<typeof NormalizedDecisionSchema>

/**
 * The result of executing a selected candidate.
 * Unknown is a first-class outcome, not an error.
 */
export const ExecutionOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('succeeded'),
      receiptRef: z.string().min(1),
      evidenceRefs: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      kind: z.literal('failed'),
      errorCode: z.string().min(1),
      retryClass: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unknown'),
      reconciliationRef: z.string().min(1),
    })
    .strict(),
])
export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>

/** The verdict of an independent task verifier. */
export const VerificationResultSchema = z
  .object({
    status: z.enum(['pass', 'fail', 'inconclusive']),
    verifierId: z.string().min(1),
    verifierVersion: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
    observedResourceVersions: z.record(z.string(), z.string()),
    failures: z.array(z.string()),
  })
  .strict()
export type VerificationResult = z.infer<typeof VerificationResultSchema>

/** Lifecycle states of a System 1 task. */
export const TaskStateSchema = z.enum([
  'admitted',
  'observing',
  'deciding',
  'executing',
  'verifying',
  'waiting_input',
  'waiting_retry',
  'escalated',
  'reconciling',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
])
export type TaskState = z.infer<typeof TaskStateSchema>
