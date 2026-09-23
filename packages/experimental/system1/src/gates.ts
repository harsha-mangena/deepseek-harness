/**
 * System 1 question builders: pure functions that turn agent-loop traffic
 * into Jev-native typed {@link System1Question}s, plus the deterministic
 * loop detector that runs before any model call.
 *
 * Design follows TypeSafe's own guidance: keep control flow in code and give
 * the model narrow, atomic judgments. Exact repetition is detected by
 * {@link detectLoop} in code — Jev is only asked about ambiguous patterns.
 * Builders never touch the network and never throw on malformed input; they
 * degrade to generic prompts so a weird payload cannot break the loop.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import type {
  LoopCheckVerdict,
  RetryVerdict,
  System1Question,
  TriageVerdict,
} from './types.ts'

/** One observed tool call, distilled for loop analysis. */
export interface ObservedToolCall {
  readonly name: string
  /** Stable string form of the arguments, for repetition comparison. */
  readonly argsKey: string
  readonly isError: boolean
  readonly at: number
}

/** Build a triage question from the messages entering a proposed step. */
export function buildTriageQuestion(messages: readonly unknown[]): System1Question {
  const preview = messages
    .slice(-3)
    .map((message) => {
      try {
        return JSON.stringify(message).slice(0, 500)
      } catch {
        return ''
      }
    })
    .join('\n')
  return {
    kind: 'triage',
    primitive: 'choice',
    prompt: 'How much reasoning does this agent step need?',
    context: { messagePreview: preview, messageCount: messages.length },
    options: {
      trivial: 'No reasoning needed; a reflex or cached answer suffices',
      standard: 'Normal step; proceed with the default reasoning effort',
      complex: 'Needs full reasoning; do not shortcut or delegate this step',
    },
  }
}

/** Validate a raw triage answer into a {@link TriageVerdict}. */
export function validateTriage(answer: unknown): TriageVerdict | null {
  return answer === 'trivial' || answer === 'standard' || answer === 'complex' ? answer : null
}

/**
 * Deterministic loop check over recent tool calls: no model needed. Flags
 * when the same tool with the same arguments repeats `threshold` times in a
 * row, which is the shape of a stuck agent.
 */
export function detectLoop(
  history: readonly ObservedToolCall[],
  threshold = 3,
): LoopCheckVerdict {
  if (history.length === 0 || threshold < 2) {
    return { looping: false, repetitions: 0, suggestion: 'continue' }
  }
  const last = history[history.length - 1]
  if (last === undefined) return { looping: false, repetitions: 0, suggestion: 'continue' }
  let repetitions = 1
  for (let i = history.length - 2; i >= 0; i -= 1) {
    const entry = history[i]
    if (entry === undefined || entry.name !== last.name || entry.argsKey !== last.argsKey) break
    repetitions += 1
  }
  if (repetitions < threshold) {
    return { looping: false, repetitions, suggestion: 'continue' }
  }
  return {
    looping: true,
    repetitions,
    suggestion: last.isError ? 'interrupt' : 'ask-user',
  }
}

/**
 * Build a loop-check question for ambiguous repetition patterns — cases the
 * deterministic {@link detectLoop} cannot settle (similar but not identical
 * calls, alternating tools, semantic repetition). A single noul: the
 * probability that the agent is stuck and should be interrupted.
 */
export function buildLoopQuestion(history: readonly ObservedToolCall[]): System1Question {
  return {
    kind: 'loop-check',
    primitive: 'noul',
    prompt: 'The agent is stuck repeating itself and should be interrupted',
    context: {
      history: history.slice(-8).map((entry) => {
        return {
          name: entry.name,
          argsKey: entry.argsKey.slice(0, 200),
          isError: entry.isError,
        }
      }),
    },
  }
}

/**
 * Validate a raw loop-check answer into a stuck-probability. The caller
 * thresholds it in code (default 0.7); the service's confidence gate already
 * rejected wishy-washy probabilities near 0.5.
 */
export function validateLoopAnswer(answer: unknown): number | null {
  return typeof answer === 'number' && Number.isFinite(answer) && answer >= 0 && answer <= 1
    ? answer
    : null
}

