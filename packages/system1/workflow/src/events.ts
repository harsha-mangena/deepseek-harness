/**
 * System 1 durable event vocabulary, merged into {@link SessionEventMap}.
 *
 * These events are the System 1 write-ahead log: every state transition the
 * coordinator makes is appended here before it takes effect, so a restarted
 * coordinator can rebuild its state machine by replaying the session log.
 * They are required-on-read (not ignorable): dropping them would corrupt
 * replay, which is why they are never pruned by compaction.
 *
 * Phase 1 adds schemastery runtime validators and versioned migrations for
 * these payloads; phase 0 establishes the type-level vocabulary only.
 *
 * @module @deepseek-ai/dsh-system1-workflow/events
 */

import type { System1RequestId } from './types.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'

/** Every System 1 event payload carries a schema version so replay can migrate. */
export interface System1EventBase {
  /** Payload schema version; currently always 1. */
  schemaVersion: 1
  /** Workflow request this event belongs to. */
  requestId: System1RequestId
}

/** Admission: the workflow request and its hard limits entered the system. */
export interface System1AdmissionData extends System1EventBase {
  /** Natural-language objective captured at admission time. */
  objective: string
  /** Hard limits admitted with the request. */
  limits: { steps: number; tokens: number; wallClockMs: number }
}

/** Routing: which strategy owns this request after the router ran. */
export interface System1RouteData extends System1EventBase {
  /** Strategy that owns execution from here on. */
  strategy: 'system1' | 'deepseek' | 'mixed'
  /** Human-readable reason for the routing decision. */
  reason: string
}

/** One executable candidate the planner produced. */
export interface System1Candidate {
  /** Candidate identity, unique within the request. */
  id: string
  /** What this candidate would do, in one line. */
  summary: string
  /** Whether the candidate only performs reversible effects. */
  reversible: boolean
  /** Estimated relative cost, used for budget reservation. */
  estimatedCost: number
}

/** Candidate snapshot: the planner's candidate set, recorded before deciding. */
export interface System1CandidatesData extends System1EventBase {
  /** Candidates under consideration, in planner rank order. */
  candidates: System1Candidate[]
}

/** Jev's normalized decision for one request. */
export interface System1DecisionData extends System1EventBase {
  /** Jev choice primitive used: `choice`, `score`, or `noul`. */
  primitive: 'choice' | 'score' | 'noul'
  /** Winning candidate for `choice`, or the scored candidate for `score`. */
  candidateId?: string
  /** Normalized confidence in [0, 1]; `noul` decisions report a reason instead. */
  confidence?: number
  /** `noul` reason when no candidate was eligible. */
  noulReason?: string
  /** Raw Jev model that produced the decision. */
  model: string
}

/** Budget reservation: tokens/steps earmarked before execution starts. */
export interface System1BudgetReservationData extends System1EventBase {
  /** Tokens reserved for this request. */
  tokens: number
  /** Steps reserved for this request. */
  steps: number
  /** Wall-clock deadline in epoch milliseconds. */
  expiresAtMs: number
}

/** One planned execution step. */
export interface System1PlannedStep {
  /** Step identity, unique within the request. */
  id: string
  /** Tool this step will execute. */
  tool: string
  /** One-line summary of the arguments; full args live in the tool call. */
  argsSummary: string
  /** Whether this step only performs reversible effects. */
  reversible: boolean
}

/** Execution intent: the plan the coordinator committed to, before running it. */
export interface System1ExecutionIntentData extends System1EventBase {
  /** Ordered steps the coordinator intends to execute. */
  steps: System1PlannedStep[]
}

/** Execution settlement: the outcome of one executed step. */
export interface System1ExecutionSettlementData extends System1EventBase {
  /** Step this settlement closes. */
  stepId: string
  /** Step outcome. */
  outcome: 'ok' | 'failed' | 'cancelled'
  /** Machine-readable detail; stack traces stay out of the log. */
  detail: string
}

/** Verification: one verifier check ran and reported. */
export interface System1VerificationData extends System1EventBase {
  /** Verifier check identity. */
  checkId: string
  /** Whether the check passed. */
  passed: boolean
  /** Evidence the verifier cited, as compact text. */
  evidence: string
}

/** Handoff: ownership moved between System 1 and the DeepSeek path. */
export interface System1HandoffData extends System1EventBase {
  /** Direction of the handoff. */
  to: 'deepseek' | 'system1'
  /** Compact package the receiving side needs to continue. */
  summary: string
}

/** Context selection: what the retention policy kept and dropped. */
export interface System1ContextSelectionData extends System1EventBase {
  /** Bytes retained in the working context. */
  retainedBytes: number
  /** Bytes dropped by the retention policy. */
  droppedBytes: number
  /** Selectors that made the cut, in application order. */
  selectors: string[]
}

/** Inbox: a message entered the coordinator's pending-work queue. */
export interface System1InboxData {
  /** Payload schema version; currently always 1. */
  schemaVersion: 1
  /** Which pending list received the message. */
  target: 'next-turn' | 'next-step'
  /** The appended message, as a JSON snapshot. */
  message: UserMessage
  /** Epoch milliseconds when the append was recorded. */
  appendedAt: number
}

/** Terminal: the workflow request reached a final outcome. */
export type System1TerminalData = System1EventBase & (
  | {
    /** Final outcome of the request. */
    outcome: 'success'
    /** One-line outcome summary. */
    summary: string
    /**
       * Verifier checks that passed before success was declared. A
       * success terminal without verification evidence is a contract
       * violation: repeated FINISH with an unmet goal must never
       * succeed. The phase 1 policy engine enforces this; the type
       * makes an unevidenced success unrepresentable.
       */
    verifiedBy: readonly string[]
  }
  | {
    /** Final outcome of the request. */
    outcome: 'failure' | 'cancelled' | 'escalated'
    /** One-line outcome summary. */
    summary: string
  }
)

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A System 1 workflow request was admitted with its hard limits. */
    'system1/admission': System1AdmissionData
    /** The router assigned a strategy to a System 1 workflow request. */
    'system1/route': System1RouteData
    /** The planner recorded its candidate set before deciding. */
    'system1/candidates': System1CandidatesData
    /** Jev returned a normalized decision for the request. */
    'system1/decision': System1DecisionData
    /** Budget was reserved before execution started. */
    'system1/budget-reservation': System1BudgetReservationData
    /** The coordinator committed to an execution plan. */
    'system1/execution-intent': System1ExecutionIntentData
    /** One execution step settled with its outcome. */
    'system1/execution-settlement': System1ExecutionSettlementData
    /** One verifier check reported its result. */
    'system1/verification': System1VerificationData
    /** Ownership moved between System 1 and the DeepSeek path. */
    'system1/handoff': System1HandoffData
    /** The retention policy recorded what it kept and dropped. */
    'system1/context-selection': System1ContextSelectionData
    /** The workflow request reached a final outcome. */
    'system1/terminal': System1TerminalData
    /** A message entered the coordinator's inbox queue. */
    'system1/inbox': System1InboxData
  }
}

/** Session event types reserved by the System 1 workflow package. */
export const SYSTEM1_EVENT_TYPES = [
  'system1/admission',
  'system1/route',
  'system1/candidates',
  'system1/decision',
  'system1/budget-reservation',
  'system1/execution-intent',
  'system1/execution-settlement',
  'system1/verification',
  'system1/handoff',
  'system1/context-selection',
  'system1/terminal',
  'system1/inbox',
] as const

/** One of the reserved System 1 session event types. */
export type System1EventType = (typeof SYSTEM1_EVENT_TYPES)[number]
