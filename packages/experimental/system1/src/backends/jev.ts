/**
 * Jev backend: TypeSafe's hosted System One model.
 *
 * Implements the documented `POST /v1/systemone` wire format: one request
 * carries a `state` object plus a map of typed questions (`choice`, `score`,
 * `noul`), and Jev evaluates every question in parallel in a single pass —
 * so a batch of N questions costs barely more time than one. The plugin
 * therefore funnels each decision point through a single `decideMany` call.
 *
 * The API key is read from the environment variable named by `jevApiKeyEnv`
 * at call time and never stored. Node's global fetch keeps connections alive
 * by default, so repeated calls reuse the TLS session.
 *
 * Wire format verified against TypeSafe's getting-started guide
 * (endpoint `https://api.typesafe.ai/v1/systemone`, model alias
 * `jev-latest`); field-level drift still surfaces as a backend error and the
 * service falls back safely.
 *
 * @module @deepseek-ai/dsh-experimental-system1
 */

import { decideManySequential, type System1Backend } from '../backend.ts'
import type {
  JevPrimitive,
  System1Judgment,
  System1Question,
  System1RuntimeConfig,
} from '../types.ts'

/** Thrown when Jev rate-limits the caller (HTTP 429). */
export class JevRateLimitError extends Error {
  constructor(readonly retryAfterMs: number | null) {
    super(
      `system1: jev rate limited (HTTP 429)${
        retryAfterMs === null ? '' : `; retry after ${retryAfterMs}ms`
      }`,
    )
    this.name = 'JevRateLimitError'
  }
}

interface JevWireQuestion {
  type: JevPrimitive
  instructions: string
  criteria?: Record<string, string> | string[]
}

interface JevWireAnswer {
  choice?: unknown
  score?: unknown
  noul?: unknown
  confidence?: unknown
  probabilities?: unknown
}

interface JevWireResponse {
  model?: unknown
  answers?: Record<string, JevWireAnswer | null | undefined>
}

function toWireQuestion(question: System1Question): JevWireQuestion {
  const wire: JevWireQuestion = {
    type: question.primitive,
    instructions: question.prompt,
  }
  if (question.primitive === 'choice' && question.options !== undefined) {
    return { ...wire, criteria: { ...question.options } }
  }
  if (question.primitive === 'score' && question.levels !== undefined) {
    return { ...wire, criteria: [...question.levels] }
  }
  return wire
}

function clamp01(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0
}

/**
 * Map one Jev wire answer to a {@link System1Judgment}. For `noul` the answer
 * is the probability itself and confidence is `max(p, 1 - p)`, so wishy-washy
 * probabilities near 0.5 fail the service's confidence gate. A missing or
 * non-numeric `noul` abstains instead of degrading to a confident zero.
 */
function toJudgment(
  question: System1Question,
  raw: JevWireAnswer | null | undefined,
  model: string | undefined,
  latencyMs: number,
): System1Judgment {
  const base = {
    latencyMs,
    backend: 'jev' as const,
    abstained: false,
    ...(model === undefined ? {} : { model }),
  }
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { ...base, answer: null, confidence: 0, abstained: true }
  }
  switch (question.primitive) {
    case 'choice':
      return { ...base, answer: raw.choice ?? null, confidence: clamp01(raw.confidence) }
    case 'score':
      return { ...base, answer: raw.score ?? null, confidence: clamp01(raw.confidence) }
    case 'noul': {
      // A missing or non-numeric noul is a non-answer: abstain. Treating it
      // as p=0 would manufacture a fully-confident "not stuck" judgment
      // (confidence would be max(0, 1) = 1) that sails through the gate.
      if (typeof raw.noul !== 'number' || !Number.isFinite(raw.noul)) {
        return { ...base, answer: null, confidence: 0, abstained: true }
      }
      const p = clamp01(raw.noul)
      return { ...base, answer: p, confidence: Math.max(p, 1 - p) }
    }
  }
}

/** Backend that calls Jev's hosted System One endpoint. */
export class JevBackend implements System1Backend {
  readonly kind = 'jev' as const

  constructor(private readonly config: System1RuntimeConfig) {}

  async decide(question: System1Question, signal: AbortSignal): Promise<System1Judgment> {
    const judgments = await this.decideMany([question], signal)
    const first = judgments[0]
    if (first === undefined) throw new Error('system1: jev returned no judgments')
    return first
  }

  /**
   * Ask every question in a single `POST /v1/systemone` call. State is
   * namespaced per question id so each question's context stays scoped;
   * Jev evaluates the questions in parallel over the shared state.
   */
  async decideMany(
    questions: readonly System1Question[],
    signal: AbortSignal,
  ): Promise<System1Judgment[]> {
    const started = Date.now()
    if (questions.length === 0) return []
    const apiKey = process.env[this.config.jevApiKeyEnv]
    if (apiKey === undefined || apiKey === '') {
      throw new Error(`system1: Jev backend needs an API key in $${this.config.jevApiKeyEnv}`)
    }

    const wireQuestions: Record<string, JevWireQuestion> = {}
    const state: Record<string, unknown> = {}
    const ids: string[] = []
    questions.forEach((question, index) => {
      // Question ids are unique within the batch; kinds are unique per
      // decision point, the index suffix is belt-and-braces.
      const id = `${question.kind}#${index}`
      ids.push(id)
      wireQuestions[id] = toWireQuestion(question)
      state[id] = question.context
    })

    const response = await fetch(this.config.jevEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.jevModel,
        state,
        questions: wireQuestions,
      }),
      signal,
    })
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      const retryAfterMs = retryAfter === null ? null : Number(retryAfter) * 1000
      throw new JevRateLimitError(Number.isFinite(retryAfterMs) ? retryAfterMs : null)
    }
    if (!response.ok) {
      throw new Error(`system1: jev systemone returned HTTP ${response.status}`)
    }
    const body = (await response.json()) as JevWireResponse
    const model = typeof body.model === 'string' ? body.model : undefined
    const latencyMs = Date.now() - started
    return questions.map((question, index) => {
      const id = ids[index] as string
      return toJudgment(question, body.answers?.[id], model, latencyMs)
    })
  }

  async dispose(): Promise<void> {
    // Stateless HTTP client; nothing held.
  }
}

/** Sequential fallback, exported for tests. */
export async function decideManyFallback(
  backend: System1Backend,
  questions: readonly System1Question[],
  signal: AbortSignal,
): Promise<System1Judgment[]> {
  return decideManySequential(backend, questions, signal)
}
