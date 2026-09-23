/**
 * System 1 (fast thinking) type surface for the DeepSeek Harness integration.
 *
 * System 1 answers small, typed questions about agent-loop traffic so the
 * harness can skip, shorten, or supervise work without paying for a full
 * reasoning-model call. Questions are expressed in Jev's three native
 * primitives (choice, score, noul); every judgment carries a confidence and
 * a structured trace, and anything uncertain falls back to existing harness
 * behavior.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

/** Which fast-thinking backend answers System 1 questions. */
export type System1BackendKind = 'laya' | 'jev' | 'none'

/** How much authority System 1 has over the agent loop. */
export type System1Mode = 'shadow' | 'assist' | 'enforce'

/** Jev's native question primitives. */
export type JevPrimitive = 'choice' | 'score' | 'noul'

/** The question areas System 1 can be asked about. */
export type System1QuestionKind =
  | 'triage'
  | 'tool-choice'
  | 'loop-check'
  | 'retry-judgment'
  | 'final-answer'
  | 'delegation'
  | 'delegation-triage'
  | 'request-retry'
  | 'preselect'
  | 'result-triage'
  | 'injection-screen'
  | 'subagent-accept'
  | 'prune'

/** Jev's verdict on a subagent's output: meets the task, partially meets it, or fails it. */
export type SubagentAcceptVerdict = 'meets' | 'partial' | 'fails'

/** Jev's verdict on a tool result: useful as-is, keep only the head, irrelevant, or an error. */
export type ResultTriageVerdict =
  | 'useful'
  | 'noisy_keep_head'
  | 'irrelevant'
  | 'error_actionable'
  | 'error_transient'

/**
 * One typed question for a System 1 backend, expressed in Jev's native
 * primitives so the backend can answer it directly:
 *
 * - `choice`: `options` maps each option name to a one-line description
 *   (Jev `criteria`); the answer is the chosen option name.
 * - `score`: `levels` is an ordered rubric of 2-10 descriptions; the answer
 *   is a score that may land between levels.
 * - `noul`: the answer is a single 0-1 probability that `prompt` holds.
 *
 * Backends return a judgment, not prose; the service validates the answer
 * against the primitive.
 */
export interface System1Question {
  readonly kind: System1QuestionKind
  readonly primitive: JevPrimitive
  /** The Jev `instructions` text: one atomic judgment, never prose. */
  readonly prompt: string
  /** Structured facts the backend may use; sent as Jev `state`. */
  readonly context: Readonly<Record<string, unknown>>
  /** Choice options: option name to one-line description. */
  readonly options?: Readonly<Record<string, string>>
  /** Score rubric: 2-10 ordered level descriptions. */
  readonly levels?: readonly string[]
  /**
   * Risk-scaled gate for this question: the minimum confidence for the
   * judgment to actuate. TypeSafe's guidance is that "a confidence threshold
   * is not one number" — different actions gate at different levels
   * depending on the consequences of getting it wrong — so each builder
   * declares the stakes of its own question here. Falls back to the
   * `thresholds` config override, then `confidenceThreshold`.
   */
  readonly threshold?: number
}

/**
 * A backend's raw answer to one question, including abstention.
 * `confidence` is always in the closed 0..1 range. For `noul` answers the
 * answer is the probability itself and confidence is `max(p, 1 - p)`.
 */
