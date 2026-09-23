/**
 * System 1 (fast thinking) type surface for the DeepSeek Harness integration.
 *
 * System 1 answers small, typed questions about agent-loop traffic so the
 * harness can skip, shorten, or supervise work without paying for a full
 * reasoning-model call. Every judgment carries a confidence and a structured
 * trace; anything uncertain falls back to existing harness behavior.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

/** Which fast-thinking backend answers System 1 questions. */
export type System1BackendKind = 'laya' | 'jev' | 'none'

/** How much authority System 1 has over the agent loop. */
export type System1Mode = 'shadow' | 'assist' | 'enforce'

/** The question areas System 1 can be asked about. */
export type System1QuestionKind =
  | 'triage'
  | 'tool-shortlist'
  | 'loop-check'
  | 'retry-judgment'
  | 'delegation'
  | 'plausibility'

/**
 * One typed question for a System 1 backend. Backends return a judgment, not
 * prose; the service validates the answer against `answerSchema`.
 */
export interface System1Question {
  readonly kind: System1QuestionKind
  /** Compact natural-language question for the backend. */
  readonly prompt: string
  /** Structured facts the backend may use to answer. */
  readonly context: Readonly<Record<string, unknown>>
  /** Expected answer shape, used to validate the backend response. */
  readonly answerSchema: 'triage' | 'choice' | 'boolean' | 'score'
}

/**
 * A backend's raw answer to one question, including abstention.
 * `confidence` is always in the closed 0..1 range.
 */
export interface System1Judgment {
  readonly answer: unknown
  readonly confidence: number
  readonly latencyMs: number
  readonly backend: System1BackendKind
  readonly abstained: boolean
}

/** Why a gate produced no usable value. */
export type System1FallbackReason =
  | 'abstain'
  | 'low-confidence'
  | 'budget-exceeded'
  | 'timeout'
  | 'backend-error'
  | 'disabled'

/**
 * The service's verdict for one question: a typed value when the gate passed,
 * otherwise the reason it fell back to existing harness behavior.
 */
export interface System1Decision<T> {
  readonly judgment: System1Judgment | null
  /** Typed answer when the gate passed; null on any fallback. */
  readonly value: T | null
  /** Null when the gate passed. */
  readonly fallback: System1FallbackReason | null
  readonly trace: System1Trace
}

/** Structured record of one System 1 evaluation, kept for replay and tuning. */
export interface System1Trace {
  readonly id: string
  readonly at: number
  readonly questionKind: System1QuestionKind
  readonly mode: System1Mode
  readonly backend: System1BackendKind
  readonly confidence: number | null
  readonly latencyMs: number
  readonly fallback: System1FallbackReason | null
  /** Whether the harness acted on the judgment (never true in shadow mode). */
  readonly acted: boolean
  readonly note?: string
}

/**
 * Runtime configuration for {@link System1Service}. The plugin builds this
 * from its validated {@link Config}; every tunable is user-overridable and
 * none is a hardcoded deployment secret.
 */
export interface System1RuntimeConfig {
  readonly backend: System1BackendKind
  readonly mode: System1Mode
  readonly enabled: boolean
  /** Minimum confidence for a judgment to pass the gate. */
  readonly confidenceThreshold: number
  /** Max System 1 calls per agent turn. */
  readonly budgetPerTurn: number
  /** Max System 1 calls per agent task. */
  readonly budgetPerTask: number
  /** Per-call timeout in milliseconds. */
  readonly timeoutMs: number
  /** Consecutive backend failures before the circuit opens. */
  readonly failureThreshold: number
  /** How long the circuit stays open in milliseconds. */
  readonly cooldownMs: number
  /** Max traces kept in the in-memory ring buffer. */
  readonly traceBufferSize: number
  /** Environment variable holding the Jev API key (the key itself is never stored). */
  readonly jevApiKeyEnv: string
  /** Jev System One endpoint URL. */
  readonly jevEndpoint: string
  /** Laya sidecar decision endpoint URL (used when `layaAutoStart` is false). */
  readonly layaEndpoint: string
  /** Start a local Laya sidecar on demand instead of using `layaEndpoint`. */
  readonly layaAutoStart: boolean
  /** Command used to start a local Laya sidecar on demand. */
  readonly layaCommand: readonly string[]
}

/** Triage verdict for one proposed agent step. */
export type TriageVerdict = 'trivial' | 'standard' | 'complex'

/** Loop-check verdict for recent tool-call history. */
export interface LoopCheckVerdict {
  readonly looping: boolean
  readonly repetitions: number
  readonly suggestion: 'continue' | 'interrupt' | 'ask-user'
}