/** Build a retry-judgment question for a failed tool call. */
export function buildRetryQuestion(toolName: string, argsKey: string, errorText: string): System1Question {
  return {
    kind: 'retry-judgment',
    primitive: 'choice',
    prompt: 'This tool call failed. What should the agent do next?',
    context: { toolName, argsKey: argsKey.slice(0, 500), errorText: errorText.slice(0, 500) },
    options: {
      retry: 'Retry the identical call; the failure looks transient',
      'retry-different': 'Retry with different arguments; the call itself was wrong',
      'give-up': 'Do not retry; surface the failure to the agent',
    },
  }
}

/** Validate a raw retry answer into a {@link RetryVerdict}. */
export function validateRetry(answer: unknown): RetryVerdict | null {
  return answer === 'retry' || answer === 'retry-different' || answer === 'give-up' ? answer : null
}

/** Build a delegation question: can a cheaper sub-agent handle this step? */
export function buildDelegationQuestion(stepSummary: string): System1Question {
  return {
    kind: 'delegation',
    primitive: 'choice',
    prompt: 'How should this step be staffed?',
    context: { stepSummary: stepSummary.slice(0, 1000) },
    options: {
      delegate: 'A cheaper sub-agent can handle this without losing quality',
      keep: 'The main agent should handle this itself',
    },
  }
}

/** Validate a raw delegation answer. */
export function validateDelegation(answer: unknown): boolean | null {
  if (answer === 'delegate') return true
  if (answer === 'keep') return false
  return null
}

/**
 * Strategy hint for a triage verdict: System 1 (fast thinking) telling the
 * agent how much slow thinking the step deserves. This is where the
 * atom/chain/tree-of-thoughts strategies plug in — the verdict selects the
 * reasoning shape, the agent loop executes it.
 */
export function buildStrategyHint(verdict: TriageVerdict): string {
  switch (verdict) {
    case 'trivial':
      return '[System 1 triage: trivial] This step looks routine. Answer directly with minimal deliberation — a single atomic step, no extended reasoning.'
    case 'complex':
      return '[System 1 triage: complex] This step needs full reasoning. Break it into atomic sub-steps, and before committing to an approach, consider 2–3 alternative approaches and pick the most promising one.'
    case 'standard':
      return '[System 1 triage: standard] Proceed with normal step-by-step reasoning.'
  }
}

/**
 * Nudge for a suspected tool loop. `stuckProbability` is the Jev loop-check
 * noul when available; null when the nudge comes from the deterministic
 * detector alone.
 */
export function buildLoopNudge(
  toolName: string,
  repetitions: number,
  stuckProbability: number | null,
  suggestion: string,
): string {
  const probability = stuckProbability === null ? 'unknown' : stuckProbability.toFixed(2)
  return `[System 1 loop-check] You appear to be repeating the same tool call ("${toolName}" ×${repetitions}, stuck probability ${probability}). Stop and reconsider before acting again: try a different approach, check your assumptions, or summarize what you have learned so far. Suggested next move: ${suggestion}.`
}

/** Hint carrying a retry-judgment verdict to the agent after a tool failure. */
export function buildRetryHint(verdict: RetryVerdict, toolName: string): string {
  switch (verdict) {
    case 'retry':
      return `[System 1 retry-judgment] The "${toolName}" failure looks transient — retrying the identical call is reasonable.`
    case 'retry-different':
      return `[System 1 retry-judgment] The "${toolName}" call itself looks wrong — retry with different arguments rather than repeating this one.`
    case 'give-up':
      return `[System 1 retry-judgment] Retrying "${toolName}" looks futile — do not retry this call; surface the failure and move on.`
  }
}

/**
 * Stable string key for tool arguments, used for repetition comparison.
 * Falls back to String() when JSON serialization fails.
 */
export function argsKeyOf(args: unknown): string {
  try {
    const key = JSON.stringify(args)
    return typeof key === 'string' ? key : String(args)
  } catch {
    return String(args)
  }
}