export interface System1Judgment {
  readonly answer: unknown
  readonly confidence: number
  readonly latencyMs: number
  readonly backend: System1BackendKind
  readonly abstained: boolean
  /** Versioned model id reported by the backend (e.g. `jev-1.13.0`). */
  readonly model?: string
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
  /** The agent the question belonged to; '' only when the caller omitted it. */
  readonly agentId: string
  readonly questionKind: System1QuestionKind
  readonly mode: System1Mode
  readonly backend: System1BackendKind
  readonly confidence: number | null
  readonly latencyMs: number
  readonly fallback: System1FallbackReason | null
  /** Whether the harness acted on the judgment (never true in shadow mode). */
  readonly acted: boolean
  /** Versioned model id that answered, when the backend reports one. */
  readonly model?: string
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
  /**
   * Per-question-kind threshold overrides. TypeSafe's confidence guidance:
   * "a confidence threshold is not one number" — a cheap reversible hint
   * (retry) gates lower than oversight advice (delegation). A kind not
   * listed here falls back to the question's own `threshold`, then
   * `confidenceThreshold`.
   */
  readonly thresholds: Partial<Record<System1QuestionKind, number>>
  /** Max System 1 questions per agent turn (each question costs tokens). */
  readonly budgetPerTurn: number
  /** Max System 1 questions per agent task. */
  readonly budgetPerTask: number
  /** Per-batch backend timeout in milliseconds. 0 disables the timeout (not recommended for network backends). */
  readonly timeoutMs: number
  /** Consecutive backend failures before the circuit opens. */
  readonly failureThreshold: number
  /** How long the circuit stays open in milliseconds. */
  readonly cooldownMs: number
  /** Max traces kept in the in-memory ring buffer. */
  readonly traceBufferSize: number
  /** Relative weights for the delegation composite scores (novelty/tool-risk/irreversibility). */
  readonly delegationWeights: DelegationWeights
  /** Environment variable holding the Jev API key (the key itself is never stored). */
  readonly jevApiKeyEnv: string
  /** Jev System One endpoint URL. */
  readonly jevEndpoint: string
  /** Jev model alias or pinned version (e.g. `jev-latest`, `jev-1.13.0`). */
  readonly jevModel: string
  /** Laya sidecar decision endpoint URL (used when `layaAutoStart` is false). */
  readonly layaEndpoint: string
  /** Start a local Laya sidecar on demand instead of using `layaEndpoint`. */
  readonly layaAutoStart: boolean
  /** Command used to start a local Laya sidecar on demand. */
  readonly layaCommand: readonly string[]
  /** Stuck probability at or above which a loop-check triggers a nudge (0..1). */
  readonly loopStuckThreshold: number
  /** Max loop nudges injected per agent task; further stuck episodes only warn. */
  readonly maxLoopNudgesPerTask: number
  /**
   * Model routing table: triage verdict to call-config override, applied at
   * `agent/request` in enforce mode. Reuses the pre-step triage verdict, so
   * routing costs no extra model call. Empty by default — model names are
   * deployment-specific, so routing stays inert until the operator wires it
   * (e.g. `trivial` to a cheap model, `complex` to a strong one).
   */
  readonly modelRoute: Partial<Record<TriageVerdict, ModelRouteOverride>>
  /**
   * Max Jev-owned request retries per agent step (`agent/request-error`).
   * Bounds the retry judgment so a confidently-wrong "transient" verdict
   * cannot loop forever; the adapter's own retry policy is unaffected.
   */
  readonly maxRequestRetries: number
  /**
   * Stuck probability at or above which a hopeless trajectory ends the turn
   * (0..1). Stricter than `loopStuckThreshold`: the STOP fires only when the
   * deterministic detector also sees a long identical streak, so a high bar
   * here means "Jev is nearly certain the agent is stuck, not polling".
   */
  readonly stopStuckThreshold: number
  /** Scrub secret-shaped values from state sent to the Jev backend. */
  readonly redactState: boolean
  /** Prefetch risk/tool-choice judgments while tool calls stream. */
  readonly prefetchToolChoice: boolean
  /** Ask Jev which MCP servers a task needs at session start. */
  readonly preselect: boolean
  /** Jev need-probability below which a server is denied (0..1). */
  readonly preselectDenyThreshold: number
  /** Minimum distinct MCP servers before preselection runs. */
  readonly preselectMinServers: number
  /** Tool-result chars at or above which post-execute triage runs. */
  readonly triageMinChars: number
  /** Head chars kept for `noisy_keep_head` results. */
  readonly triageHeadChars: number
  /** Screen untrusted tool results for prompt injection. */
  readonly injectionScreen: boolean
  /** Injection probability at or above which a result is flagged (0..1). */
  readonly injectionThreshold: number
  /** Check subagent outputs against their delegated task. */
  readonly subagentAccept: boolean
  /** Pressure-gated pruning of past tool results (compaction). */
  readonly compactionPrune: boolean
  /** Token-meter pressure at or above which the prune gate runs (0..1). */
  readonly prunePressureThreshold: number
  /** Tool-result chars at or above which a result is prune-eligible. */
  readonly pruneMinChars: number
  /** Still-needed probability below which a result is dropped (0..1). */
  readonly pruneDropThreshold: number
  /** Max history rewrites per agent task. */
  readonly maxPrunePerTask: number
}

/** Triage verdict for one proposed agent step. */
export type TriageVerdict = 'trivial' | 'standard' | 'complex'

/** Retry verdict for a failed tool call. */
export type RetryVerdict = 'retry' | 'retry-different' | 'replan' | 'give-up'

/**
 * Retry verdict for a failed model request (`agent/request-error`). Unlike
 * the tool-retry judgment, this actuates a real retry of the request, so it
 * is owned per step and bounded by `maxRequestRetries`.
 */
export type RequestRetryVerdict = 'retry' | 'fail'

/**
 * One model-route override: where a triage verdict sends the step's model
 * call. All fields optional; fields left unset keep the loop's own config.
 * `reasoningEffort` is a plain string here (cordis.yml-friendly) and branded
 * at the call boundary. An empty `modelRoute` map disables routing.
 */
export interface ModelRouteOverride {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/**
 * Tool-choice verdict for one proposed tool call. `wrong-tool` means the
 * call is clearly mistaken for the step's apparent goal — not merely
 * suboptimal — and in enforce mode denies the dispatch so the agent can
 * self-correct instead of spending a round-trip on a useless call.
 */
export type ToolChoiceVerdict = 'proceed' | 'wrong-tool'

/**
 * Final-answer verdict for a finished turn. `inadequate` means the agent's
 * closing answer clearly fails to address the user's request (or the agent
 * gave up). Observe-only: the turn is already over, so there is no veto —
 * assist mode warns the operator.
 */
export type FinalAnswerVerdict = 'adequate' | 'inadequate'

/** Oversight tier for a delegated subtask, from composite delegation scores. */
export type OversightLevel = 'low' | 'standard' | 'high'

/** Atomic delegation scores (each 0..3 on a four-level rubric), combined with weights in code. */
export interface DelegationScores {
  readonly novelty: number
  readonly toolRisk: number
  readonly irreversibility: number
}

/** Relative weights for the delegation composite; normalized in code so they need not sum to 1. */
export interface DelegationWeights {
  readonly novelty: number
  readonly toolRisk: number
  readonly irreversibility: number
}

/** Combined oversight judgment for one delegation. */
export interface OversightJudgment {
  readonly level: OversightLevel
  /** Normalized weighted composite score in 0..1. */
  readonly score: number
  readonly scores: DelegationScores
}

/** Loop-check verdict for recent tool-call history. */
export interface LoopCheckVerdict {
  readonly looping: boolean
  readonly repetitions: number
  readonly suggestion: 'continue' | 'interrupt' | 'ask-user'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** System 1 injected guidance: triage strategy hints, loop nudges, retry hints. */
    system1: { kind: 'system1' }
  }
}
