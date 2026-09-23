/**
 * System 1 question builders: pure functions that turn agent-loop traffic
 * into typed {@link System1Question}s, plus the deterministic loop detector
 * that runs before any model call.
 *
 * Builders never touch the network and never throw on malformed input; they
 * degrade to generic prompts so a weird payload cannot break the loop.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import type {
  LoopCheckVerdict,
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
    prompt:
      'Classify this agent step as trivial (no reasoning needed), standard, or complex (needs full reasoning). '
      + 'Answer with exactly one word.',
    context: { messagePreview: preview, messageCount: messages.length },
    answerSchema: 'triage',
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

/** Build a loop-check question for ambiguous repetition patterns. */
export function buildLoopQuestion(history: readonly ObservedToolCall[]): System1Question {
  return {
    kind: 'loop-check',
    prompt:
      'Given this recent tool-call history, is the agent stuck in a loop? '
      + 'Answer with a JSON object: {"looping": boolean, "suggestion": "continue"|"interrupt"|"ask-user"}.',
    context: {
      history: history.slice(-8).map((entry) => {
        return {
          name: entry.name,
          argsKey: entry.argsKey.slice(0, 200),
          isError: entry.isError,
        }
      }),
    },
    answerSchema: 'choice',
  }
}

/** Build a retry-judgment question for a failed tool call. */
export function buildRetryQuestion(toolName: string, argsKey: string, errorText: string): System1Question {
  return {
    kind: 'retry-judgment',
    prompt:
      'This tool call failed. Should the agent retry it as-is, retry with different arguments, or give up? '
      + 'Answer with exactly one word: retry, retry-different, or give-up.',
    context: { toolName, argsKey: argsKey.slice(0, 500), errorText: errorText.slice(0, 500) },
    answerSchema: 'choice',
  }
}

/** Validate a raw retry answer. */
export function validateRetry(answer: unknown): 'retry' | 'retry-different' | 'give-up' | null {
  return answer === 'retry' || answer === 'retry-different' || answer === 'give-up' ? answer : null
}

/** Build a delegation question: can a cheaper sub-agent handle this step? */
export function buildDelegationQuestion(stepSummary: string): System1Question {
  return {
    kind: 'delegation',
    prompt:
      'Can this step be delegated to a cheaper sub-agent without losing quality? '
      + 'Answer with exactly one word: yes or no.',
    context: { stepSummary: stepSummary.slice(0, 1000) },
    answerSchema: 'boolean',
  }
}

/** Validate a raw delegation answer. */
export function validateDelegation(answer: unknown): boolean | null {
  if (answer === true || answer === 'yes') return true
  if (answer === false || answer === 'no') return false
  return null
}

/** Validate a raw loop-check answer into a {@link LoopCheckVerdict}. */
export function validateLoopAnswer(answer: unknown): LoopCheckVerdict | null {
  if (typeof answer !== 'object' || answer === null) return null
  const raw = answer as { looping?: unknown; suggestion?: unknown }
  if (typeof raw.looping !== 'boolean') return null
  const suggestion = raw.suggestion === 'interrupt' || raw.suggestion === 'ask-user'
    ? raw.suggestion
    : 'continue'
  return { looping: raw.looping, repetitions: 0, suggestion }
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
